/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text.
 */

/* js/crypto/ratchet.js on its own.   node --test tests/unit/ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import * as r from '../../js/crypto/ratchet.js';

const subtle = webcrypto.subtle;
const random = (n) => webcrypto.getRandomValues(new Uint8Array(n));
const bytes = (t) => new TextEncoder().encode(t);
const text = (b) => new TextDecoder().decode(b);
const names = { from: 'fpA', to: 'fpB', kind: 'text' };

async function pair(seed = random(32)) {
  const A = await r.deriveChains(subtle, seed, { kid: 'k1', role: 'offerer' });
  const B = await r.deriveChains(subtle, seed, { kid: 'k1', role: 'answerer' });
  return { A, B };
}
async function send(state, plain) {
  const { mk, n, c } = await r.nextSendKey(subtle, state.send);
  const out = await r.encryptWith(subtle, mk, bytes(plain), r.messageAad({ c, n, ...names }), random);
  return { ...out, n, c, mk: r.toBase64(mk) };
}
async function receive(state, msg) {
  const mk = await r.recvKey(subtle, state.recv, msg.n);
  return text(await r.decryptWith(subtle, mk, msg.iv, msg.cipher, r.messageAad({ c: msg.c, n: msg.n, ...names })));
}

test('the two sides agree, and each direction is its own chain', async () => {
  const { A, B } = await pair();
  assert.equal(A.send.id, B.recv.id);
  assert.equal(A.recv.id, B.send.id);
  assert.notEqual(A.send.id, A.recv.id);
  assert.equal(A.send.ck, B.recv.ck);
  assert.notEqual(A.send.ck, A.recv.ck);
});

test('another handshake is other chains', async () => {
  const seed = random(32);
  const one = await r.deriveChains(subtle, seed, { kid: 'k1', role: 'offerer' });
  const two = await r.deriveChains(subtle, seed, { kid: 'k2', role: 'offerer' });
  assert.notEqual(one.send.id, two.send.id);
});

test('every message has a key of its own', async () => {
  const { A, B } = await pair();
  const m1 = await send(A, 'one');
  const m2 = await send(A, 'two');
  assert.notEqual(m1.mk, m2.mk);
  assert.equal(await receive(B, m1), 'one');
  assert.equal(await receive(B, m2), 'two');
});

test('a chain key taken later opens nothing that was sent before it', async () => {
  const { A, B } = await pair();
  const early = await send(A, 'secret');
  await receive(B, early);
  /* Everything BARAN holds after reading it. */
  const stolen = JSON.parse(JSON.stringify(B.recv));
  await assert.rejects(r.recvKey(subtle, stolen, early.n), { name: 'ChainError', reason: 'replay' });
  /* And the next key derived from what was stolen is not the old one. */
  const next = await r.recvKey(subtle, stolen, early.n + 1);
  assert.notEqual(r.toBase64(next), early.mk);
});

test('out of order: an early message waits, the late one still opens, once', async () => {
  const { A, B } = await pair();
  const m0 = await send(A, 'zero');
  const m1 = await send(A, 'one');
  const m2 = await send(A, 'two');
  assert.equal(await receive(B, m2), 'two');
  assert.equal(Object.keys(B.recv.skipped).length, 2);
  assert.equal(await receive(B, m0), 'zero');
  assert.equal(await receive(B, m1), 'one');
  assert.equal(Object.keys(B.recv.skipped).length, 0);
  await assert.rejects(receive(B, m1), { reason: 'replay' });
});

test('a kept key expires and the cap holds', async () => {
  const { A, B } = await pair();
  for (let i = 0; i < 3; i += 1) await send(A, String(i));
  const last = await send(A, 'last');
  await r.recvKey(subtle, B.recv, last.n, 1000);
  assert.equal(Object.keys(B.recv.skipped).length, 3);
  r.pruneSkipped(B.recv, 1000 + r.SKIPPED_TTL_MS + 1);
  assert.equal(Object.keys(B.recv.skipped).length, 0);
  const many = { ...(await pair()).B.recv };
  await r.recvKey(subtle, many, r.MAX_SKIP_PER_MESSAGE);
  await r.recvKey(subtle, many, r.MAX_SKIP_PER_MESSAGE * 2);
  assert.ok(Object.keys(many.skipped).length <= r.MAX_SKIPPED);
});

