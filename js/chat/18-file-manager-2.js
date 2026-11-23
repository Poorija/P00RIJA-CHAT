/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Part 18 of 36 of the Secure Chat module.
   Split out of the original single-file js/chat.js — see js/chat/README.md.
   These files share one global scope and are loaded in order; the numbering is
   that order and must not be changed.

   The local file manager
*/

/* ===================== رلهٔ خانگی مخاطب ===================== */
/* Where a contact lives, and how much that claim is worth.
 *
 * Routing across relays is a decision the CLIENT has to make. The relay a
 * message is handed to cannot be told who it is for -- that is the whole
 * point of blind transit -- so it cannot work out which relay to pass it on
 * to. Only the sender can, and only if each contact record says where that
 * person's messages have to end up.
 *
 * Which makes the claim worth attacking, so it is ranked by the channel it
 * arrived on rather than taken at face value:
 *
 *   card      a QR or a pasted identity card. The same out-of-band channel
 *             that carries the public key, and no more forgeable than that
 *             key is.
 *   session   inside the sealed body of a message. Encrypted end to end, so
 *             no relay wrote it and no relay can read it. It does NOT prove
 *             the sender is who the envelope says: anybody holding the
 *             recipient's public key or current prekey can seal an envelope
 *             claiming to be somebody else, which is what the safety number
 *             exists to catch. That is exactly why a card outranks it — a
 *             claim like this can introduce a home relay for a contact who
 *             has none, and can never displace one that was established out
 *             of band.
 *   presence  a hello, through a relay. The hello is NOT signed: the client
 *             checks that the fingerprint matches the key it came with, and
 *             nothing more. Every other field in it is whatever the relay
 *             chose to forward. A hint, and never anything more.
 *
 * The ladder only goes up. A presence hint cannot displace a value from a
 * card, and no amount of repetition promotes it -- an attacker who can
 * rewrite presence can repeat it as often as they like. Routing acts on a
 * presence-rank claim only when it names a whole relay -- id and key, with
 * the key checked against the id at seal time -- because refusing to route
 * it strands a real contact's messages on the wrong relay. A wrong relay
 * still never sees a message, which stays end-to-end encrypted; what it can
 * see is the carrying metadata, which is the reason a card outranks a
 * presence hint for everything else. */
const HOME_RELAY_TRUST = { presence: 1, session: 2, card: 3 };
/* A home relay is an origin, the id of the relay that must be there, and
   that relay's public key.
 *
 * The origin alone repeats the problem relay identities were added to solve:
 * a hostname is whoever holds the hostname today. The KEY travels too, and
 * that is not redundancy — it is what makes transit work at all in the case
 * it exists for. A client could fetch the key from the far relay and check it
 * against the id, but the whole reason it is sending through a carrier is
 * that it may not be able to reach that relay: if it could, it would not need
 * transit. So the key comes down the same out-of-band channel as the id, and
 * is checked against it at the moment it is used. */
function normalizeHomeRelay(value, source = '') {
if (!value || typeof value !== 'object') return null;
const rank = HOME_RELAY_TRUST[String(source || value.source || '')] ? String(source || value.source) : '';
if (!rank) return null;
let origin = '';
try {
origin = isUsableRelayOrigin(value.origin) ? normalizeRelayOrigin(value.origin, '') : '';
} catch (_error) {
origin = '';
}
if (!origin) return null;
const id = /^[a-f0-9]{64}$/i.test(String(value.id || '')) ? String(value.id).toLowerCase() : '';
/* Kept as it arrived and checked where it is used: the check is a hash, which
   is asynchronous in a browser, and this function is called from the record
   merge where everything else is a plain comparison. A key that does not hash
   to the id is refused at seal time, which is the moment it matters. */
const key = /^[A-Za-z0-9+/=]{40,400}$/.test(String(value.key || '')) ? String(value.key) : '';
return { origin, id, key, source: rank, updatedAt: value.updatedAt || new Date().toISOString() };
}
/* Which of the two to keep. Equal rank means the newer one, because a person
   who moves relays re-shares a card; lower rank never displaces higher. */
function betterHomeRelay(existing, incoming) {
const current = normalizeHomeRelay(existing);
const offered = normalizeHomeRelay(incoming);
if (!offered) return current;
if (!current) return offered;
const currentRank = HOME_RELAY_TRUST[current.source] || 0;
const offeredRank = HOME_RELAY_TRUST[offered.source] || 0;
if (offeredRank < currentRank) return current;
if (offeredRank > currentRank) return offered;
return offered.origin === current.origin && offered.id === current.id && offered.key === current.key
? current : offered;
}
/* What routing is allowed to use. A hint is not an address, and an address
   with nothing to seal to is not one either. */
function routableHomeRelay(peer) {
const home = normalizeHomeRelay(peer?.homeRelay);
if (!home || !home.id || !home.key) return null;
const trust = HOME_RELAY_TRUST[home.source] || 0;
/* Presence-rank routes too: a contact whose home relay is only known from
   a presence answer still lives there, and not routing strands the message
   on this relay. The session-rank path is still preferred when both exist. */
return trust >= HOME_RELAY_TRUST.presence ? home : null;
}
function normalizePeerRecord(peer = {}) {
return {
clientId: String(peer.clientId || peer.peerId || ''),
peerId: String(peer.peerId || ''),
username: String(peer.username || peer.name || ''),
name: String(peer.name || peer.username || ''),
publicKeyData: String(peer.publicKeyData || ''),
/* A fingerprint is a hex digest of the key or it is nothing. Anything else
   here used to ride into the safety-number comparison and the render paths
   verbatim. */
fingerprint: /^[a-f0-9]{16,128}$/i.test(String(peer.fingerprint || '')) ? String(peer.fingerprint) : '',
/* What their build reads (51-envelope-privacy.js). */
caps: typeof sanitizeCaps === 'function' ? sanitizeCaps(peer.caps) : [],
/* Their current prekey, for writing to them while they are away. */
prekeyId: String(peer.prekeyId || ''),
prekeyPublic: String(peer.prekeyPublic || ''),
prekeyExpiresAt: peer.prekeyExpiresAt || '',
/* The identity key's signature over that prekey (prekeySignBytes). */
prekeySig: String(peer.prekeySig || '').slice(0, 1024),
/* The prekey's ML-KEM-768 half, and the statement that signs it in
   (prekeyPqSignBytes). */
prekeyPq: String(peer.prekeyPq || '').slice(0, 2048),
prekeyPqSig: String(peer.prekeyPqSig || '').slice(0, 1024),
/* The key exchange this contact has been SEEN to do (19-forward-secrecy.js):
   once it is the hybrid one, an exchange with them that leaves the
   post-quantum half out is refused. It has to be here, because this function
   is what a contact is written to storage through — a field it does not
   name is a field that is gone the next time the app opens, and the refusal
   with it. A whole number in the range that exists, whatever arrived. */
kexPinned: Math.max(0, Math.min(3, Math.floor(Number(peer.kexPinned) || 0))),
kexBinding: Math.max(0, Math.min(4, Math.floor(Number(peer.kexBinding) || 0))),
/* Seen to bind its payloads (roadmap 1.1); from then on an unbound one is refused. */
aadPinned: peer.aadPinned === true,
/* Seen to key its sessions as chains (roadmap 1.3); never offered less again. */
ratchetPinned: peer.ratchetPinned === true ? 1 : Math.max(0, Math.min(2, Math.floor(Number(peer.ratchetPinned) || 0))),
status: String(peer.status || 'offline'),
/* Avatars arrive from presence records and contact cards sent by people who
   have never been verified; only a raster data: URL is ever kept. */
avatarData: sanitizeAvatarData(peer.avatarData),
/* What they say they are doing, in their own words, from their hello. */
mood: String(peer.mood || '').slice(0, 40),
/* Which save of their profile the photograph and status above came from
   (their card's version). Kept so an older card arriving late, even after a
   reload, cannot put back what they replaced. */
profileVersion: String(peer.profileVersion || '').slice(0, 40),
/* When this account deleted the conversation and kept the contact: the
   conversation stays off the list until there is something in it again
   (shouldShowConversation). */
chatClearedAt: String(peer.chatClearedAt || ''),
conversationId: isReservedConversationKey(peer.conversationId) ? '' : (peer.conversationId || ''),
/* Kept with its provenance rather than flattened to an address: the merge
   below has to know which channel it came on to decide whether it may
   replace what is already there. */
homeRelay: normalizeHomeRelay(peer.homeRelay, peer.homeRelaySource || peer.homeRelay?.source || ''),
lastSeenAt: peer.lastSeenAt || '',
type: peer.type || '',
members: Array.isArray(peer.members) ? [...peer.members] : undefined,
ownerFingerprint: String(peer.ownerFingerprint || ''),
manual: Boolean(peer.manual),
/* Said yes to as a message request (49-message-requests.js). */
accepted: Boolean(peer.accepted),
pinned: Boolean(peer.pinned),
pinOrder: Number(peer.pinOrder || 0),
/* Arrived from a sibling device rather than earned here — the flag that
   keeps isStoredContact holding a contact this machine has no history
   with yet. */
synced: Boolean(peer.synced),
/* Known because they share a group with this account, from a member card —
   never written to directly. Kept so group messages, calls and replies can
   be sealed to them; not shown as a conversation until there is one. */
groupMember: Boolean(peer.groupMember),
/* ---- per-contact state that must survive a reload -----------------------
   Blocking, muting, archiving and the conversation timer were kept only on
   the in-memory record, so each one silently reset the moment the app was
   reopened — a blocked peer came back unblocked with their whole history. */
blocked: Boolean(peer.blocked),
muted: Boolean(peer.muted),
archived: Boolean(peer.archived),
timerSeconds: Number(peer.timerSeconds || 0),
/* ---- trust on first use -------------------------------------------------
   The key a contact was first seen with, kept beside the current one. The
   relay hands out public keys in its presence list, so a hostile relay could
   quietly swap one for its own and read everything from then on -- the one
   attack end-to-end encryption cannot see. Pinning the first key turns that
   silent swap into a visible event: trustedKey never moves on its own, and a
   presence record that disagrees with it raises keyChangedAt instead of
   overwriting it. verifiedAt is set only when a human compares the safety
   number aloud, and any change clears it. */
trustedKey: String(peer.trustedKey || ''),
trustedFingerprint: String(peer.trustedFingerprint || ''),
trustedAt: peer.trustedAt || '',
verifiedAt: peer.verifiedAt || '',
keyChangedAt: peer.keyChangedAt || '',
pendingKey: String(peer.pendingKey || ''),
pendingFingerprint: String(peer.pendingFingerprint || ''),
/* The key that changed had been verified by a person. Sending stops until the
   new one is checked (48-key-verify.js), so the flag has to outlive a reload. */
keyChangeWasVerified: Boolean(peer.keyChangeWasVerified),
/* Identity v4 (docs/design/1.2-identity-v4.md). The X25519 agreement key and
   the contact's signing key's signature over it; seals go to it once the
   contact moved. Taken only from a path that checked that signature (a card,
   a continuation) or from this device's own store — never from presence. */
agreeKey: /^[A-Za-z0-9+/]{43}=$/.test(String(peer.agreeKey || '')) ? String(peer.agreeKey) : '',
agreeKeySig: /^[A-Za-z0-9+/=]{86,88}$/.test(String(peer.agreeKeySig || '')) ? String(peer.agreeKeySig) : '',
/* The RSA key and fingerprint they had before they moved, and until when
   what was signed or sealed with it before the move is still read. */
legacyKey: String(peer.legacyKey || ''),
legacyFingerprint: /^[a-f0-9]{64}$/.test(String(peer.legacyFingerprint || '')) ? String(peer.legacyFingerprint) : '',
legacyUntil: Number.isSafeInteger(Number(peer.legacyUntil)) ? Number(peer.legacyUntil) : 0,
movedAt: String(peer.movedAt || ''),
};
}
/* What the address book is allowed to keep.

   The relay hands every online client to every other one -- that is what makes
   discovery work -- and the peers message used to be merged straight into the
   saved contacts. A fresh install therefore opened with a directory of
   strangers in it, kept on disk for good, before the user had done anything at
   all. Presence still arrives and still fills chatState.peers, because the
   online list is built from it; it just no longer survives a reload.

   A record is stored once the user has actually engaged with it: added by
   hand, pinned, archived, holds a session key, or has messages. Local spaces
   and groups keep their old behaviour -- they are the user's own objects. */
