/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* The door between js/crypto/ratchet.js and the chat's classic scripts
 * (roadmap 1.3, release 2.8). Loaded as a module before them.
 *
 * A live session keyed by a handshake now has `session.ratchet`:
 *
 *   { v: 1, kid, send: { id, ck, n }, recv: { id, ck, n, skipped } }
 *
 * and every payload is sealed with the next message key of `send` and opened
 * with the key of its number on `recv`. The handshake's own key stays on the
 * session (cryptoKey) only as the session's anchor: it is no longer what any
 * message is encrypted under, and it is no longer written to the vault.
 *
 * Chains are kept encrypted with the other stores, keyed by the contact's
 * fingerprint and the handshake's id, so a reload continues where it was and
 * the vault never holds a key that opens a message already read. */

import * as r from './ratchet.js';

const STORE_KEY = 'poorija_chat_ratchets';
/* A chain not used for this long is dropped: the next connection makes a
   new handshake anyway, and the chain only holds keys that were never used. */
const IDLE_MS = 30 * 24 * 60 * 60 * 1000;

const subtle = () => globalThis.crypto.subtle;
const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
let store = null;
let saveTimer = null;

function all() {
  if (store) return store;
  const loaded = typeof globalThis.loadEncrypted === 'function' ? globalThis.loadEncrypted(STORE_KEY, null) : null;
  const unlocked = typeof globalThis.isUnlocked !== 'function' || globalThis.isUnlocked();
  const value = loaded && typeof loaded === 'object' ? loaded : {};
  if (unlocked) store = value;
  return value;
}
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 200);
}
function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const value = all();
  const now = Date.now();
  for (const [key, entry] of Object.entries(value)) {
    if (!entry || now - Number(entry.at || 0) > IDLE_MS) delete value[key];
  }
  if (typeof globalThis.saveEncrypted === 'function') globalThis.saveEncrypted(STORE_KEY, value);
}
const storeKeyOf = (fingerprint) => String(fingerprint || '');

const kem = () => globalThis.PoorijaMlKem;
/* What this side brings to a version-2 handshake: a first X25519 ratchet key
   and a first ML-KEM-768 key. The private halves stay with the caller (on the
   pending exchange); `wire` is what is sent. */
async function offer() {
  return r.ratchetOffer(subtle(), kem());
}
/* The chains for a session from its handshake's seed. Replaces whatever the
   contact had: a new handshake is a new ratchet. Version 2 when both sides
   brought their ratchet keys (`mine`, `theirs`), version 1 otherwise. */
/**
 * @param {any} session
 * @param {{ seed: Uint8Array, kid: string, role: string, fingerprint: string, mine?: any, theirs?: { rp?: string, rq?: string }|null }} options
 */
async function start(session, { seed, kid, role, fingerprint, mine = null, theirs = null }) {
  if (mine && theirs?.rp && theirs?.rq && kem()) {
    session.ratchet = await r.startV2(subtle(), seed, { kid, role, mine, theirs, kem: kem() });
  } else {
    const chains = await r.deriveChains(subtle(), seed, { kid, role });
    session.ratchet = { v: 1, kid, ...chains };
  }
  const key = storeKeyOf(fingerprint);
  if (key) {
    all()[key] = { ratchet: session.ratchet, at: Date.now() };
    save();
  }
  return session.ratchet;
}
/* Chains kept from before a reload, for this contact. */
function restore(session, fingerprint) {
  const entry = all()[storeKeyOf(fingerprint)];
  if ((entry?.ratchet?.v === 1 && entry.ratchet.send?.ck && entry.ratchet.recv?.ck) || (entry?.ratchet?.v === 2 && entry.ratchet.rk)) {
    session.ratchet = entry.ratchet;
    return true;
  }
  return false;
}
function touch(fingerprint) {
  const entry = all()[storeKeyOf(fingerprint)];
  if (entry) { entry.at = Date.now(); save(); }
}
function forget(fingerprint) {
  delete all()[storeKeyOf(fingerprint)];
  save();
}

