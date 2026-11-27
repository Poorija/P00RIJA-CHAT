/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Part 28 of 36 of the Secure Chat module.
   Split out of the original single-file js/chat.js — see js/chat/README.md.
   These files share one global scope and are loaded in order; the numbering is
   that order and must not be changed.

   Offline envelopes seal themselves.
*/

/* ------------------------------------------------------------------
 * Offline envelopes seal themselves.
 *
 * A live session negotiates one AES key that both ends keep. That model
 * cannot be reused for store-and-forward: if both peers are offline and both
 * write to each other, each would mint a key, each would accept the other's,
 * and each would then encrypt under a key the other has just discarded. The
 * messages become unreadable and nothing reports an error, because both sides
 * believe they hold "the" session key.
 *
 * So an offline envelope carries its own. A fresh AES-256-GCM key per
 * envelope, wrapped to the recipient's RSA-OAEP-3072 public key, travels with
 * the ciphertext. There is no shared state to disagree about, no dependency on
 * delivery order, and no requirement that the recipient still holds a session
 * key from some earlier conversation — which is the other way offline delivery
 * used to fail, silently, after a reinstall.
 *
 * The relay sees the wrapped key and cannot open it: unwrapping needs the
 * recipient's private key, which never leaves their device.
 * ------------------------------------------------------------------ */
/* The forward-secret way to write to somebody who is not here.
   An ephemeral pair is made for this one envelope, the shared secret comes
   from it and the recipient's published prekey, and the private half is
   dropped before this function returns — it exists only inside this call.
   What travels is the ephemeral PUBLIC key and the id of the prekey used, so
   the recipient knows which of their own private prekeys to reach for. When
   that prekey expires they delete it, and the envelope stops being openable
   by anyone including them. That is the fifteen-day window the UI promises. */
/* Silence would be the wrong answer here: something was sent, it waited too
   long, and the person it was sent to should be told that rather than left to
   assume nothing was ever sent. */
function noteExpiredEnvelope(session, payload) {
  const peer = findPeerBySession(session);
  /* Whatever names this conversation. An envelope whose window has closed
     still knows who sent it, so there is always somewhere to put the note. */
  const conversationId = getPeerHistoryKey(peer, session)
    || session?.conversationId
    || (payload?.fromPeerId ? `peer:${payload.fromPeerId}` : '')
    || payload?.fromFingerprint
    || '';
  if (!conversationId) return;
  appendHistory(conversationId, {
    id: `expired-${payload.createdAt || Date.now()}`,
    type: 'system-note',
    direction: 'in',
    text: t(
      'یک پیام تحویل‌نشده رسید که پنجرهٔ ۱۵ روزه‌اش تمام شده بود و دیگر قابل باز کردن نیست.',
      'An undelivered message arrived after its 15-day window had closed and can no longer be opened.',
    ),
    createdAt: new Date().toISOString(),
  });
  renderPeers();
  renderMessages();
}

async function sealWithPrekey(peerRecord, rawKeyBytes) {
  const prekeyPublic = peerRecord?.prekeyPublic || '';
  const prekeyId = peerRecord?.prekeyId || '';
  if (!prekeyPublic || !prekeyId) return null;
  if (peerRecord.prekeyExpiresAt && Date.parse(peerRecord.prekeyExpiresAt) <= Date.now()) return null;
  /* The check that matters, at the moment it matters: a prekey that is not
     signed by the identity key pinned for this contact is somebody else's,
     whoever handed it over. The caller then seals to the identity key. */
  if (!await prekeyIsTheirs(peerRecord)) return null;
  try {
    const ephemeral = await generateEcdhPair();
    const theirPrekey = await importEcdhPublic(prekeyPublic);
    /* Both halves, when the prekey has both and the second is theirs: an
       ML-KEM secret encapsulated to it joins the curve's in the key the seal
       is made under. The message waits on the relay under this seal, which
       is the reason it is not left to the curve alone. */
    if (kexHybridAvailable() && await prekeyPqIsTheirs(peerRecord)) {
      const sealedPq = PoorijaMlKem.encapsulate(new Uint8Array(app().base64ToArrayBuffer(peerRecord.prekeyPq)));
      const pqct = app().arrayBufferToBase64(sealedPq.cipherText.buffer.slice(sealedPq.cipherText.byteOffset, sealedPq.cipherText.byteOffset + sealedPq.cipherText.byteLength));
      const transcript = await kexDigest(`${prekeyId}|${ephemeral.publicKeyData}|${pqct}`);
      const hybridKey = await deriveHybridWrapKey(ephemeral.keyPair.privateKey, theirPrekey, sealedPq.sharedSecret, transcript);
      const hybridIv = app().generateSecureRandomBytes(12);
      const hybridWrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: hybridIv }, hybridKey, rawKeyBytes);
      return {
        v: 3,
        prekeyId,
        kex: ephemeral.publicKeyData,
        pqct,
        iv: Array.from(hybridIv),
        key: app().arrayBufferToBase64(hybridWrapped),
      };
    }
    const wrapKey = await deriveSharedAesKey(ephemeral.keyPair.privateKey, theirPrekey, 'poorija-offline-v2');
    const iv = app().generateSecureRandomBytes(12);
    const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, rawKeyBytes);
    return {
      v: 2,
      prekeyId,
      kex: ephemeral.publicKeyData,
      iv: Array.from(iv),
      key: app().arrayBufferToBase64(wrapped),
    };
  } catch (error) {
    console.warn('[Chat] prekey seal unavailable, falling back:', error);
    return null;
  }
}
/* The other side of it. A missing or expired prekey is not an error to work
   around — it is the window having closed. */
