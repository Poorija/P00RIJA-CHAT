/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Key separation (roadmap 5.1, review task 5.1 "key-separation").
 *
 * Until identity v4 one RSA key both decrypted (OAEP) and signed (PKCS#1
 * v1.5). Now an account has two keys that do one thing each: sk (Ed25519)
 * signs, ak (X25519) opens what is sealed to the account. These are the
 * attacks a single key made possible, made against the two, and each must
 * fail:
 *   - the signing key opens a seal;
 *   - the agreement key makes a signature that verifies;
 *   - one key's bytes are taken for the other's (raw or PKCS#8);
 *   - a signature made for one purpose is passed off as another (labels);
 *   - a seal made for one purpose, or one account, is opened as another.
 * And the positive case, so the test cannot pass by everything failing. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import * as id from '../../js/crypto/identity.js';

const subtle = webcrypto.subtle;
const random = (n) => webcrypto.getRandomValues(new Uint8Array(n));
const text = (s) => new TextEncoder().encode(s);
const rejects = async (fn) => { try { await fn(); return false; } catch (_error) { return true; } };

const alice = await id.generate(subtle);
const bob = await id.generate(subtle);

test('the two keys are different keys', () => {
  assert.notEqual(alice.sk, alice.ak);
  assert.notEqual(alice.signPrivate, alice.agreePrivate);
});

test('the positive case: ak opens what is sealed to it, sk signs what verifies', async () => {
  const sealed = await id.seal(subtle, alice, 'test/1', text('hello'), random);
  const opened = await id.open(subtle, alice, 'test/1', sealed);
  assert.equal(new TextDecoder().decode(opened), 'hello');
  const signature = await id.sign(subtle, alice.signPrivate, text('m'));
  assert.equal(await id.verify(subtle, alice.sk, signature, text('m')), true);
  assert.equal(await id.verifyAgreeKey(subtle, alice), true);
});

test('the signing key cannot open a seal', async () => {
  const sealed = await id.seal(subtle, alice, 'test/1', text('secret'), random);
  /* Handed to open() as if it were the agreement key. */
  assert.equal(await rejects(() => id.open(subtle, { ...alice, agreePrivate: alice.signPrivate }, 'test/1', sealed)), true);
  /* And as X25519 by hand: an Ed25519 PKCS#8 is not an X25519 key. */
  assert.equal(await rejects(() => subtle.importKey('pkcs8', id.fromBase64(alice.signPrivate), { name: 'X25519' }, false, ['deriveBits'])), true);
});

test('the agreement key cannot make a signature that verifies', async () => {
  /* Its PKCS#8 is not an Ed25519 key... */
  assert.equal(await rejects(() => id.sign(subtle, alice.agreePrivate, text('m'))), true);
  /* ...and its public bytes, taken for a signing key, verify nothing real. */
  const real = await id.sign(subtle, alice.signPrivate, text('m'));
  assert.equal(await id.verify(subtle, alice.ak, real, text('m')), false);
});

test('one key\'s public bytes in the other\'s place is refused', async () => {
  /* ak offered as sk: the fingerprint is the signing key's, so it no longer names the account. */
  assert.equal(await id.verifyAgreeKey(subtle, { ...alice, sk: alice.ak }), false);
  /* Bob's agreement key under Alice's signature: the signature covers fp and ak together. */
  assert.equal(await id.verifyAgreeKey(subtle, { ...alice, ak: bob.ak }), false);
  /* Alice's statement presented for Bob. */
  assert.equal(await id.verifyAgreeKey(subtle, { ...bob, akSig: alice.akSig }), false);
});

test('a signature made for one purpose is not accepted for another', async () => {
  /* Every signed text is framed with its own label, so the statement that
     binds the agreement key is not anything else, and nothing else is it. */
  const other = id.framed([id.ID_LABEL, alice.fp, alice.ak]);
  const forOther = await id.sign(subtle, alice.signPrivate, other);
  assert.equal(await id.verify(subtle, alice.sk, forOther, id.agreeKeyText(alice.fp, alice.ak)), false);
  assert.equal(await id.verify(subtle, alice.sk, id.fromBase64(alice.akSig), other), false);
});

test('a seal is for one purpose and one account', async () => {
  const sealed = await id.seal(subtle, alice, 'envelope/1', text('x'), random);
  assert.equal(await rejects(() => id.open(subtle, alice, 'profile/1', sealed)), true);
  /* Re-addressed: the same bytes presented as sealed to Bob. */
  assert.equal(await rejects(() => id.open(subtle, bob, 'envelope/1', sealed)), true);
  /* Alice's fingerprint swapped for Bob's in the binding. */
  assert.equal(await rejects(() => id.open(subtle, { ...alice, fp: bob.fp }, 'envelope/1', sealed)), true);
  /* And one bit flipped anywhere. */
  const flipped = sealed.slice(); flipped[flipped.length - 1] ^= 1;
  assert.equal(await rejects(() => id.open(subtle, alice, 'envelope/1', flipped)), true);
});