/* Seals a payload with the next message key. Returns the wire payload. */
function keep(session, fingerprint) {
  const key = storeKeyOf(fingerprint);
  if (key) { all()[key] = { ratchet: session.ratchet, at: Date.now() }; save(); }
}
async function seal(session, plainBytes, { kind, from, to, fingerprint }) {
  if (session.ratchet?.v === 2) {
    const { mk, header } = await r.sendV2(subtle(), session.ratchet);
    keep(session, fingerprint);
    try {
      const out = await r.encryptWith(subtle(), mk, plainBytes, r.messageAad({ c: header.c, n: header.n, from, to, kind }), random);
      return { iv: out.iv, cipher: r.toBase64(out.cipher), r: 2, ...header };
    } finally {
      mk.fill(0);
    }
  }
  const chain = session.ratchet?.send;
  if (!chain) throw new r.ChainError('no-chain');
  const { mk, n, c } = await r.nextSendKey(subtle(), chain);
  touch(fingerprint);
  try {
    const out = await r.encryptWith(subtle(), mk, plainBytes, r.messageAad({ c, n, from, to, kind }), random);
    return { iv: out.iv, cipher: r.toBase64(out.cipher), r: 1, c, n };
  } finally {
    mk.fill(0);
  }
}
/* Opens a ratchet payload; throws ChainError for a number already used (a
   replay) or one this device has no chain for, OperationError for a payload
   that does not authenticate. A failed tag does not consume the number. */
async function open(session, payload, { kind, from, to, fingerprint }) {
  if (payload?.r === 2) {
    if (session.ratchet?.v !== 2) throw new r.ChainError('unknown-chain', 'no version-2 ratchet');
    const header = { c: payload.c, n: payload.n, d: payload.d, q: payload.q, k: payload.k };
    /* recvV2 works on a copy; it becomes the state only once the message
       has authenticated, so a forgery steps nothing and spends nothing. */
    const { mk, state } = await r.recvV2(subtle(), session.ratchet, header, kem());
    try {
      const plain = await r.decryptWith(subtle(), mk, payload.iv, r.fromBase64(payload.cipher), r.messageAad({ c: payload.c, n: payload.n, from, to, kind }));
      session.ratchet = state;
      keep(session, fingerprint);
      return plain;
    } finally {
      mk.fill(0);
    }
  }
  if (session.ratchet?.v === 2) throw new r.ChainError('unknown-chain', 'a version-1 payload on a version-2 ratchet');
  const chain = session.ratchet?.recv;
  if (!chain || payload.c !== chain.id) throw new r.ChainError('unknown-chain', String(payload.c || ''));
  /* Worked on a copy, so a forgery cannot move the chain or burn a key. */
  const trial = JSON.parse(JSON.stringify(chain));
  const mk = await r.recvKey(subtle(), trial, payload.n);
  try {
    const plain = await r.decryptWith(subtle(), mk, payload.iv, r.fromBase64(payload.cipher), r.messageAad({ c: payload.c, n: payload.n, from, to, kind }));
    Object.assign(chain, trial);
    touch(fingerprint);
    return plain;
  } finally {
    mk.fill(0);
  }
}

/* A file transfer's key: 32 random bytes, sent as an ordinary ratchet
   message (kind 'file-key') on the transfer's start, so the receiver takes it
   only once its tag checks — a forged start can neither step the ratchet nor
   spend a key. Each chunk's key is derived from it by index, so a large file
   is one message on the chain and a chunk can be sent again. */
async function transferKey(session, { from, to, fingerprint, transferId }) {
  const raw = random(32);
  const sealed = await seal(session, raw, { kind: `file-key:${transferId}`, from, to, fingerprint });
  const key = await subtle().importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  raw.fill(0);
  return { key, c: sealed.c, sealed };
}
async function receiveTransferKey(session, { sealed, c, n, from, to, fingerprint, transferId }) {
  if (sealed) {
    const raw = await open(session, sealed, { kind: `file-key:${transferId}`, from, to, fingerprint });
    const key = await subtle().importKey('raw', raw, 'HKDF', false, ['deriveKey']);
    raw.fill(0);
    return key;
  }
  /* A 2.8 sender: the transfer key is message n of the chain c itself. */
  const chain = session.ratchet?.recv;
  if (!chain || c !== chain.id) throw new r.ChainError('unknown-chain', String(c || ''));
  const mk = await r.recvKey(subtle(), chain, n);
  touch(fingerprint);
  const key = await subtle().importKey('raw', mk, 'HKDF', false, ['deriveKey']);
  mk.fill(0);
  return key;
}
async function chunkKey(transferHkdfKey, index) {
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode(`poorija-chunk/1|${index}`) },
    transferHkdfKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function reset() {
  if (saveTimer && store) flush();
  store = null;
}
globalThis.addEventListener?.('poorija:lock', reset);
globalThis.addEventListener?.('poorija:unlock', () => { store = null; });

globalThis.PoorijaRatchet = Object.freeze({
  offer,
  start,
  version: (session) => Number(session?.ratchet?.v || 0),
  restore,
  forget,
  seal,
  open,
  transferKey,
  receiveTransferKey,
  chunkKey,
  chunkAad: r.chunkAad,
  flush,
  MAX_SKIPPED: r.MAX_SKIPPED,
  SKIPPED_TTL_MS: r.SKIPPED_TTL_MS,
});