async function openPrekeySeal(kex) {
  if (!kex || (kex.v !== 2 && kex.v !== 3) || !kex.prekeyId || !kex.kex) return null;
  const mine = findPrekey(kex.prekeyId);
  if (!mine) return null;
  const privateKey = await importEcdhPrivate(mine.privateKeyData);
  const theirEphemeral = await importEcdhPublic(kex.kex);
  if (kex.v === 3) {
    /* Sealed under both halves. Without this prekey's ML-KEM secret there is
       no opening it — and no falling back to the curve alone, which is not
       the key it was sealed under. */
    if (!kex.pqct || !mine.pqSecret || !kexHybridAvailable()) return null;
    const pqct = new Uint8Array(app().base64ToArrayBuffer(kex.pqct));
    if (pqct.length !== PoorijaMlKem.ciphertextBytes) return null;
    const pqSecret = PoorijaMlKem.decapsulate(pqct, new Uint8Array(app().base64ToArrayBuffer(mine.pqSecret)));
    const transcript = await kexDigest(`${kex.prekeyId}|${kex.kex}|${kex.pqct}`);
    const hybridKey = await deriveHybridWrapKey(privateKey, theirEphemeral, pqSecret, transcript);
    const opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(kex.iv || []) }, hybridKey, app().base64ToArrayBuffer(kex.key));
    return crypto.subtle.importKey('raw', opened, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  }
  const wrapKey = await deriveSharedAesKey(privateKey, theirEphemeral, 'poorija-offline-v2');
  const raw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(kex.iv || []) }, wrapKey, app().base64ToArrayBuffer(kex.key));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

/* The session key, sealed to the contact's identity key, rides in an envelope
   only for a contact who has never shown anything better. For one who has
   done a hybrid exchange (kexPinned) or runs a ratchet with this device, the
   key a session holds is a ratchet seed or a post-quantum key: sealing it to
   the identity key would hand every later message to whoever ever holds that
   key, and lower the post-quantum exchange to the curve. The call sites
   already avoided it; nothing here stopped one that did not (roadmap 5.2,
   finding F3). */
function identitySealRefused(session, peerRecord) {
  const record = peerRecord || (typeof findPeerBySession === 'function' ? findPeerBySession(session) : null);
  if (session?.ratchet) return true;
  if (!record) return Boolean(session?.ratchet);
  return Number(record.kexPinned || 0) >= KEX_HYBRID || Number(record.ratchetPinned || 0) >= 1;
}
async function sealSessionKeyFor(session, peerRecord, contentKey = null) {
const key = contentKey || session?.cryptoKey;
if (!key) return '';
if (identitySealRefused(session, peerRecord)) return '';
const publicKeyData = peerRecord?.publicKeyData || session.remotePublicKeyData || '';
if (!publicKeyData) return '';
const rawKey = await crypto.subtle.exportKey('raw', key);
const wrapped = await sealToIdentity(peerRecord || { publicKeyData }, 'offline', rawKey);
return app().arrayBufferToBase64(wrapped);
}
async function openOfflineSeal(seal) {
if (!seal) return null;
const raw = await openIdentitySeal('offline', app().base64ToArrayBuffer(seal));
return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}
/* A seal to a contact's account key (what RSA-OAEP to their identity key
   was): to their X25519 agreement key once they moved to identity v4, RSA
   otherwise. The record is the contact as this device pinned it. */
async function sealToIdentity(record, purpose, plain) {
const contact = () => {
/* The live record, which a presence answer may have filled in meanwhile. */
const live = record?.fingerprint ? ((chatState.peers || []).find((peer) => peer.fingerprint === record.fingerprint) || record) : record;
return {
publicKeyData: live?.trustedKey || live?.publicKeyData || record?.publicKeyData || '',
fingerprint: live?.trustedFingerprint || live?.fingerprint || '',
agreeKey: live?.agreeKey || record?.agreeKey || '',
agreeKeySig: live?.agreeKeySig || record?.agreeKeySig || '',
};
};
let target = contact();
/* A v4 contact met before their agreement key reached this device (the
   relay's table, their card or their session-hello carry it): asked for once,
   and waited on briefly, before the seal is given up. */
if (PoorijaIdentity.keyKind(target.publicKeyData) === 'v4' && !target.agreeKey) {
try { if (chatState.ws?.readyState === WebSocket.OPEN) chatState.ws.send(JSON.stringify({ type: 'get-peers' })); } catch (_error) { /* not connected */ }
for (let waited = 0; waited < 4000 && !target.agreeKey; waited += 250) {
await new Promise((resolve) => setTimeout(resolve, 250));
target = contact();
}
}
return PoorijaIdentity.sealTo(target, purpose, plain);
}
/* This account, as a contact record for sealing to itself (device sync,
   beacon, sibling files): every device of the account holds the keys. */
