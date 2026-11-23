/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Part 19 of 36 of the Secure Chat module.
   Split out of the original single-file js/chat.js — see js/chat/README.md.
   These files share one global scope and are loaded in order; the numbering is
   that order and must not be changed.

   Forward secrecy
*/

/* =====================================================================
   Forward secrecy
   ---------------------------------------------------------------------
   The identity key is an RSA-OAEP pair that never changes. Wrapping every
   session key to it means one compromise of that key opens everything ever
   recorded — which is the whole of what forward secrecy is about.

   Two ECDH layers sit on top of it, both P-256 because that is what every
   browser's WebCrypto actually has:

   LIVE SESSIONS (both sides connected). Each side makes an ephemeral pair,
   sends the PUBLIC half to the other encrypted to their pinned identity key,
   and throws the private half away when the session ends. The identity key
   only ever protects the delivery of a public value, so learning it later
   reveals nothing: without an ephemeral private key there is no shared secret
   to recover.

   OFFLINE MESSAGES (recipient not there). They cannot take part, so they
   publish a prekey in advance and rotate it. The sender does ECDH against
   whichever prekey is current, and the recipient keeps that private prekey
   only until it expires. After PREKEY_LIFETIME_MS an undelivered message is
   not "hard to read" — the key it needs no longer exists on any device.
   ===================================================================== */
const CHAT_PREKEY_STORAGE_KEY = 'poorija_chat_prekeys';
/* Fifteen days, and the app says so before anyone relies on it. */
const PREKEY_LIFETIME_MS = 15 * 24 * 60 * 60 * 1000;
/* A live session's key is re-negotiated at least this often, so a device that
   stays open for months is not still using the key it derived in January. */
const SESSION_KEY_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

