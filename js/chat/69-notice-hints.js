/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* What a notification says — and who is allowed to know it.
 *
 * A notification for a message that came while the app was closed is raised by
 * the service worker from a push the relay sent, and the relay sees only a
 * sealed envelope: it cannot say who wrote or what, and neither can the push
 * service of Google or Apple that carries it. So the notification used to say
 * one fixed line. This lets a person ask for more, in two switches that are OFF
 * until they are turned on:
 *
 *   - the sender's name        "New message from Ali"
 *   - the message, or the kind  "Hello there" / "Photo" / "Sticker" ...
 *
 * and it does it without telling the relay or the push service anything.
 *
 * The receiver makes a key for each switch that is on and gives it to its
 * contacts, sealed to each one's prekey like any message. A contact writing to
 * them adds to the envelope a hint: the name, and the kind and the start of the
 * text, each encrypted under the key it was given for that. The relay passes the
 * hint on inside the push as bytes it cannot open; the service worker opens it
 * with the same key, which this page keeps in IndexedDB where a worker can read
 * it (a vault the worker cannot open would leave it with nothing to say). A
 * switch that is off has no key anywhere, so there is nothing for a contact to
 * encrypt under and nothing on the wire.
 *
 * What it costs, and the hints say so: a notification that names or quotes is
 * read by whoever sees the locked screen. The vault key never leaves the vault;
 * the notice keys do, on purpose, and only open what a notification shows.
 */

const NOTICE_DB = 'poorija-notice';
const NOTICE_NAME_BYTES = 128;
const NOTICE_BODY_BUCKETS = [256, 512, 768];
const NOTICE_TEXT_CHARS = 140;
const NOTICE_KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/* ---- the switches ------------------------------------------------------------ */

function noticeWantsSender() { return chatState.prefs?.notifyShowSender === true; }
function noticeWantsPreview() { return chatState.prefs?.notifyShowPreview === true; }

/* The words of a notification as THIS device shows them itself — the desktop
   shell's, where the page is running and has the message in the clear. The
   defaults are the fixed line it always had. */
function noticeKindWord(kind) {
  const words = {
    text: ['پیام جدید', 'New message'],
    sticker: ['استیکر', 'Sticker'],
    gif: ['گیف', 'GIF'],
    photo: ['عکس', 'Photo'],
    video: ['ویدیو', 'Video'],
    voice: ['پیام صوتی', 'Voice message'],
    audio: ['فایل صوتی', 'Audio'],
    file: ['فایل', 'File'],
    location: ['موقعیت مکانی', 'Location'],
  };
  const pair = words[kind] || words.text;
  return t(pair[0], pair[1]);
}
function noticeKindOf(entry = {}) {
  if (entry.type === 'sticker') return typeof isGifEntry === 'function' && isGifEntry(entry) ? 'gif' : 'sticker';
  if (entry.type === 'voice') return 'voice';
  if (entry.type === 'location' || entry.type === 'live-location') return 'location';
  if (entry.type === 'file' || entry.type === 'file-start') {
    const mime = String(entry.mime || '').toLowerCase();
    if (entry.photo === true || mime.startsWith('image/')) return 'photo';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    return 'file';
  }
  return 'text';
}
function noticeTextOf(entry = {}) {
  const raw = entry.type === 'text' || entry.type === 'rich' || entry.type === 'space-message' || !entry.type
    ? entry.text
    : entry.caption;
  const plain = typeof plainMessageText === 'function' ? plainMessageText(raw) : raw;
  return String(plain || '').replace(/\s+/g, ' ').trim().slice(0, NOTICE_TEXT_CHARS);
}
/* The title and body this device puts on its own system notification for an
   arrival, given the two switches. */
function noticeLineFor(entry, senderName, { strict = false } = {}) {
  const name = String(senderName || '').trim().slice(0, 60);
  /* A locked app, a locked chat tab or a locked conversation says the bare line
     whatever was asked: those locks exist to keep exactly this off a screen. */
  const showName = !strict && noticeWantsSender() && name;
  const showWhat = !strict && noticeWantsPreview();
  const what = noticeKindOf(entry) === 'text' ? (noticeTextOf(entry) || noticeKindWord('text')) : noticeKindWord(noticeKindOf(entry));
  if (showName && showWhat) return { title: name, body: what };
  if (showName) return { title: 'P00RIJA Chat', body: t(`پیام تازه از ${name}`, `New message from ${name}`) };
  if (showWhat) return { title: 'P00RIJA Chat', body: what };
  return { title: 'P00RIJA Chat', body: t('پیام رمزنگاری‌شدهٔ تازه رسید.', 'Encrypted chat update received.') };
}