function ownIdentityRecord() {
const identity = chatState.identity || {};
return { publicKeyData: identity.publicKeyData, fingerprint: identity.fingerprint, agreeKey: identity.ak || '', agreeKeySig: identity.akSig || '' };
}
/* Opens a seal to this account, v4 or RSA (the RSA key of an account that
   moved, for its ninety days). */
async function openIdentitySeal(purpose, sealed) {
const identity = await ensureIdentity();
if (!identity) throw new Error('no identity to open with');
return PoorijaIdentity.openSealed(identity, purpose, sealed);
}
/* Builds the envelope every offline send goes through, so the seal cannot be
   forgotten at one call site out of ten. `class` is the only thing the relay
   reads: it keeps text indefinitely and expires media after seven days, and it
   cannot tell them apart from ciphertext alone. */
/* ------------------------------------------------------------------
 * What the relay is allowed to see
 *
 * The body was already sealed; the envelope around it was not. A queued
 * file-start sat in the mailbox with `name`, `mime`, `kind`, `size`,
 * `durationMs` and the timers all in the clear, so anyone holding that file —
 * a server operator, whoever finds a backup, anyone who compels one — learned
 * every filename people had sent while the other side was away, with its type
 * and size. The contents were encrypted and nothing else was.
 *
 * `body` now carries the whole message encrypted under the session key that
 * `seal` already wraps to the recipient, so opening it needs the recipient's
 * private key and nothing else. The relay keeps only what it actually uses:
 * the class, to know how long to hold it, and the routing fields.
 * ------------------------------------------------------------------ */
function offlineEnvelope(message, { createdAt, seal = '', messageClass = 'text', body = null, kex = null, notify = true, scope = '', hint = null } = {}) {
const envelope = {
type: 'offline-chat',
fromPeerId: chatState.peerId,
fromFingerprint: chatState.identity?.fingerprint || '',
seal,
class: messageClass,
createdAt: createdAt || message?.createdAt || new Date().toISOString(),
};
/* Two hints the relay is allowed to read, so the notification it sends can say
   what kind of thing is waiting. Neither carries content, a name, or a group
   id: `scope` says only "this belongs to a group", and `signal` is the call
   verb plus voice-or-video, which 1:1 call signalling has always sent in the
   clear anyway. Without them a group call to a phone that is asleep rings as
   "chat update", which is worse than the small amount this admits. */
const signalType = String(message?.type || '');
/* What is inside, by name only.
 *
 * Everything an envelope wraps comes out as type 'offline-chat', and both the
 * decision to store it and the decision to ring a phone for it were made from
 * that outer name. A delivery receipt or a typing flag sent to somebody who
 * had stepped away was therefore stored like a message and rang like one -
 * which is where a screen full of "Encrypted chat update received" with
 * nothing behind it came from. The name is enough to tell them apart and says
 * nothing the relay could not already infer from the timing. */
if (signalType) envelope.inner = signalType;
if (/^g?call-/.test(signalType)) {
envelope.signal = signalType;
if (message?.mode === 'video' || message?.mode === 'voice') envelope.mode = message.mode;
}
/* Nothing ephemeral is worth waking anyone for. */
if (EPHEMERAL_RELAY_TYPES.has(signalType)) envelope.notify = false;
/* A `gcall-` verb is a group call by definition, so the caller does not have
   to remember to say so. */
const groupScope = scope || (signalType.startsWith('gcall-') || message?.spaceId ? 'group' : '');
if (groupScope) envelope.scope = groupScope;
/* The forward-secret path. Present instead of `seal` when the recipient had a
   live prekey to write to. */
if (kex) envelope.kex = kex;
/* Whether this envelope is worth waking a device for. The relay cannot see
   inside a sealed envelope, so it cannot tell a message from the fortieth
   chunk of a file — this is the one bit of metadata that lets it ring once for
   the file rather than once per chunk, and it says nothing about content. */
if (notify === false) envelope.notify = false;
/* Two ciphertexts the relay cannot open and hands on with the push: the
   sender's name and the kind of thing, each under a key the recipient gave
   for exactly that (69-notice-hints.js). */
if (hint && typeof hint === 'object' && (hint.n || hint.p)) envelope.hint = hint;
/* No session key means no key to encrypt with, and in that case the plaintext
   shape is the only way the message travels at all. Older builds also only
   understand that shape, so it stays readable. */
if (body) envelope.body = body;
else envelope.message = message;
return envelope;
}
/* ------------------------------------------------------------------
 * A session's payloads, bound to where they belong (roadmap 1.1)
 *
 * Every payload under a session key used to be AES-GCM with no additional
 * data: the same ciphertext could be delivered twice, delivered as another
 * kind of message (a text's payload as an edit of an older message), or read
 * as written in the other direction, and the tag still checked.
 *
 * Toward a contact whose build says it reads them ('aad1', in the caps every
 * hello and sealed body carries), a payload is now sealed by
 * js/crypto/aad.js with the session id, both fingerprints, the kind and a
 * sequence number as additional data, and a number seen before is refused.
 * A contact seen once to bind (`aadPinned`) is not accepted unbound again:
 * an attacker leaving the binding out is what a downgrade would look like.
 *
 * `kind` is what the payload is for, and has to be the same on both sides:
 * the message type, or the type and the field for a second payload in one
 * message ('text.preview').
 * ------------------------------------------------------------------ */