async function exportEcdhPublic(keyPair) {
  return app().arrayBufferToBase64(await crypto.subtle.exportKey('spki', keyPair.publicKey));
}
async function importEcdhPublic(base64) {
  return crypto.subtle.importKey('spki', app().base64ToArrayBuffer(base64),
    { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}
async function importEcdhPrivate(base64) {
  return crypto.subtle.importKey('pkcs8', app().base64ToArrayBuffer(base64),
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
}
async function generateEcdhPair() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return {
    publicKeyData: await exportEcdhPublic(pair),
    privateKeyData: app().arrayBufferToBase64(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
    keyPair: pair,
  };
}
/* HKDF over the raw ECDH output, so the AES key is not the curve point itself
   and the two directions cannot collide with anything else derived here. */
async function deriveSharedAesKey(privateKey, publicKey, info) {
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const material = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode(info) },
    material, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
  );
}

/* ---- the hybrid exchange --------------------------------------------------

   A live session's key came from one thing: an ECDH exchange on P-256. A
   conversation recorded today can be kept, and P-256 is one of the things a
   large quantum computer breaks; so can the RSA key the exchange is sealed
   under. Whoever is recording now only has to wait.

   So the exchange carries a second secret beside the first: the side that
   offers sends an ML-KEM-768 public key made for this exchange alone, and the
   side that answers encapsulates to it. The session key is derived from BOTH
   secrets together, so it falls only if both do — ML-KEM is new, and the
   point of keeping the curve is not to have bet the conversation on it.

   The ML-KEM key and ciphertext travel in the clear (they are too big to
   seal under the identity key, and need not be secret), so each side signs
   what it sent with its identity key: somebody in the middle who swapped in
   an ML-KEM key of their own would be found out by the signature, not left
   holding half the secret.

   `kex3` is this exchange. A contact seen to do it is remembered as able to
   (kexPinned), and from then on an exchange with them that leaves the second
   secret out is refused: otherwise leaving it out is all an attacker needs
   to do. */
const KEX_HYBRID = 3;
const kexHybridAvailable = () => typeof PoorijaMlKem === 'object' && typeof PoorijaMlKem.keygen === 'function';
async function kexDigest(bytesOrText) {
  const bytes = typeof bytesOrText === 'string' ? new TextEncoder().encode(bytesOrText) : bytesOrText;
  return sha256Hex(bytes);
}
/* What the offerer signs: who is offering to whom, which offer, and the
   digests of the two public keys it sent — the ECDH one as it left this
   device (sealed), and the ML-KEM one. */
function kexOfferSignBytes(fromFingerprint, toFingerprint, offer) {
  /* Binding 4 (cap kx4, roadmap 5.2 finding F1): the signature also covers
     the exchange's version and the ratchet it asks for (dr, and the digests
     of the ratchet keys rp, rq). Binding 3 signed the key material only, so
     whoever carried the offer could take the ratchet fields out, or change
     them, and only a pin set on an earlier contact noticed. */
  if (offer.binding === 4) {
    return new TextEncoder().encode(['kex-offer/4', String(fromFingerprint || ''), String(toFingerprint || ''),
      String(offer.kid || ''), String(offer.pubDigest || ''), String(offer.pqDigest || ''),
      `v=${Number(offer.v) || 0}`, `dr=${Number(offer.dr) || 0}`, String(offer.rpDigest || ''), String(offer.rqDigest || '')].join('\n'));
  }
  return new TextEncoder().encode(['kex-offer/3', String(fromFingerprint || ''), String(toFingerprint || ''),
    String(offer.kid || ''), String(offer.pubDigest || ''), String(offer.pqDigest || '')].join('\n'));
}
/* What the answerer signs: the same, for its half, and the offer it answers
   — so an answer cannot be moved to another offer. */
function kexAnswerSignBytes(fromFingerprint, toFingerprint, answer) {
  if (answer.binding === 4) {
    return new TextEncoder().encode(['kex-answer/4', String(fromFingerprint || ''), String(toFingerprint || ''),
      String(answer.kid || ''), String(answer.pubDigest || ''), String(answer.pqctDigest || ''), String(answer.offerDigest || ''),
      `v=${Number(answer.v) || 0}`, `dr=${Number(answer.dr) || 0}`, String(answer.rpDigest || ''), String(answer.rqDigest || '')].join('\n'));
  }
  return new TextEncoder().encode(['kex-answer/3', String(fromFingerprint || ''), String(toFingerprint || ''),
    String(answer.kid || ''), String(answer.pubDigest || ''), String(answer.pqctDigest || ''), String(answer.offerDigest || '')].join('\n'));
}
/* The digests binding 4 signs for the ratchet keys: '' when the field is absent. */
async function kexRatchetDigests(frame) {
  return {
    rpDigest: typeof frame?.rp === 'string' && frame.rp ? await kexDigest(frame.rp) : '',
    rqDigest: typeof frame?.rq === 'string' && frame.rq ? await kexDigest(frame.rq) : '',
  };
}
/* Binding 4 is used with a contact who said they read it; once a contact has
   used it, an offer or an answer at binding 3 from them is refused (the
   downgrade it would be). */
const KEX_BINDING_PIN = 4;
function kexBindingPinned(session) {
  return (kexPinnedIdentity(session).record?.kexBinding || 0) >= KEX_BINDING_PIN;
}
function pinKexBinding(session) {
  const { record } = kexPinnedIdentity(session);
  if (!record || (record.kexBinding || 0) >= KEX_BINDING_PIN) return;
  record.kexBinding = KEX_BINDING_PIN;
  if (typeof saveContacts === 'function') saveContacts();
}
async function kexSign(bytes) {
  return identitySign(bytes);
}
/* The identity key a session's signatures are checked against: the one
   pinned for the contact, never one that arrived with the session. */
function kexPinnedIdentity(session) {
  const record = typeof findPeerBySession === 'function' ? findPeerBySession(session) : null;
  return {
    record,
    key: record?.trustedKey || record?.publicKeyData || session?.remotePublicKeyData || '',
    fingerprint: record?.trustedFingerprint || record?.fingerprint || session?.remoteFingerprint || '',
  };
}
async function kexVerify(session, bytes, signatureBase64) {
  const { key } = kexPinnedIdentity(session);
  if (!key || !signatureBase64) return false;
  try {
    return await verifyIdentitySignature(key, app().base64ToArrayBuffer(String(signatureBase64)), bytes);
  } catch (error) {
    return false;
  }
}
/* The session key and the key that confirms it, from both secrets and the
   whole exchange. The label is not the classical exchange's, so a key made
   one way can never be taken for a key made the other. */
async function deriveHybridKeys(privateKey, theirPublic, pqSecret, transcript) {
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: theirPublic }, privateKey, 256));
  const both = new Uint8Array(ecdh.length + pqSecret.length);
  both.set(ecdh, 0);
  both.set(pqSecret, ecdh.length);
  const material = await crypto.subtle.importKey('raw', both, 'HKDF', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode(`poorija-session-v3|${transcript}`) },
    material, 512));
  both.fill(0);
  ecdh.fill(0);
  const cryptoKey = await crypto.subtle.importKey('raw', bits.slice(0, 32), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  const confirmKey = await crypto.subtle.importKey('raw', bits.slice(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  bits.fill(0);
  return { cryptoKey, confirmKey };
}
async function kexConfirmTag(confirmKey, role, kid) {
  const tag = await crypto.subtle.sign('HMAC', confirmKey, new TextEncoder().encode(`kex-confirm/3|${role}|${kid}`));
  return app().arrayBufferToBase64(tag);
}
/* Checked by HMAC verify, which compares in constant time; comparing two
   base64 strings with !== stops at the first byte that differs (roadmap 5.2,
   finding F6). A tag that is not base64 of 32 bytes is simply wrong. */
async function kexConfirmTagValid(confirmKey, role, kid, tagBase64) {
  let tag;
  try { tag = new Uint8Array(app().base64ToArrayBuffer(String(tagBase64 || ''))); } catch (_error) { return false; }
  if (tag.length !== 32) return false;
  return crypto.subtle.verify('HMAC', confirmKey, tag, new TextEncoder().encode(`kex-confirm/3|${role}|${kid}`));
}
/* An answer has gone out and its confirmation is on the way. Asking for a
   key in that moment makes the other side start again, and the exchange
   that was about to finish is thrown away for one that will be asked about
   in turn. A few seconds is far longer than a confirmation takes. */
function kexSettling(session) {
  return Boolean(session?.kexPending) && Date.now() - (session.kexPending.at || 0) < 5000;
}
/* Remembered on the contact once they have been seen to do it. */
function pinKexHybrid(session) {
  const { record } = kexPinnedIdentity(session);
  if (!record || record.kexPinned >= KEX_HYBRID) return;
  record.kexPinned = KEX_HYBRID;
  if (typeof saveContacts === 'function') saveContacts();
}
function kexHybridPinned(session) {
  return (kexPinnedIdentity(session).record?.kexPinned || 0) >= KEX_HYBRID;
}

/* ---- a prekey says whose it is -------------------------------------------

   A prekey is what somebody writes to while this device is away, and it gets
   to them by the relay: in the hello, repeated to whoever asks. It used to
   travel bare. The relay could hand out a prekey of its own in place of this
   one, open what was then written to it, and seal it again to the real one
   so that nothing looked different at either end — reading the offline
   messages of a conversation that is end-to-end encrypted against exactly
   that relay.

   So a prekey is signed by the identity key, over everything that makes it
   this prekey of this person until this time, and the sender checks that
   signature against the identity key it has PINNED for the contact — never
   one that arrived with the prekey. One that does not check is not used; the
   message goes under the seal to the identity key instead, which has no
   window but cannot be read by the relay. */
function prekeySignBytes(fingerprint, prekey) {
  return new TextEncoder().encode([
    'prekey/1',
    String(fingerprint || ''),
    String(prekey?.prekeyId || prekey?.id || ''),
    String(prekey?.prekeyPublic || prekey?.publicKeyData || ''),
    String(prekey?.prekeyExpiresAt || prekey?.expiresAt || ''),
  ].join('\n'));
}
async function signPrekey(entry) {
  const identity = chatState.identity;
  if (!identity?.fingerprint || !identityHasPrivate(identity)) return '';
  const fingerprint = identity.fingerprint;
  /* From the identity already in hand, and NOT through ensureIdentity: a
     prekey is made at the end of the identity's own initialisation, and
     asking for the identity from there waits on the very promise that is
     waiting on this. */
  const signature = await PoorijaIdentity.sign(identity, prekeySignBytes(fingerprint, entry));
  return app().arrayBufferToBase64(signature);
}
/* ---- a prekey's second half ------------------------------------------------

   A message for a device that is away is sealed to its prekey and then sits
   on the relay until it is collected: of everything this app sends, that is
   what somebody else's disk holds, to be kept for the day a P-256 key can be
   broken. So a prekey has an ML-KEM-768 half too, and the seal is made under
   a key derived from both (sealWithPrekey).

   It is signed in a statement of its own, `prekey/2`, which names the same
   prekey as `prekey/1` and adds the digest of the ML-KEM key. The first
   statement stays as it was, so a build that knows only that one still reads
   the P-256 half; this one is what says the ML-KEM half belongs with it. */
function prekeyPqSignBytes(fingerprint, prekey, pqDigest) {
  return new TextEncoder().encode([
    'prekey/2',
    String(fingerprint || ''),
    String(prekey?.prekeyId || prekey?.id || ''),
    String(prekey?.prekeyPublic || prekey?.publicKeyData || ''),
    String(prekey?.prekeyExpiresAt || prekey?.expiresAt || ''),
    String(pqDigest || ''),
  ].join('\n'));
}
/* Gives a prekey its ML-KEM half and both signatures, where it lacks them. */
async function completePrekey(entry) {
  if (!entry.sig) entry.sig = await signPrekey(entry).catch(() => '');
  /* Which account key signed it, so a move to identity v4 is seen to call
     for a new signature (ensurePrekey). */
  if (entry.sig) entry.signedBy = chatState.identity?.fingerprint || '';
  if (!kexHybridAvailable() || !identityHasPrivate(chatState.identity)) return entry;
  if (!entry.pqPublic || !entry.pqSecret) {
    const pair = PoorijaMlKem.keygen();
    const b64 = (bytes) => app().arrayBufferToBase64(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    entry.pqPublic = b64(pair.publicKey);
    entry.pqSecret = b64(pair.secretKey);
    entry.pqSig = '';
  }
  if (!entry.pqSig) {
    try {
      const bytes = prekeyPqSignBytes(chatState.identity.fingerprint, entry, await kexDigest(entry.pqPublic));
      entry.pqSig = app().arrayBufferToBase64(await PoorijaIdentity.sign(chatState.identity, bytes));
    } catch (error) {
      entry.pqSig = '';
    }
  }
  return entry;
}
/* Whether the ML-KEM half on a contact's record is theirs: the P-256 half it
   came with is (prekeyIsTheirs), and the second statement, over both, is
   signed by the identity key pinned for them. */
async function prekeyPqIsTheirs(record, candidate = record) {
  if (!candidate?.prekeyPq || !candidate.prekeyPqSig) return false;
  if (!await prekeyIsTheirs(record, candidate)) return false;
  const identityKey = record?.trustedKey || record?.publicKeyData || '';
  const fingerprint = record?.trustedFingerprint || record?.fingerprint || '';
  try {
    if (app().base64ToArrayBuffer(candidate.prekeyPq).byteLength !== 1184) return false;
    return await verifyIdentitySignature(identityKey, app().base64ToArrayBuffer(candidate.prekeyPqSig),
      prekeyPqSignBytes(fingerprint, candidate, await kexDigest(candidate.prekeyPq)));
  } catch (error) {
    return false;
  }
}
/* The key a hybrid seal is made under: the curve's secret and ML-KEM's, and
   everything the seal consists of. A label of its own, so it is never the
   key the classical seal would have used for the same two halves. */
async function deriveHybridWrapKey(privateKey, publicKey, pqSecret, transcript) {
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256));
  const both = new Uint8Array(ecdh.length + pqSecret.length);
  both.set(ecdh, 0);
  both.set(pqSecret, ecdh.length);
  const material = await crypto.subtle.importKey('raw', both, 'HKDF', false, ['deriveKey']);
  both.fill(0);
  ecdh.fill(0);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode(`poorija-offline-v3|${transcript}`) },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

/* Whether the prekey on a contact's record is theirs: signed by the identity
   key pinned for them, and still inside a window no longer than a prekey's
   own. Asked at the moment of use, so it does not rest on a flag that some
   other path could have set. */
async function prekeyIsTheirs(record, candidate = record) {
  const identityKey = record?.trustedKey || record?.publicKeyData || '';
  const fingerprint = record?.trustedFingerprint || record?.fingerprint || '';
  if (!identityKey || !fingerprint) return false;
  if (!candidate?.prekeyId || !candidate.prekeyPublic || !candidate.prekeySig) return false;
  const expires = Date.parse(candidate.prekeyExpiresAt || 0);
  if (!expires || expires <= Date.now()) return false;
  /* A day's grace for two clocks that disagree. Longer than that is a window
     nobody's build makes, and a way to keep a private key alive past it. */
  if (expires - Date.now() > PREKEY_LIFETIME_MS + 24 * 60 * 60 * 1000) return false;
  try {
    return await verifyIdentitySignature(identityKey, app().base64ToArrayBuffer(candidate.prekeySig), prekeySignBytes(fingerprint, candidate));
  } catch (error) {
    return false;
  }
}
/* A prekey that arrived for a contact — by the relay, or down a live session.
   Taken up only once its signature checks, so one that does not check can
   never push out one that did. Between two that check, the later window
   wins, as it always has (a contact with two devices publishes two). */
async function considerPrekey(record, candidate) {
  if (!record || !candidate) return false;
  const offered = {
    prekeyId: String(candidate.prekeyId || '').slice(0, 64),
    prekeyPublic: String(candidate.prekeyPublic || '').slice(0, 512),
    prekeyExpiresAt: String(candidate.prekeyExpiresAt || '').slice(0, 40),
    prekeySig: String(candidate.prekeySig || '').slice(0, 1024),
    prekeyPq: String(candidate.prekeyPq || '').slice(0, 2048),
    prekeyPqSig: String(candidate.prekeyPqSig || '').slice(0, 1024),
  };
  if (record.prekeyId === offered.prekeyId && record.prekeyPublic === offered.prekeyPublic && record.prekeySig === offered.prekeySig
    && (record.prekeyPq || '') === offered.prekeyPq && (record.prekeyPqSig || '') === offered.prekeyPqSig) return true;
  if (!await prekeyIsTheirs(record, offered)) return false;
  /* An ML-KEM half that does not check is not a reason to refuse the P-256
     half it came with, which did: it is dropped, and the rest considered. */
  const offeredHybrid = await prekeyPqIsTheirs(record, offered);
  if (!offeredHybrid) { offered.prekeyPq = ''; offered.prekeyPqSig = ''; }
  const held = Date.parse(record.prekeyExpiresAt || 0) || 0;
  const heldIsGood = held > Date.now() && await prekeyIsTheirs(record);
  const heldHybrid = heldIsGood && await prekeyPqIsTheirs(record);
  /* A prekey with both halves is not given up for one with only the first,
     however fresh: a relay that wants the second half gone only has to repeat
     the prekey without it. It is kept for as long as it lasts. */
  /* Either of the two having both halves, signed, is this contact shown to
     have them. That is remembered, and is what a message for them is then
     held out for (prekeyHybridOwed). */
  if ((heldHybrid || offeredHybrid) && !((record.kexPinned || 0) >= KEX_HYBRID)) {
    record.kexPinned = KEX_HYBRID;
    if (typeof saveContacts === 'function') saveContacts();
  }
  if (heldHybrid && !offeredHybrid) return true;
  if (heldIsGood && heldHybrid === offeredHybrid && held >= Date.parse(offered.prekeyExpiresAt)) return true;
  Object.assign(record, offered);
  if (typeof saveContacts === 'function') saveContacts();
  /* What was waiting for exactly this goes now. */
  if (offeredHybrid && typeof releaseHeldForPrekey === 'function') setTimeout(() => { releaseHeldForPrekey(record).catch(() => {}); }, 0);
  return true;
}

/* ---- a message is not sealed with less than the contact can open ---------

   A message for somebody who is away is sealed to their prekey, and the
   relay is what hands the prekey over. For a contact on a build with a
   post-quantum half, a relay that left that half out — or handed over
   nothing, or something that does not check — used to get a message sealed
   to the curve alone, or to the identity key: weaker, and its choice.

   A contact who has once been seen with both halves (kexPinned, which only
   ever goes up) is owed a seal with both. With no such prekey in hand that
   is still inside its window and still theirs, nothing is sealed: the
   message stays on this device and goes when one arrives. */
function prekeyHybridOwed(record) {
  return (record?.kexPinned || 0) >= KEX_HYBRID;
}
async function prekeyHybridInHand(record) {
  if (!record?.prekeyPublic || !record.prekeyId || !kexHybridAvailable()) return false;
  if (!record.prekeyExpiresAt || !(Date.parse(record.prekeyExpiresAt) > Date.now())) return false;
  return await prekeyIsTheirs(record) && await prekeyPqIsTheirs(record);
}
async function prekeyHybridMissing(record) {
  return prekeyHybridOwed(record) && !await prekeyHybridInHand(record);
}

/* ---- the published prekey, and the ones still inside their window ------- */
function loadPrekeys() {
  const stored = loadEncrypted(CHAT_PREKEY_STORAGE_KEY, null);
  return Array.isArray(stored) ? stored : [];
}
function savePrekeys(list) {
  saveEncrypted(CHAT_PREKEY_STORAGE_KEY, list);
}
/* Expired prekeys are deleted, not archived. That deletion IS the feature. */
function prunePrekeys(list) {
  const now = Date.now();
  return list.filter((entry) => Date.parse(entry.expiresAt || 0) > now);
}
async function ensurePrekey() {
  if (!isUnlocked()) return null;
  let prekeys = prunePrekeys(loadPrekeys());
  const now = Date.now();
  /* Rotate at a third of the lifetime, so a message sent just before a
     rotation still has most of its window left. */
  const current = prekeys.find((entry) => Date.parse(entry.createdAt || 0) > now - PREKEY_LIFETIME_MS / 3);
  if (current) {
    /* A prekey is signed by the account key that was in force when it was
       signed. After a move to identity v4 the old RSA signatures no longer
       verify against the new key, so every prekey is signed again. */
    const signer = chatState.identity?.fingerprint || '';
    for (const entry of prekeys) {
      if (entry.signedBy && entry.signedBy !== signer) { entry.sig = ''; entry.pqSig = ''; }
    }
    if (current.signedBy !== signer) { current.sig = ''; current.pqSig = ''; }
    /* One made before prekeys were signed, or before they had an ML-KEM half,
       gets what it lacks now. */
    await completePrekey(current);
    savePrekeys(prekeys);
    chatState.prekeys = prekeys;
    return current;
  }
  const pair = await generateEcdhPair();
  const entry = {
    id: generateId('pk'),
    publicKeyData: pair.publicKeyData,
    privateKeyData: pair.privateKeyData,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PREKEY_LIFETIME_MS).toISOString(),
  };
  await completePrekey(entry);
  prekeys = [...prekeys, entry].slice(-4);
  savePrekeys(prekeys);
  chatState.prekeys = prekeys;
  return entry;
}

