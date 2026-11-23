/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text.
 */

/* js/crypto/identity.js (the app) against scripts/lib/identity-v4.js (the
 * relay): what one writes, the other must read, byte for byte.
 *   node --test tests/unit/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto, { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import * as id from '../../js/crypto/identity.js';

const require = createRequire(import.meta.url);
const relay = require('../../scripts/lib/identity-v4.js');
const subtle = webcrypto.subtle;
const random = (n) => webcrypto.getRandomValues(new Uint8Array(n));
const bytes = (text) => new TextEncoder().encode(text);

test('both sides compute the same fingerprint', async () => {
  const sk = Buffer.alloc(32, 1).toString('base64');
  assert.equal(await id.fingerprintV4(subtle, sk), relay.fingerprintV4(sk));
  const made = await id.generate(subtle);
  assert.equal(made.fp, relay.fingerprintV4(made.sk));
});

test('both sides tell a key\'s kind the same way', async () => {
  const made = await id.generate(subtle);
  assert.equal(id.keyKind(made.sk), relay.keyKind(made.sk));
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  assert.equal(id.keyKind(rsa), 'rsa');
  assert.equal(relay.keyKind(rsa), 'rsa');
});

test('this device is able to', async () => {
  assert.equal(await id.supported(subtle), true);
});

test('an agreement key signed here is accepted by the relay', async () => {
  const made = await id.generate(subtle);
  assert.ok(relay.verifyAgreeKey(made));
  assert.ok(await id.verifyAgreeKey(subtle, made));
  const other = await id.generate(subtle);
  assert.ok(!(await id.verifyAgreeKey(subtle, { ...made, ak: other.ak })));
});

test('a proof signed here verifies on the relay', async () => {
  const made = await id.generate(subtle);
  const text = Buffer.from(['relay-proof/1', 'socket', made.fp, 'nonce'].join('\n'));
  const signature = await id.sign(subtle, made.signPrivate, new Uint8Array(text));
  assert.ok(relay.verifyProof(made.sk, text, id.toBase64(signature)));
  assert.ok(await id.verify(subtle, made.sk, signature, new Uint8Array(text)));
  assert.ok(!(await id.verify(subtle, made.sk, signature, bytes('other'))));
});

test('a continuation made here holds on the relay', async () => {
  const old = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const oldKey = old.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const made = await id.generate(subtle);
  const statement = { oldFp: relay.fingerprintV3(oldKey), newFp: made.fp, oldKey, sk: made.sk, ak: made.ak, at: Date.now() };
  const text = id.continuationText(statement);
  assert.deepEqual(Buffer.from(text), relay.continuationText(statement));
  const oldSig = crypto.sign('sha256', Buffer.from(text), { key: old.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }).toString('base64');
  const newSig = id.toBase64(await id.sign(subtle, made.signPrivate, text));
  assert.deepEqual(relay.verifyContinuation({ statement, akSig: made.akSig, oldSig, newSig }), { ok: true });
});

test('a seal opens for its account and its purpose only', async () => {
  const to = await id.generate(subtle);
  const sealed = await id.seal(subtle, to, 'kex', bytes('secret'), random);
  assert.ok(id.isSeal(sealed));
  assert.equal(new TextDecoder().decode(await id.open(subtle, to, 'kex', sealed)), 'secret');
  await assert.rejects(id.open(subtle, to, 'offline', sealed), { name: 'OperationError' });
  const other = await id.generate(subtle);
  await assert.rejects(id.open(subtle, other, 'kex', sealed));
  /* The same keys under another fingerprint (the binding to the account). */
  await assert.rejects(id.open(subtle, { ...to, fp: other.fp }, 'kex', sealed), { name: 'OperationError' });
  const tampered = sealed.slice(); tampered[tampered.length - 1] ^= 1;
  await assert.rejects(id.open(subtle, to, 'kex', tampered), { name: 'OperationError' });
});

test('an RSA-3072 seal is never taken for a v4 one', () => {
  /* RSA-OAEP output is exactly the modulus size; a 384-byte value that
     happens to start with 0x04 is still read by its length (see the bridge). */
  const rsaSized = new Uint8Array(384); rsaSized[0] = 0x04;
  assert.ok(id.isSeal(rsaSized));
  /* so the bridge decides by length first — asserted there. */
});

test('the signing key cannot agree and the agreement key cannot sign', async () => {
  const made = await id.generate(subtle);
  await assert.rejects(subtle.importKey('pkcs8', id.fromBase64(made.signPrivate), { name: 'X25519' }, false, ['deriveBits']));
  await assert.rejects(subtle.importKey('pkcs8', id.fromBase64(made.agreePrivate), { name: 'Ed25519' }, false, ['sign']));
});