function isStoredContact(peer) {
if (!peer || !peer.peerId) return false;
if (peer.type || peer.system) return true;
if (peer.manual || peer.pinned || peer.archived) return true;
/* Arrived from a sibling device: the account engaged with them somewhere,
   so they belong in the book even before this machine has spoken a word. */
if (peer.synced) return true;
if (peer.groupMember) return true;
if (chatState.sessionKeys?.[peer.peerId]) return true;
if (peer.fingerprint && chatState.sessionKeys?.[peer.fingerprint]) return true;
return conversationHistory(peer).length > 0;
}
/* Online, sent by the relay, and not in the book: shown in its own list and
   never written to storage. */
function discoveredPeers() {
return (chatState.peers || []).filter((peer) => (
peer.peerId && !isSelfPeerRecord(peer) && !peer.type && !peer.system
&& peerLooksOnline(peer) && !isStoredContact(peer)
));
}
function saveContacts() {
const contacts = chatState.peers
.filter((peer) => peer.peerId && !isSelfPeerRecord(peer))
/* The one place the rule is applied, so it also cleans up what earlier
   versions saved: the boot path ends in saveContacts(). */
.filter((peer) => isStoredContact(peer))
.map((peer) => normalizePeerRecord(peer));
saveEncrypted(CHAT_CONTACTS_STORAGE_KEY, contacts);
/* The book changed on disk, which is the moment a sibling should hear
   about anything new in it — see maybePushContactDelta. The typeof guard
   keeps the standalone-extract test harnesses (which lift this function
   out of the page) running without the device-sync half. */
if (typeof maybePushContactDelta === 'function') maybePushContactDelta(contacts);
}
/* Written into the conversation itself, so the change is still there tomorrow
   even if the banner was dismissed in a hurry today. */
/* The fingerprint is a claim until it is checked.
   It arrives inside the relay's presence record, and everything downstream
   trusts it: the safety number is computed from fingerprints, so a relay that
   sent its OWN public key alongside the VICTIM'S fingerprint would sit in the
   middle of the conversation and the safety numbers on both phones would still
   match. Recompute it here from the key that actually arrived, and use that.
   A record whose claimed fingerprint disagrees with its key is not repaired
   quietly — the computed one wins, which is what the pinning check then sees. */
/* Everything a relay hands over passes through here, which makes it the one
   place that can say where a record came from. The check itself is narrow --
   the fingerprint matches the key or it does not -- and naming the channel
   is what stops the REST of the record being read as though it had been
   checked too. */
async function withVerifiedFingerprint(peer = {}) {
  const fromRelay = peer.homeRelay ? { ...peer, homeRelaySource: 'presence' } : peer;
  const publicKeyData = String(fromRelay.publicKeyData || '');
  if (!publicKeyData) return fromRelay;
  try {
    const computed = await PoorijaIdentity.fingerprintOfKey(publicKeyData);
    if (fromRelay.fingerprint && fromRelay.fingerprint !== computed) {
      console.warn('[chat] presence record claimed a fingerprint its key does not produce; using the computed one');
    }
    /* A v4 agreement key from the relay is kept only when the signing key the
       record names signed it; then it is as checked as one from a card. */
    const agreeOk = PoorijaIdentity.keyKind(publicKeyData) === 'v4' && fromRelay.agreeKey
      && await PoorijaIdentity.verifyAgreeKey({ fp: computed, sk: publicKeyData, ak: fromRelay.agreeKey, akSig: fromRelay.agreeKeySig });
    return { ...fromRelay, fingerprint: computed, agreeKey: agreeOk ? fromRelay.agreeKey : '', agreeKeySig: agreeOk ? fromRelay.agreeKeySig : '', agreeChecked: Boolean(agreeOk) };
  } catch (error) {
    /* An unreadable key is not a usable contact. */
    return { ...fromRelay, publicKeyData: '', fingerprint: fromRelay.fingerprint || '' };
  }
}

function noteKeyChangeInThread(peerRecord) {
  const conversationId = getConversationKey(peerRecord);
  if (!conversationId) return;
  appendHistory(conversationId, {
    id: `key-change-${Date.now()}`,
    type: 'system-note',
    direction: 'in',
    noteKind: 'key-change',
    text: t(
      'کلید امنیتی این مخاطب عوض شد. همین گفتگو ادامه دارد و پیام‌های قبلی روی همین دستگاه باقی می‌مانند، اما دیگر نمی‌توان اصالتشان را با کلید تازه سنجید — تا وقتی شمارهٔ امنیتی را از راهی جز این برنامه نسنجیده‌اید، پیام حساس نفرستید. فایل‌هایی که تا اینجا دانلود نکرده‌اید دیگر قابل بازیابی نیستند.',
      "This contact's security key changed. This same conversation continues and the earlier messages stay on this device, but they can no longer be verified against the new key — compare the safety number over some channel other than this app before sending anything sensitive. Files you have not downloaded by now cannot be retrieved any more.",
    ),
    createdAt: new Date().toISOString(),
  });
}

/* Accepting means the pinned key moves to the one being offered — the ordinary
   case of someone reinstalling. Keeping means the offered key is refused, and
   anything they send from it will not open: that is the honest consequence and
   the note says so. */
