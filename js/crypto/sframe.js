/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* SFrame, RFC 9605: end-to-end encryption of media frames (roadmap 3.2).
 *
 * Each sender in a group call has a base key; every encoded audio or video
 * frame it sends is encrypted under a key derived from it, with a header that
 * names the key (KID) and the frame's counter (CTR). The SFU that carries the
 * frames sees the header and nothing else. Cipher suite AES_128_GCM_SHA256_128
 * (0x0004), the one WebCrypto does natively; checked against the RFC's test
 * vectors (tests/unit/sframe.test.mjs).
 *
 *   header        = config byte |X|K|K|K|Y|C|C|C| ‖ KID? ‖ CTR?   (§4.3)
 *   sframe_secret = HKDF-Extract("", base_key)
 *   sframe_key    = HKDF-Expand(secret, "SFrame 1.0 Secret key "  ‖ u64 KID ‖ u16 suite, 16)
 *   sframe_salt   = HKDF-Expand(secret, "SFrame 1.0 Secret salt " ‖ u64 KID ‖ u16 suite, 12)
 *   nonce         = salt XOR u96(CTR)
 *   out           = header ‖ AES-GCM(key, nonce, aad = header ‖ metadata, frame)
 *
 * KID and CTR are numbers here and stay below 2^53 (a sender's counter would
 * need 285,000 years at 1,000 frames a second to get there). */

const enc = new TextEncoder();
export const SUITE_AES_128_GCM_SHA256_128 = 0x0004;
const NK = 16;
const NN = 12;
const NT = 16;
export const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export class SFrameError extends Error {
  constructor(reason) { super(reason); this.name = 'SFrameError'; this.reason = reason; }
}

function minBytes(n) {
  let len = 1;
  while (n >= 2 ** (8 * len)) len += 1;
  return len;
}
function bigEndian(n, len) {
  const out = new Uint8Array(len);
  let v = n;
  for (let i = len - 1; i >= 0; i -= 1) { out[i] = v % 256; v = Math.floor(v / 256); }
  return out;
}
function readBigEndian(bytes, at, len) {
  let v = 0;
  for (let i = 0; i < len; i += 1) v = v * 256 + bytes[at + i];
  return v;
}

/* §4.3: values 0..7 inline in the config byte; larger ones appended as the
   shortest big-endian integer, KID before CTR. */
export function encodeHeader(kid, ctr) {
  if (!Number.isSafeInteger(kid) || kid < 0 || !Number.isSafeInteger(ctr) || ctr < 0) throw new SFrameError('bad-header-value');
  let config = 0;
  const tail = [];
  if (kid < 8) config |= kid << 4;
  else { const len = minBytes(kid); config |= 0x80 | ((len - 1) << 4); tail.push(bigEndian(kid, len)); }
  if (ctr < 8) config |= ctr;
  else { const len = minBytes(ctr); config |= 0x08 | (len - 1); tail.push(bigEndian(ctr, len)); }
  const out = new Uint8Array(1 + tail.reduce((n, t) => n + t.length, 0));
  out[0] = config;
  let at = 1;
  for (const t of tail) { out.set(t, at); at += t.length; }
  return out;
}
export function decodeHeader(bytes) {
  if (!bytes || bytes.length < 1) throw new SFrameError('short');
  const config = bytes[0];
  let at = 1;
  let kid = (config >> 4) & 0x07;
  let ctr = config & 0x07;
  if (config & 0x80) {
    const len = kid + 1;
    if (bytes.length < at + len) throw new SFrameError('short');
    kid = readBigEndian(bytes, at, len);
    at += len;
  }
  if (config & 0x08) {
    const len = ctr + 1;
    if (bytes.length < at + len) throw new SFrameError('short');
    ctr = readBigEndian(bytes, at, len);
    at += len;
  }
  if (!Number.isSafeInteger(kid) || !Number.isSafeInteger(ctr)) throw new SFrameError('too-large');
  return { kid, ctr, length: at };
}

