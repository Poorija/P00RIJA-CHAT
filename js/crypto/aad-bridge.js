/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* The one door between js/crypto/aad.js (an ES module) and the chat's classic
 * scripts, which share one global scope and cannot `import`.
 *
 * Loaded as <script type="module"> before the chat's scripts. Module scripts
 * are deferred and run in document order with the `defer` ones, so
 * window.PoorijaSessionAad exists before any chat code runs.
 *
 * What it adds to the bare module is the session: which key a session holds
 * (and so which session id), the sender's counter, the receiver's window of
 * numbers seen, and keeping that window with the device's other encrypted
 * stores so a reload is not a way to have a frame accepted twice. */

import * as aad from './aad.js';

const STORE_KEY = 'poorija_chat_aad_windows';
/* How long a window is kept after it was last used: past the longest a
   session key lives (7 days, 19-forward-secrecy.js) and a day more, so a
   window is never forgotten while its key can still open a frame. Before,
   only the 256 most recently used were kept: with enough sessions (a busy
   group, many contacts) the window of a key still alive was dropped, and its
   frames could then be accepted a second time (roadmap 5.2, finding F5). */
const WINDOW_KEEP_MS = 8 * 24 * 60 * 60 * 1000;
/* A bound on memory only, far above what the age rule leaves. */
const MAX_SESSIONS = 8192;

const sidByKey = new WeakMap();
const senders = new Map();
let windows = null;
let saveTimer = null;

const subtle = () => globalThis.crypto.subtle;
const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const toBase64 = (buffer) => globalThis.PoorijaApp.arrayBufferToBase64(buffer);
const fromBase64 = (text) => globalThis.PoorijaApp.base64ToArrayBuffer(text);

async function sidOf(key) {
  if (!key) throw new TypeError('aad: the session has no key');
  let sid = sidByKey.get(key);
  if (!sid) {
    sid = await aad.sessionId(subtle(), await subtle().exportKey('raw', key));
    sidByKey.set(key, sid);
  }
  return sid;
}

/* The stored windows, read once the vault can be read. loadEncrypted and
   saveEncrypted are top-level functions of a classic script, and so
   properties of window. */
function allWindows() {
  if (windows) return windows;
  const loaded = typeof globalThis.loadEncrypted === 'function' ? globalThis.loadEncrypted(STORE_KEY, null) : null;
  const unlocked = typeof globalThis.isUnlocked !== 'function' || globalThis.isUnlocked();
  const value = loaded && typeof loaded === 'object' ? loaded : {};
  /* Not cached while the vault is shut: an empty answer then would be
     written back over the real windows at the next save. */
  if (unlocked) windows = value;
  return value;
}
function windowFor(sid) {
  const all = allWindows();
  const entry = all[sid] || (all[sid] = { seen: [] });
  entry.at = Date.now();
  return entry;
}
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const all = allWindows();
    const now = Date.now();
    for (const id of Object.keys(all)) if (now - (all[id].at || 0) > WINDOW_KEEP_MS) delete all[id];
    const ids = Object.keys(all);
    if (ids.length > MAX_SESSIONS) {
      ids.sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
      ids.slice(0, ids.length - MAX_SESSIONS).forEach((id) => { delete all[id]; });
    }
    if (typeof globalThis.saveEncrypted === 'function') globalThis.saveEncrypted(STORE_KEY, all);
  }, 250);
}

function binding(session, { kind, from, to }) {
  if (!kind) throw new TypeError('aad: kind is required');
  if (!from || !to) throw new TypeError('aad: both fingerprints are required');
  return { kind, from, to };
}

/* Seals `plainBytes` for the session. Returns the wire payload: iv, base64
   cipher, seq and `a: 1`. */
async function seal(session, plainBytes, options) {
  const { kind, from, to } = binding(session, options);
  const sid = await sidOf(session.cryptoKey);
  const state = senders.get(sid) || {};
  senders.set(sid, state);
  const sent = await aad.seal(subtle(), session.cryptoKey, plainBytes, { sid, from, to, kind, state, random });
  return { iv: sent.iv, cipher: toBase64(sent.cipher), seq: sent.seq, a: 1 };
}

/* Opens a bound payload for the session; throws OperationError when the
   binding or the key is wrong and ReplayError when the number was seen. */
async function open(session, payload, options) {
  const { kind, from, to } = binding(session, options);
  const sid = await sidOf(session.cryptoKey);
  const state = windowFor(sid);
  const plain = await aad.open(subtle(), session.cryptoKey, payload, fromBase64(payload.cipher), { sid, from, to, kind, state });
  scheduleSave();
  return plain;
}

/* File chunks: bound to the transfer and index, not counted. */
async function chunkData(key, { from, to, transferId, index }) {
  const sid = await sidOf(key);
  return aad.chunkAad({ sid, from, to, transferId: String(transferId || ''), index });
}

async function seenCount(session) {
  if (!session?.cryptoKey) return 0;
  const sid = await sidOf(session.cryptoKey);
  return (allWindows()[sid]?.seen || []).length;
}

/* Another profile may open next (the decoy and the real one share this
   page): nothing of this one's windows stays in memory across a lock. A
   pending save is written first, while the profile it belongs to is open. */
function forget() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (windows && typeof globalThis.saveEncrypted === 'function') globalThis.saveEncrypted(STORE_KEY, windows);
  }
  windows = null;
  senders.clear();
}
globalThis.addEventListener?.('poorija:lock', forget);
globalThis.addEventListener?.('poorija:unlock', () => { windows = null; });

globalThis.PoorijaSessionAad = Object.freeze({
  seal,
  open,
  chunkData,
  seenCount,
  sessionId: sidOf,
  /* Forgets what is held in memory; the next use reads the store again
     (after a vault is opened, or a profile switched). */
  reset: forget,
  REPLAY_WINDOW: aad.REPLAY_WINDOW,
  WINDOW_KEEP_MS,
});