const AAD_CAP = 'aad1';
function sessionAadAvailable() {
return typeof PoorijaSessionAad === 'object' && typeof PoorijaSessionAad.seal === 'function';
}
function sessionAadPeerOf(session) {
return typeof findPeerBySession === 'function' ? findPeerBySession(session) : null;
}
/* The two names a payload is bound to. The far side's is the one pinned for
   the contact, never one the payload itself could supply. */
function sessionAadNames(session, direction) {
const mine = chatState.identity?.fingerprint || '';
const record = sessionAadPeerOf(session);
const theirs = record?.trustedFingerprint || record?.fingerprint || session?.remoteFingerprint || '';
return direction === 'out' ? { from: mine, to: theirs } : { from: theirs, to: mine };
}
function sessionBinds(session) {
if (!sessionAadAvailable()) return false;
const record = sessionAadPeerOf(session);
if (!record) return false;
if (record.aadPinned) return true;
return typeof peerSupports === 'function' && peerSupports(record, AAD_CAP);
}
function pinSessionAad(session) {
const record = sessionAadPeerOf(session);
if (!record || record.aadPinned) return;
record.aadPinned = true;
if (typeof saveContacts === 'function') saveContacts();
}
/* AES-GCM under the session key with no binding, for the few containers
   that are opened the same way whatever key they are under (a sealed
   envelope's body). Everything a contact reads as a message goes through
   encryptForSession. */
async function encryptUnboundForSession(session, plainBytes) {
const iv = app().generateSecureRandomBytes(12);
const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, session.cryptoKey, plainBytes);
return { iv: Array.from(iv), cipher: app().arrayBufferToBase64(cipher) };
}
/* One thing at a time per session.
 *
 * What a session seals and opens moves the state it keeps (the ratchet's chains and
 * its DH step, the binding's counters), and each of those steps awaits WebCrypto
 * in the middle of reading and writing that state. Two at once — and two people
 * writing at the same moment is exactly two at once: a message arriving while
 * another is being opened, a reply sealed while the next is — each read the state
 * as it was before the other's step, and one of them used a key the other had
 * already moved past: a tag that does not open (OperationError), the message left
 * on the relay unacknowledged and never shown, in the engine that interleaves
 * them (WebKit; Chromium happened to finish each before the next began). They are
 * run in the order they were asked, one after another. */
const sessionTurns = new WeakMap();
const contactTurns = new Map();
function inSessionTurn(session, work) {
  if (!session || typeof session !== 'object') return work();
  /* One line per contact, not per session object: a contact can be reached by
     two (a live one, and one made for mail), and both step the same chains. */
  const fingerprint = String(session.remoteFingerprint || '');
  const table = fingerprint ? contactTurns : sessionTurns;
  const key = fingerprint || session;
  const before = table.get(key) || Promise.resolve();
  const mine = before.then(work, work);
  const tail = mine.then(() => undefined, () => undefined);
  table.set(key, tail);
  tail.then(() => { if (table.get(key) === tail) table.delete(key); });
  return mine;
}
/* Which key each payload was sealed under, remembered by the payload itself (not
   written into it): an envelope that encloses the key has to enclose THAT one.
   It used to enclose whatever the session held when the envelope was built, a
   moment after the payload was sealed — and when two people begin at the same
   instant the session's key is replaced in between (the offline key by the
   negotiated one): the payload under the first, the envelope carrying the second,
   a tag that opens for nobody, the message left on the relay unacknowledged
   and never shown. */