function resolveKeyChange(peerRecord, accept) {
  if (!peerRecord) return;
  /* Pin the conversation to the key it has had all along BEFORE the pinned
     fingerprint is allowed to move. getConversationKey is fingerprint-first,
     so an accepted key change used to retarget the record at a brand-new
     conversation id: the thread emptied out, the old messages became
     unreachable behind a stale key, and the whole thing read as a new chat.
     With the id anchored, the same conversation simply carries on. */
  if (!peerRecord.conversationId) {
    peerRecord.conversationId = getConversationKey(peerRecord);
  }
  const conversationId = getConversationKey(peerRecord);
  if (accept && peerRecord.pendingKey) {
    peerRecord.trustedKey = peerRecord.pendingKey;
    peerRecord.trustedFingerprint = peerRecord.pendingFingerprint || peerRecord.trustedFingerprint;
    peerRecord.publicKeyData = peerRecord.pendingKey;
    peerRecord.fingerprint = peerRecord.pendingFingerprint || peerRecord.fingerprint;
    peerRecord.trustedAt = new Date().toISOString();
  }
  peerRecord.pendingKey = '';
  peerRecord.pendingFingerprint = '';
  peerRecord.keyChangedAt = '';
  peerRecord.keyChangeWasVerified = false;
  /* The session key was minted against the old key; it cannot survive either
     answer. Dropping it forces a fresh negotiation. */
  clearSessionKeysFor(peerRecord);
  /* On accept, tell them so. Their side has been holding every negotiation
     because our pin refused their new key; without this word the banner they
     see clears only on the next lucky reconnect. Control frame over the live
     channel first, sealed envelope as the fallback for the offline case. */
  if (accept) {
    const session = chatState.sessions.get(peerRecord.peerId);
    if (session?.connection?.open) {
      safeConnectionSend(session.connection, { type: 'key-accepted' }, 'key-accepted');
    } else {
      relaySessionEvent(peerRecord, { type: 'key-accepted', createdAt: new Date().toISOString() });
    }
  }
  saveContacts();
  if (conversationId) {
    appendHistory(conversationId, {
      id: `key-resolve-${Date.now()}`,
      type: 'system-note',
      direction: 'in',
      text: accept
        ? t('کلید تازه پذیرفته شد. لطفاً شمارهٔ امنیتی را دوباره بسنجید.', 'The new key was accepted. Please compare the safety number again.')
        : t('کلید تازه رد شد. پیام‌هایی که با آن فرستاده شوند باز نخواهند شد.', 'The new key was refused. Anything sent with it will not open.'),
      createdAt: new Date().toISOString(),
    });
  }
  renderActivePeer();
  renderMessages();
}

function clearSessionKeysFor(peerRecord) {
  [peerRecord?.peerId, peerRecord?.fingerprint, peerRecord?.trustedFingerprint, getConversationKey(peerRecord)]
    .filter(Boolean)
    .forEach((alias) => { delete chatState.sessionKeys[alias]; });
  chatState.sessions.get(peerRecord?.peerId)?.connection?.close?.();
  chatState.sessions.delete(peerRecord?.peerId);
  saveSessionKeys();
}