/* Each INSTALL has a unique device id, distinct from the identity it holds.
   Two devices linked to the same account share the fingerprint but never
   the device id — this is how the device list tells them apart and how
   "which device am I on" is answered without asking the user. */
function getDeviceId() {
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(CHAT_DEVICE_ID_STORAGE_KEY) || 'null'); } catch (_error) { stored = null; }
  if (!stored || !stored.id) {
    stored = { id: generateId('device'), linkedAt: new Date().toISOString() };
    try { localStorage.setItem(CHAT_DEVICE_ID_STORAGE_KEY, JSON.stringify(stored)); } catch (_error) { /* private mode */ }
  }
  return stored.id;
}

function findPrekey(id) {
if (!id) return null;
const now = Date.now();
/* The live list first. This is called on every arriving envelope, including
   ones that land while the app is locked — reading only storage there once
   made every locked-interval envelope look past its window, and the relay
   destroyed real mail on the strength of that. */
const live = (chatState.prekeys || []).find((entry) => entry.id === id
  && Date.parse(entry.expiresAt || 0) > now);
if (live) return live;
return prunePrekeys(loadPrekeys()).find((entry) => entry.id === id) || null;
}

let chatIdentityInitialization = null;
window.addEventListener('poorija:lock', () => { chatIdentityInitialization = null; });
async function ensureIdentity() {
  const address = chatStorageAddress(CHAT_IDENTITY_STORAGE_KEY);
  if (chatIdentityInitialization?.address === address) return chatIdentityInitialization.promise;
  const operation = { address, promise: null };
  chatIdentityInitialization = operation;
  operation.promise = initializeChatIdentity(operation);
  try { return await operation.promise; }
  finally { if (chatIdentityInitialization === operation) chatIdentityInitialization = null; }
}
async function initializeChatIdentity(operation) {
/* After an emergency wipe this page does not get another identity. */
if (chatState.wiped) return null;
if (chatState.identity?.publicKeyData && identityHasPrivate(chatState.identity)) {
return chatState.identity;
}
const stored = loadEncrypted(CHAT_IDENTITY_STORAGE_KEY, null);
if (stored?.publicKeyData && identityHasPrivate(stored)) {
chatState.identity = await settleIdentityVersion(stored);
await ensurePrekey();
return chatState.identity;
}
if (!isUnlocked()) return null;
const keyPair = await crypto.subtle.generateKey({
name: 'RSA-OAEP',
modulusLength: 3072,
publicExponent: new Uint8Array([1, 0, 1]),
hash: 'SHA-256',
}, true, ['encrypt', 'decrypt']);
const exportedPublic = await crypto.subtle.exportKey('spki', keyPair.publicKey);
const exportedPrivate = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
const identity = {
publicKeyData: app().arrayBufferToBase64(exportedPublic),
privateKeyData: app().arrayBufferToBase64(exportedPrivate),
fingerprint: await sha256Hex(exportedPublic),
createdAt: new Date().toISOString(),
/* Made here: this device founds the account's roster as its primary
   (58-device-roster.js). */
origin: 'generated',
};
// RSA generation can overlap startup, Copy/QR, import, or a profile lock.
// Never publish a second identity or write one into a different vault.
if (chatState.wiped || !isUnlocked() || chatIdentityInitialization !== operation
  || operation.address !== chatStorageAddress(CHAT_IDENTITY_STORAGE_KEY)) return null;
if (chatState.identity?.publicKeyData && identityHasPrivate(chatState.identity)) return chatState.identity;
chatState.identity = await settleIdentityVersion(identity);
saveEncrypted(CHAT_IDENTITY_STORAGE_KEY, chatState.identity);
await ensurePrekey();
return chatState.identity;
}
/* An identity record holds a private key to act with: RSA for v3, the
   Ed25519 one for v4. */