test('a number implausibly far ahead is refused, not computed', async () => {
  const { B } = await pair();
  await assert.rejects(r.recvKey(subtle, B.recv, r.MAX_SKIP_PER_MESSAGE + 5), { reason: 'too-far' });
  assert.equal(B.recv.n, 0);
});

test('the binding still holds under a message key', async () => {
  const { A, B } = await pair();
  const m = await send(A, 'hi');
  const mk = await r.recvKey(subtle, B.recv, m.n);
  await assert.rejects(r.decryptWith(subtle, mk, m.iv, m.cipher, r.messageAad({ c: m.c, n: m.n, ...names, kind: 'edit' })), { name: 'OperationError' });
});

test('state survives JSON (what is stored)', async () => {
  const { A, B } = await pair();
  const m = await send(A, 'later');
  const reloaded = JSON.parse(JSON.stringify(B));
  assert.equal(await receive(reloaded, m), 'later');
});

/* ---- version 2: the DH step and the post-quantum step ---------------------- */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.window = globalThis;
require('../../vendor/mlkem/mlkem.bundle.min.js');
const kem = globalThis.PoorijaMlKem;

async function pairV2(now = 1_000_000) {
  const seed = random(32);
  const oMine = await r.ratchetOffer(subtle, kem);
  const aMine = await r.ratchetOffer(subtle, kem);
  const O = await r.startV2(subtle, seed, { kid: 'k1', role: 'offerer', mine: oMine, theirs: aMine.wire, kem, now });
  const A = await r.startV2(subtle, seed, { kid: 'k1', role: 'answerer', mine: aMine, theirs: oMine.wire, kem, now });
  return { O, A };
}
async function sendV2(state, plain) {
  const { mk, header } = await r.sendV2(subtle, state);
  const out = await r.encryptWith(subtle, mk, bytes(plain), r.messageAad({ c: header.c, n: header.n, ...names }), random);
  return { ...out, header };
}
async function recvV2(holder, key, msg, now = 1_000_000) {
  const { mk, state } = await r.recvV2(subtle, holder[key], msg.header, kem, now);
  const plain = text(await r.decryptWith(subtle, mk, msg.iv, msg.cipher, r.messageAad({ c: msg.header.c, n: msg.header.n, ...names })));
  holder[key] = state;
  return plain;
}

test('v2: either side may speak first, and they agree', async () => {
  const s = await pairV2();
  assert.equal(await recvV2(s, 'A', await sendV2(s.O, 'from the offerer')), 'from the offerer');
  const t = await pairV2();
  assert.equal(await recvV2(t, 'O', await sendV2(t.A, 'from the answerer')), 'from the answerer');
});

test('v2: a stolen state stops working once the robbed side has made a key the thief never saw', async () => {
  const s = await pairV2();
  await recvV2(s, 'A', await sendV2(s.O, 'one'));
  /* Everything the answerer holds, stolen now — and the thief, from here on,
     sees every frame and applies each to its copy. */
  const thief = { A: JSON.parse(JSON.stringify(s.A)) };
  const follow = async (msg) => { try { return await recvV2(thief, 'A', msg); } catch (error) { return error; } };
  /* Right after the theft the thief reads along: same private keys. */
  const two = await sendV2(s.O, 'two');
  assert.equal(await follow(two), 'two');
  await recvV2(s, 'A', two);
  /* A round trip: the answerer replies on its current key, the offerer steps. */
  await recvV2(s, 'O', await sendV2(s.A, 'reply'));
  const three = await sendV2(s.O, 'three');
  /* Still readable: the offerer's new chain is a DH with the answerer's key,
     which the thief stole. */
  assert.equal(await follow(three), 'three');
  /* Receiving it, the answerer made a NEW key pair — the thief's copy made a
     different one of its own. Its next reply carries the new public half. */
  await recvV2(s, 'A', three);
  await recvV2(s, 'O', await sendV2(s.A, 'reply-2'));
  const healed = await sendV2(s.O, 'after healing');
  assert.equal(await recvV2(s, 'A', healed), 'after healing');
  const verdict = await follow(healed);
  assert.ok(verdict instanceof Error, `the thief read: ${verdict}`);
});

