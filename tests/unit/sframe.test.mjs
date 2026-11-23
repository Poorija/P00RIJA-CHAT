/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text.
 */

/* js/crypto/sframe.js against RFC 9605's own test vectors.   node --test tests/unit/ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import * as sf from '../../js/crypto/sframe.js';

const subtle = webcrypto.subtle;
const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (h) => new Uint8Array(Buffer.from(h, 'hex'));

/* RFC 9605 Appendix C.1. */
const HEADERS = [
  [0x0, 0x0, '00'], [0x0, 0x1, '01'], [0x0, 0xff, '08ff'], [0x0, 0x100, '090100'],
  [0x1, 0x1, '11'], [0xff, 0x0, '80ff'], [0xff, 0xff, '88ffff'], [0xff, 0x100, '89ff0100'],
  [0x100, 0x0, '900100'], [0x100, 0xff, '980100ff'], [0xffff, 0x100, '99ffff0100'],
  [0x10000, 0x0, 'a0010000'], [0xffffffff, 0x1, 'b1ffffffff'], [0x100000000, 0xff, 'c80100000000ff'],
  [0x1000000000000, 0x100, 'e9010000000000000100'],
];

test('the header encodes and decodes as in RFC 9605 C.1', () => {
  for (const [kid, ctr, want] of HEADERS) {
    assert.equal(hex(sf.encodeHeader(kid, ctr)), want, `kid ${kid} ctr ${ctr}`);
    const back = sf.decodeHeader(unhex(want));
    assert.deepEqual([back.kid, back.ctr, back.length], [kid, ctr, want.length / 2]);
  }
});

/* RFC 9605 test vectors, sframe section, cipher suite 0x0004. */
const V = {
  kid: 291, ctr: 17767,
  base_key: '000102030405060708090a0b0c0d0e0f',
  sframe_secret: 'd926952ca8b7ec4a95941d1ada3a5203ceff8cceee34f574d23909eb314c40c0',
  sframe_key: 'd34f547f4ca4f9a7447006fe7fcbf768',
  sframe_salt: '75234edefe07819026751816',
  metadata: '4945544620534672616d65205747',
  pt: '64726166742d696574662d736672616d652d656e63',
  ct: '9901234567b7412c2513a1b66dbb48841bbaf17f598751176ad847681a69c6d0b091c07018ce4adb34eb',
};

test('the keys, and the whole frame, are exactly the RFC\'s for AES_128_GCM_SHA256_128', async () => {
  const keys = await sf.deriveKeys(subtle, unhex(V.base_key), V.kid);
  assert.equal(hex(keys.secret), V.sframe_secret);
  assert.equal(hex(keys.keyBytes), V.sframe_key);
  assert.equal(hex(keys.salt), V.sframe_salt);
  const ct = await sf.encryptFrame(subtle, keys, V.ctr, unhex(V.pt), unhex(V.metadata));
  assert.equal(hex(ct), V.ct);
  const back = await sf.decryptFrame(subtle, async (kid) => (kid === V.kid ? keys : null), ct, unhex(V.metadata));
  assert.equal(hex(back.frame), V.pt);
  assert.deepEqual([back.kid, back.ctr], [V.kid, V.ctr]);
});

test('a changed byte, a wrong KID or other metadata is refused', async () => {
  const keys = await sf.deriveKeys(subtle, unhex(V.base_key), V.kid);
  const ct = unhex(V.ct);
  const flipped = ct.slice(); flipped[flipped.length - 1] ^= 1;
  await assert.rejects(sf.decryptFrame(subtle, async () => keys, flipped, unhex(V.metadata)), { reason: 'auth' });
  await assert.rejects(sf.decryptFrame(subtle, async () => keys, ct, new Uint8Array(0)), { reason: 'auth' });
  await assert.rejects(sf.decryptFrame(subtle, async () => null, ct, unhex(V.metadata)), { reason: 'unknown-kid' });
});

test('the replay window takes each counter once', () => {
  const w = sf.createReplayWindow(16);
  assert.ok(w.accept(1, 5));
  assert.ok(!w.accept(1, 5));
  assert.ok(w.accept(1, 3));
  assert.ok(w.accept(1, 40));
  assert.ok(!w.accept(1, 10), 'too far behind');
  assert.ok(w.accept(2, 5), 'another sender is another window');
});

test('asking whether a counter is fresh moves nothing (the window moves only for a frame that opened)', () => {
  const w = sf.createReplayWindow(16);
  assert.ok(w.accept(1, 5));
  /* A forged frame claims counter 2^40: fresh, but never accepted (it fails to open). */
  assert.ok(w.fresh(1, 2 ** 40));
  /* So the genuine frames after it are still taken. */
  assert.ok(w.fresh(1, 6));
  assert.ok(w.accept(1, 6));
  assert.ok(!w.fresh(1, 6), 'a counter seen is not fresh');
  assert.ok(!w.fresh(1, 6 - 17), 'nor one too far behind');
});
