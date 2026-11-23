/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Part 65 of the Secure Chat module.

   An account moving to identity v4, as its contacts see it
   (docs/design/1.2-identity-v4.md, roadmap 1.2, release 2.7b).

   The account's RSA key is replaced by an Ed25519 signing key and an X25519
   agreement key, and its fingerprint (which is the hash of the key) changes
   with it. That would ordinarily be a key change: a red banner, sending held
   back, a verified contact no longer verified. It is not one — the old key
   signs that the new one is its successor — so it is presented as what it
   is:

   - the moved account sends every contact an `identity-move`: the
     continuation its old RSA key and its new Ed25519 key both signed, with
     the agreement key signed by the new key;
   - a contact checks the RSA signature against the key IT PINNED for this
     person (never only the one in the statement) and the new signatures;
     then moves the record to the new key, keeps the old one for ninety days,
     carries a verification over, and says so in one quiet line;
   - a statement that does not check is ignored, and the ordinary key-change
     path applies to whatever key the relay then presents.
*/

const IDENTITY_MOVE_TYPE = 'identity-move';

/* Sent once to each contact when the account moves (adoptMovedIdentity), and
   again to anybody met afterwards while the window is open. */
const identityMoveSentTo = new Set();
function identityMoveFrame() {
  const identity = chatState.identity;
  if (identity?.v !== 4 || !identity.continuation || !identity.legacy) return null;
  if (Number(identity.legacy.until || 0) <= Date.now()) return null;
  return { type: IDENTITY_MOVE_TYPE, continuation: identity.continuation, peerId: chatState.peerId || '', createdAt: new Date().toISOString() };
}
function sendIdentityMove(peerRecord, { force = false } = {}) {
  const frame = identityMoveFrame();
  if (!frame || !peerRecord || peerRecord.type || isSelfPeerRecord(peerRecord)) return false;
  const key = peerRecord.fingerprint || peerRecord.peerId;
  if (!key || (!force && identityMoveSentTo.has(key))) return false;
  identityMoveSentTo.add(key);
  /* Live when there is a channel; queued on the relay otherwise. The move
     is public information (both keys are public), so it needs no seal; the
     signatures are what protect it. */
  try { return relaySessionEvent(peerRecord, frame); } catch (error) {
    console.warn('[Chat] could not tell a contact about the identity move:', error);
    return false;
  }
}
/* The account just moved on this device. Every contact is told; sessions are
   re-keyed because the kex seals now go to and from the new keys. */
function adoptMovedIdentity(identity) {
  if (identity?.v !== 4) return;
  noteOwnMove(identity);
  /* Prekeys were signed by the RSA key; signed again by the new one before
     the hello that follows publishes them. */
  if (typeof ensurePrekey === 'function') ensurePrekey().catch((error) => console.warn('[Chat] prekeys could not be signed again after the move:', error));
  (chatState.peers || []).filter((peer) => !peer.type && (peer.fingerprint || peer.peerId)).forEach((peer) => {
    sendIdentityMove(peer, { force: true });
  });
  if (typeof renderStaticUi === 'function') renderStaticUi();
}
function noteOwnMove(identity) {
  console.info(`[Chat] this account is now ${identity.fingerprint.slice(0, 16)}… (identity v4); its previous key ${String(identity.legacy?.fingerprint || '').slice(0, 16)}… verifies until ${new Date(identity.legacy?.until || 0).toISOString()}.`);
}