const payloadKeys = new WeakMap();
function keyOfPayload(payload) {
  if (payload && typeof payload === 'object') {
    const direct = payloadKeys.get(payload);
    if (direct) return direct;
    for (const value of Object.values(payload)) {
      if (value && typeof value === 'object' && payloadKeys.has(value)) return payloadKeys.get(value);
    }
  }
  return null;
}
async function encryptForSession(session, plainBytes, kind) {
return inSessionTurn(session, async () => {
const keyNow = session?.cryptoKey || null;
const sealed = await encryptForSessionNow(session, plainBytes, kind);
if (sealed && typeof sealed === 'object' && keyNow) payloadKeys.set(sealed, keyNow);
return sealed;
});
}
async function encryptForSessionNow(session, plainBytes, kind) {
/* Required, not defaulted: a payload sealed as one kind and opened as another
   does not open, and a default is how a caller gets that wrong silently. */
if (!kind) throw new TypeError('encryptForSession: kind is required');
/* A key per message (roadmap 1.3): a session keyed as chains seals with the
   next key of its sending chain, bound as in 1.1. */
if ((session?.ratchet?.send || session?.ratchet?.v === 2) && typeof PoorijaRatchet === 'object') {
const names = sessionAadNames(session, 'out');
if (names.from && names.to) return PoorijaRatchet.seal(session, plainBytes, { kind, ...names, fingerprint: names.to });
}
if (sessionBinds(session)) {
const names = sessionAadNames(session, 'out');
if (names.from && names.to) {
return PoorijaSessionAad.seal(session, plainBytes, { kind, ...names });
}
}
return encryptUnboundForSession(session, plainBytes);
}
/* The per-message ratchet (roadmap 1.3, js/crypto/ratchet-bridge.js). */
const RATCHET_CAP = 'dr1';
/* The ratchet level this device runs: 0 off, 1 chains (2.8), 2 chains with
   the DH and post-quantum steps (2.9). 'poorija-ratchet' = 'off' or '1' holds
   a device back. */
function ratchetAvailable() {
if (typeof PoorijaRatchet !== 'object') return 0;
let hold = '';
try { hold = localStorage.getItem('poorija-ratchet') || ''; } catch (_error) { /* private mode */ }
if (hold === 'off') return 0;
if (hold === '1') return 1;
return typeof PoorijaMlKem === 'object' && typeof PoorijaRatchet.offer === 'function' ? 2 : 1;
}
/* The highest level a contact has been seen at; never offered less again. */
function ratchetPinnedFor(session) {
const pinned = sessionAadPeerOf(session)?.ratchetPinned;
return pinned === true ? 1 : Number(pinned) || 0;
}
function pinRatchet(session) {
const record = sessionAadPeerOf(session);
const level = typeof PoorijaRatchet === 'object' ? PoorijaRatchet.version(session) : 0;
if (!record || !level || ratchetPinnedFor(session) >= level) return;
record.ratchetPinned = level;
if (typeof saveContacts === 'function') saveContacts();
}
/* A refusal that is not a broken key. The connection's error handler takes
   OperationError for a key mismatch and renegotiates; a replay or a stripped
   binding is somebody on the path, and renegotiating would hand them a way to
   reset the session at will. Callers drop the message. */
class SessionPayloadRefused extends Error {
constructor(reason) {
super(`session payload refused: ${reason}`);
this.name = 'SessionPayloadRefused';
this.reason = reason;
}
}
async function decryptForSession(session, payload, kind) {
return inSessionTurn(session, () => decryptForSessionNow(session, payload, kind));
}
async function decryptForSessionNow(session, payload, kind) {
if (!kind) throw new TypeError('decryptForSession: kind is required');
if (payload && (payload.r === 1 || payload.r === 2)) {
if (typeof PoorijaRatchet !== 'object') throw new SessionPayloadRefused('ratchet unavailable');
const names = sessionAadNames(session, 'in');
/* The chains of this session, or kept from before a reload. */
if (!session.ratchet && !PoorijaRatchet.restore(session, names.from)) throw new SessionPayloadRefused('no-chain');
try {
const plain = await PoorijaRatchet.open(session, payload, { kind, ...names, fingerprint: names.from });
pinRatchet(session);
return plain;
} catch (error) {
if (error?.name === 'ChainError') {
console.warn(`[Chat] dropped a ${kind} payload: ${error.message}`);
throw new SessionPayloadRefused(error.reason);
}
throw error;
}
}
/* A contact seen once on the ratchet does not get to send under the
   session key again: that is what stripping the ratchet would look like. */
if (payload && ratchetPinnedFor(session) > 0) {
console.warn(`[Chat] refused a ${kind} payload outside the ratchet from a contact who uses it`);
throw new SessionPayloadRefused('no-ratchet');
}
if (payload && payload.a === 1) {
if (!sessionAadAvailable()) throw new SessionPayloadRefused('binding unavailable');
const names = sessionAadNames(session, 'in');
try {
const plain = await PoorijaSessionAad.open(session, payload, { kind, ...names });
pinSessionAad(session);
return plain;
} catch (error) {
if (error?.name === 'ReplayError') {
console.warn(`[Chat] dropped a ${error.kind} ${kind} payload (seq ${error.seq})`);
throw new SessionPayloadRefused(error.kind);
}
/* A tag that does not check under the binding. The key may be wrong (the
   ordinary mismatch, renegotiated by the caller) or the payload moved —
   the two cannot be told apart, and either way it does not open. */
throw error;
}
}
if (sessionAadPeerOf(session)?.aadPinned) {
console.warn(`[Chat] refused an unbound ${kind} payload from a contact who binds`);
throw new SessionPayloadRefused('unbound');
}
const decrypted = await crypto.subtle.decrypt(
{ name: 'AES-GCM', iv: new Uint8Array(payload.iv || []) },
session.cryptoKey,
app().base64ToArrayBuffer(payload.cipher)
);
return decrypted;
}

