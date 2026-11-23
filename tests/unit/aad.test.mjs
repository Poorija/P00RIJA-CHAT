/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text.
 */

/* js/crypto/aad.js on its own, in Node, against the real WebCrypto.
 *   node --test tests/unit/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import * as aad from '../../js/crypto/aad.js';

const subtle = webcrypto.subtle;
const random = (n) => webcrypto.getRandomValues(new Uint8Array(n));
const ctx = (over = {}) => ({ sid: 's1', from: 'fpA', to: 'fpB', kind: 'text', ...over });

async function freshKey() {
  const raw = random(32);
  const key = await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return { raw, key };
}
const bytes = (text) => new TextEncoder().encode(text);
const text = (buf) => new TextDecoder().decode(buf);

test('the additional data is unambiguous', () => {
  /* Fields that run into each other would make two tuples one. */
  const a = aad.buildAad({ sid: 'ab', from: 'c', to: 'd', kind: 'text', seq: 1 });
  const b = aad.buildAad({ sid: 'a', from: 'bc', to: 'd', kind: 'text', seq: 1 });
  assert.notDeepEqual(a, b);
});

test('every field is required', () => {
  for (const name of ['sid', 'from', 'to', 'kind']) {
    assert.throws(() => aad.buildAad({ ...ctx(), seq: 1, [name]: '' }), TypeError, name);
  }
  assert.throws(() => aad.buildAad({ ...ctx(), seq: 0 }), RangeError);
  assert.throws(() => aad.buildAad({ ...ctx(), seq: 1.5 }), RangeError);
});

test('the session id follows the key and nothing else', async () => {
  const one = random(32);
  const two = random(32);
  assert.equal(await aad.sessionId(subtle, one), await aad.sessionId(subtle, one.slice()));
  assert.notEqual(await aad.sessionId(subtle, one), await aad.sessionId(subtle, two));
  assert.equal((await aad.sessionId(subtle, one)).length, 32);
});

test('sequence numbers rise, and start at the clock', () => {
  const state = {};
  const a = aad.nextSeq(state, 1000);
  const b = aad.nextSeq(state, 1000);
  const c = aad.nextSeq(state, 999); /* clock went back */
  assert.ok(a >= 1000 * 1024);
  assert.ok(b > a && c > b);
  /* A sender that forgot its counter still goes past what it sent before. */
  const forgot = {};
  assert.ok(aad.nextSeq(forgot, 2000) > c);
});

test('a sealed payload opens with the same binding', async () => {
  const { raw, key } = await freshKey();
  const sid = await aad.sessionId(subtle, raw);
  const sent = await aad.seal(subtle, key, bytes('hello'), { ...ctx({ sid }), state: {}, random });
  assert.equal(sent.a, 1);
  const plain = await aad.open(subtle, key, sent, sent.cipher, { ...ctx({ sid }), state: {} });
  assert.equal(text(plain), 'hello');
});

test('it does not open under any other binding', async () => {
  const { key } = await freshKey();
  const sent = await aad.seal(subtle, key, bytes('x'), { ...ctx(), state: {}, random });
  for (const change of [{ sid: 's2' }, { from: 'fpB', to: 'fpA' }, { from: 'fpC' }, { to: 'fpC' }, { kind: 'edit' }]) {
    await assert.rejects(aad.open(subtle, key, sent, sent.cipher, { ...ctx(change), state: {} }), { name: 'OperationError' }, JSON.stringify(change));
  }
  await assert.rejects(aad.open(subtle, key, { ...sent, seq: sent.seq + 1 }, sent.cipher, { ...ctx(), state: {} }), { name: 'OperationError' });
  await assert.rejects(aad.open(subtle, key, { ...sent, seq: undefined }, sent.cipher, { ...ctx(), state: {} }), { name: 'OperationError' });
});

test('a copy is refused, an out-of-order original is not', async () => {
  const { key } = await freshKey();
  const tx = {};
  const rx = {};
  const one = await aad.seal(subtle, key, bytes('1'), { ...ctx(), state: tx, random });
  const two = await aad.seal(subtle, key, bytes('2'), { ...ctx(), state: tx, random });
  assert.equal(text(await aad.open(subtle, key, two, two.cipher, { ...ctx(), state: rx })), '2');
  /* The relay's copy of an earlier message, arriving after a live one. */
  assert.equal(text(await aad.open(subtle, key, one, one.cipher, { ...ctx(), state: rx })), '1');
  await assert.rejects(aad.open(subtle, key, one, one.cipher, { ...ctx(), state: rx }), { name: 'ReplayError', kind: 'replay' });
  await assert.rejects(aad.open(subtle, key, two, two.cipher, { ...ctx(), state: rx }), { name: 'ReplayError' });
});

test('a forged frame cannot spend a number', async () => {
  const { key } = await freshKey();
  const { key: other } = await freshKey();
  const rx = {};
  const real = await aad.seal(subtle, key, bytes('real'), { ...ctx(), state: {}, random });
  /* Built by hand at exactly the real number: nextSeq would move to the
     clock if a millisecond passed between the two. */
  const iv = random(12);
  const forged = {
    iv: Array.from(iv), seq: real.seq, a: 1,
    cipher: await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad.buildAad({ ...ctx(), seq: real.seq }) }, other, bytes('forged')),
  };
  await assert.rejects(aad.open(subtle, key, forged, forged.cipher, { ...ctx(), state: rx }), { name: 'OperationError' });
  assert.equal(text(await aad.open(subtle, key, real, real.cipher, { ...ctx(), state: rx })), 'real');
});

test('the window is bounded, and what fell out of it is refused', () => {
  const state = {};
  for (let i = 1; i <= aad.REPLAY_WINDOW + 10; i += 1) aad.remember(state, i * 10);
  assert.equal(state.seen.length, aad.REPLAY_WINDOW);
  assert.equal(aad.classify(state, 10), 'stale');
  assert.equal(aad.classify(state, state.seen[0]), 'replay');
  assert.equal(aad.classify(state, state.seen[0] + 1), 'new');
  assert.equal(aad.classify(state, (aad.REPLAY_WINDOW + 11) * 10), 'new');
});

test('a chunk is bound to its transfer and its index', () => {
  const base = { sid: 's', from: 'a', to: 'b' };
  const a = aad.chunkAad({ ...base, transferId: 't1', index: 0 });
  assert.deepEqual(a, aad.chunkAad({ ...base, transferId: 't1', index: 0 }));
  assert.notDeepEqual(a, aad.chunkAad({ ...base, transferId: 't1', index: 1 }));
  assert.notDeepEqual(a, aad.chunkAad({ ...base, transferId: 't2', index: 0 }));
  assert.throws(() => aad.chunkAad({ ...base, transferId: 't1', index: -1 }), RangeError);
});