/* A contact's move, received. Returns true when the record was moved. */
async function acceptIdentityMove(frame, senderRecord) {
  const signed = frame?.continuation;
  const statement = signed?.statement;
  if (!statement) return false;
  /* The contact as this device knows them: by the OLD fingerprint, which is
     the one pinned. A statement about somebody unknown changes nothing. */
  const record = senderRecord && (senderRecord.fingerprint === statement.oldFp || senderRecord.trustedFingerprint === statement.oldFp)
    ? senderRecord
    : (chatState.peers || []).find((peer) => !peer.type && (peer.fingerprint === statement.oldFp || peer.trustedFingerprint === statement.oldFp)) || null;
  if (!record) {
    /* Already moved (a repeat), or never known: nothing to do. */
    return false;
  }
  const pinned = record.trustedKey || record.publicKeyData || '';
  const verdict = await PoorijaIdentity.checkContinuation(signed, pinned);
  if (!verdict.ok) {
    console.warn(`[Chat] an identity move for ${String(statement.oldFp).slice(0, 16)}… was refused: ${verdict.reason}`);
    return false;
  }
  /* Anchor the conversation first: getConversationKey is fingerprint-first,
     and the fingerprint is about to move. The thread stays the same thread. */
  if (!record.conversationId) record.conversationId = getConversationKey(record);
  const wasVerified = Boolean(record.trustedFingerprint && isPeerVerified(record.trustedFingerprint));
  const oldKey = pinned;
  const oldFp = statement.oldFp;
  Object.assign(record, {
    publicKeyData: statement.sk,
    fingerprint: statement.newFp,
    trustedKey: statement.sk,
    trustedFingerprint: statement.newFp,
    trustedAt: new Date().toISOString(),
    agreeKey: statement.ak,
    agreeKeySig: signed.akSig,
    legacyKey: oldKey,
    legacyFingerprint: oldFp,
    legacyUntil: Number(statement.at) + PoorijaIdentity.LEGACY_WINDOW_MS,
    movedAt: new Date(Number(statement.at)).toISOString(),
    /* A key change that had been pending against the old key is moot: the
       old key itself has named its successor. */
    pendingKey: '',
    pendingFingerprint: '',
    keyChangedAt: '',
    keyChangeWasVerified: false,
    /* What the contact had been seen to do (hybrid exchange, AAD) stays: it
       is the same person on a newer key, not a stranger. */
  });
  /* A verification was of the old key, and the old key signed the new one:
     the person who compared the safety number is still talking to whom they
     compared it with (the owner's decision, 2026-11-19). */
  if (wasVerified) {
    setPeerVerified(statement.newFp, true);
    setPeerVerified(oldFp, false);
  }
  /* Session keys were exchanged under the old key's seals; the next
     connection exchanges anew under the new ones. */
  if (typeof clearSessionKeysFor === 'function') clearSessionKeysFor({ ...record, fingerprint: oldFp });
  saveContacts();
  appendHistory(getConversationKey(record), {
    id: `identity-move-${statement.newFp.slice(0, 16)}`,
    type: 'system-note',
    direction: 'in',
    noteKind: 'identity-move',
    text: t(
      'کلیدهای امنیتی این مخاطب به نسل تازه ارتقا یافت. شمارهٔ امنیتی به همین دلیل عوض شده است؛ کلید قبلی خودش این ارتقا را امضا و تأیید کرده است.',
      'This contact upgraded their security keys. Your safety number changed because of this upgrade; it was confirmed by their previous key.',
    ),
    createdAt: new Date().toISOString(),
  });
  renderPeers();
  renderActivePeer();
  renderMessages();
  return true;
}

/* A record still known by an old fingerprint resolves by it during the
   window: an envelope or a hello that names the old fingerprint finds the
   moved contact. */
function findPeerByLegacyFingerprint(fingerprint) {
  if (!fingerprint) return null;
  return (chatState.peers || []).find((peer) => peer.legacyFingerprint === fingerprint && Number(peer.legacyUntil || 0) > Date.now()) || null;
}
/* Past its window, a contact's old key is forgotten here too. */
function retireContactLegacyKeys(now = Date.now()) {
  let changed = false;
  for (const peer of chatState.peers || []) {
    if (peer.legacyKey && Number(peer.legacyUntil || 0) <= now) {
      peer.legacyKey = '';
      peer.legacyFingerprint = '';
      peer.legacyUntil = 0;
      changed = true;
    }
  }
  if (changed) saveContacts();
  return changed;
}

/* ---- published to globalThis (roadmap 2.1, tools/esm-chat.cjs) ---- */
Object.defineProperties(globalThis, {
  "IDENTITY_MOVE_TYPE": { get() { return IDENTITY_MOVE_TYPE; }, set() { throw new TypeError('Assignment to constant variable IDENTITY_MOVE_TYPE.'); }, configurable: true },
  "identityMoveSentTo": { get() { return identityMoveSentTo; }, set() { throw new TypeError('Assignment to constant variable identityMoveSentTo.'); }, configurable: true },
  "identityMoveFrame": { get() { return identityMoveFrame; }, set(value) { identityMoveFrame = value; }, configurable: true },
  "sendIdentityMove": { get() { return sendIdentityMove; }, set(value) { sendIdentityMove = value; }, configurable: true },
  "adoptMovedIdentity": { get() { return adoptMovedIdentity; }, set(value) { adoptMovedIdentity = value; }, configurable: true },
  "noteOwnMove": { get() { return noteOwnMove; }, set(value) { noteOwnMove = value; }, configurable: true },
  "acceptIdentityMove": { get() { return acceptIdentityMove; }, set(value) { acceptIdentityMove = value; }, configurable: true },
  "findPeerByLegacyFingerprint": { get() { return findPeerByLegacyFingerprint; }, set(value) { findPeerByLegacyFingerprint = value; }, configurable: true },
  "retireContactLegacyKeys": { get() { return retireContactLegacyKeys; }, set(value) { retireContactLegacyKeys = value; }, configurable: true },
});
