/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* A key per message (docs/design/1.3-ratchet.md, release 2.8).
 *
 * A live session used to have one AES key for everything, kept for up to
 * seven days. Now the handshake's key is only a seed: it is turned into two
 * chains, one per direction, and then forgotten.
 *
 *     seed            = the handshake's 32-byte output
 *     CK_0 (dir)      = HKDF(seed, info "poorija-ratchet/1" ‖ dir ‖ kid)
 *     chain id (dir)  = SHA-256("poorija-chain-id/1" ‖ CK_0)[0..16] hex
 *     MK_n            = HMAC-SHA-256(CK_n, 0x01)    a message's key, used once
 *     CK_n+1          = HMAC-SHA-256(CK_n, 0x02)    CK_n is then dropped
 *
 * `dir` is 'o' for the side that offered the handshake to the side that
 * answered, 'a' the other way. A message is AES-256-GCM under MK_n with the
 * 1.1 binding as additional data (sid = the chain id, seq = n + 1), and
 * carries { r: 1, c: chain id, n }.
 *
 * Whoever later steals a chain key holds the keys of messages not yet sent,
 * never of those before it. Keys skipped by a message that arrived early are
 * kept (at most MAX_SKIPPED, for SKIPPED_TTL_MS) and dropped once used.
 *
 * Pure: `subtle` is passed in, state is plain JSON with base64 strings, the
 * caller stores it. Tested in Node (tests/unit/ratchet.test.mjs).
 */

import * as aad from './aad.js';

export const RATCHET_LABEL = 'poorija-ratchet/1';
export const CHAIN_ID_LABEL = 'poorija-chain-id/1';
export const MAX_SKIPPED = 1000;
export const SKIPPED_TTL_MS = 48 * 60 * 60 * 1000;
/* How far ahead of the chain one message may claim to be. More than this is
   not a lost message, it is a frame meant to make the receiver burn time. */
export const MAX_SKIP_PER_MESSAGE = 1000;

const encoder = new TextEncoder();
const MK_BYTE = new Uint8Array([0x01]);
const CK_BYTE = new Uint8Array([0x02]);