/* ------------------------------------------------------------------
 * Who an envelope is from, vouched for by the key that name belongs to.
 *
 * The seal authenticates the RECIPIENT — it is encrypted to a public key,
 * which anybody can do. The sender's name rode on the envelope as a claim,
 * and the v2 body honoured a key the same claimant chose, so whoever held
 * the recipient's public key could queue a message as any of their contacts
 * and the only line of defence was a safety number that does not change when
 * a third party is impersonated — the victim's key is never touched.
 *
 * An envelope is now signed with the sender's identity key over exactly the
 * bytes that carry the claim: the fingerprint, the peer id, the timestamp
 * and the sealed body itself, so a field swapped on the relay breaks the
 * signature along with the claim. A receiver who has pinned the contact's
 * key verifies and drops what fails; a first contact arrives unsigned or
 * unverified exactly as a hello does, and the pin formed by that first
 * contact is what protects every envelope after it.
 * ------------------------------------------------------------------ */
/* Signs with this account's key, whichever kind it is (identity v4,
   js/crypto/identity-bridge.js): Ed25519 for an account that moved, RSA
   PKCS#1 v1.5 for one that has not. Every signature the app makes goes
   through here, so none can be made with the wrong key. */
async function identitySignBytes(bytes) {
const identity = await ensureIdentity();
if (!identity) throw new Error('no identity to sign with');
return PoorijaIdentity.sign(identity, bytes);
}
async function identitySign(bytes) {
return app().arrayBufferToBase64(await identitySignBytes(bytes));
}
/* Against `publicKeyData`, by its kind. A contact that moved is checked with
   their Ed25519 key; within their ninety days, their old RSA key still
   counts for what was signed before the move (verifyContactSignature). */
async function verifyIdentitySignature(publicKeyData, signatureBytes, data) {
return PoorijaIdentity.verify(publicKeyData, signatureBytes, data);
}
/* A signature from a contact: their current key, or — for the ninety days
   after they moved — the RSA key they had before. */
async function verifyContactSignature(record, signatureBytes, data) {
const key = record?.trustedKey || record?.publicKeyData || '';
if (key && await PoorijaIdentity.verify(key, signatureBytes, data)) return true;
const legacy = record?.legacyKey;
if (legacy && Number(record.legacyUntil || 0) > Date.now()) return PoorijaIdentity.verify(legacy, signatureBytes, data);
return false;
}
/* The bytes a sender vouches for. The ciphertext rather than the plaintext:
   the signature then covers the exact envelope the relay holds, and no field
   can be swapped without breaking it. */
function offlineEnvelopeSignBytes(envelope) {
const body = envelope?.body
? `${(envelope.body.iv || []).join(',')}|${envelope.body.cipher || ''}`
: `msg:${JSON.stringify(envelope?.message || null)}`;
const parts = [
envelope?.fromFingerprint || '',
envelope?.fromPeerId || '',
envelope?.createdAt || '',
body,
];
/* v2 names the recipient too (sealed sender, 51-envelope-privacy.js): the
   same envelope re-sealed to somebody else no longer verifies for them. */
if (envelope?.to) parts.push(`to:${envelope.to}`);
return new TextEncoder().encode(parts.join('\n'));
}
async function signOfflineEnvelope(envelope) {
try {
const signature = await identitySignBytes(offlineEnvelopeSignBytes(envelope));
envelope.sig = app().arrayBufferToBase64(signature);
envelope.sigv = envelope.to ? 2 : 1;
} catch (error) {
/* An envelope that cannot be signed still travels — an old receiver would
   ignore the field anyway, and silence is worse than an unverified seal. */
console.warn('[Chat] could not sign the offline envelope:', error);
}
}
/* 'verified' — the pinned key signed it. 'forged' — a key is pinned for the
   name it claims (by peer id or by fingerprint, this account's own included)
   and what arrived does not match it. 'unsigned-pinned' — a contact with a
   pinned key, but no signature: only the harmless kinds of message may pass
   on that (see handleOfflineRelayMessage). 'unknown' — nobody is pinned under
   either name yet: a first contact, trusted on first use as every hello is.
   'unsigned' — no pin and no signature, the pre-signature world.

   Both names an envelope gives are checked, not just the peer id: a sealed
   sender's fingerprint is otherwise only a claim, and an envelope that named
   a contact's fingerprint under an unknown peer id used to be taken at its
   word. The relay's own proven fingerprint, where it has one, must agree with
   the claim too. Any failure to check is a refusal, never a pass. */