function identityHasPrivate(identity) {
return Boolean(identity && (identity.v === 4 ? identity.signPrivate && identity.agreePrivate : identity.privateKeyData));
}
/* Brings a stored or new identity to the version this device runs (roadmap
   1.2): a v3 account moves to v4 once — new Ed25519 and X25519 keys, the
   continuation its old RSA key and the new key both sign, the RSA key kept
   for ninety days — and a v4 account whose window has closed lets the RSA key
   go. A browser without both curves stays on v3, which is always safe.
   Linked devices move together: only a device that founded the account (or
   is its primary) moves it; the others receive the moved identity in the
   device sync and stay as they are until then. */
async function settleIdentityVersion(identity) {
if (typeof PoorijaIdentity !== 'object' || !identity) return identity;
if (identity.v === 4) {
const retired = PoorijaIdentity.retireLegacy(identity);
if (retired !== identity) {
saveEncrypted(CHAT_IDENTITY_STORAGE_KEY, retired);
console.info('[Chat] the identity\'s previous RSA key passed its ninety days and was removed.');
}
return retired;
}
if (!identityMayMigrate(identity)) return identity;
/* ONE move per account, whoever asks. The welcome frame and identity loading
   can both reach here in the same moment; two moves would make two different
   v4 identities, announce one and keep the other, and the account would be
   split between them. The move in flight is shared, and a stored identity that
   has already moved (written by the other caller) is the answer. */
const key = identity.fingerprint || '';
if (identityMoveInFlight && identityMoveInFlight.from === key) return identityMoveInFlight.promise;
const promise = (async () => {
const stored = loadEncrypted(CHAT_IDENTITY_STORAGE_KEY, null);
if (stored?.v === 4 && stored.legacy?.fingerprint === key) return stored;
try {
const moved = await PoorijaIdentity.migrate(identity);
if (!moved) return identity;
if (!isUnlocked() || chatState.wiped) return identity;
saveEncrypted(CHAT_IDENTITY_STORAGE_KEY, moved);
console.info('[Chat] the identity moved to v4 (Ed25519 + X25519); the previous key verifies for ninety days.');
return moved;
} catch (error) {
console.warn('[Chat] the identity could not move to v4; staying on the RSA key:', error);
return identity;
}
})();
identityMoveInFlight = { from: key, promise };
try { return await promise; } finally { if (identityMoveInFlight?.promise === promise) identityMoveInFlight = null; }
}
let identityMoveInFlight = null;
/* Who moves an account: the device that made it, or the primary the
   account's roster names. A device linked to the account waits for the
   primary's sync. And only against a relay that can prove a v4 key: the
   home relay must say so in /chat-health, or the account would lock itself
   out of its own mailbox. Tests and the owner can hold it back with
   localStorage 'poorija-identity-v4' = 'off'. */