function mergePeerRecord(peer = {}, options = {}) {
const normalized = normalizePeerRecord(peer);
if (!normalized.peerId || isSelfPeerRecord(normalized)) return null;
/* A prekey arriving with a record is a candidate. It is lifted out here, so
   that no branch below can file it, and offered to considerPrekey at the end,
   which takes it up only if the pinned identity key signed it. A record this
   device stored itself is read back as it was: what is on it was checked when
   it was taken up, and is checked again before anything is sealed to it. */
const offeredPrekey = options.stored ? null : {
prekeyId: normalized.prekeyId, prekeyPublic: normalized.prekeyPublic,
prekeyExpiresAt: normalized.prekeyExpiresAt, prekeySig: normalized.prekeySig,
prekeyPq: normalized.prekeyPq, prekeyPqSig: normalized.prekeyPqSig,
};
if (offeredPrekey) {
normalized.prekeyId = ''; normalized.prekeyPublic = ''; normalized.prekeySig = ''; normalized.prekeyExpiresAt = '';
normalized.prekeyPq = ''; normalized.prekeyPqSig = '';
}
/* What a contact has been seen to do is this device's own observation. A
   record from outside — presence, a card, another device's copy — neither
   sets it nor clears it: clearing it is the downgrade it exists to stop, and
   setting it would let a relay have this device refuse a contact who cannot
   do the hybrid exchange at all. */
if (!options.stored) { normalized.kexPinned = 0; normalized.kexBinding = 0; normalized.aadPinned = false; normalized.ratchetPinned = 0; }
/* The agreement key, and what a contact moved from, are set by the paths that
   check them (checkedIdentity for a card, acceptContinuation for a move) with
   options.checked; anything else arriving with a record is dropped. */
if (!options.stored && !options.checked) {
/* withVerifiedFingerprint checked a presence record's agreement key. */
if (!peer.agreeChecked) { normalized.agreeKey = ''; normalized.agreeKeySig = ''; }
normalized.legacyKey = ''; normalized.legacyFingerprint = ''; normalized.legacyUntil = 0; normalized.movedAt = '';
}
const filePrekey = (record) => {
if (record && offeredPrekey?.prekeyId && offeredPrekey.prekeyPublic && typeof considerPrekey === 'function') {
considerPrekey(record, offeredPrekey).catch(() => {});
}
return record;
};
/* A peer id is whatever the far side registered with the signalling server;
   one named after a conversation of this device's own would be filed there. */
if (isReservedConversationKey(normalized.peerId) || isReservedConversationKey(normalized.clientId)) return null;
const existing = chatState.peers.find((item) => (
(normalized.peerId && item.peerId === normalized.peerId)
|| (normalized.clientId && item.clientId === normalized.clientId)
|| (normalized.fingerprint && item.fingerprint === normalized.fingerprint)
|| (normalized.conversationId && getConversationKey(item) === normalized.conversationId)
));
const lastSeenAt = options.online ? new Date().toISOString() : (normalized.lastSeenAt || existing?.lastSeenAt || '');
if (existing) {
/* Trust on first use. The presented key is compared with the one this contact
   was first seen with; a mismatch is held aside as pendingKey and reported,
   and the trusted key stays exactly where it was until a person accepts the
   change. Without this the relay could hand over a different key and the app
   would adopt it without a word. */
const trusted = existing.trustedKey || '';
const offered = normalized.publicKeyData || '';
const keyConflict = Boolean(trusted && offered && offered !== trusted);
if (keyConflict) {
existing.pendingKey = offered;
existing.pendingFingerprint = normalized.fingerprint || '';
/* Anchor the conversation before any key can move: the alert's accept path
   swaps the fingerprint, and an unanchored record would follow it into a
   fresh conversation id — the "key change opens a new chat" breakage. */
if (!existing.conversationId) existing.conversationId = getConversationKey(existing);
if (!existing.keyChangedAt) {
existing.keyChangedAt = new Date().toISOString();
/* A key that changed is a key nobody has compared yet. Whatever was
   verified before referred to the old one. */
if (existing.trustedFingerprint) {
if (isPeerVerified(existing.trustedFingerprint)) existing.keyChangeWasVerified = true;
setPeerVerified(existing.trustedFingerprint, false);
}
noteKeyChangeInThread(existing);
}
}
/* Between two prekeys, the FRESHER window wins rather than the more recent
   hello: a multi-device contact publishes one prekey per device, and
   "whoever hailed last" made the record flap between them message by
   message. */
const fresherPrekey = Boolean(normalized.prekeyId && normalized.prekeyPublic)
&& Date.parse(normalized.prekeyExpiresAt || 0) > Date.parse(existing.prekeyExpiresAt || 0);
const prekeySource = fresherPrekey ? normalized : existing;
Object.assign(existing, {
...normalized,
clientId: normalized.clientId || existing.clientId,
/* The conversation id is the anchor a key change must not move (see the
   conflict branch above); a presence record arriving without one must not
   wipe what was pinned. */
conversationId: normalized.conversationId || existing.conversationId || '',
/* The pinned key wins over anything the relay offers. */
publicKeyData: keyConflict ? trusted : (normalized.publicKeyData || existing.publicKeyData),
/* The prekey is what makes a queued message expire, and it has to survive a
   record that does not carry one — an identity card pasted by hand has no
   prekey, and merging it used to blank what presence had just published. The
   sender then silently fell back to the identity-wrapped seal, which never
   expires, and the fifteen-day window quietly did not apply. */
prekeyId: fresherPrekey ? normalized.prekeyId : (existing.prekeyId || normalized.prekeyId || ''),
prekeyPublic: fresherPrekey ? normalized.prekeyPublic : (existing.prekeyPublic || normalized.prekeyPublic || ''),
prekeyExpiresAt: fresherPrekey ? normalized.prekeyExpiresAt : (existing.prekeyExpiresAt || normalized.prekeyExpiresAt || ''),
/* The signature belongs to the prekey it signs, so it follows the same choice. */
prekeySig: prekeySource.prekeySig || '',
prekeyPq: prekeySource.prekeyPq || '',
prekeyPqSig: prekeySource.prekeyPqSig || '',
/* Only ever raised, and only by what this device saw (pinKexHybrid). */
kexPinned: Math.max(existing.kexPinned || 0, normalized.kexPinned || 0),
kexBinding: Math.max(existing.kexBinding || 0, normalized.kexBinding || 0),
aadPinned: Boolean(existing.aadPinned || normalized.aadPinned),
ratchetPinned: Math.max(existing.ratchetPinned === true ? 1 : Number(existing.ratchetPinned) || 0, normalized.ratchetPinned === true ? 1 : Number(normalized.ratchetPinned) || 0),
/* Kept unless a checked path brought a new one, and never for a key that
   is not the one pinned (a conflict leaves both where they were). */
agreeKey: (!keyConflict && normalized.agreeKey) ? normalized.agreeKey : (existing.agreeKey || ''),
agreeKeySig: (!keyConflict && normalized.agreeKey) ? normalized.agreeKeySig : (existing.agreeKeySig || ''),
legacyKey: normalized.legacyKey || existing.legacyKey || '',
legacyFingerprint: normalized.legacyFingerprint || existing.legacyFingerprint || '',
legacyUntil: Math.max(Number(existing.legacyUntil || 0), Number(normalized.legacyUntil || 0)),
movedAt: normalized.movedAt || existing.movedAt || '',
/* A pinned contact's fingerprint moves only with its key: through a key
   change a person accepts, or a continuation the old key signed
   (65-identity-move.js). A record that names a different fingerprint and
   brings no key (presence carries none) used to move it silently — the
   contact then answered to a fingerprint no key had been checked against. */
fingerprint: (keyConflict || (existing.trustedFingerprint && normalized.fingerprint && normalized.fingerprint !== existing.trustedFingerprint && !offered))
? (existing.trustedFingerprint || existing.fingerprint)
: (normalized.fingerprint || existing.fingerprint),
trustedKey: trusted || normalized.publicKeyData || '',
trustedFingerprint: existing.trustedFingerprint || normalized.fingerprint || '',
trustedAt: existing.trustedAt || (normalized.publicKeyData ? new Date().toISOString() : ''),
verifiedAt: keyConflict ? '' : (existing.verifiedAt || ''),
keyChangedAt: keyConflict ? (existing.keyChangedAt || new Date().toISOString()) : existing.keyChangedAt || '',
pendingKey: keyConflict ? offered : (existing.pendingKey || ''),
pendingFingerprint: keyConflict ? (normalized.fingerprint || '') : (existing.pendingFingerprint || ''),
/* Never set by a record arriving from outside — only by the conflict above,
   and cleared only by resolveKeyChange. */
keyChangeWasVerified: Boolean(existing.keyChangeWasVerified),
/* A photograph comes from the contact's own card (options.profile), which is
   their word on it: empty there means they removed it. Anything else that
   arrives without one — presence, which never carries one, a pasted card —
   leaves the one already kept. A card's photograph this device will not
   display (SVG, oversized) changes nothing rather than blanking it. */
avatarData: options.profile
? (String(options.profile.avatarData || '') === '' ? '' : (normalized.avatarData || existing.avatarData))
: (normalized.avatarData || existing.avatarData),
profileVersion: existing.profileVersion || normalized.profileVersion || '',
chatClearedAt: peer.chatClearedAt !== undefined ? String(peer.chatClearedAt || '') : (existing.chatClearedAt || ''),
/* Ranked, not overwritten. A record arriving without one -- an identity card
   pasted by hand, a hello from an older build -- must not blank what a card
   established, which is the same mistake the prekey fields above had. */
homeRelay: betterHomeRelay(existing.homeRelay, normalized.homeRelay),
/* The status is said in two places, and both are its owner's own word: the
   card, and the presence record the relay repeats from their hello. From
   either, an empty one means they cleared it — which used to be ignored, so
   a cleared status stayed on every contact's screen for good. Any other
   record without one leaves it as it was. */
mood: (options.profile || options.moodFromPresence)
? String((options.profile ? options.profile.mood : normalized.mood) || '').slice(0, 40)
: (normalized.mood !== undefined && normalized.mood !== '' ? normalized.mood : existing.mood),
username: normalized.username || existing.username,
name: normalized.name || existing.name,
members: normalized.members || existing.members,
manual: existing.manual || normalized.manual,
accepted: Boolean(existing.accepted),
/* A record that says nothing about capabilities (a pasted card, an older
   relay) does not erase what was learnt. */
caps: normalized.caps?.length ? normalized.caps : (existing.caps || []),
pinned: existing.pinned || normalized.pinned,
pinOrder: existing.pinOrder || normalized.pinOrder,
/* Decisions this device made about the contact. A presence record, a hello
   or a card never carries them, so `...normalized` above put false in their
   place and every presence broadcast quietly unblocked, unmuted and
   unarchived the contact and switched its message timer off. They are kept
   from the record that holds them; the toggles change them directly. */
blocked: peer.blocked !== undefined ? Boolean(peer.blocked) : Boolean(existing.blocked),
muted: peer.muted !== undefined ? Boolean(peer.muted) : Boolean(existing.muted),
archived: peer.archived !== undefined ? Boolean(peer.archived) : Boolean(existing.archived),
timerSeconds: peer.timerSeconds !== undefined ? Number(peer.timerSeconds || 0) : Number(existing.timerSeconds || 0),
synced: Boolean(existing.synced || normalized.synced),
groupMember: Boolean(existing.groupMember || normalized.groupMember),
	/* The relay says three things about a peer — online, away, gone — and the
	   merge used to hear only two of them: `online: true` flattened an away
	   peer into an online one, so a frozen or backgrounded device showed a
	   green dot and its correspondents kept handing messages to a channel
	   nobody was draining. Away is the relay's word for "the socket is there
	   and the person is not"; it outranks the socket. */
	status: options.online ? (normalized.status === 'away' ? 'away' : 'online') : (normalized.status || existing.status || 'offline'),
	lastSeenAt,
	});
return filePrekey(existing);
}
/* First sight is what gets pinned — unless this identity's trust was already
   revoked locally. A tombstone (26-contacts keeps them when a contact with a
   pinned key is deleted) that matches this peerId/clientId and names a
   DIFFERENT key means the person we once verified has been met again under a
   new one: pinning it silently would re-arm exactly the trust the user took
   away, so it goes through the key-change flow instead. */
const revoked = (() => {
try {
return (typeof loadRevokedTrust === 'function' ? loadRevokedTrust() : null) || [];
} catch (_error) {
return [];
}
})();
const tombstone = revoked.find((item) => (
(item.peerId && item.peerId === normalized.peerId)
|| (item.clientId && item.clientId === normalized.clientId)
)) || null;
if (tombstone && tombstone.trustedKey && normalized.publicKeyData
&& tombstone.trustedKey !== normalized.publicKeyData) {
const record = {
...normalized,
status: options.online ? 'online' : normalized.status || 'offline',
lastSeenAt,
/* The revoked key stays the pinned one; the newcomer is held as pending
   until a person compares the safety number and accepts it. */
trustedKey: tombstone.trustedKey,
trustedFingerprint: tombstone.fingerprint || '',
trustedAt: '',
verifiedAt: '',
pendingKey: normalized.publicKeyData,
pendingFingerprint: normalized.fingerprint || '',
keyChangedAt: new Date().toISOString(),
keyChangeWasVerified: false,
};
chatState.peers.push(record);
noteKeyChangeInThread(record);
return filePrekey(record);
}
const record = {
...normalized,
status: options.online ? 'online' : normalized.status || 'offline',
lastSeenAt,
trustedKey: normalized.trustedKey || normalized.publicKeyData || '',
trustedFingerprint: normalized.trustedFingerprint || normalized.fingerprint || '',
trustedAt: normalized.trustedAt || (normalized.publicKeyData ? new Date().toISOString() : ''),
/* Only this device's own conflict branch above ever sets it. A record that
   arrives from outside — a card, a presence entry — does not get to. */
keyChangeWasVerified: false,
/* Nor does it arrive already accepted: that is this person's answer to give. */
accepted: false,
/* Somebody this account blocked and then deleted is still blocked when the
   relay lists them again (rememberBlocked). */
blocked: Boolean(normalized.blocked) || (typeof isBlocklisted === 'function' && isBlocklisted(normalized)),
};
chatState.peers.push(record);
/* The same key meeting us again after its contact was deleted is the real
person coming back, not an impersonation — retire the tombstone so it stops
forcing the pending-key path on every future merge. */
if (typeof clearRevokedTrustFor === 'function'
&& tombstone && tombstone.trustedKey === record.trustedKey) {
clearRevokedTrustFor(record);
}
return filePrekey(record);
}
function findPeerRecordByPeerId(peerId) {
if (!peerId) return null;
return chatState.peers.find((peer) => peer.peerId === peerId) || null;
}
/* A call names its caller by the PeerJS id the media connection arrived on, and
   that id is not always the one the contact record holds: a relay call names it
   by whatever the card said — peer id, client id or fingerprint — and a second
   device of the same account dials from the account's id plus a suffix of its
   own. The exact lookup found nobody for the first, and the call-log row was then
   filed under the raw id as a conversation of its own — a stranger in the chat
   list.

   Only ids this device already holds resolve. A suffixed id is NOT matched to
   the contact whose id it extends: a PeerJS id is whatever its holder registered,
   so anybody could register "<contact>-abc123" and have a call line appear in
   that contact's thread. Anything else stays unresolved, is written to the call
   log under its own name and makes no conversation. */
function resolveCallPeerRecord(peerId) {
  const id = String(peerId || '');
  if (!id) return null;
  return findPeerRecordByPeerId(id) || findPeerByAnyKey(id) || null;
}
function findPeerBySession(session) {
if (!session) return null;
return chatState.peers.find((peer) => (
peer.peerId === session.peerId ||
peer.fingerprint === session.remoteFingerprint ||
getConversationKey(peer) === session.conversationId
)) || null;
}
/* A WebRTC data channel does not notice the far end going away. `open` stays
 * true long after the other browser is closed, and every send path in here
 * asks that flag whether to go direct or through the relay - so a message to
 * somebody who had just left went into a dead channel, came back as sent, and
 * was never queued for them. The relay's presence list is the authority on who
 * is actually there, so when it says a peer is gone their channel is closed
 * and `open` starts telling the truth again. One place, rather than teaching
 * thirty-three call sites to distrust the flag they are reading. */
