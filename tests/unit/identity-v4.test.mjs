/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text.
 */

/* scripts/lib/identity-v4.js — the relay's half of identity v4.
 *   node --test tests/unit/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const v4 = require('../../scripts/lib/identity-v4.js');

const raw32 = (keyObject) => keyObject.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
function v4Account() {
  const signing = crypto.generateKeyPairSync('ed25519');
  const agree = crypto.generateKeyPairSync('x25519');
  const sk = raw32(signing.publicKey);
  const ak = raw32(agree.publicKey);
  const fp = v4.fingerprintV4(sk);
  const akSig = crypto.sign(null, v4.agreeKeyText(fp, ak), signing.privateKey).toString('base64');
  return { signing, sk, ak, fp, akSig };
}
function rsaAccount() {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 0x10001 });
  const key = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  return { pair, key, fp: v4.fingerprintV3(key) };
}
const rsaSign = (pair, bytes) => crypto.sign('sha256', bytes, { key: pair.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }).toString('base64');
function continuation(old, next, at = Date.now()) {
  const statement = { oldFp: old.fp, newFp: next.fp, oldKey: old.key, sk: next.sk, ak: next.ak, at };
  const text = v4.continuationText(statement);
  return { statement, akSig: next.akSig, oldSig: rsaSign(old.pair, text), newSig: crypto.sign(null, text, next.signing.privateKey).toString('base64') };
}

const OLD = rsaAccount();

test('a fixed vector, so the browser side can be checked against it', () => {
  /* 32 bytes of 0x01: what js/crypto/identity.js must also produce. */
  const sk = Buffer.alloc(32, 1).toString('base64');
  assert.equal(v4.fingerprintV4(sk), crypto.createHash('sha256').update(Buffer.concat([
    Buffer.from([0, 0, 0, 12]), Buffer.from('poorija-id/4'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1),
  ])).digest('hex'));
});

test('the kind of a key is told by its shape', () => {
  const a = v4Account();
  assert.equal(v4.keyKind(a.sk), 'v4');
  assert.equal(v4.keyKind(OLD.key), 'rsa');
  assert.equal(v4.keyKind(''), '');
  assert.equal(v4.keyKind(Buffer.alloc(31).toString('base64')), 'rsa');
});

test('a key names its fingerprint, under its own rules only', () => {
  const a = v4Account();
  assert.ok(v4.keyMatchesFingerprint(a.sk, a.fp));
  assert.ok(v4.keyMatchesFingerprint(OLD.key, OLD.fp));
  /* The v3 rule applied to a v4 key is not the v4 fingerprint. */
  assert.notEqual(v4.fingerprintV3(a.sk), a.fp);
  assert.ok(!v4.keyMatchesFingerprint(a.sk, v4.fingerprintV3(a.sk)));
  assert.ok(!v4.keyMatchesFingerprint(a.sk, OLD.fp));
});

test('a proof is checked with whichever key the account has', () => {
  const a = v4Account();
  const text = Buffer.from('relay-proof/1\nsocket\nfp\nnonce');
  assert.ok(v4.verifyProof(a.sk, text, crypto.sign(null, text, a.signing.privateKey).toString('base64')));
  assert.ok(!v4.verifyProof(a.sk, Buffer.from('other'), crypto.sign(null, text, a.signing.privateKey).toString('base64')));
  assert.ok(v4.verifyProof(OLD.key, text, rsaSign(OLD.pair, text)));
  assert.ok(!v4.verifyProof(a.sk, text, rsaSign(OLD.pair, text)));
});

test('the agreement key is the signing key\'s', () => {
  const a = v4Account();
  const b = v4Account();
  assert.ok(v4.verifyAgreeKey(a));
  assert.ok(!v4.verifyAgreeKey({ ...a, ak: b.ak }));
  assert.ok(!v4.verifyAgreeKey({ ...a, akSig: b.akSig }));
});

test('a continuation holds with both signatures and the pinned key', () => {
  const next = v4Account();
  const signed = continuation(OLD, next);
  assert.deepEqual(v4.verifyContinuation(signed), { ok: true });
  assert.deepEqual(v4.verifyContinuation(signed, { pinnedOldKey: OLD.key }), { ok: true });
});

test('and not without any one of them', () => {
  const next = v4Account();
  const signed = continuation(OLD, next);
  const other = rsaAccount();
  assert.equal(v4.verifyContinuation(signed, { pinnedOldKey: other.key }).reason, 'old-key-not-pinned');
  assert.equal(v4.verifyContinuation({ ...signed, oldSig: rsaSign(other.pair, v4.continuationText(signed.statement)) }).reason, 'bad-old-signature');
  const stranger = v4Account();
  assert.equal(v4.verifyContinuation({ ...signed, newSig: crypto.sign(null, v4.continuationText(signed.statement), stranger.signing.privateKey).toString('base64') }).reason, 'bad-new-signature');
  /* Somebody holding only the old key cannot move the account to a key they
     chose without that key signing too — and a statement pointing the old
     account at somebody else's new key fails on that key's signature. */
  const hijack = { ...signed, statement: { ...signed.statement, newFp: stranger.fp, sk: stranger.sk, ak: stranger.ak }, akSig: stranger.akSig };
  hijack.oldSig = rsaSign(OLD.pair, v4.continuationText(hijack.statement));
  assert.equal(v4.verifyContinuation(hijack).reason, 'bad-new-signature');
  assert.equal(v4.verifyContinuation({ ...signed, statement: { ...signed.statement, at: Date.now() + 3600e3 } }).reason, 'future');
  assert.equal(v4.verifyContinuation({ ...signed, statement: { ...signed.statement, oldKey: other.key } }).reason, 'old-key-not-fp');
});

test('the old key answers for ninety days', () => {
  const at = Date.UTC(2026, 10, 19);
  assert.equal(v4.legacyUntil({ at }) - at, 90 * 24 * 3600 * 1000);
});