function identityMayMigrate(identity) {
try { if (localStorage.getItem('poorija-identity-v4') === 'off') return false; } catch (_error) { /* private mode */ }
if (!chatState.relayIdentityKinds || !chatState.relayIdentityKinds.includes('v4')) return false;
const roster = typeof currentRoster === 'function' ? currentRoster() : null;
if (roster && typeof getDeviceId === 'function') return roster.primary?.d === getDeviceId();
return identity.origin !== 'linked';
}

function activePeer() {
const wantedClient = chatState.activePeerClientId || '';
const wantedKey = chatState.activeConversationId || '';
if (!wantedClient && !wantedKey) return null;
const records = allConversationRecords();
// The conversation key is the stable identity; a relay clientId is a UUID the
// presence server hands out fresh on every reconnect. Matching either in one
// pass let `find` return whichever record came first in the array, so a stale
// clientId could resolve to a different conversation than the one selected —
// the thread then read an unrelated key and rendered empty while the list
// preview, which uses the right record, still showed the messages.
// An empty id must never match a record that also has none.
const byKey = wantedKey
? records.find((peer) => getConversationKey(peer) === wantedKey)
: null;
if (byKey) return byKey;
return (wantedClient ? records.find((peer) => peer.clientId === wantedClient) : null) || null;
}
function activeSession() {
const peer = activePeer();
if (!peer || peer.clientId === 'system') return null;
return chatState.sessions.get(peer.peerId) || null;
}
function isCompactChatLayout() {
return window.matchMedia?.('(max-width: 1023px)').matches || false;
}
function updateChatShellMode() {
const shell = document.querySelector('.chat-shell');
if (!shell) return;
const hasConversation = Boolean(getActiveConversation());
shell.classList.toggle('chat-has-conversation', hasConversation);
['chats', 'calls', 'groups', 'connection'].forEach((view) => {
shell.classList.toggle(`chat-view-${view}`, chatState.activeView === view);
});
document.documentElement.classList.toggle('chat-screen-active', appState()?.activeTab === 'chat');
document.documentElement.classList.toggle('chat-conversation-active', hasConversation);
refreshComposerFocusFlag();
}

