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
/* A new handshake replaces the chains, but mail already sealed under the
   previous one can still be on its way (an offline mailbox, a message that
   crossed the handshake). The receiving halves of the last few generations are
   kept for a while so that mail opens instead of being dropped. They are only
   ever read from: nothing is sealed under an old generation. */
const OLD_KEEP = 8;
/* A key exchange the answering side has worked out but not yet been shown
   confirmed. The offering side starts using its half the moment it sends the
   confirmation, so mail can reach the answerer sealed under chains it has not
   adopted yet (the confirmation, or the connection it travels on, may not get
   there). Those chains are kept as candidates: a message that opens under one
   is as authentic as one under the adopted chains, since only the other end
   of that exchange can seal under it. */
const CAND_KEEP = 6;
const OLD_MS = 14 * 24 * 60 * 60 * 1000;

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
/* The earlier generations of an entry that are still young enough. */
function liveOld(entry) {
  const now = Date.now();
  return (Array.isArray(entry?.old) ? entry.old : []).filter((o) => o?.ratchet && now - Number(o.at || 0) <= OLD_MS);
}
function liveCand(entry) {
  const now = Date.now();
  return (Array.isArray(entry?.cand) ? entry.cand : []).filter((o) => o?.ratchet && now - Number(o.at || 0) <= OLD_MS);
}

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
/* Each generation carries an id of its own (local to this device), so that a
   holder of the state that is not the contact's newest one can tell, and file
   what it did where it belongs instead of over the newest. */
/**
 * @param {{ seed: Uint8Array, kid: string, role: string, mine?: any, theirs?: { rp?: string, rq?: string }|null }} options
 */
async function build({ seed, kid, role, mine = null, theirs = null }) {
  const gid = r.toBase64(random(9));
  if (mine && theirs?.rp && theirs?.rq && kem()) {
    return { ...(await r.startV2(subtle(), seed, { kid, role, mine, theirs, kem: kem() })), gid };
  }
  const chains = await r.deriveChains(subtle(), seed, { kid, role });
  return { v: 1, kid, ...chains, gid };
}
/**
 * @param {any} session
 * @param {{ seed: Uint8Array, kid: string, role: string, fingerprint: string, mine?: any, theirs?: { rp?: string, rq?: string }|null, candidateId?: string|null }} options
 */
async function start(session, { seed, kid, role, fingerprint, mine = null, theirs = null, candidateId = null }) {
  const key = storeKeyOf(fingerprint);
  const before = key ? all()[key] : null;
  /* The chains this exchange was already given as a candidate, with whatever
     they have received since, when there are any. */
  const taken = candidateId ? liveCand(before).find((c) => c.id === candidateId) : null;
  session.ratchet = taken ? taken.ratchet : await build({ seed, kid, role, mine, theirs });
  if (key) {
    const entry = all()[key] || before;
    const old = liveOld(entry);
    if (entry?.ratchet && entry.ratchet !== session.ratchet && (entry.ratchet.v === 1 || entry.ratchet.v === 2)) {
      old.unshift({ ratchet: entry.ratchet, at: Date.now() });
    }
    all()[key] = { ratchet: session.ratchet, at: Date.now(), old: old.slice(0, OLD_KEEP), cand: liveCand(entry).filter((c) => c !== taken).slice(0, CAND_KEEP) };
    save();
  }
  return session.ratchet;
}
/* Chains for an exchange not yet confirmed, kept beside the contact's own.
   Returns the id `start` takes them back by. */