async function verifyOfflineEnvelopeSender(payload, fromId, { relayFingerprint = '' } = {}) {
const myFingerprint = chatState.identity?.fingerprint || '';
const claimed = String(payload?.fromFingerprint || '');
/* Written to somebody else and re-sealed to this device. */
if (payload?.to && payload.to !== myFingerprint) return 'forged';
if (relayFingerprint && claimed && relayFingerprint !== claimed) return 'forged';
const byId = typeof findPeerRecordByPeerId === 'function' ? findPeerRecordByPeerId(fromId) : null;
/* A contact who moved to identity v4 is still found by the fingerprint
   they had, for the ninety days in which mail sealed and signed before the
   move may still arrive (65-identity-move.js). */
const byFingerprint = claimed
? ((chatState.peers || []).find((peer) => peer.fingerprint === claimed) || (typeof findPeerByLegacyFingerprint === 'function' ? findPeerByLegacyFingerprint(claimed) : null))
: null;
if (byId && byFingerprint && byId !== byFingerprint) return 'forged';
const record = byId || byFingerprint;
const legacyClaim = Boolean(record && claimed && record.legacyFingerprint === claimed && Number(record.legacyUntil || 0) > Date.now());
if (record?.fingerprint && claimed && record.fingerprint !== claimed && !legacyClaim) return 'forged';
/* This account's own name: only this account's own key can have signed it. */
const claimsSelf = Boolean(myFingerprint) && (claimed === myFingerprint || (fromId && fromId === chatState.peerId));
const publicKeyData = claimsSelf ? String(chatState.identity?.publicKeyData || '') : String((legacyClaim ? record.legacyKey : record?.publicKeyData) || '');
if (!publicKeyData) return payload?.sig ? 'unknown' : 'unsigned';
if (!payload?.sig) return claimsSelf ? 'forged' : 'unsigned-pinned';
try {
const good = await verifyIdentitySignature(
publicKeyData,
app().base64ToArrayBuffer(payload.sig),
offlineEnvelopeSignBytes(payload),
);
return good ? 'verified' : 'forged';
} catch (_error) {
return 'forged';
}
}

/* ------------------------------------------------------------------
 * A space record carries the whole roster — membership, admins, the
 * permissions, the dissolve bit — so who pushed it is the whole question.
 * On the same relay the envelope's sender is the relay's own challenged
 * fingerprint. Over transit that field is deliberately blank (nothing was
 * proved on the carrying leg), and the record used to be refused by every
 * cross-relay member for exactly that reason: their owner's edits never
 * arrived, and a removed member kept a ghost group that others kept
 * encrypting to. The record now names its author inside itself, signed
 * with the identity key, and the recipient checks that signature against
 * the owner's pinned key before a roster moves.
 * ------------------------------------------------------------------ */
function spaceSyncSignBytes(payload) {
return new TextEncoder().encode([
String(payload?.fromFingerprint || ''),
String(payload?.createdAt || ''),
JSON.stringify(payload?.space || null),
String(payload?.note || ''),
].join('\n'));
}
async function signSpaceSyncPayload(payload) {
try {
const signature = await identitySignBytes(spaceSyncSignBytes(payload));
payload.sig = app().arrayBufferToBase64(signature);
payload.sigv = 1;
} catch (error) {
console.warn('[Chat] could not sign the space record:', error);
}
}
async function verifySpaceSyncSender(payload, ownerPublicKeyData) {
try {
if (!payload?.sig || !ownerPublicKeyData) return false;
return await verifyIdentitySignature(
ownerPublicKeyData,
app().base64ToArrayBuffer(payload.sig),
spaceSyncSignBytes(payload),
);
} catch (_error) {
return false;
}
}