function dropStaleSessionChannels() {
const reachable = new Set();
chatState.peers.forEach((peer) => {
if (peer.type || peer.status !== 'online') return;
[peer.peerId, peer.clientId, peer.fingerprint].filter(Boolean).forEach((key) => reachable.add(key));
});
chatState.sessions.forEach((session, peerId) => {
if (!session?.connection) return;
const known = [peerId, session.peerId, session.remoteFingerprint].filter(Boolean);
if (known.some((key) => reachable.has(key))) return;
try {
session.connection.close();
} catch (_error) {
/* Already torn down at the other end; the point is only that `open` stops
   claiming otherwise. */
}
session.connection = null;
});
}
function markPeerUnavailable(peerId, message = '') {
if (!peerId) return;
const record = chatState.peers.find((peer) => peer.peerId === peerId);
let changed = false;
if (record && record.status !== 'offline') {
record.status = 'offline';
record.lastSeenAt = new Date().toISOString();
changed = true;
saveContacts();
}
if (changed) {
notify(message || t('این کاربر آفلاین شد، اما گفتگو به‌صورت محلی باقی می‌ماند.', 'This peer went offline, but the local conversation remains available.'), 'warning');
renderPeers();
renderActivePeer();
}
}
function getActiveConversation() {
return activePeer();
}
function localMembershipKeys() {
return new Set([
chatState.clientId,
chatState.peerId,
chatState.identity?.fingerprint,
chatState.profile.stablePeerId,
].filter(Boolean));
}
function spaceIncludesLocalUser(space) {
if (!space?.type) return false;
if (space.ownerPeerId && localMembershipKeys().has(space.ownerPeerId)) return true;
if (space.ownerClientId && localMembershipKeys().has(space.ownerClientId)) return true;
if (space.ownerFingerprint && space.ownerFingerprint === chatState.identity?.fingerprint) return true;
const members = Array.isArray(space.members) ? space.members : [];
if (!members.length) return true;
const mine = localMembershipKeys();
return members.some((member) => mine.has(member));
}
function selectedSpaceMembers(type = 'group') {
if (type !== 'group') return [];
const panel = document.getElementById('chatGroupMembersPanel');
if (!panel) return [];
return Array.from(panel.querySelectorAll('input[type="checkbox"]:checked'))
.map((input) => input.value)
.filter(Boolean);
}
/* The roster is everybody in the group, the reader included.
 *
 * This used to drop the local user's own keys, which reads as sensible - you
 * do not send yourself a copy - until you notice the same function normalises
 * the roster a *member* stores of a group somebody else made. Their own key
 * was stripped on the way in, and `spaceIncludesLocalUser` then went looking
 * for them in a list they had just been removed from and decided the group
 * was not theirs: it survived a restart on disk and came back inert. Dropping
 * yourself belongs at delivery time, and `groupDeliveryMemberKeys` already
 * does it as its last step. */
function normalizeSpaceMembers(members = []) {
return Array.from(new Set((Array.isArray(members) ? members : [])
.map((member) => String(member || '').trim())
.filter(Boolean)));
}
function groupDeliveryMemberKeys(space) {
const fromHistory = (chatState.history[space?.conversationId] || [])
.flatMap((entry) => [entry.senderPeerId, entry.senderFingerprint]);
const candidates = normalizeSpaceMembers([
...(Array.isArray(space?.members) ? space.members : []),
space?.ownerPeerId,
space?.ownerClientId,
space?.ownerFingerprint,
...fromHistory,
]);
/* A removal only sticks if it also beats the ways a member can still be
   named: history rows and stale rosters keep listing keys of people who were
    taken out, and without this filter they came straight back through the
    delivery list — a removed member kept receiving everything the group sent.
    Both the raw removed key and everything it resolves to are excluded, the
    same resolution the candidate list itself goes through. */
const removedKeys = new Set();
normalizeSpaceMembers(space?.removed).forEach((key) => {
removedKeys.add(key);
const resolved = findPeerByAnyKey(key);
if (resolved) {
removedKeys.add(resolved.peerId);
removedKeys.add(resolved.clientId);
removedKeys.add(resolved.fingerprint);
}
});
const seen = new Set();
return candidates
.filter((memberKey) => memberKey && !removedKeys.has(memberKey))
.map((memberKey) => {
const peer = findPeerByAnyKey(memberKey);
return peer?.peerId || peer?.clientId || peer?.fingerprint || memberKey;
})
.filter((memberKey) => {
if (!memberKey || localMembershipKeys().has(memberKey) || removedKeys.has(memberKey) || seen.has(memberKey)) return false;
seen.add(memberKey);
return true;
});
}
function findPeerByAnyKey(key) {
if (!key) return null;
return chatState.peers.find((peer) => (
getConversationKey(peer) === key
|| peer.peerId === key
|| peer.clientId === key
|| peer.fingerprint === key
)) || null;
}
function renderSpaceMemberPickers() {
const renderPanel = (id, labelText) => {
const panel = document.getElementById(id);
if (!panel) return;
const peers = chatState.peers
.filter((peer) => peer.peerId && !peer.type && !isSelfPeerRecord(peer))
.sort((a, b) => Number(peerLooksOnline(b)) - Number(peerLooksOnline(a)));
if (!peers.length) {
panel.innerHTML = `<div class="chat-member-picker-empty">${t('برای انتخاب عضو، ابتدا کاربر آنلاین یا مخاطب داشته باشید.', 'Add or discover contacts before choosing members.')}</div>`;
return;
}
panel.innerHTML = `
<div class="chat-member-picker-title">${labelText}</div>
${peers.map((peer) => {
const name = peer.username || peer.name || peer.peerId;
return `
<label class="chat-member-option">
<input type="checkbox" value="${app().escapeHTML(getConversationKey(peer))}" ${peerLooksOnline(peer) ? 'checked' : ''}>
<span class="chat-peer-presence-dot ${peerLooksOnline(peer) ? 'online' : 'offline'}"></span>
<span>${app().escapeHTML(name)}</span>
</label>
`;
}).join('')}
`;
};
renderPanel('chatGroupMembersPanel', t('اعضای گروه', 'Group members'));
}
function memberDisplayName(memberKey) {
const peer = findPeerByAnyKey(memberKey);
return peer?.username || peer?.name || peer?.peerId || memberKey;
}
function messageSenderLabel(entry, conversation) {
if (!conversation?.type) return '';
if (entry.senderName) return entry.senderName;
if (entry.direction === 'out') return chatState.profile.name || t('شما', 'You');
return memberDisplayName(entry.senderPeerId || entry.senderFingerprint || '');
}
/* The face beside the name, in a group. A name alone makes a busy group hard
   to read at a glance: several people, several similar names, and every line
   looking the same. Falls back to initials, which is what the roster and the
   conversation list already do, so the same person looks the same everywhere. */