/* ---- the keys this device gives out ----------------------------------------- */

function noticeB64(bytes) { return app().arrayBufferToBase64(bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); }
function noticeFromB64(text) { return new Uint8Array(app().base64ToArrayBuffer(String(text || ''))); }
/* One pair of keys PER CONTACT, never one for all. A key everyone holds lets any
   one of them put another's name, or any words, on this person's lock screen;
   with a key of its own a contact can speak only as the one who was given it,
   and can be cut off alone (blocked, removed, or the switch turned off). The
   worker tries each in turn when a hint arrives, so nothing on the wire says
   which contact it is. */
function noticeKeysOf(prefs) {
  const stored = prefs?.noticeKeys && typeof prefs.noticeKeys === 'object' ? prefs.noticeKeys : {};
  const per = stored.per && typeof stored.per === 'object' ? stored.per : {};
  return { per, at: Number(stored.at || 0) };
}

/* IndexedDB, because a service worker has no other way to read what the page
   knows. One record: the two keys (opening only — a key imported here cannot be
   read back out) and which switches are on. */
function noticeDbOpen() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return; }
    const request = indexedDB.open(NOTICE_DB, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('kv'); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function noticeStoreWrite(record) {
  const db = await noticeDbOpen();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      if (record) tx.objectStore('kv').put(record, 'keys'); else tx.objectStore('kv').delete('keys');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}
async function noticeOpeningKey(b64) {
  if (!b64) return null;
  return crypto.subtle.importKey('raw', noticeFromB64(b64), { name: 'AES-GCM' }, false, ['decrypt']);
}
function noticeRandomKey() { return noticeB64(crypto.getRandomValues(new Uint8Array(32))); }

/* Brings the per-contact keys, the worker's copy and the contacts in line with
   the two switches. Safe to call as often as is convenient. */
async function syncNoticeKeys({ redistribute = false } = {}) {
  if (!chatState.prefs) return;
  const keys = noticeKeysOf(chatState.prefs);
  const wants = { s: noticeWantsSender(), p: noticeWantsPreview() };
  const audience = new Map(noticeAudience().map((peer) => [peer.fingerprint || peer.peerId, peer]).filter(([id]) => id));
  const expired = keys.at && Date.now() - keys.at > NOTICE_KEY_TTL_MS;
  let changed = false;
  const dropped = [];
  /* Gone from the audience (blocked, removed) or nothing left switched on: the
     keys go, and the contact is told when we still can. */
  for (const id of Object.keys(keys.per)) {
    if (!audience.has(id) || (!wants.s && !wants.p)) { dropped.push(id); delete keys.per[id]; changed = true; }
  }
  if (wants.s || wants.p) {
    for (const id of audience.keys()) {
      const mine = keys.per[id] || (keys.per[id] = { s: '', p: '' });
      for (const which of ['s', 'p']) {
        if (wants[which] && (!mine[which] || expired)) { mine[which] = noticeRandomKey(); changed = true; }
        else if (!wants[which] && mine[which]) { mine[which] = ''; changed = true; }
      }
    }
  }
  if (changed) keys.at = Date.now();
  chatState.prefs.noticeKeys = keys;
  if (changed) saveChatPrefs();
  try {
    if (wants.s || wants.p) {
      const list = [];
      for (const [id, mine] of Object.entries(keys.per)) {
        const peer = audience.get(id);
        list.push({ s: await noticeOpeningKey(mine.s), p: await noticeOpeningKey(mine.p), name: noticeSavedName(peer) });
      }
      await noticeStoreWrite({ list, show: wants, at: keys.at });
    } else {
      await noticeStoreWrite(null);
    }
  } catch (error) {
    console.warn('[Chat] the notification keys could not be kept for the worker:', error);
  }
  if (changed || redistribute || dropped.length) await giveNoticeKeysToContacts({ revoked: dropped });
}

/* The sealed message that hands a contact their keys (or takes them back: an
   empty key is a revocation). Never in the clear: with no prekey of theirs to
   seal to it waits, and so does a contact the relay has not shown us yet. */
function noticeKeyMessage(mine) {
  return { type: 'notice-key', v: 2, s: mine?.s || '', p: mine?.p || '', createdAt: new Date().toISOString() };
}
function noticeAudience() {
  return (chatState.peers || []).filter((peer) => !peer.type && !peer.system && !peer.blocked
    && typeof isSelfPeerRecord === 'function' && !isSelfPeerRecord(peer)
    && typeof isProfileAudience === 'function' && isProfileAudience(peer)
    /* A locked conversation exists to keep its words off screens the owner has
       not opened; a contact in one is given no key, so nothing of theirs can
       show on a lock screen (the worker cannot see locks, so it is done here). */
    && !(typeof conversationLocked === 'function' && typeof getConversationKey === 'function' && conversationLocked(getConversationKey(peer))));
}
/* The name THIS device has for a contact — what the worker shows, never the one
   a hint carries: a contact holding a key could otherwise sign as "Mom". */
function noticeSavedName(peer) {
  return String(peer?.nickname || peer?.username || peer?.name || '').trim().slice(0, 60);
}
async function giveNoticeKeysToContacts({ revoked = [] } = {}) {
  const keys = noticeKeysOf(chatState.prefs);
  const given = chatState.prefs.noticeGivenTo && typeof chatState.prefs.noticeGivenTo === 'object' ? chatState.prefs.noticeGivenTo : {};
  let sent = 0;
  const reachable = (peer) => chatState.sessions.get(peer.peerId)?.connection?.open || peer.prekeyPublic;
  const send = (peer, mine, tag) => {
    try {
      if (typeof relaySessionEvent === 'function' && relaySessionEvent(peer, noticeKeyMessage(mine))) {
        given[peer.fingerprint || peer.peerId] = tag;
        sent += 1;
      }
    } catch (error) { console.warn('[Chat] a notification key could not be sent:', error); }
  };
  for (const peer of noticeAudience()) {
    const id = peer.fingerprint || peer.peerId;
    const mine = keys.per[id];
    if (!id || !mine || !reachable(peer)) continue;
    const tag = `${mine.s.slice(0, 6)}|${mine.p.slice(0, 6)}`;
    if (given[id] !== tag) send(peer, mine, tag);
  }
  /* A contact whose key was taken back is told so, if it ever had one; a
     blocked contact is not messaged at all, and just stops being believed here. */
  for (const id of revoked) {
    if (!given[id]) continue;
    const peer = (chatState.peers || []).find((item) => (item.fingerprint || item.peerId) === id);
    if (peer && !peer.blocked && reachable(peer)) send(peer, { s: '', p: '' }, '');
    else delete given[id];
  }
  chatState.prefs.noticeGivenTo = given;
  if (sent) saveChatPrefs();
  return sent;
}

/* A contact's keys, received. Only from a contact: the message arrives sealed
   and in a session whose sender is established. */
async function handleNoticeKeyMessage(session, message) {
  const peer = typeof findPeerBySession === 'function' ? findPeerBySession(session) : null;
  if (!peer || peer.type || peer.system) return;
  const clean = (value) => {
    const text = String(value || '');
    if (!text) return '';
    try { return noticeFromB64(text).length === 32 ? text : ''; } catch (_error) { return ''; }
  };
  const next = { s: clean(message.s), p: clean(message.p), at: Date.now() };
  const before = JSON.stringify(peer.noticeKeys || {});
  if (next.s || next.p) peer.noticeKeys = next; else delete peer.noticeKeys;
  if (before !== JSON.stringify(peer.noticeKeys || {}) && typeof saveContacts === 'function') saveContacts();
}

/* ---- the hint a sender adds --------------------------------------------------- */

const NOTICE_WAKING_TYPES = new Set(['text', 'rich', 'space-message', 'voice', 'sticker', 'file', 'file-start', 'location']);
function noticePadded(value, buckets) {
  let text = JSON.stringify(value);
  const size = new TextEncoder().encode(text).length;
  const target = buckets.find((bucket) => bucket >= size + 12) || (buckets[buckets.length - 1]);
  const fill = Math.max(0, target - size - 9);
  if (fill) { text = JSON.stringify({ ...value, pad: '0'.repeat(fill) }); }
  return new TextEncoder().encode(text);
}
async function noticeSeal(rawB64, value, buckets) {
  const key = await crypto.subtle.importKey('raw', noticeFromB64(rawB64), { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, noticePadded(value, buckets));
  return { iv: noticeB64(iv), c: noticeB64(new Uint8Array(cipher)) };
}
/* What was just written, found again by its id in the conversation it was
   written to: the send paths hold only ciphertext by now. */
function noticeEntryFor(peerRecord, message) {
  const id = message?.id || message?.messageId;
  if (!id) return null;
  const keys = [message.spaceId, typeof getConversationKey === 'function' ? getConversationKey(peerRecord) : ''].filter(Boolean);
  for (const key of keys) {
    const list = chatState.history?.[key];
    if (!Array.isArray(list)) continue;
    for (let at = list.length - 1; at >= 0 && at >= list.length - 40; at -= 1) if (list[at]?.id === id) return list[at];
  }
  return null;
}
async function noticeHintFor(peerRecord, message) {
  const keys = peerRecord?.noticeKeys;
  if (!keys || (!keys.s && !keys.p)) return null;
  if (!NOTICE_WAKING_TYPES.has(String(message?.type || ''))) return null;
  const entry = noticeEntryFor(peerRecord, message);
  if (!entry) return null;
  const hint = {};
  try {
    if (keys.s) {
      const name = String(chatState.profile?.name || '').trim().slice(0, 48);
      if (name) hint.n = await noticeSeal(keys.s, { n: name, at: Date.now() }, [NOTICE_NAME_BYTES]);
    }
    if (keys.p) hint.p = await noticeSeal(keys.p, { k: noticeKindOf(entry), t: noticeTextOf(entry), at: Date.now() }, NOTICE_BODY_BUCKETS);
  } catch (error) {
    console.warn('[Chat] a notification hint could not be made:', error);
    return null;
  }
  return hint.n || hint.p ? hint : null;
}

/* ---- the settings ------------------------------------------------------------- */

function syncNoticeToggles() {
  const sender = document.getElementById('chatNoticeShowSender');
  const preview = document.getElementById('chatNoticeShowPreview');
  if (sender) sender.checked = noticeWantsSender();
  if (preview) preview.checked = noticeWantsPreview();
}
function onNoticeToggle(which, event) {
  chatState.prefs = chatState.prefs || {};
  chatState.prefs[which] = Boolean(event.target.checked);
  saveChatPrefs();
  syncNoticeKeys().catch((error) => console.warn('[Chat] notification keys:', error));
  if (typeof syncChatToggleStates === 'function') syncChatToggleStates();
}
document.getElementById('chatNoticeShowSender')?.addEventListener('change', (event) => onNoticeToggle('notifyShowSender', event));
document.getElementById('chatNoticeShowPreview')?.addEventListener('change', (event) => onNoticeToggle('notifyShowPreview', event));
/* On the way up, and when a contact appears: whoever has not been given the
   keys yet is. Not before the vault is open (the keys live in the prefs). */
window.addEventListener('poorija:unlock', () => {
  setTimeout(() => { syncNoticeToggles(); if (noticeWantsSender() || noticeWantsPreview()) syncNoticeKeys({ redistribute: true }).catch(() => {}); }, 2500);
});
setInterval(() => {
  if (!noticeWantsSender() && !noticeWantsPreview()) return;
  if (typeof isUnlocked === 'function' && !isUnlocked()) return;
  syncNoticeKeys().catch(() => {});
}, 60000);

/* ---- published to globalThis (roadmap 2.1, tools/esm-chat.cjs) ---- */
Object.defineProperties(globalThis, {
  "NOTICE_DB": { get() { return NOTICE_DB; }, set() { throw new TypeError('Assignment to constant variable NOTICE_DB.'); }, configurable: true },
  "NOTICE_NAME_BYTES": { get() { return NOTICE_NAME_BYTES; }, set() { throw new TypeError('Assignment to constant variable NOTICE_NAME_BYTES.'); }, configurable: true },
  "NOTICE_BODY_BUCKETS": { get() { return NOTICE_BODY_BUCKETS; }, set() { throw new TypeError('Assignment to constant variable NOTICE_BODY_BUCKETS.'); }, configurable: true },
  "NOTICE_TEXT_CHARS": { get() { return NOTICE_TEXT_CHARS; }, set() { throw new TypeError('Assignment to constant variable NOTICE_TEXT_CHARS.'); }, configurable: true },
  "NOTICE_KEY_TTL_MS": { get() { return NOTICE_KEY_TTL_MS; }, set() { throw new TypeError('Assignment to constant variable NOTICE_KEY_TTL_MS.'); }, configurable: true },
  "noticeWantsSender": { get() { return noticeWantsSender; }, set(value) { noticeWantsSender = value; }, configurable: true },
  "noticeWantsPreview": { get() { return noticeWantsPreview; }, set(value) { noticeWantsPreview = value; }, configurable: true },
  "noticeKindWord": { get() { return noticeKindWord; }, set(value) { noticeKindWord = value; }, configurable: true },
  "noticeKindOf": { get() { return noticeKindOf; }, set(value) { noticeKindOf = value; }, configurable: true },
  "noticeTextOf": { get() { return noticeTextOf; }, set(value) { noticeTextOf = value; }, configurable: true },
  "noticeLineFor": { get() { return noticeLineFor; }, set(value) { noticeLineFor = value; }, configurable: true },
  "noticeB64": { get() { return noticeB64; }, set(value) { noticeB64 = value; }, configurable: true },
  "noticeFromB64": { get() { return noticeFromB64; }, set(value) { noticeFromB64 = value; }, configurable: true },
  "noticeKeysOf": { get() { return noticeKeysOf; }, set(value) { noticeKeysOf = value; }, configurable: true },
  "noticeDbOpen": { get() { return noticeDbOpen; }, set(value) { noticeDbOpen = value; }, configurable: true },
  "noticeStoreWrite": { get() { return noticeStoreWrite; }, set(value) { noticeStoreWrite = value; }, configurable: true },
  "noticeOpeningKey": { get() { return noticeOpeningKey; }, set(value) { noticeOpeningKey = value; }, configurable: true },
  "noticeRandomKey": { get() { return noticeRandomKey; }, set(value) { noticeRandomKey = value; }, configurable: true },
  "syncNoticeKeys": { get() { return syncNoticeKeys; }, set(value) { syncNoticeKeys = value; }, configurable: true },
  "noticeKeyMessage": { get() { return noticeKeyMessage; }, set(value) { noticeKeyMessage = value; }, configurable: true },
  "noticeAudience": { get() { return noticeAudience; }, set(value) { noticeAudience = value; }, configurable: true },
  "noticeSavedName": { get() { return noticeSavedName; }, set(value) { noticeSavedName = value; }, configurable: true },
  "giveNoticeKeysToContacts": { get() { return giveNoticeKeysToContacts; }, set(value) { giveNoticeKeysToContacts = value; }, configurable: true },
  "handleNoticeKeyMessage": { get() { return handleNoticeKeyMessage; }, set(value) { handleNoticeKeyMessage = value; }, configurable: true },
  "NOTICE_WAKING_TYPES": { get() { return NOTICE_WAKING_TYPES; }, set() { throw new TypeError('Assignment to constant variable NOTICE_WAKING_TYPES.'); }, configurable: true },
  "noticePadded": { get() { return noticePadded; }, set(value) { noticePadded = value; }, configurable: true },
  "noticeSeal": { get() { return noticeSeal; }, set(value) { noticeSeal = value; }, configurable: true },
  "noticeEntryFor": { get() { return noticeEntryFor; }, set(value) { noticeEntryFor = value; }, configurable: true },
  "noticeHintFor": { get() { return noticeHintFor; }, set(value) { noticeHintFor = value; }, configurable: true },
  "syncNoticeToggles": { get() { return syncNoticeToggles; }, set(value) { syncNoticeToggles = value; }, configurable: true },
  "onNoticeToggle": { get() { return onNoticeToggle; }, set(value) { onNoticeToggle = value; }, configurable: true },
});
