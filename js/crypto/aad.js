/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Binding a ciphertext to where it belongs (roadmap 1.1).
 *
 * Every payload under a session key used to be AES-GCM with no additional
 * data, so nothing in the ciphertext said which session it was for, who wrote
 * it, who it was for, what kind of message it was or where it stood in the
 * order. Whoever carried it could deliver it twice, deliver a `text` as an
 * `edit`, or hand it to the other direction of the same conversation, and
 * the tag still checked.
 *
 * Now every such payload is sealed with additional data
 *
 *     "poorija-aad/1" ‖ sid ‖ fromFingerprint ‖ toFingerprint ‖ kind ‖ seq
 *
 * each field length-prefixed (u32, big-endian) so no two different tuples can
 * produce the same bytes. `sid` is derived from the session key itself, so
 * both sides compute it without a field on the wire and it changes whenever
 * the key does. `seq` is a 53-bit counter that also carries time
 * (see nextSeq) and is checked against a window of numbers already seen, so a
 * copy is refused even across a reload.
 *
 * This file is an ES module with no dependency on the app, so it is tested in
 * Node (tests/unit/aad.test.mjs) and is the first piece of src/crypto/ in
 * docs/ROADMAP-3.0.md. The app reaches it through window.PoorijaSessionAad,
 * set by js/crypto/aad-bridge.js.
 */

export const AAD_LABEL = 'poorija-aad/1';
export const SID_LABEL = 'poorija-sid/1';
/* How many numbers each session remembers. Enough to cover a relay that
   delivers a day of queued mail behind live traffic; small enough to keep
   with the session keys. */
export const REPLAY_WINDOW = 2048;
/* seq = time in ms × 1024 + a counter, so a sender that lost its counter (a
   crash, a fresh tab) still never repeats a number it used before. 2^53 /
   1024 ms is about 278 years from the epoch. */
const SEQ_TIME_SHIFT = 1024;

const encoder = new TextEncoder();

function field(value) {
  const bytes = value instanceof Uint8Array ? value : encoder.encode(String(value ?? ''));
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, false);
  out.set(bytes, 4);
  return out;
}
function concat(parts) {
  const length = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
function seqBytes(seq) {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new RangeError('seq must be a positive safe integer');
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.floor(seq / 2 ** 32), false);
  view.setUint32(4, seq >>> 0, false);
  return out;
}
function hex(buffer) {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* The canonical additional data. Every argument is required: a binding that
   silently accepted an empty sender would bind nothing. */
export function buildAad({ sid, from, to, kind, seq }) {
  for (const [name, value] of Object.entries({ sid, from, to, kind })) {
    if (!value) throw new TypeError(`aad: ${name} is required`);
  }
  return concat([field(AAD_LABEL), field(sid), field(from), field(to), field(kind), field(seqBytes(seq))]);
}

/* The session id: a hash of the raw session key under its own label. Both
   sides hold the key, so both get the same id; nobody without the key can
   compute it; and a new key is a new id, so a window never carries over. */
export async function sessionId(subtle, rawKey) {
  const key = rawKey instanceof Uint8Array ? rawKey : new Uint8Array(rawKey);
  const digest = await subtle.digest('SHA-256', concat([field(SID_LABEL), field(key)]));
  return hex(digest).slice(0, 32);
}

/* The next number to send under `state`. Never below the clock, never below
   the last one sent. */
export function nextSeq(state, now = Date.now()) {
  const floor = Math.floor(now) * SEQ_TIME_SHIFT;
  const next = Math.max(floor, (state.sent || 0) + 1);
  state.sent = next;
  return next;
}

/* The receiver's side: has this number been seen, and is it still inside the
   window? `state.seen` is a sorted array of the newest REPLAY_WINDOW numbers.
   Returns 'new', 'replay' or 'stale'. Does not change the state. */
export function classify(state, seq) {
  const seen = state.seen || [];
  if (seen.length >= REPLAY_WINDOW && seq < seen[0]) return 'stale';
  return binarySearch(seen, seq) >= 0 ? 'replay' : 'new';
}
/* Records a number that has just been accepted. */
export function remember(state, seq) {
  const seen = state.seen || (state.seen = []);
  const at = binarySearch(seen, seq);
  if (at >= 0) return;
  seen.splice(~at, 0, seq);
  if (seen.length > REPLAY_WINDOW) seen.splice(0, seen.length - REPLAY_WINDOW);
}
function binarySearch(list, value) {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid] === value) return mid;
    if (list[mid] < value) lo = mid + 1; else hi = mid - 1;
  }
  return ~lo;
}

/* A replay or a stale number, as an error a caller can tell apart from a
   failed tag. */
export class ReplayError extends Error {
  constructor(kind, seq) {
    super(`aad: ${kind} sequence number ${seq}`);
    this.name = 'ReplayError';
    this.kind = kind;
    this.seq = seq;
  }
}

/* Seal `plain` under `key` bound to the tuple. `state` is the sender's
   per-session counter record. Returns the wire payload. */
export async function seal(subtle, key, plain, { sid, from, to, kind, state, random }) {
  const seq = nextSeq(state);
  const iv = random(12);
  const additionalData = buildAad({ sid, from, to, kind, seq });
  const cipher = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key, plain);
  return { iv: Array.from(iv), cipher, seq, a: 1 };
}

/* Open a bound payload. The tag is checked first; only a payload that
   authenticates is allowed to touch the replay window, so a forger cannot
   push real numbers out of it. Throws OperationError (wrong binding, wrong
   key) or ReplayError. */
export async function open(subtle, key, payload, cipherBytes, { sid, from, to, kind, state }) {
  const seq = payload?.seq;
  if (!Number.isSafeInteger(seq) || seq < 1) {
    const error = new Error('aad: missing or malformed sequence number');
    error.name = 'OperationError';
    throw error;
  }
  const additionalData = buildAad({ sid, from, to, kind, seq });
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(payload.iv || []), additionalData }, key, cipherBytes);
  const verdict = classify(state, seq);
  if (verdict !== 'new') throw new ReplayError(verdict, seq);
  remember(state, seq);
  return plain;
}

/* File chunks: bound to the transfer and the index instead of a counter. A
   chunk is legitimately sent twice (file-resend), so a repeat is not a
   replay; what must not work is moving a chunk to another index or another
   transfer, which this stops. */
export function chunkAad({ sid, from, to, transferId, index }) {
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError('chunk index must be a non-negative integer');
  return buildAad({ sid, from, to, kind: `chunk:${transferId}`, seq: index + 1 });
}