export function toBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary);
}
export function fromBase64(text) {
  const binary = atob(String(text || ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
const hex = (buffer) => Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');

export class ChainError extends Error {
  constructor(reason, detail = '') {
    super(`ratchet: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'ChainError';
    this.reason = reason;
  }
}

async function hmac(subtle, keyBytes, data) {
  const key = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', key, data));
}

/* The two chains a handshake yields. `role` is this side's: 'offerer' or
   'answerer'. The sending chain of one side is the receiving chain of the
   other. */
export async function deriveChains(subtle, seed, { kid, role }) {
  if (!kid) throw new TypeError('ratchet: kid is required');
  if (role !== 'offerer' && role !== 'answerer') throw new TypeError('ratchet: role must be offerer or answerer');
  const material = await subtle.importKey('raw', seed instanceof Uint8Array ? seed : new Uint8Array(seed), 'HKDF', false, ['deriveBits']);
  const chainFor = async (dir) => {
    const ck = new Uint8Array(await subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: encoder.encode(`${RATCHET_LABEL}|${dir}|${kid}`) },
      material, 256));
    const id = hex(await subtle.digest('SHA-256', new Uint8Array([...encoder.encode(CHAIN_ID_LABEL), ...ck]))).slice(0, 32);
    return { id, ck: toBase64(ck), n: 0 };
  };
  const o = await chainFor('o');
  const a = await chainFor('a');
  return role === 'offerer'
    ? { send: o, recv: { ...a, skipped: {} } }
    : { send: a, recv: { ...o, skipped: {} } };
}

async function stepChain(subtle, ckBase64) {
  const ck = fromBase64(ckBase64);
  const mk = await hmac(subtle, ck, MK_BYTE);
  const next = await hmac(subtle, ck, CK_BYTE);
  ck.fill(0);
  return { mk, next: toBase64(next) };
}

/* The next sending key. Mutates `state` (ck moves on, n counts up); the
   caller stores it before the message leaves. */
export async function nextSendKey(subtle, state) {
  if (!state?.ck) throw new ChainError('no-chain');
  const n = state.n;
  const { mk, next } = await stepChain(subtle, state.ck);
  state.ck = next;
  state.n = n + 1;
  return { mk, n, c: state.id };
}

/* The key of message `n` on a receiving chain. Mutates `state`: the chain
   moves past n, keys for the numbers it skipped are kept, and a key that is
   handed out is removed. Throws ChainError('replay') for a number already
   used, ChainError('too-far') for one implausibly far ahead. */
export async function recvKey(subtle, state, n, now = Date.now()) {
  if (!Number.isSafeInteger(n) || n < 0) throw new ChainError('bad-index', String(n));
  pruneSkipped(state, now);
  const skipped = state.skipped || (state.skipped = {});
  if (n < state.n) {
    const held = skipped[n];
    if (!held) throw new ChainError('replay', String(n));
    delete skipped[n];
    return fromBase64(held.k);
  }
  if (n - state.n > MAX_SKIP_PER_MESSAGE) throw new ChainError('too-far', `${n} > ${state.n} + ${MAX_SKIP_PER_MESSAGE}`);
  let ck = state.ck;
  for (let i = state.n; i < n; i += 1) {
    const { mk, next } = await stepChain(subtle, ck);
    skipped[i] = { k: toBase64(mk), at: now };
    mk.fill(0);
    ck = next;
  }
  const { mk, next } = await stepChain(subtle, ck);
  state.ck = next;
  state.n = n + 1;
  capSkipped(state);
  return mk;
}

/* Marks message `n` as used without deriving it — for a message whose key
   came inside its own envelope, so the chain does not keep a key for it. */
export async function consume(subtle, state, n, now = Date.now()) {
  try { const mk = await recvKey(subtle, state, n, now); mk.fill(0); return true; } catch (_error) { return false; }
}

export function pruneSkipped(state, now = Date.now()) {
  const skipped = state?.skipped;
  if (!skipped) return;
  for (const [n, held] of Object.entries(skipped)) {
    if (!held || now - Number(held.at || 0) > SKIPPED_TTL_MS) delete skipped[n];
  }
}
function capSkipped(state) {
  const entries = Object.keys(state.skipped || {}).map(Number).sort((x, y) => x - y);
  for (const n of entries.slice(0, Math.max(0, entries.length - MAX_SKIPPED))) delete state.skipped[n];
}

/* The additional data of message n on chain c: the 1.1 binding with the chain
   id for the session id. */
export function messageAad({ c, n, from, to, kind }) {
  return aad.buildAad({ sid: c, from, to, kind, seq: n + 1 });
}
export function chunkAad({ c, from, to, transferId, index }) {
  return aad.chunkAad({ sid: c, from, to, transferId, index });
}

export async function encryptWith(subtle, mkBytes, plain, additionalData, random) {
  const key = await subtle.importKey('raw', mkBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = random(12);
  const cipher = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key, plain);
  return { iv: Array.from(iv), cipher: new Uint8Array(cipher) };
}
export async function decryptWith(subtle, mkBytes, iv, cipher, additionalData) {
  const key = await subtle.importKey('raw', mkBytes, { name: 'AES-GCM' }, false, ['decrypt']);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv), additionalData }, key, cipher));
}

/* ===========================================================================
   The session heals (release 2.9): a Diffie-Hellman step on every round trip,
   and a post-quantum step every so often.
   ===========================================================================

   The chains above end with a stolen chain key: whoever has it has every
   message still to come on that chain. Version 2 is the Double Ratchet: each
   side keeps an X25519 ratchet key pair, every message carries the sender's
   current public half (`d`), and a side that sees a new one from the other
   does two steps on a shared root key RK:

       RK, CK_recv = KDF_RK(RK, X25519(my_priv, their_new))
       new pair;  RK, CK_send = KDF_RK(RK, X25519(my_new_priv, their_new))

   with KDF_RK(rk, x) = HKDF-SHA-256(ikm x, salt rk, info "poorija-rk/2") →
   64 bytes, the first 32 the next RK and the last 32 the chain key. Whoever
   stole everything at one moment loses it at the next round trip: the new
   secret uses a private key that did not exist when they took it.

   Every PQ_EVERY_MESSAGES messages or PQ_EVERY_MS, whichever comes first,
   the side making a sending step also encapsulates to the other's ML-KEM-768
   ratchet key and mixes that secret in: KDF_RK(RK, dh ‖ ss). The chain made
   that way carries the ciphertext (`q`) on its messages; the side that opens
   it makes a new ML-KEM key and announces it (`k`) on its next chain. A
   recording kept for a quantum computer then has to break ML-KEM again at
   each of those points, not only at the handshake (iMessage PQ3's schedule).

   The handshake gives each side the other's first ratchet key and ML-KEM
   key, and both go into the first root key, so a swapped one only makes the
   chains disagree (a failure that is noticed), never a key somebody else
   holds. The offerer starts its sending chain at once; the answerer derives
   that chain as its receiving one and starts its own, so either may speak
   first.

   The KEM is passed in ({ keygen, encapsulate, decapsulate }, the shape of
   PoorijaMlKem), so this file stays free of globals and runs in Node. */

export const RK_LABEL = 'poorija-rk/2';
export const ROOT_LABEL = 'poorija-root/2';
export const PQ_EVERY_MESSAGES = 50;
export const PQ_EVERY_MS = 24 * 60 * 60 * 1000;
/* Receiving chains kept besides the current one, for messages that were in
   flight when the other side stepped. */
export const OLD_CHAINS = 4;

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
async function chainIdOf(subtle, ck) {
  return hex(await subtle.digest('SHA-256', concat(encoder.encode(CHAIN_ID_LABEL), ck))).slice(0, 32);
}
async function kdfRk(subtle, rk, input) {
  const material = await subtle.importKey('raw', input, 'HKDF', false, ['deriveBits']);
  const out = new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: rk, info: encoder.encode(RK_LABEL) }, material, 512));
  return { rk: out.slice(0, 32), ck: out.slice(32) };
}
async function newDhPair(subtle) {
  const pair = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  return {
    pub: toBase64(await subtle.exportKey('raw', pair.publicKey)),
    priv: toBase64(await subtle.exportKey('pkcs8', pair.privateKey)),
  };
}
async function dh(subtle, privBase64, pubBase64) {
  const mine = await subtle.importKey('pkcs8', fromBase64(privBase64), { name: 'X25519' }, false, ['deriveBits']);
  const theirs = await subtle.importKey('raw', fromBase64(pubBase64), { name: 'X25519' }, false, []);
  return new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: theirs }, mine, 256));
}
function newKem(kem) {
  const pair = kem.keygen();
  return { pub: toBase64(pair.publicKey), priv: toBase64(pair.secretKey) };
}

/* The pieces a side brings to the handshake: a first ratchet key pair and a
   first ML-KEM key pair. Only the public halves travel. */
export async function ratchetOffer(subtle, kem) {
  const dhPair = await newDhPair(subtle);
  const kemPair = newKem(kem);
  return { dh: dhPair, kem: kemPair, wire: { rp: dhPair.pub, rq: kemPair.pub } };
}

/* Version 2 state from the handshake. `mine` is what this side offered
   (ratchetOffer), `theirs` the other side's { rp, rq }. */
export async function startV2(subtle, seed, { kid, role, mine, theirs, kem, now = Date.now() }) {
  if (role !== 'offerer' && role !== 'answerer') throw new TypeError('ratchet: role must be offerer or answerer');
  if (!theirs?.rp || !theirs?.rq) throw new TypeError('ratchet: the other side\'s ratchet keys are required');
  const offererKeys = role === 'offerer' ? mine.wire : theirs;
  const answererKeys = role === 'offerer' ? theirs : mine.wire;
  const material = await subtle.importKey('raw', seed instanceof Uint8Array ? seed : new Uint8Array(seed), 'HKDF', false, ['deriveBits']);
  /* The four public keys are bound in through their digest: HKDF's info is
     limited to 1 KB and an ML-KEM key alone is more. */
  const keysDigest = new Uint8Array(await subtle.digest('SHA-256', concat(
    encoder.encode(`${ROOT_LABEL}|keys|`), encoder.encode(offererKeys.rp), encoder.encode('|'), encoder.encode(offererKeys.rq),
    encoder.encode('|'), encoder.encode(answererKeys.rp), encoder.encode('|'), encoder.encode(answererKeys.rq))));
  const rk0 = new Uint8Array(await subtle.deriveBits({
    name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32),
    info: concat(encoder.encode(`${ROOT_LABEL}|${kid}|`), keysDigest),
  }, material, 256));
  /** @type {any} */
  const state = {
    v: 2, kid, rk: toBase64(rk0), dhs: mine.dh, dhr: theirs.rp, kem: mine.kem, peerKem: theirs.rq,
    send: null, recv: null, chains: {}, sincePq: 0, lastPqAt: now, announceKem: false,
  };
  if (role === 'offerer') {
    const step = await kdfRk(subtle, rk0, await dh(subtle, state.dhs.priv, state.dhr));
    state.rk = toBase64(step.rk);
    state.send = { id: await chainIdOf(subtle, step.ck), ck: toBase64(step.ck), n: 0, d: state.dhs.pub };
  } else {
    /* The offerer's sending chain is this side's first receiving chain; the
       first sending chain is made on top of it. */
    await receiveStep(subtle, state, state.dhr, null, null, kem, now);
  }
  return state;
}

/* A new ratchet key from the other side: the receiving step, then this
   side's sending step. Mutates `state`. */
async function receiveStep(subtle, state, theirPub, q, k, kem, now) {
  let ss = null;
  if (q) {
    ss = kem.decapsulate(fromBase64(q), fromBase64(state.kem.priv));
    /* That key has done its work; a new one is announced on the next chain. */
    state.kem = newKem(kem);
    state.announceKem = true;
  }
  const recvSecret = await dh(subtle, state.dhs.priv, theirPub);
  const r = await kdfRk(subtle, fromBase64(state.rk), ss ? concat(recvSecret, ss) : recvSecret);
  /* The root moves on at the receiving step too: the sending step below
     builds on it, as the other side's next receiving step will. */
  state.rk = toBase64(r.rk);
  if (state.recv) {
    state.chains[state.recv.id] = { ...state.recv, at: now };
    const ids = Object.keys(state.chains).sort((a, b) => state.chains[a].at - state.chains[b].at);
    for (const id of ids.slice(0, Math.max(0, ids.length - OLD_CHAINS))) delete state.chains[id];
  }
  state.recv = { id: await chainIdOf(subtle, r.ck), ck: toBase64(r.ck), n: 0, skipped: {} };
  state.dhr = theirPub;
  if (k) state.peerKem = k;
  /* This side's sending step, with the post-quantum secret mixed in when it
     is due and the other side has a key to encapsulate to. */
  const fresh = await newDhPair(subtle);
  const sendSecret = await dh(subtle, fresh.priv, theirPub);
  const due = Boolean(state.peerKem) && (state.sincePq >= PQ_EVERY_MESSAGES || now - Number(state.lastPqAt || 0) >= PQ_EVERY_MS);
  let ct = null;
  let ss2 = null;
  if (due) {
    const out = kem.encapsulate(fromBase64(state.peerKem));
    ct = toBase64(out.cipherText);
    ss2 = out.sharedSecret;
    state.sincePq = 0;
    state.lastPqAt = now;
    /* Used once: the other side rotates it and says so (k). */
    state.peerKem = null;
  }
  const s = await kdfRk(subtle, fromBase64(state.rk), ss2 ? concat(sendSecret, ss2) : sendSecret);
  state.rk = toBase64(s.rk);
  state.dhs = fresh;
  state.send = {
    id: await chainIdOf(subtle, s.ck), ck: toBase64(s.ck), n: 0, d: fresh.pub,
    ...(ct ? { q: ct } : {}),
    ...(state.announceKem ? { k: state.kem.pub } : {}),
  };
  state.announceKem = false;
  pruneChains(state, now);
}
function pruneChains(state, now) {
  for (const [id, chain] of Object.entries(state.chains)) {
    if (now - Number(chain.at || 0) > SKIPPED_TTL_MS) delete state.chains[id];
    else pruneSkipped(chain, now);
  }
  if (state.recv) pruneSkipped(state.recv, now);
}

/* The next sending key and the header that goes with it. Mutates `state`. */
export async function sendV2(subtle, state) {
  if (!state?.send?.ck) throw new ChainError('no-chain');
  const { mk, n, c } = await nextSendKey(subtle, state.send);
  state.sincePq = Number(state.sincePq || 0) + 1;
  const header = { c, n, d: state.send.d };
  if (state.send.q) header.q = state.send.q;
  if (state.send.k) header.k = state.send.k;
  return { mk, header };
}

/* The key for a received header. Works on, and returns, a COPY of `state`:
   the caller keeps the copy only once the message has authenticated, so a
   forged header can neither step the ratchet nor spend a key. */
export async function recvV2(subtle, state, header, kem, now = Date.now()) {
  const st = JSON.parse(JSON.stringify(state));
  const { c, n, d } = header || {};
  if (typeof c !== 'string' || !Number.isSafeInteger(n)) throw new ChainError('bad-header');
  let chain = st.recv && st.recv.id === c ? st.recv : st.chains[c] || null;
  if (!chain) {
    if (typeof d !== 'string' || !d || d === st.dhr) throw new ChainError('unknown-chain', c);
    await receiveStep(subtle, st, d, header.q || null, header.k || null, kem, now);
    if (st.recv.id !== c) throw new ChainError('unknown-chain', c);
    chain = st.recv;
  }
  const mk = await recvKey(subtle, chain, n, now);
  return { mk, state: st };
}