test('v2: messages in flight across a step still open, once', async () => {
  const s = await pairV2();
  const m1 = await sendV2(s.O, 'early');
  const m2 = await sendV2(s.O, 'early-2');
  await recvV2(s, 'A', m2);
  await recvV2(s, 'O', await sendV2(s.A, 'reply'));
  const m3 = await sendV2(s.O, 'new chain');
  assert.equal(await recvV2(s, 'A', m3), 'new chain');
  assert.equal(await recvV2(s, 'A', m1), 'early');
  await assert.rejects(r.recvV2(subtle, s.A, m1.header, kem), { reason: 'replay' });
});

test('v2: a forged header does not move the ratchet', async () => {
  const s = await pairV2();
  const real = await sendV2(s.O, 'real');
  const before = JSON.stringify(s.A);
  const fake = { ...real.header, c: 'f'.repeat(32), d: (await r.ratchetOffer(subtle, kem)).wire.rp };
  await assert.rejects(r.recvV2(subtle, s.A, fake, kem), { name: 'ChainError' });
  assert.equal(JSON.stringify(s.A), before);
  assert.equal(await recvV2(s, 'A', real), 'real');
});

test('v2: the post-quantum step comes on schedule and both sides follow it', async () => {
  const s = await pairV2(0);
  let sawQ = false;
  let sawK = false;
  for (let round = 0; round < 4; round += 1) {
    for (let i = 0; i < r.PQ_EVERY_MESSAGES / 2 + 1; i += 1) await recvV2(s, 'A', await sendV2(s.O, `o${round}-${i}`), 0);
    const reply = await sendV2(s.A, `a${round}`);
    sawQ = sawQ || Boolean(reply.header.q);
    sawK = sawK || Boolean(reply.header.k);
    await recvV2(s, 'O', reply, 0);
    const back = await sendV2(s.O, `o${round}-back`);
    sawQ = sawQ || Boolean(back.header.q);
    sawK = sawK || Boolean(back.header.k);
    assert.equal(await recvV2(s, 'A', back, 0), `o${round}-back`);
  }
  assert.ok(sawQ, 'an ML-KEM ciphertext was carried');
  assert.ok(sawK, 'and a fresh ML-KEM key announced after it');
  /* And by the clock alone. */
  const t = await pairV2(0);
  await recvV2(t, 'A', await sendV2(t.O, 'x'), 0);
  const late = await sendV2(t.A, 'a day later');
  await recvV2(t, 'O', late, r.PQ_EVERY_MS + 1);
  const pq = await sendV2(t.O, 'pq');
  assert.ok(pq.header.q, 'a day later the step is post-quantum');
  assert.equal(await recvV2(t, 'A', pq, r.PQ_EVERY_MS + 2), 'pq');
});

test('v2: a swapped ratchet key in the handshake makes the chains disagree', async () => {
  const seed = random(32);
  const oMine = await r.ratchetOffer(subtle, kem);
  const aMine = await r.ratchetOffer(subtle, kem);
  const mallory = await r.ratchetOffer(subtle, kem);
  const O = await r.startV2(subtle, seed, { kid: 'k', role: 'offerer', mine: oMine, theirs: mallory.wire, kem });
  const A = await r.startV2(subtle, seed, { kid: 'k', role: 'answerer', mine: aMine, theirs: oMine.wire, kem });
  const msg = await sendV2(O, 'hi');
  await assert.rejects(r.recvV2(subtle, A, msg.header, kem));
});