/* chat-composer-focused hides the phone's tab bar, which is right while you
   are typing and wrong the moment you are not. It was set when a conversation
   opened and cleared only by the composer's own blur event — an event that
   never fires when the composer is hidden by a class change instead. So going
   back to the list left the flag on and the bar gone, until a tap somewhere
   blurred something and it reappeared. Re-deriving it from what is actually
   focused, at every point the view changes, is the fix. */
function refreshComposerFocusFlag() {
const composer = document.getElementById('chatComposer');
const live = Boolean(composer)
&& document.activeElement === composer
&& composer.getBoundingClientRect().height > 0;
syncComposerViewportFocus(live);
}
function conversationHistory(record) {
const key = getConversationKey(record);
return key ? (chatState.history[key] || []) : [];
}
function saveSpaces() {
chatState.spaces.channels = [];
saveEncrypted(CHAT_SPACES_STORAGE_KEY, {
groups: chatState.spaces.groups,
channels: [],
});
}
function upsertSharedSpace(incoming, { addedBy = '' } = {}) {
if (!incoming?.conversationId || !incoming?.type) return null;
if (isReservedConversationKey(incoming.conversationId)) return null;
/* Whether this account said yes to the group is its own answer, and who put
   it there is what this device authenticated — neither is something a
   record from outside gets to carry (49-message-requests.js). */
const { accepted: _theirAnswer, addedBy: _theirClaim, ...space } = incoming;
if (space.type !== 'group') return null;
if (!spaceIncludesLocalUser(space)) return null;
const collection = chatState.spaces.groups;
const members = normalizeSpaceMembers(space.members);
/* A removal has to win over the union, whatever order the records arrive in:
   both sides know somebody left, so merging without subtracting puts them
   straight back. The removed list can name a member by any of their keys, so
   each candidate is also tested through the peer record it resolves to —
   the same key set broadcastSpaceRecord membership uses. */
const removed = new Set([...normalizeSpaceMembers(space.removed || [])]);
const isRemovedMember = (memberKey) => {
if (removed.has(memberKey)) return true;
const peer = findPeerByAnyKey(memberKey);
return Boolean(peer) && [getConversationKey(peer), peer.peerId, peer.clientId, peer.fingerprint]
.filter(Boolean).some((key) => removed.has(key));
};
const existing = collection.find((item) => item.conversationId === space.conversationId);
if (existing) {
/* Merging member lists is right when two devices learn about the same group
   from different directions, and wrong the moment somebody is removed — the
   union puts them straight back. A record carrying a newer revision is a
   deliberate edit, so it replaces instead of merging. */
const incomingRev = Number(space.rev || 0);
const currentRev = Number(existing.rev || 0);
const authoritative = incomingRev > currentRev;
normalizeSpaceMembers(existing.removed || []).forEach((key) => removed.add(key));
const mergedMembers = (authoritative ? members : normalizeSpaceMembers([
...normalizeSpaceMembers(existing.members),
...members,
space.ownerPeerId,
space.ownerClientId,
space.ownerFingerprint,
])).filter((memberKey) => !isRemovedMember(memberKey));
Object.assign(existing, {
...existing,
...space,
type: 'group',
rev: Math.max(incomingRev, currentRev),
admins: authoritative
  ? normalizeSpaceMembers(space.admins)
  : normalizeSpaceMembers([...(existing.admins || []), ...(space.admins || [])]),
removed: normalizeSpaceMembers([...(existing.removed || []), ...(space.removed || [])]),
description: space.description !== undefined ? space.description : existing.description,
avatarData: space.avatarData !== undefined ? space.avatarData : existing.avatarData,
ownerPeerId: space.ownerPeerId || existing.ownerPeerId || '',
ownerClientId: space.ownerClientId || existing.ownerClientId || '',
ownerFingerprint: space.ownerFingerprint || existing.ownerFingerprint || '',
members: mergedMembers.length || authoritative ? mergedMembers : normalizeSpaceMembers(existing.members),
accepted: Boolean(existing.accepted),
addedBy: existing.addedBy || '',
});
saveSpaces();
return existing;
}
collection.unshift({
...space,
/* The authenticated sender of the record that created it here. */
addedBy: /^[a-f0-9]{16,128}$/i.test(String(addedBy || '')) ? String(addedBy) : '',
type: 'group',
ownerPeerId: space.ownerPeerId || '',
ownerClientId: space.ownerClientId || '',
ownerFingerprint: space.ownerFingerprint || '',
members: members.filter((memberKey) => !isRemovedMember(memberKey)),
});
saveSpaces();
return collection[0];
}
/* The record that travels, named and signed: the author rides inside the
   payload because over transit the envelope's sender field is blank by
   design, and the signature is what makes the name worth anything. */