async function hkdfExtract(subtle, salt, ikm) {
  const key = await subtle.importKey('raw', salt.length ? salt : new Uint8Array(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', key, ikm));
}
async function hkdfExpand(subtle, prk, info, length) {
  const key = await subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const out = new Uint8Array(length);
  let previous = new Uint8Array(0);
  let filled = 0;
  for (let i = 1; filled < length; i += 1) {
    const input = new Uint8Array(previous.length + info.length + 1);
    input.set(previous, 0); input.set(info, previous.length); input[input.length - 1] = i;
    previous = new Uint8Array(await subtle.sign('HMAC', key, input));
    out.set(previous.subarray(0, Math.min(previous.length, length - filled)), filled);
    filled += previous.length;
  }
  return out;
}
function label(prefix, kid, suite) {
  const head = enc.encode(prefix);
  const out = new Uint8Array(head.length + 10);
  out.set(head, 0);
  out.set(bigEndian(kid, 8), head.length);
  out.set(bigEndian(suite, 2), head.length + 8);
  return out;
}

/* The key and salt for one KID (§4.4.2), with the bytes kept for the tests. */
export async function deriveKeys(subtle, baseKey, kid, suite = SUITE_AES_128_GCM_SHA256_128) {
  if (suite !== SUITE_AES_128_GCM_SHA256_128) throw new SFrameError('unsupported-suite');
  const secret = await hkdfExtract(subtle, new Uint8Array(0), baseKey);
  const keyBytes = await hkdfExpand(subtle, secret, label('SFrame 1.0 Secret key ', kid, suite), NK);
  const salt = await hkdfExpand(subtle, secret, label('SFrame 1.0 Secret salt ', kid, suite), NN);
  const key = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { kid, key, salt, secret, keyBytes };
}

function nonceFor(salt, ctr) {
  const c = bigEndian(ctr, NN);
  const out = new Uint8Array(NN);
  for (let i = 0; i < NN; i += 1) out[i] = salt[i] ^ c[i];
  return out;
}
function joined(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}

export async function encryptFrame(subtle, keys, ctr, frame, metadata = new Uint8Array(0)) {
  const header = encodeHeader(keys.kid, ctr);
  const aad = joined(header, metadata);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonceFor(keys.salt, ctr), additionalData: aad, tagLength: NT * 8 }, keys.key, frame));
  return joined(header, ct);
}

/* `keysFor(kid)` returns the derived keys for a KID this receiver holds, or
   null. Returns { kid, ctr, frame }. */
export async function decryptFrame(subtle, keysFor, bytes, metadata = new Uint8Array(0)) {
  const { kid, ctr, length } = decodeHeader(bytes);
  const keys = await keysFor(kid);
  if (!keys) throw new SFrameError('unknown-kid');
  const header = bytes.subarray(0, length);
  try {
    const frame = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonceFor(keys.salt, ctr), additionalData: joined(header, metadata), tagLength: NT * 8 }, keys.key, bytes.subarray(length)));
    return { kid, ctr, frame };
  } catch (_error) {
    throw new SFrameError('auth');
  }
}

/* A receiver's window of counters already seen per KID, so a frame replayed
   by the SFU (or anyone between) is dropped. 2,048 behind the newest.

   Two steps, as RFC 9605 orders them: `fresh` before the frame is opened (a
   counter already seen, or too old, costs no decryption), `accept` only after
   it authenticated. Accepting before, as this did, let whoever relays the
   frames send ONE forged frame with a huge counter under a member's KID: the
   window jumped to it, and every genuine frame after was "too old" and
   dropped, which silenced that member for the rest of the call. */
export function createReplayWindow(size = 2048) {
  const seen = new Map();
  return {
    fresh(kid, ctr) {
      const entry = seen.get(kid);
      if (!entry || ctr > entry.top) return true;
      return !(ctr < entry.top - size || entry.bits.has(ctr));
    },
    accept(kid, ctr) {
      let entry = seen.get(kid);
      if (!entry) { entry = { top: -1, bits: new Set() }; seen.set(kid, entry); }
      if (ctr > entry.top) {
        entry.top = ctr;
        entry.bits.add(ctr);
        for (const old of entry.bits) if (old < ctr - size) entry.bits.delete(old);
        return true;
      }
      if (ctr < entry.top - size || entry.bits.has(ctr)) return false;
      entry.bits.add(ctr);
      return true;
    },
  };
}