async function candidate({ seed, kid, role, fingerprint, mine = null, theirs = null }) {
  const key = storeKeyOf(fingerprint);
  if (!key) return null;
  const ratchet = await build({ seed, kid, role, mine, theirs });
  const id = r.toBase64(random(12));
  const entry = all()[key] || { ratchet: null, at: Date.now(), old: [], cand: [] };
  entry.cand = [{ id, ratchet, at: Date.now() }, ...liveCand(entry)].slice(0, CAND_KEEP);
  entry.at = Date.now();
  all()[key] = entry;
  save();
  return id;
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
  if (!key) return;
  const before = all()[key];
  const mine = session.ratchet;
  /* This holder's state is another generation than the contact's newest: it is
     an earlier one (a session object that was not replaced when the exchange
     was). It goes back where it came from; it does not replace the newest. */
  if (before?.ratchet?.gid && mine?.gid && before.ratchet.gid !== mine.gid) {
    const slot = [...liveOld(before), ...liveCand(before)].find((o) => o.ratchet?.gid === mine.gid);
    if (slot) slot.ratchet = mine;
    else before.old = [{ ratchet: mine, at: Date.now() }, ...liveOld(before)].slice(0, OLD_KEEP);
    save();
    return;
  }
  all()[key] = { ratchet: mine, at: Date.now(), old: liveOld(before), cand: liveCand(before) };
  save();
}
/* The newest generation of a contact, taken up by a holder that has an earlier
   one: what is sealed is sealed under the chains the contact was last given. */
function newest(session, fingerprint) {
  const entry = all()[storeKeyOf(fingerprint)];
  if (entry?.ratchet?.gid && session.ratchet?.gid && entry.ratchet.gid !== session.ratchet.gid) {
    session.ratchet = entry.ratchet;
  }
}
async function seal(session, plainBytes, { kind, from, to, fingerprint }) {
  newest(session, fingerprint);
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
async function openOn(ratchet, payload, { kind, from, to }) {
  if (payload?.r === 2) {
    if (ratchet?.v !== 2) throw new r.ChainError('unknown-chain', 'no version-2 ratchet');
    const header = { c: payload.c, n: payload.n, d: payload.d, q: payload.q, k: payload.k };
    /* recvV2 works on a copy; it becomes the state only once the message
       has authenticated, so a forgery steps nothing and spends nothing. */
    const { mk, state } = await r.recvV2(subtle(), ratchet, header, kem());
    try {
      const plain = await r.decryptWith(subtle(), mk, payload.iv, r.fromBase64(payload.cipher), r.messageAad({ c: payload.c, n: payload.n, from, to, kind }));
      return { plain, state };
    } finally {
      mk.fill(0);
    }
  }
  if (ratchet?.v === 2) throw new r.ChainError('unknown-chain', 'a version-1 payload on a version-2 ratchet');
  const chain = ratchet?.recv;
  if (!chain || payload.c !== chain.id) throw new r.ChainError('unknown-chain', String(payload.c || ''));
  /* Worked on a copy, so a forgery cannot move the chain or burn a key. */
  const trial = JSON.parse(JSON.stringify(chain));
  const mk = await r.recvKey(subtle(), trial, payload.n);
  try {
    const plain = await r.decryptWith(subtle(), mk, payload.iv, r.fromBase64(payload.cipher), r.messageAad({ c: payload.c, n: payload.n, from, to, kind }));
    Object.assign(chain, trial);
    return { plain, state: ratchet };
  } finally {
    mk.fill(0);
  }
}
/* A payload the current chains cannot place is tried on the earlier
   generations kept for the contact: it may be mail sealed before the latest
   handshake. A replay or a bad header on the current chain is not retried. */
const maybeEarlier = (error) => (error instanceof r.ChainError ? error.reason === 'unknown-chain' || error.reason === 'too-far' : error?.name === 'OperationError');
async function open(session, payload, { kind, from, to, fingerprint }) {
  try {
    const { plain, state } = await openOn(session.ratchet, payload, { kind, from, to });
    session.ratchet = state;
    if (state?.v === 2) keep(session, fingerprint); else touch(fingerprint);
    return plain;
  } catch (error) {
    const entry = all()[storeKeyOf(fingerprint)];
    const newer = entry?.ratchet && entry.ratchet !== session.ratchet && entry.ratchet.gid !== session.ratchet?.gid ? [entry] : [];
    const earlier = maybeEarlier(error) ? [...newer, ...liveCand(entry), ...liveOld(entry)] : [];
    for (const generation of earlier) {
      try {
        const { plain, state } = await openOn(generation.ratchet, payload, { kind, from, to });
        generation.ratchet = state;
        entry.at = Date.now();
        save();
        return plain;
      } catch { /* not this one; try the next */ }
    }
    throw error;
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
  candidate,
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