function messageSenderAvatar(entry, conversation) {
  if (!conversation?.type) return '';
  const own = entry.direction === 'out';
  const peer = own ? null : findPeerByAnyKey(entry.senderPeerId || entry.senderFingerprint || '');
  const image = own ? (chatState.profile.avatarData || '') : (peer?.avatarData || '');
  const name = messageSenderLabel(entry, conversation) || '?';
  return `<span class="chat-message-avatar">${image
    ? `<img src="${app().escapeHTML(image)}" alt="">`
    : app().escapeHTML(initials(name))}</span>`;
}
function renderSpaceMemberManager() {
const panel = document.getElementById('chatSpaceMembersPanel');
if (!panel) return;
const space = getActiveConversation();
const visible = Boolean(space?.type === 'group' && chatState.activeView === 'groups');
panel.classList.toggle('hidden', !visible);
if (!visible) {
panel.innerHTML = '';
return;
}
const peers = chatState.peers
.filter((peer) => peer.peerId && !peer.type && !isSelfPeerRecord(peer))
.sort((a, b) => Number(peerLooksOnline(b)) - Number(peerLooksOnline(a)));
const normalizedMembers = normalizeSpaceMembers(space.members);
const members = new Set(normalizedMembers);
const memberPeers = peers.filter((peer) => (
members.has(peer.peerId)
|| members.has(peer.clientId)
|| members.has(peer.fingerprint)
|| members.has(getConversationKey(peer))
));
const avatarMarkup = space.avatarData
? `<img src="${space.avatarData}" alt="">`
: app().escapeHTML(initials(space.name || 'G'));
panel.innerHTML = `
<div class="chat-space-profile-editor">
<button id="chatGroupAvatarBtn" type="button" class="chat-space-avatar-btn" title="${app().escapeHTML(t('تغییر عکس گروه', 'Change group picture'))}">${avatarMarkup}</button>
<input id="chatGroupNameEditInput" class="chat-space-name-input" type="text" value="${app().escapeHTML(space.name || '')}" placeholder="${app().escapeHTML(t('نام گروه', 'Group name'))}">
<button id="chatSaveGroupDetailsBtn" type="button" class="chat-space-save-btn">${t('ذخیره مشخصات', 'Save details')}</button>
</div>
<div class="chat-space-members-head">
<div>
<strong>${app().escapeHTML(space.name || '')}</strong>
<span>${t('اعضای گروه', 'Group members')} · ${members.size}</span>
</div>
<button id="chatSaveSpaceMembersBtn" type="button" class="chat-space-save-btn">${t('ذخیره اعضا', 'Save members')}</button>
</div>
<div class="chat-space-current-members">
${memberPeers.length ? memberPeers.map((peer) => `
<div class="chat-space-current-member">
<span class="chat-peer-presence-dot ${peerLooksOnline(peer) ? 'online' : 'offline'}"></span>
<span>${app().escapeHTML(peer.username || peer.name || peer.peerId)}</span>
<small>${peerLooksOnline(peer) ? t('آنلاین', 'Online') : t('آفلاین', 'Offline')}</small>
</div>
`).join('') : `<div class="chat-member-picker-empty">${t('هنوز عضوی برای این گروه انتخاب نشده است.', 'No members are selected for this group yet.')}</div>`}
</div>
<details class="chat-space-member-accordion" open>
<summary>${t('مدیریت اعضای محلی', 'Manage local members')}</summary>
<div class="chat-space-members-list">
${peers.length ? peers.map((peer) => {
const key = peer.peerId || getConversationKey(peer);
const checked = members.has(key) || members.has(peer.peerId) || members.has(peer.clientId) || members.has(peer.fingerprint) || members.has(getConversationKey(peer));
return `
<label class="chat-member-option">
<input type="checkbox" value="${app().escapeHTML(key)}" ${checked ? 'checked' : ''}>
<span class="chat-peer-presence-dot ${peerLooksOnline(peer) ? 'online' : 'offline'}"></span>
<span>${app().escapeHTML(peer.username || peer.name || peer.peerId)}</span>
<small>${peerLooksOnline(peer) ? t('آنلاین', 'Online') : t('آفلاین', 'Offline')}</small>
</label>
`;
}).join('') : `<div class="chat-member-picker-empty">${t('هنوز مخاطبی برای مدیریت اعضا وجود ندارد.', 'No contacts are available for member management yet.')}</div>`}
</div>
</details>
`;
panel.querySelector('#chatGroupAvatarBtn')?.addEventListener('click', () => {
document.getElementById('chatGroupAvatarInput')?.click();
});
panel.querySelector('#chatSaveGroupDetailsBtn')?.addEventListener('click', () => {
const nextName = panel.querySelector('#chatGroupNameEditInput')?.value.trim();
if (nextName) space.name = nextName;
space.members = normalizeSpaceMembers(space.members);
saveSpaces();
broadcastSpaceRecord(space);
renderPeers();
renderActivePeer();
renderSpaceMemberManager();
notify(t('مشخصات گروه ذخیره شد.', 'Group details saved.'), 'success');
});
panel.querySelector('#chatSaveSpaceMembersBtn')?.addEventListener('click', () => {
space.members = normalizeSpaceMembers(Array.from(panel.querySelectorAll('input[type="checkbox"]:checked'))
.map((input) => input.value)
.filter(Boolean));
saveSpaces();
broadcastSpaceRecord(space);
renderPeers();
renderSpaceMemberManager();
notify(t('اعضای فضا ذخیره شدند.', 'Members saved.'), 'success');
});
}
function notifyTyping() {
const peer = activePeer();
/* Saved Messages has nobody on the other end to tell. */
if (!peer || peer.type === 'saved' || !chatState.ws || chatState.ws.readyState !== WebSocket.OPEN) return;
const now = Date.now();
if (chatState.lastTypingSentAt && now - chatState.lastTypingSentAt < 3000) return;
chatState.lastTypingSentAt = now;
/* The sender travels inside the payload, not on the envelope: a relay
   delivering over transit blanks the envelope-level fingerprint (nothing was
   proved on that leg), so without this the far side hunted for a peer by a
   name that was not there. */
sendRelayEnvelope(peer, { type: 'typing', fromFingerprint: chatState.identity?.fingerprint || '' });
}
function handleRemoteTyping(fingerprint) {
const peer = chatState.peers.find((p) => p.fingerprint === fingerprint);
if (!peer) return;
const key = getConversationKey(peer);
if (chatState.typingTimers.has(key)) {
clearTimeout(chatState.typingTimers.get(key));
}
const timer = setTimeout(() => {
chatState.typingTimers.delete(key);
renderActivePeer();
}, 4000);
chatState.typingTimers.set(key, timer);
renderActivePeer();
}
function initials(name) {
const clean = String(name || 'P').trim();
return clean.slice(0, 1).toUpperCase() || 'P';
}
function formatTime(value) {
try {
return new Date(value || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
} catch (_error) {
return '';
}
}
function formatCountdown(expiresAt) {
if (!expiresAt) return '';
const diff = Date.parse(expiresAt) - Date.now();
if (diff <= 0) return '0s';
const totalSeconds = Math.floor(diff / 1000);
if (totalSeconds < 60) return `${totalSeconds}s`;
const minutes = Math.floor(totalSeconds / 60);
const seconds = totalSeconds % 60;
if (minutes < 60) return `${minutes}:${String(seconds).padStart(2, '0')}`;
const hours = Math.floor(minutes / 60);
const remMinutes = minutes % 60;
return `${hours}:${String(remMinutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
/* h:mm:ss once an hour has passed, m:ss before that.
 *
 * Minutes used to run without a ceiling, so an hour and a half of talking read
 * as "90:45" — a number nobody converts in their head, and one that looks like
 * a mistake beside a clock. Every call surface goes through here: the calls
 * list, the label above a call in progress, and the group call stage. */
function formatDuration(ms = 0) {
const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
const hours = Math.floor(totalSeconds / 3600);
const minutes = Math.floor((totalSeconds % 3600) / 60);
const seconds = totalSeconds % 60;
if (hours > 0) {
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
function formatTimerLabel(seconds) {
if (!seconds) return t('بدون تایمر', 'No timer');
if (seconds < 60) return t(`${seconds} ثانیه`, `${seconds}s`);
if (seconds < 3600) return t(`${Math.round(seconds / 60)} دقیقه`, `${Math.round(seconds / 60)}m`);
return t(`${Math.round(seconds / 3600)} ساعت`, `${Math.round(seconds / 3600)}h`);
}
function formatTimerBadge(seconds) {
if (!seconds) return '';
if (seconds < 60) return `${seconds}s`;
if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
return `${Math.round(seconds / 3600)}h`;
}
function currentReactorId() {
return chatState.clientId || chatState.peerId || chatState.identity?.fingerprint || 'local-user';
}
function currentReactorCandidates() {
return new Set([
chatState.clientId,
chatState.peerId,
chatState.identity?.fingerprint,
].filter(Boolean));
}
function resolveRemoteReactorId(session, message) {
const localIds = currentReactorCandidates();
const incomingCandidates = [
message?.reactorId,
message?.clientId,
message?.peerId,
message?.fingerprint,
].filter(Boolean);
const incoming = incomingCandidates.find((candidate) => !localIds.has(candidate));
if (incoming) return incoming;
return session?.remoteClientId || session?.peerId || session?.remoteFingerprint || 'remote-user';
}
function normalizeMessageReactions(entry) {
if (!entry) return {};
if (entry.reactions && typeof entry.reactions === 'object' && !Array.isArray(entry.reactions)) {
return { ...entry.reactions };
}
if (entry.reaction) {
return { legacy: entry.reaction };
}
return {};
}
function summarizeMessageReactions(entry) {
const reactions = normalizeMessageReactions(entry);
const tally = new Map();
Object.values(reactions).forEach((emoji) => {
if (!emoji) return;
tally.set(emoji, (tally.get(emoji) || 0) + 1);
});
return Array.from(tally.entries()).map(([emoji, count]) => ({ emoji, count }));
}
function applyMessageReaction(entry, reaction, reactorId = currentReactorId()) {
if (!entry || !reactorId) return;
const reactions = normalizeMessageReactions(entry);
if (!reaction) delete reactions[reactorId];
else reactions[reactorId] = reaction;
entry.reactions = reactions;
delete entry.reaction;
}
function syncTimerUi() {
const badge = document.getElementById('chatTimerBadge');
const toggle = document.getElementById('chatTimerToggleBtn');
const popover = document.getElementById('chatTimerPopover');
const seconds = Number(chatState.timerSeconds || 0);
if (badge) {
badge.textContent = formatTimerBadge(seconds);
badge.classList.toggle('hidden', !seconds);
}
if (toggle) {
toggle.classList.toggle('active', Boolean(seconds));
toggle.setAttribute('title', seconds ? formatTimerLabel(seconds) : t('پیام خودتخریب', 'Self-destruct message'));
}
if (popover) {
popover.classList.toggle('hidden', !chatState.timerPopoverOpen);
popover.querySelectorAll('[data-chat-timer]').forEach((button) => {
button.classList.toggle('active', Number(button.getAttribute('data-chat-timer') || 0) === seconds);
});
if (chatState.timerPopoverOpen) {
positionTimerPopover();
requestAnimationFrame(positionTimerPopover);
window.setTimeout(positionTimerPopover, 0);
}
}
}
function toggleTimerPopover(force) {
chatState.timerPopoverOpen = typeof force === 'boolean' ? force : !chatState.timerPopoverOpen;
syncTimerUi();
}
function setTimerSeconds(seconds) {
chatState.timerSeconds = Number(seconds || 0);
chatState.timerPopoverOpen = false;
/* The timer used to live only in chatState, so setting it in one
   conversation and switching away silently carried it into the next one.
   It is written onto the conversation record here, and normalizePeerRecord
   keeps it across reloads; the switch path reads it back. */
const record = activePeer();
if (record && !isSelfPeerRecord(record)) {
record.timerSeconds = chatState.timerSeconds;
if (record.type) saveSpaces();
else saveContacts();
}
syncTimerUi();
}
function detectComposerDirection(value) {
const text = String(value || '');
const RTL_STRONG = /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/;
const LTR_STRONG = /[A-Za-z\u00C0-\u02AF\u0370-\u058F\u2C00-\uD7FF]/;
// The first STRONG character decides, the way the Unicode bidi algorithm does
// it. Reading only charAt(0) called "123 hello" and "!Salam" right-to-left,
// because digits, punctuation and spaces carry no direction of their own.
for (const ch of text) {
if (RTL_STRONG.test(ch)) return 'rtl';
if (LTR_STRONG.test(ch)) return 'ltr';
}
return language() === 'fa' ? 'rtl' : 'ltr';
}
function positionTimerPopover() {
const popover = document.getElementById('chatTimerPopover');
const toggle = document.getElementById('chatTimerToggleBtn');
if (!popover || !toggle || popover.classList.contains('hidden')) return;
// Modern check for mobile/PWA standalone
const isMobile = document.documentElement.classList.contains('mobile-browser-context') ||
window.matchMedia('(max-width: 767px)').matches;
if (isMobile) {
// Let CSS handle mobile placement, but clear desktop inline overrides first.
['position', 'z-index', 'top', 'right', 'bottom', 'left', 'inset', 'inset-inline-start', 'inset-inline-end'].forEach((property) => {
popover.style.removeProperty(property);
});
return;
}
const toggleRect = toggle.getBoundingClientRect();
const popoverHeight = popover.offsetHeight || 220;
const popoverWidth = popover.offsetWidth || 180;
// Older responsive override blocks use !important, so desktop placement must
// be set with matching priority after every toggle/open.
popover.style.setProperty('position', 'fixed', 'important');
popover.style.setProperty('z-index', '99999', 'important');
popover.style.setProperty('bottom', 'auto', 'important');
popover.style.setProperty('right', 'auto', 'important');
popover.style.setProperty('inset', 'auto', 'important');
popover.style.setProperty('inset-inline-start', 'auto', 'important');
popover.style.setProperty('inset-inline-end', 'auto', 'important');
// Default: Above the toggle
let top = toggleRect.top - popoverHeight - 10;
let left = toggleRect.right - popoverWidth;
// Boundary checks
if (top < 10) {
// Show below if no space above
top = toggleRect.bottom + 10;
}
if (left < 10) left = 10;
if (left + popoverWidth > window.innerWidth - 10) {
left = window.innerWidth - popoverWidth - 10;
}
popover.style.setProperty('left', left + 'px', 'important');
popover.style.setProperty('top', top + 'px', 'important');
}
// One place that decides how every delivery state looks, so the glyph, the
// colour and the tooltip can never drift apart. 'seen' and 'delivered' both
// drew ✓✓ before, which left no way to tell a read message from a delivered one.
function statusMeta(status) {
switch (status) {
case 'seen':
case 'opened':
return { label: '✓✓', cls: 'is-seen', title: t('خوانده شد', 'Read') };
case 'delivered':
return { label: '✓✓', cls: 'is-delivered', title: t('تحویل داده شد', 'Delivered') };
case 'sent':
return { label: '✓', cls: 'is-sent', title: t('ارسال شد', 'Sent') };
case 'relayed':
return { label: '✓', cls: 'is-relayed', title: t('به سرور سپرده شد؛ در انتظار دریافت', 'Stored on the relay, waiting for the peer') };
case 'queued':
return { label: '🕐', cls: 'is-queued', title: t('در انتظار ارسال', 'Waiting to send') };
case 'failed':
return { label: '!', cls: 'is-failed', title: t('ارسال نشد', 'Not sent') };
case 'scheduled':
return { label: '⏰', cls: 'is-scheduled', title: t('زمان‌بندی‌شده؛ هنوز فرستاده نشده', 'Scheduled; not sent yet') };
default:
return { label: '🕐', cls: 'is-pending', title: t('در حال ارسال', 'Sending') };
}
}
function pruneExpiredHistory() {
const now = Date.now();
let changed = false;
Object.keys(chatState.history).forEach((key) => {
const current = chatState.history[key];
if (!Array.isArray(current)) return;
const next = current.filter((entry) => {
if (!entry || !entry.expiresAt) return true;
const expiry = Date.parse(entry.expiresAt);
const alive = !isNaN(expiry) && expiry > now;
/* Leaving the ciphertext behind would make "self-destruct" a lie: the
   message row disappears while the bytes sit in IndexedDB forever. */
if (!alive && isMediaEntry(entry)) dropMessageMedia(entry.id);
return alive;
});
if (next.length !== current.length) {
chatState.history[key] = next;
changed = true;
}
});
return changed;
}
function scheduleExpirySweep() {
if (chatState.expiryTimer) {
clearTimeout(chatState.expiryTimer);
chatState.expiryTimer = null;
}
let nextExpiry = Infinity;
Object.values(chatState.history).forEach((items) => {
(items || []).forEach((entry) => {
if (!entry.expiresAt) return;
const stamp = Date.parse(entry.expiresAt);
if (!isNaN(stamp) && stamp > Date.now()) nextExpiry = Math.min(nextExpiry, stamp);
});
});
if (!Number.isFinite(nextExpiry)) return;
chatState.expiryTimer = setTimeout(() => {
if (pruneExpiredHistory()) storeHistory();
renderPeers();
renderMessages();
scheduleExpirySweep();
}, Math.max(250, nextExpiry - Date.now() + 50));
}
function saveSessionKeys() {
saveEncrypted(CHAT_SESSION_KEYS_STORAGE_KEY, chatState.sessionKeys);
}
async function persistSessionKey(session, rawKey) {
const key = session.peerId || session.remoteFingerprint;
if (!key || !rawKey) return;
if (session.keySource !== 'negotiated') return;
const record = {
rawKey: app().arrayBufferToBase64(rawKey),
fingerprint: session.remoteFingerprint || '',
conversationId: session.conversationId || '',
/* How the key came to be. Only one made by the exchange is ever written,
   and only one that says so is ever read back (hydrateSessionKey). */
source: session.keySource || '',
updatedAt: new Date().toISOString(),
/* Kept so the key can be retired on age rather than living as long as the
   contact does. A key nobody has replaced for a week is a week of recorded
   traffic that one stolen device would open. */
createdAt: new Date().toISOString(),
};
chatState.sessionKeys[key] = record;
if (session.remoteFingerprint) chatState.sessionKeys[session.remoteFingerprint] = record;
if (session.conversationId) chatState.sessionKeys[session.conversationId] = record;
saveSessionKeys();
}
function forgetSessionKey(session) {
[session?.peerId, session?.remoteFingerprint, session?.conversationId]
.filter(Boolean)
.forEach((alias) => { delete chatState.sessionKeys[alias]; });
saveSessionKeys();
}
// Both ends learn both fingerprints from session-hello, so they can agree on a
// single key owner without another round trip. Whoever's fingerprint sorts
// first generates the AES key; the other side only ever accepts one. Letting
// both sides generate is how they ended up encrypting under different keys.
function sessionKeyOwner(session) {
const mine = chatState.identity?.fingerprint || '';
const theirs = session?.remoteFingerprint || '';
if (!mine || !theirs) return Boolean(session?.initiator);
/* Two devices of one account have one fingerprint between them, and then
   neither sorts first: each took itself for the side that waits. That went
   unseen while the side that waits made a key of its own after six seconds;
   with that gone, a session between one's own devices had nobody to offer an
   exchange and never got a key. Their addresses on the relay differ, and
   both ends know both, so those decide it. */
if (mine === theirs) return String(chatState.peerId || '') < String(session?.peerId || '');
return mine < theirs;
}
function requestSessionKey(session) {
if (!session?.connection?.open) return false;
return safeConnectionSend(session.connection, {
type: 'chat-key-request',
fingerprint: chatState.identity?.fingerprint || '',
}, 'chat-key-request');
}
async function renegotiateSessionKey(session) {
forgetSessionKey(session);
session.cryptoKey = null;
session.keySource = '';
session.keyNegotiatedFor = null;
session.keyReady = false;
if (sessionKeyOwner(session)) {
await ensureSessionKey(session, {
peerId: session.peerId,
clientId: session.remoteClientId,
publicKeyData: session.remotePublicKeyData,
fingerprint: session.remoteFingerprint,
});
return;
}
requestSessionKey(session);
}
async function hydrateSessionKey(session) {
if (session.cryptoKey) return;
/* An exchange is under way on this connection — an offer out, or a key held
   until the other side confirms it. The key from the connection before is
   one the other side has already replaced; reviving it here would have this
   side talk under a key nobody is listening on. */
if (session.kexPrivate || session.kexPending) return;
/* Chains kept from before a reload (roadmap 1.3). No session key was stored
   for them; the session's cryptoKey becomes a key of its own that nothing is
   encrypted under, so the many places that ask "does this session have a
   key" keep their meaning, while every payload takes a chain key. A stored
   session key, if one is there, is examined below first only when no chain
   exists: a chain always wins over a key from before chains. */
const stored0 = chatState.sessionKeys[session.peerId] || chatState.sessionKeys[session.remoteFingerprint] || chatState.sessionKeys[session.conversationId];
if (!stored0?.rawKey && typeof PoorijaRatchet === 'object' && session.remoteFingerprint && PoorijaRatchet.restore(session, session.remoteFingerprint)) {
session.cryptoKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
session.keySource = 'ratchet';
session.keyReady = true;
return;
}
const stored = chatState.sessionKeys[session.peerId] || chatState.sessionKeys[session.remoteFingerprint] || chatState.sessionKeys[session.conversationId];
if (!stored?.rawKey) return;
/* A key with nothing to say how it was made is one from before keys were
   only ever exchanged — delivered wrapped to an identity key, by an older
   build or carried in by a backup. Reviving it keeps a session keyed to the
   key that never changes for as long as nobody notices. It is dropped, and
   the next connection exchanges a new one. */
if (stored.source !== 'negotiated') {
forgetSessionKey(session);
return;
}
// A stored key belongs to the identity it was negotiated with. Once the peer
// resets their key their fingerprint changes, and reviving the old key here
// is what made both ends talk past each other for good.
if (session.remoteFingerprint && stored.fingerprint && stored.fingerprint !== session.remoteFingerprint) {
forgetSessionKey(session);
return;
}
/* And a key has an age. Past its lifetime it is dropped rather than revived,
   which forces a fresh exchange and takes everything older than that out of
   reach of a device opened tomorrow. */
const bornAt = Date.parse(stored.createdAt || stored.updatedAt || 0);
if (bornAt && Date.now() - bornAt > SESSION_KEY_LIFETIME_MS) {
console.info('[Chat] a stored session key passed its lifetime and was dropped.');
forgetSessionKey(session);
return;
}
session.cryptoKey = await crypto.subtle.importKey(
'raw',
app().base64ToArrayBuffer(stored.rawKey),
{ name: 'AES-GCM' },
true,
['encrypt', 'decrypt']
);
session.keySource = 'stored';
session.keyReady = true;
}
async function sha256Hex(buffer) {
const hash = await crypto.subtle.digest('SHA-256', buffer);
return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/* ---- published to globalThis (roadmap 2.1, tools/esm-chat.cjs) ---- */
Object.defineProperties(globalThis, {
  "HOME_RELAY_TRUST": { get() { return HOME_RELAY_TRUST; }, set() { throw new TypeError('Assignment to constant variable HOME_RELAY_TRUST.'); }, configurable: true },
  "normalizeHomeRelay": { get() { return normalizeHomeRelay; }, set(value) { normalizeHomeRelay = value; }, configurable: true },
  "betterHomeRelay": { get() { return betterHomeRelay; }, set(value) { betterHomeRelay = value; }, configurable: true },
  "routableHomeRelay": { get() { return routableHomeRelay; }, set(value) { routableHomeRelay = value; }, configurable: true },
  "normalizePeerRecord": { get() { return normalizePeerRecord; }, set(value) { normalizePeerRecord = value; }, configurable: true },
  "isStoredContact": { get() { return isStoredContact; }, set(value) { isStoredContact = value; }, configurable: true },
  "discoveredPeers": { get() { return discoveredPeers; }, set(value) { discoveredPeers = value; }, configurable: true },
  "saveContacts": { get() { return saveContacts; }, set(value) { saveContacts = value; }, configurable: true },
  "withVerifiedFingerprint": { get() { return withVerifiedFingerprint; }, set(value) { withVerifiedFingerprint = value; }, configurable: true },
  "noteKeyChangeInThread": { get() { return noteKeyChangeInThread; }, set(value) { noteKeyChangeInThread = value; }, configurable: true },
  "resolveKeyChange": { get() { return resolveKeyChange; }, set(value) { resolveKeyChange = value; }, configurable: true },
  "clearSessionKeysFor": { get() { return clearSessionKeysFor; }, set(value) { clearSessionKeysFor = value; }, configurable: true },
  "mergePeerRecord": { get() { return mergePeerRecord; }, set(value) { mergePeerRecord = value; }, configurable: true },
  "findPeerRecordByPeerId": { get() { return findPeerRecordByPeerId; }, set(value) { findPeerRecordByPeerId = value; }, configurable: true },
  "resolveCallPeerRecord": { get() { return resolveCallPeerRecord; }, set(value) { resolveCallPeerRecord = value; }, configurable: true },
  "findPeerBySession": { get() { return findPeerBySession; }, set(value) { findPeerBySession = value; }, configurable: true },
  "dropStaleSessionChannels": { get() { return dropStaleSessionChannels; }, set(value) { dropStaleSessionChannels = value; }, configurable: true },
  "markPeerUnavailable": { get() { return markPeerUnavailable; }, set(value) { markPeerUnavailable = value; }, configurable: true },
  "getActiveConversation": { get() { return getActiveConversation; }, set(value) { getActiveConversation = value; }, configurable: true },
  "localMembershipKeys": { get() { return localMembershipKeys; }, set(value) { localMembershipKeys = value; }, configurable: true },
  "spaceIncludesLocalUser": { get() { return spaceIncludesLocalUser; }, set(value) { spaceIncludesLocalUser = value; }, configurable: true },
  "selectedSpaceMembers": { get() { return selectedSpaceMembers; }, set(value) { selectedSpaceMembers = value; }, configurable: true },
  "normalizeSpaceMembers": { get() { return normalizeSpaceMembers; }, set(value) { normalizeSpaceMembers = value; }, configurable: true },
  "groupDeliveryMemberKeys": { get() { return groupDeliveryMemberKeys; }, set(value) { groupDeliveryMemberKeys = value; }, configurable: true },
  "findPeerByAnyKey": { get() { return findPeerByAnyKey; }, set(value) { findPeerByAnyKey = value; }, configurable: true },
  "renderSpaceMemberPickers": { get() { return renderSpaceMemberPickers; }, set(value) { renderSpaceMemberPickers = value; }, configurable: true },
  "memberDisplayName": { get() { return memberDisplayName; }, set(value) { memberDisplayName = value; }, configurable: true },
  "messageSenderLabel": { get() { return messageSenderLabel; }, set(value) { messageSenderLabel = value; }, configurable: true },
  "messageSenderAvatar": { get() { return messageSenderAvatar; }, set(value) { messageSenderAvatar = value; }, configurable: true },
  "renderSpaceMemberManager": { get() { return renderSpaceMemberManager; }, set(value) { renderSpaceMemberManager = value; }, configurable: true },
  "notifyTyping": { get() { return notifyTyping; }, set(value) { notifyTyping = value; }, configurable: true },
  "handleRemoteTyping": { get() { return handleRemoteTyping; }, set(value) { handleRemoteTyping = value; }, configurable: true },
  "initials": { get() { return initials; }, set(value) { initials = value; }, configurable: true },
  "formatTime": { get() { return formatTime; }, set(value) { formatTime = value; }, configurable: true },
  "formatCountdown": { get() { return formatCountdown; }, set(value) { formatCountdown = value; }, configurable: true },
  "formatDuration": { get() { return formatDuration; }, set(value) { formatDuration = value; }, configurable: true },
  "formatTimerLabel": { get() { return formatTimerLabel; }, set(value) { formatTimerLabel = value; }, configurable: true },
  "formatTimerBadge": { get() { return formatTimerBadge; }, set(value) { formatTimerBadge = value; }, configurable: true },
  "currentReactorId": { get() { return currentReactorId; }, set(value) { currentReactorId = value; }, configurable: true },
  "currentReactorCandidates": { get() { return currentReactorCandidates; }, set(value) { currentReactorCandidates = value; }, configurable: true },
  "resolveRemoteReactorId": { get() { return resolveRemoteReactorId; }, set(value) { resolveRemoteReactorId = value; }, configurable: true },
  "normalizeMessageReactions": { get() { return normalizeMessageReactions; }, set(value) { normalizeMessageReactions = value; }, configurable: true },
  "summarizeMessageReactions": { get() { return summarizeMessageReactions; }, set(value) { summarizeMessageReactions = value; }, configurable: true },
  "applyMessageReaction": { get() { return applyMessageReaction; }, set(value) { applyMessageReaction = value; }, configurable: true },
  "syncTimerUi": { get() { return syncTimerUi; }, set(value) { syncTimerUi = value; }, configurable: true },
  "toggleTimerPopover": { get() { return toggleTimerPopover; }, set(value) { toggleTimerPopover = value; }, configurable: true },
  "setTimerSeconds": { get() { return setTimerSeconds; }, set(value) { setTimerSeconds = value; }, configurable: true },
  "detectComposerDirection": { get() { return detectComposerDirection; }, set(value) { detectComposerDirection = value; }, configurable: true },
  "positionTimerPopover": { get() { return positionTimerPopover; }, set(value) { positionTimerPopover = value; }, configurable: true },
  "statusMeta": { get() { return statusMeta; }, set(value) { statusMeta = value; }, configurable: true },
  "pruneExpiredHistory": { get() { return pruneExpiredHistory; }, set(value) { pruneExpiredHistory = value; }, configurable: true },
  "scheduleExpirySweep": { get() { return scheduleExpirySweep; }, set(value) { scheduleExpirySweep = value; }, configurable: true },
  "saveSessionKeys": { get() { return saveSessionKeys; }, set(value) { saveSessionKeys = value; }, configurable: true },
  "persistSessionKey": { get() { return persistSessionKey; }, set(value) { persistSessionKey = value; }, configurable: true },
  "forgetSessionKey": { get() { return forgetSessionKey; }, set(value) { forgetSessionKey = value; }, configurable: true },
  "sessionKeyOwner": { get() { return sessionKeyOwner; }, set(value) { sessionKeyOwner = value; }, configurable: true },
  "requestSessionKey": { get() { return requestSessionKey; }, set(value) { requestSessionKey = value; }, configurable: true },
  "renegotiateSessionKey": { get() { return renegotiateSessionKey; }, set(value) { renegotiateSessionKey = value; }, configurable: true },
  "hydrateSessionKey": { get() { return hydrateSessionKey; }, set(value) { hydrateSessionKey = value; }, configurable: true },
  "sha256Hex": { get() { return sha256Hex; }, set(value) { sha256Hex = value; }, configurable: true },
});
