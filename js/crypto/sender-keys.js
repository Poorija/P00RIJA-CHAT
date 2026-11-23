/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Sender Keys for groups (roadmap 3.1, release 2.12).
 *
 * In a group each member keeps, for itself, a sending chain: a 32-byte chain
 * key, a counter and an Ed25519 key pair. The chain key and the public half of
 * the signing key — the "sender key" — are handed to every other member once,
 * inside the pairwise ratchet each pair already has, so only members receive
 * it and each copy is authenticated by the session it rides in. A group
 * message is then encrypted ONCE, under the next message key of the sender's
 * chain, and signed with the sender's group signing key, so a member who holds
 * the chain key (every member does) still cannot write as somebody else.
 *
 *   mk_n   = HMAC-SHA256(ck_n, 0x01)
 *   ck_n+1 = HMAC-SHA256(ck_n, 0x02)
 *   AAD    = "poorija-sk/1" ‖ lp(groupId) ‖ lp(senderFp) ‖ lp(keyId) ‖ u32 n ‖ lp(kind)
 *   wire   = { sk:1, g: keyId, n, iv, c, s }    s = Ed25519 over AAD ‖ iv ‖ c
 *
 * keyId names one chain: SHA-256("poorija-sk-id/1" ‖ groupId ‖ senderFp ‖
 * chain-key-0 ‖ signing key)[0..16]. A receiver keeps each sender's chain and
 * up to MAX_SKIPPED skipped message keys for MAX_SKIPPED_AGE_MS, like the
 * pairwise ratchet.
 *
 * When a member leaves or is removed, every remaining member starts a new
 * chain and hands it to the members still in (never to the one who left), so
 * whatever the departed member kept opens nothing sent after. A member who
 * joins gets each sender's CURRENT chain key, which derives forward only: what
 * was sent before they joined stays closed to them. */

const enc = new TextEncoder();
export const MAX_SKIPPED = 2000;
export const MAX_SKIP_PER_MESSAGE = 1000;
export const MAX_SKIPPED_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export class SenderKeyError extends Error {
  constructor(reason, detail = '') { super(`${reason}${detail ? `: ${detail}` : ''}`); this.name = 'SenderKeyError'; this.reason = reason; }
}

export function toBase64(bytes) {
  let s = '';
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 0x8000) s += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(text) {
  const raw = atob(String(text || ''));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; };
const lp = (s) => { const b = typeof s === 'string' ? enc.encode(s) : s; return concat(u32(b.length), b); };

async function hmac(subtle, keyBytes, byte) {
  const key = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', key, Uint8Array.of(byte)));
}
async function step(subtle, ck) {
  return { mk: await hmac(subtle, ck, 0x01), next: await hmac(subtle, ck, 0x02) };
}

export function messageAad({ groupId, senderFp, keyId, n, kind }) {
  return concat(lp('poorija-sk/1'), lp(groupId), lp(senderFp), lp(keyId), u32(n), lp(kind || 'space-message'));
}

async function keyIdOf(subtle, { groupId, senderFp, ck0, signPublic }) {
  const digest = new Uint8Array(await subtle.digest('SHA-256', concat(lp('poorija-sk-id/1'), lp(groupId), lp(senderFp), lp(ck0), lp(signPublic))));
  return toHex(digest.subarray(0, 16));
}

/* A new sending chain for this device in `groupId`. The state is JSON. */
export async function createSendingChain(subtle, random, { groupId, senderFp }) {
  const ck0 = random(32);
  const pair = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const signPublic = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const signPrivate = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
  const keyId = await keyIdOf(subtle, { groupId, senderFp, ck0, signPublic });
  return { v: 1, groupId, senderFp, keyId, ck: toBase64(ck0), n: 0, signPublic: toBase64(signPublic), signPrivate: toBase64(signPrivate), createdAt: Date.now() };
}

/* What is handed to a member: the chain where it stands now (so a member who
   joins cannot derive what came before), and the public signing key. */
export function distribution(chain) {
  return { v: 1, groupId: chain.groupId, senderFp: chain.senderFp, keyId: chain.keyId, ck: chain.ck, n: chain.n, signPublic: chain.signPublic };
}

/* A receiving chain from a distribution, checked: the keyId must be what the
   fields hash to, except that a chain handed on mid-way (n > 0) cannot be
   re-hashed from chain-key-0, which the receiver never sees — then the id is
   taken as given and bound by every message's signature and AAD. */