async function buildSignedSpaceSyncPayload(space, note = '') {
const payload = {
type: 'space-sync',
space,
note: note || '',
createdAt: new Date().toISOString(),
fromFingerprint: chatState.identity?.fingerprint || '',
/* A card per member this device can vouch for — see 41-member-cards.js.
   Outside the signed bytes on purpose: each card proves its own key, and an
   older receiver that does not know the field still verifies the record. */
memberCards: typeof memberCardsFor === 'function' ? memberCardsFor(space) : [],
};
if (typeof signSpaceSyncPayload === 'function') await signSpaceSyncPayload(payload);
return payload;
}
function sendSpaceSync(peer, space, note = '') {
if (!peer || !space) return;
buildSignedSpaceSyncPayload(space, note)
.then((payload) => { try { sendRelayEnvelope(peer, payload); } catch (_error) { /* the caller's loop goes on */ } })
.catch(() => { /* an unsigned record is still better than none */ });
}
function broadcastSpaceRecord(space, note = '') {
if (!space) return;
const memberSet = new Set(Array.isArray(space.members) ? space.members : []);
const isMember = (peer) => {
if (peer.type || isSelfPeerRecord(peer)) return false;
if (!memberSet.size) return true;
return memberSet.has(getConversationKey(peer)) || memberSet.has(peer.peerId) || memberSet.has(peer.clientId) || memberSet.has(peer.fingerprint);
};
/* Built once, signed once, sent to everybody: the record does not differ by
   recipient, and neither does the signature over it. */
void buildSignedSpaceSyncPayload(space, note).then((payload) => {
chatState.peers
.filter((peer) => peer.status === 'online' && isMember(peer))
.forEach((peer) => {
sendRelayEnvelope(peer, payload);
});
/* A removal has to reach the people who were offline when it happened, or the
   roster they come back to still lists the removed member forever. The relay
   queue is the same road offline 1:1 traffic takes: sendRelayEnvelope with a
   non-ephemeral type is persisted by the relay until the recipient returns,
   and the space-sync handler on the other side applies it then. Fire-and-forget
   per member — one failure must not stop the rest being queued. */
chatState.peers
.filter((peer) => peer.status !== 'online' && isMember(peer))
.forEach((peer) => {
try {
sendRelayEnvelope(peer, payload);
} catch (error) {
console.warn('[Space] an offline member could not be sent the space record', error);
}
});
}).catch(() => { /* nothing to send unsigned for */ });
}
/* The log holds this many calls, newest first. */
const CALL_LOG_LIMIT = 80;
function saveCalls() {
/* Newest first, so the cap has to take from the front. slice(-80) kept the
   *oldest* eighty — harmless only because appendCall already trims. */
saveEncrypted(CHAT_CALLS_STORAGE_KEY, chatState.calls.slice(0, CALL_LOG_LIMIT));
}