/* ---- published to globalThis (roadmap 2.1, tools/esm-chat.cjs) ---- */
Object.defineProperties(globalThis, {
  "noteExpiredEnvelope": { get() { return noteExpiredEnvelope; }, set(value) { noteExpiredEnvelope = value; }, configurable: true },
  "sealWithPrekey": { get() { return sealWithPrekey; }, set(value) { sealWithPrekey = value; }, configurable: true },
  "openPrekeySeal": { get() { return openPrekeySeal; }, set(value) { openPrekeySeal = value; }, configurable: true },
  "identitySealRefused": { get() { return identitySealRefused; }, set(value) { identitySealRefused = value; }, configurable: true },
  "sealSessionKeyFor": { get() { return sealSessionKeyFor; }, set(value) { sealSessionKeyFor = value; }, configurable: true },
  "openOfflineSeal": { get() { return openOfflineSeal; }, set(value) { openOfflineSeal = value; }, configurable: true },
  "sealToIdentity": { get() { return sealToIdentity; }, set(value) { sealToIdentity = value; }, configurable: true },
  "ownIdentityRecord": { get() { return ownIdentityRecord; }, set(value) { ownIdentityRecord = value; }, configurable: true },
  "openIdentitySeal": { get() { return openIdentitySeal; }, set(value) { openIdentitySeal = value; }, configurable: true },
  "offlineEnvelope": { get() { return offlineEnvelope; }, set(value) { offlineEnvelope = value; }, configurable: true },
  "AAD_CAP": { get() { return AAD_CAP; }, set() { throw new TypeError('Assignment to constant variable AAD_CAP.'); }, configurable: true },
  "sessionAadAvailable": { get() { return sessionAadAvailable; }, set(value) { sessionAadAvailable = value; }, configurable: true },
  "sessionAadPeerOf": { get() { return sessionAadPeerOf; }, set(value) { sessionAadPeerOf = value; }, configurable: true },
  "sessionAadNames": { get() { return sessionAadNames; }, set(value) { sessionAadNames = value; }, configurable: true },
  "sessionBinds": { get() { return sessionBinds; }, set(value) { sessionBinds = value; }, configurable: true },
  "pinSessionAad": { get() { return pinSessionAad; }, set(value) { pinSessionAad = value; }, configurable: true },
  "encryptUnboundForSession": { get() { return encryptUnboundForSession; }, set(value) { encryptUnboundForSession = value; }, configurable: true },
  "sessionTurns": { get() { return sessionTurns; }, set() { throw new TypeError('Assignment to constant variable sessionTurns.'); }, configurable: true },
  "contactTurns": { get() { return contactTurns; }, set() { throw new TypeError('Assignment to constant variable contactTurns.'); }, configurable: true },
  "inSessionTurn": { get() { return inSessionTurn; }, set(value) { inSessionTurn = value; }, configurable: true },
  "payloadKeys": { get() { return payloadKeys; }, set() { throw new TypeError('Assignment to constant variable payloadKeys.'); }, configurable: true },
  "keyOfPayload": { get() { return keyOfPayload; }, set(value) { keyOfPayload = value; }, configurable: true },
  "encryptForSession": { get() { return encryptForSession; }, set(value) { encryptForSession = value; }, configurable: true },
  "encryptForSessionNow": { get() { return encryptForSessionNow; }, set(value) { encryptForSessionNow = value; }, configurable: true },
  "RATCHET_CAP": { get() { return RATCHET_CAP; }, set() { throw new TypeError('Assignment to constant variable RATCHET_CAP.'); }, configurable: true },
  "ratchetAvailable": { get() { return ratchetAvailable; }, set(value) { ratchetAvailable = value; }, configurable: true },
  "ratchetPinnedFor": { get() { return ratchetPinnedFor; }, set(value) { ratchetPinnedFor = value; }, configurable: true },
  "pinRatchet": { get() { return pinRatchet; }, set(value) { pinRatchet = value; }, configurable: true },
  "SessionPayloadRefused": { get() { return SessionPayloadRefused; }, set() { throw new TypeError('Assignment to constant variable SessionPayloadRefused.'); }, configurable: true },
  "decryptForSession": { get() { return decryptForSession; }, set(value) { decryptForSession = value; }, configurable: true },
  "decryptForSessionNow": { get() { return decryptForSessionNow; }, set(value) { decryptForSessionNow = value; }, configurable: true },
  "identitySignBytes": { get() { return identitySignBytes; }, set(value) { identitySignBytes = value; }, configurable: true },
  "identitySign": { get() { return identitySign; }, set(value) { identitySign = value; }, configurable: true },
  "verifyIdentitySignature": { get() { return verifyIdentitySignature; }, set(value) { verifyIdentitySignature = value; }, configurable: true },
  "verifyContactSignature": { get() { return verifyContactSignature; }, set(value) { verifyContactSignature = value; }, configurable: true },
  "offlineEnvelopeSignBytes": { get() { return offlineEnvelopeSignBytes; }, set(value) { offlineEnvelopeSignBytes = value; }, configurable: true },
  "signOfflineEnvelope": { get() { return signOfflineEnvelope; }, set(value) { signOfflineEnvelope = value; }, configurable: true },
  "verifyOfflineEnvelopeSender": { get() { return verifyOfflineEnvelopeSender; }, set(value) { verifyOfflineEnvelopeSender = value; }, configurable: true },
  "spaceSyncSignBytes": { get() { return spaceSyncSignBytes; }, set(value) { spaceSyncSignBytes = value; }, configurable: true },
  "signSpaceSyncPayload": { get() { return signSpaceSyncPayload; }, set(value) { signSpaceSyncPayload = value; }, configurable: true },
  "verifySpaceSyncSender": { get() { return verifySpaceSyncSender; }, set(value) { verifySpaceSyncSender = value; }, configurable: true },
});