export async function acceptDistribution(subtle, dist, { groupId, senderFp }) {
  if (!dist || dist.v !== 1 || dist.groupId !== groupId || dist.senderFp !== senderFp) throw new SenderKeyError('bad-distribution', 'group or sender');
  if (!/^[0-9a-f]{32}$/.test(String(dist.keyId || '')) || !Number.isSafeInteger(dist.n) || dist.n < 0) throw new SenderKeyError('bad-distribution', 'fields');
  const ck = fromBase64(dist.ck);
  const signPublic = fromBase64(dist.signPublic);
  if (ck.length !== 32 || signPublic.length !== 32) throw new SenderKeyError('bad-distribution', 'lengths');
  if (dist.n === 0 && (await keyIdOf(subtle, { groupId, senderFp, ck0: ck, signPublic })) !== dist.keyId) throw new SenderKeyError('bad-distribution', 'key id');
  return { v: 1, groupId, senderFp, keyId: dist.keyId, ck: dist.ck, n: dist.n, signPublic: dist.signPublic, skipped: {}, receivedAt: Date.now() };
}

/* Encrypts once for the whole group; advances `chain` in place. */
export async function seal(subtle, random, chain, plainBytes, { kind = 'space-message' } = {}) {
  const n = chain.n;
  const { mk, next } = await step(subtle, fromBase64(chain.ck));
  chain.ck = toBase64(next);
  chain.n = n + 1;
  const aad = messageAad({ groupId: chain.groupId, senderFp: chain.senderFp, keyId: chain.keyId, n, kind });
  const iv = random(12);
  const key = await subtle.importKey('raw', mk, 'AES-GCM', false, ['encrypt']);
  mk.fill(0);
  const cipher = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plainBytes));
  const signKey = await subtle.importKey('pkcs8', fromBase64(chain.signPrivate), { name: 'Ed25519' }, false, ['sign']);
  const sig = new Uint8Array(await subtle.sign({ name: 'Ed25519' }, signKey, concat(aad, iv, cipher)));
  return { sk: 1, g: chain.keyId, n, iv: toBase64(iv), c: toBase64(cipher), s: toBase64(sig) };
}

function pruneSkipped(chain, now) {
  for (const [n, entry] of Object.entries(chain.skipped || {})) {
    if (now - Number(entry.at || 0) > MAX_SKIPPED_AGE_MS) delete chain.skipped[n];
  }
  const keys = Object.keys(chain.skipped || {});
  if (keys.length > MAX_SKIPPED) keys.sort((a, b) => chain.skipped[a].at - chain.skipped[b].at).slice(0, keys.length - MAX_SKIPPED).forEach((k) => { delete chain.skipped[k]; });
}

/* Opens a group message with the sender's chain. Works on a copy: the chain
   (and its skipped keys) become what they are only once the signature and the
   tag both check, so a forgery moves nothing. Returns { plain, chain }. */
export async function open(subtle, chain, wire, { kind = 'space-message', now = Date.now() } = {}) {
  if (!wire || wire.sk !== 1 || wire.g !== chain.keyId || !Number.isSafeInteger(wire.n) || wire.n < 0) throw new SenderKeyError('unknown-chain');
  const aad = messageAad({ groupId: chain.groupId, senderFp: chain.senderFp, keyId: chain.keyId, n: wire.n, kind });
  const iv = fromBase64(wire.iv);
  const cipher = fromBase64(wire.c);
  const verifyKey = await subtle.importKey('raw', fromBase64(chain.signPublic), { name: 'Ed25519' }, false, ['verify']);
  if (!(await subtle.verify({ name: 'Ed25519' }, verifyKey, fromBase64(wire.s), concat(aad, iv, cipher)))) throw new SenderKeyError('bad-signature');
  const trial = JSON.parse(JSON.stringify(chain));
  trial.skipped = trial.skipped || {};
  let mk;
  if (wire.n < trial.n) {
    const kept = trial.skipped[wire.n];
    if (!kept) throw new SenderKeyError('replay', String(wire.n));
    mk = fromBase64(kept.mk);
    delete trial.skipped[wire.n];
  } else {
    if (wire.n - trial.n > MAX_SKIP_PER_MESSAGE) throw new SenderKeyError('too-far', String(wire.n));
    let ck = fromBase64(trial.ck);
    for (let i = trial.n; i < wire.n; i += 1) {
      const s = await step(subtle, ck);
      trial.skipped[i] = { mk: toBase64(s.mk), at: now };
      ck = s.next;
    }
    const s = await step(subtle, ck);
    mk = s.mk;
    trial.ck = toBase64(s.next);
    trial.n = wire.n + 1;
  }
  const key = await subtle.importKey('raw', mk, 'AES-GCM', false, ['decrypt']);
  mk.fill(0);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, cipher));
  pruneSkipped(trial, now);
  return { plain, chain: trial };
}