/* ---- published to globalThis (roadmap 2.1, tools/esm-chat.cjs) ---- */
Object.defineProperties(globalThis, {
  "CHAT_PREKEY_STORAGE_KEY": { get() { return CHAT_PREKEY_STORAGE_KEY; }, set() { throw new TypeError('Assignment to constant variable CHAT_PREKEY_STORAGE_KEY.'); }, configurable: true },
  "PREKEY_LIFETIME_MS": { get() { return PREKEY_LIFETIME_MS; }, set() { throw new TypeError('Assignment to constant variable PREKEY_LIFETIME_MS.'); }, configurable: true },
  "SESSION_KEY_LIFETIME_MS": { get() { return SESSION_KEY_LIFETIME_MS; }, set() { throw new TypeError('Assignment to constant variable SESSION_KEY_LIFETIME_MS.'); }, configurable: true },
  "exportEcdhPublic": { get() { return exportEcdhPublic; }, set(value) { exportEcdhPublic = value; }, configurable: true },
  "importEcdhPublic": { get() { return importEcdhPublic; }, set(value) { importEcdhPublic = value; }, configurable: true },
  "importEcdhPrivate": { get() { return importEcdhPrivate; }, set(value) { importEcdhPrivate = value; }, configurable: true },
  "generateEcdhPair": { get() { return generateEcdhPair; }, set(value) { generateEcdhPair = value; }, configurable: true },
  "deriveSharedAesKey": { get() { return deriveSharedAesKey; }, set(value) { deriveSharedAesKey = value; }, configurable: true },
  "KEX_HYBRID": { get() { return KEX_HYBRID; }, set() { throw new TypeError('Assignment to constant variable KEX_HYBRID.'); }, configurable: true },
  "kexHybridAvailable": { get() { return kexHybridAvailable; }, set() { throw new TypeError('Assignment to constant variable kexHybridAvailable.'); }, configurable: true },
  "kexDigest": { get() { return kexDigest; }, set(value) { kexDigest = value; }, configurable: true },
  "kexOfferSignBytes": { get() { return kexOfferSignBytes; }, set(value) { kexOfferSignBytes = value; }, configurable: true },
  "kexAnswerSignBytes": { get() { return kexAnswerSignBytes; }, set(value) { kexAnswerSignBytes = value; }, configurable: true },
  "kexRatchetDigests": { get() { return kexRatchetDigests; }, set(value) { kexRatchetDigests = value; }, configurable: true },
  "KEX_BINDING_PIN": { get() { return KEX_BINDING_PIN; }, set() { throw new TypeError('Assignment to constant variable KEX_BINDING_PIN.'); }, configurable: true },
  "kexBindingPinned": { get() { return kexBindingPinned; }, set(value) { kexBindingPinned = value; }, configurable: true },
  "pinKexBinding": { get() { return pinKexBinding; }, set(value) { pinKexBinding = value; }, configurable: true },
  "kexSign": { get() { return kexSign; }, set(value) { kexSign = value; }, configurable: true },
  "kexPinnedIdentity": { get() { return kexPinnedIdentity; }, set(value) { kexPinnedIdentity = value; }, configurable: true },
  "kexVerify": { get() { return kexVerify; }, set(value) { kexVerify = value; }, configurable: true },
  "deriveHybridKeys": { get() { return deriveHybridKeys; }, set(value) { deriveHybridKeys = value; }, configurable: true },
  "kexConfirmTag": { get() { return kexConfirmTag; }, set(value) { kexConfirmTag = value; }, configurable: true },
  "kexConfirmTagValid": { get() { return kexConfirmTagValid; }, set(value) { kexConfirmTagValid = value; }, configurable: true },
  "kexSettling": { get() { return kexSettling; }, set(value) { kexSettling = value; }, configurable: true },
  "pinKexHybrid": { get() { return pinKexHybrid; }, set(value) { pinKexHybrid = value; }, configurable: true },
  "kexHybridPinned": { get() { return kexHybridPinned; }, set(value) { kexHybridPinned = value; }, configurable: true },
  "prekeySignBytes": { get() { return prekeySignBytes; }, set(value) { prekeySignBytes = value; }, configurable: true },
  "signPrekey": { get() { return signPrekey; }, set(value) { signPrekey = value; }, configurable: true },
  "prekeyPqSignBytes": { get() { return prekeyPqSignBytes; }, set(value) { prekeyPqSignBytes = value; }, configurable: true },
  "completePrekey": { get() { return completePrekey; }, set(value) { completePrekey = value; }, configurable: true },
  "prekeyPqIsTheirs": { get() { return prekeyPqIsTheirs; }, set(value) { prekeyPqIsTheirs = value; }, configurable: true },
  "deriveHybridWrapKey": { get() { return deriveHybridWrapKey; }, set(value) { deriveHybridWrapKey = value; }, configurable: true },
  "prekeyIsTheirs": { get() { return prekeyIsTheirs; }, set(value) { prekeyIsTheirs = value; }, configurable: true },
  "considerPrekey": { get() { return considerPrekey; }, set(value) { considerPrekey = value; }, configurable: true },
  "prekeyHybridOwed": { get() { return prekeyHybridOwed; }, set(value) { prekeyHybridOwed = value; }, configurable: true },
  "prekeyHybridInHand": { get() { return prekeyHybridInHand; }, set(value) { prekeyHybridInHand = value; }, configurable: true },
  "prekeyHybridMissing": { get() { return prekeyHybridMissing; }, set(value) { prekeyHybridMissing = value; }, configurable: true },
  "loadPrekeys": { get() { return loadPrekeys; }, set(value) { loadPrekeys = value; }, configurable: true },
  "savePrekeys": { get() { return savePrekeys; }, set(value) { savePrekeys = value; }, configurable: true },
  "prunePrekeys": { get() { return prunePrekeys; }, set(value) { prunePrekeys = value; }, configurable: true },
  "ensurePrekey": { get() { return ensurePrekey; }, set(value) { ensurePrekey = value; }, configurable: true },
  "getDeviceId": { get() { return getDeviceId; }, set(value) { getDeviceId = value; }, configurable: true },
  "findPrekey": { get() { return findPrekey; }, set(value) { findPrekey = value; }, configurable: true },
  "chatIdentityInitialization": { get() { return chatIdentityInitialization; }, set(value) { chatIdentityInitialization = value; }, configurable: true },
  "ensureIdentity": { get() { return ensureIdentity; }, set(value) { ensureIdentity = value; }, configurable: true },
  "initializeChatIdentity": { get() { return initializeChatIdentity; }, set(value) { initializeChatIdentity = value; }, configurable: true },
  "identityHasPrivate": { get() { return identityHasPrivate; }, set(value) { identityHasPrivate = value; }, configurable: true },
  "settleIdentityVersion": { get() { return settleIdentityVersion; }, set(value) { settleIdentityVersion = value; }, configurable: true },
  "identityMoveInFlight": { get() { return identityMoveInFlight; }, set(value) { identityMoveInFlight = value; }, configurable: true },
  "identityMayMigrate": { get() { return identityMayMigrate; }, set(value) { identityMayMigrate = value; }, configurable: true },
  "activePeer": { get() { return activePeer; }, set(value) { activePeer = value; }, configurable: true },
  "activeSession": { get() { return activeSession; }, set(value) { activeSession = value; }, configurable: true },
  "isCompactChatLayout": { get() { return isCompactChatLayout; }, set(value) { isCompactChatLayout = value; }, configurable: true },
  "updateChatShellMode": { get() { return updateChatShellMode; }, set(value) { updateChatShellMode = value; }, configurable: true },
  "refreshComposerFocusFlag": { get() { return refreshComposerFocusFlag; }, set(value) { refreshComposerFocusFlag = value; }, configurable: true },
  "conversationHistory": { get() { return conversationHistory; }, set(value) { conversationHistory = value; }, configurable: true },
  "saveSpaces": { get() { return saveSpaces; }, set(value) { saveSpaces = value; }, configurable: true },
  "upsertSharedSpace": { get() { return upsertSharedSpace; }, set(value) { upsertSharedSpace = value; }, configurable: true },
  "buildSignedSpaceSyncPayload": { get() { return buildSignedSpaceSyncPayload; }, set(value) { buildSignedSpaceSyncPayload = value; }, configurable: true },
  "sendSpaceSync": { get() { return sendSpaceSync; }, set(value) { sendSpaceSync = value; }, configurable: true },
  "broadcastSpaceRecord": { get() { return broadcastSpaceRecord; }, set(value) { broadcastSpaceRecord = value; }, configurable: true },
  "CALL_LOG_LIMIT": { get() { return CALL_LOG_LIMIT; }, set() { throw new TypeError('Assignment to constant variable CALL_LOG_LIMIT.'); }, configurable: true },
  "saveCalls": { get() { return saveCalls; }, set(value) { saveCalls = value; }, configurable: true },
});
