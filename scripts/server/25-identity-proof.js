/* ------------------------------------------------------------------
 * Identity proof
 *
 * The fingerprint in a hello was self-declared: whoever typed it collected
 * the mail queued for it and could ACK it away. The identity key behind
 * the fingerprint is the only thing that can settle the claim, so hello
 * seals a random nonce with the claimed public key and only the holder of
 * the matching private key can open it and return it.
 * ------------------------------------------------------------------ */
const IDENTITY_CHALLENGE_TIMEOUT_MS = 15 * 1000;

function clearIdentityChallenge(record) {
  if (!record) return;
  if (record.idChallengeTimer) {
    clearTimeout(record.idChallengeTimer);
    record.idChallengeTimer = null;
  }
  record.idChallengeNonce = null;
  record.idSignNonce = null;
}

/* Proof of an identity by signature.
 *
 * The challenge used to be one thing only: a nonce sealed to the claimed
 * public key, to be opened and sent back. That made every client a service
 * that opens whatever is sealed to its identity key — and a message's key,
 * for somebody who is away, is sealed to that same key in that same way and
 * is the same 32 bytes long. A relay holding such an envelope could send its
 * seal as a "challenge" and be handed the message key by the recipient's own
 * device. This relay would not; the client could not know that.
 *
 * So a client is now asked to SIGN: a fresh nonce, under a label that nothing
 * else it signs begins with. A signature opens nothing. The sealed challenge
 * is still sent beside it, with a nonce of its own, for builds that only know
 * how to open one; a build that knows better answers the other and ignores it.
 */
function identityProofText(purpose, fingerprint, nonceBase64) {
  return Buffer.from(['relay-proof/1', String(purpose), String(fingerprint || ''), String(nonceBase64 || '')].join('\n'));
}
function identityProofSigned(publicKeyData, purpose, fingerprint, nonceBase64, signatureBase64) {
  if (!publicKeyData || !nonceBase64 || !signatureBase64) return false;
  /* The key must be the fingerprint's before its signature means anything:
     RSA PKCS#1 v1.5 for a v3 account, Ed25519 for a v4 one, the same text. */
  if (!identityV4.keyMatchesFingerprint(String(publicKeyData).replace(/\s+/g, ''), fingerprint)) return false;
  return identityV4.verifyProof(String(publicKeyData).replace(/\s+/g, ''), identityProofText(purpose, fingerprint, nonceBase64), signatureBase64);
}

function beginIdentityChallenge(record) {
  /* The challenges later hellos replace: their answers may still be on the
     way, and must not spend the current one when they land (see id-proof).
     A few at most — a client says hello again on its own profile changes. */
  if (record.idChallengeNonce) record.idSupersededNonces = [...(record.idSupersededNonces || []), record.idChallengeNonce].slice(-4);
  clearIdentityChallenge(record);
  record.identityVerified = false;
  /* A v4 account is asked to sign and nothing else. Its agreement key is
     never used to open what a relay hands it, so there is no sealed nonce;
     the id-proof handler takes only a signature from it. */
  if (identityV4.keyKind(record.publicKeyData) === 'v4') {
    record.idChallengeNonce = crypto.randomBytes(32);
    record.idSignNonce = crypto.randomBytes(32);
    record.idSignOnly = true;
    record.idChallengeTimer = setTimeout(() => {
      if (record.idChallengeNonce) {
        clearIdentityChallenge(record);
        safeSend(record.ws, { type: 'error', reason: 'identity-unverified' });
      }
    }, IDENTITY_CHALLENGE_TIMEOUT_MS);
    record.idChallengeTimer.unref?.();
    safeSend(record.ws, { type: 'id-challenge', sign: record.idSignNonce.toString('base64') });
    return;
  }
  record.idSignOnly = false;
  const nonce = crypto.randomBytes(32);
  /* The key travels as base64 SPKI; publicEncrypt wants it dressed as a PEM. */
  const body = String(record.publicKeyData || '').replace(/\s+/g, '');
  const pem = `-----BEGIN PUBLIC KEY-----\n${(body.match(/.{1,64}/g) || []).join('\n')}\n-----END PUBLIC KEY-----`;
  try {
    const cipher = crypto.publicEncrypt(
      { key: pem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      nonce,
    );
    record.idChallengeNonce = nonce;
    /* A different nonce from the sealed one: this one travels in the clear,
       so it must not be an answer to the other. */
    record.idSignNonce = crypto.randomBytes(32);
    /* No answer inside the window keeps the socket's degraded presence, but
       nothing keyed to the claimed identity answers to it afterwards. */
    record.idChallengeTimer = setTimeout(() => {
      if (record.idChallengeNonce) {
        clearIdentityChallenge(record);
        safeSend(record.ws, { type: 'error', reason: 'identity-unverified' });
      }
    }, IDENTITY_CHALLENGE_TIMEOUT_MS);
    record.idChallengeTimer.unref?.();
    safeSend(record.ws, { type: 'id-challenge', cipher: cipher.toString('base64'), sign: record.idSignNonce.toString('base64') });
  } catch (error) {
    /* A key that cannot be used to seal a challenge is not one this relay
       can take a fingerprint's word for. */
    console.warn(`[Presence] Could not challenge ${record.fingerprint}: ${error?.message || error}`);
    safeSend(record.ws, { type: 'error', reason: 'identity-unverified' });
  }
}

function closeDuplicatePresenceRecords(record) {
  for (const [clientId, existing] of presence.entries()) {
    if (clientId === record.clientId) continue;
    const sameFingerprint = record.fingerprint && existing.fingerprint === record.fingerprint;
    const samePeerId = record.peerId && existing.peerId === record.peerId;
    if (!sameFingerprint && !samePeerId) continue;
    /* One account may prove itself from several sockets at once: a second
       VERIFIED connection for a fingerprint is a second device of the same
       identity, not a reconnect, and closing it here would make multi-device
       impossible no matter what delivery did. Anything unproven is still
       replaced, exactly as before — this is not a door back to claim-based
       kicks, because the newcomer has proven and the old one has not. */
    if (sameFingerprint && record.identityVerified && existing.identityVerified) {
      console.log(`[Presence] Second verified device for ${record.fingerprint?.slice(0, 12) ?? ''} (${clientId.slice(0, 8)}) — coexisting`);
      continue;
    }
    console.log(`[Presence] Replacing duplicate connection ${clientId} for ${record.username || record.peerId}`);
    presence.delete(clientId);
    try {
      existing.ws?.close(4000, 'duplicate-presence');
    } catch (_error) {
      try { existing.ws?.terminate(); } catch (_terminateError) {}
    }
  }
}

/* A duplicate is replaced only by a connection that proved itself. The
   fingerprint and the peerId a hello carries are claims, and both are
   broadcast to every client in the peers payload — so closing duplicates on
   the claim alone let anybody disconnect anybody, faster than they could
   reconnect, with nothing but a name they read off the contact list. The
   call used to sit in the hello handler before any challenge ran; it runs
   now from the two places where identity is actually established, and a
   reconnect costs the same one round trip it always did. */

// Ensure data directory exists
try {
  fs.mkdirSync(path.dirname(PUSH_STORE_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(OFFLINE_STORE_PATH), { recursive: true });
} catch (_e) {}

/* Same ceiling as the relay frames: a hello carries an avatar but nothing
   near this size, and an unbounded frame is buffered before it is parsed. */
const wsServer = attachSocketKeepAlive(
  new WebSocketServer({ noServer: true, maxPayload: 12 * 1024 * 1024 }),
  'Presence',
);

