/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* The door between js/crypto/identity.js and the chat's classic scripts
 * (roadmap 1.2, release 2.7b). Loaded as a module before them, like
 * aad-bridge.js, so window.PoorijaIdentity exists when they run.
 *
 * The chat keeps one identity record, chatState.identity:
 *
 *   v3 (never moved):  { publicKeyData: RSA SPKI, privateKeyData: RSA PKCS#8, fingerprint }
 *   v4 (moved):        { v: 4, publicKeyData: sk, fingerprint: fp, sk, ak, akSig,
 *                        signPrivate, agreePrivate,
 *                        legacy: { publicKeyData, privateKeyData, fingerprint, until },
 *                        continuation: { statement, akSig, oldSig, newSig } }
 *
 * so everything that names the account (publicKeyData, fingerprint) follows
 * the active key, and the old RSA key is kept for the ninety days in which
 * mail written to it may still arrive. This module signs, verifies, seals and
 * opens for either kind, by looking at the key. */

import * as id from './identity.js';

const subtle = () => globalThis.crypto.subtle;
const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const toBytes = (value) => (value instanceof Uint8Array ? value : new Uint8Array(value));
let supportedAnswer = null;

async function supported() {
  if (supportedAnswer === null) supportedAnswer = await id.supported(subtle());
  return supportedAnswer;
}

/* ---- signing ------------------------------------------------------------- */

async function rsaSign(privateKeyData, bytes) {
  const key = await subtle().importKey('pkcs8', id.fromBase64(privateKeyData), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('RSASSA-PKCS1-v1_5', key, bytes));
}
async function rsaVerify(publicKeyData, signature, bytes) {
  try {
    const key = await subtle().importKey('spki', id.fromBase64(publicKeyData), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return await subtle().verify('RSASSA-PKCS1-v1_5', key, toBytes(signature), bytes);
  } catch (_error) {
    return false;
  }
}

/* Signs with this account's active key. */
async function sign(identity, bytes) {
  if (identity?.v === 4) return id.sign(subtle(), identity.signPrivate, toBytes(bytes));
  return rsaSign(identity.privateKeyData, toBytes(bytes));
}
/* Verifies against `publicKeyData`, whichever kind it is. */
async function verify(publicKeyData, signature, bytes) {
  if (id.keyKind(publicKeyData) === 'v4') return id.verify(subtle(), publicKeyData, toBytes(signature), toBytes(bytes));
  return rsaVerify(publicKeyData, signature, toBytes(bytes));
}

/* ---- sealing ------------------------------------------------------------- */

/* Seals to a contact: to their v4 agreement key when they have moved and it
   checks, RSA-OAEP to their SPKI otherwise. `purpose` binds a v4 seal to
   what it is for; RSA seals ignore it (they never had one). */
async function sealTo(contact, purpose, plain) {
  const key = contact?.publicKeyData || '';
  if (id.keyKind(key) === 'v4') {
    if (!contact.agreeKey || !(await id.verifyAgreeKey(subtle(), { fp: contact.fingerprint, sk: key, ak: contact.agreeKey, akSig: contact.agreeKeySig }))) {
      throw new Error('identity: the contact\'s agreement key does not check');
    }
    return id.seal(subtle(), { fp: contact.fingerprint, ak: contact.agreeKey }, purpose, toBytes(plain), random);
  }
  const pub = await subtle().importKey('spki', id.fromBase64(key), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  return new Uint8Array(await subtle().encrypt({ name: 'RSA-OAEP' }, pub, toBytes(plain)));
}
/* Opens what was sealed to this account: a v4 seal with the agreement key, an
   RSA seal with the RSA key — the active one for an account that never moved,
   the legacy one (inside its ninety days) for one that did. An RSA-OAEP-3072
   seal is exactly 384 bytes; a v4 seal is 61 plus the plaintext, and is told
   apart by its version byte and its length. */
async function openSealed(identity, purpose, sealed) {
  const bytes = toBytes(sealed);
  if (identity?.v === 4 && id.isSeal(bytes) && bytes.length !== 384) {
    return id.open(subtle(), { fp: identity.fp, ak: identity.ak, agreePrivate: identity.agreePrivate }, purpose, bytes);
  }
  const rsa = identity?.v === 4 ? legacyKeyIfOpen(identity) : identity;
  if (!rsa?.privateKeyData) throw Object.assign(new Error('identity: no key to open an RSA seal with'), { name: 'OperationError' });
  const key = await subtle().importKey('pkcs8', id.fromBase64(rsa.privateKeyData), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
  return new Uint8Array(await subtle().decrypt({ name: 'RSA-OAEP' }, key, bytes));
}
function legacyKeyIfOpen(identity) {
  const legacy = identity?.legacy;
  if (!legacy?.privateKeyData) return null;
  return Number(legacy.until || 0) > Date.now() ? legacy : null;
}

/* ---- moving an account --------------------------------------------------- */

/* A v3 identity, moved: new keys, the continuation both sign, the RSA key
   kept as `legacy` until the window closes. Returns the new record; the
   caller stores it. Refuses when the browser lacks either curve. */
async function migrate(identity, { now = Date.now() } = {}) {
  if (!identity?.privateKeyData || identity.v === 4) return null;
  if (!(await supported())) return null;
  const fresh = await id.generate(subtle());
  const statement = { oldFp: identity.fingerprint, newFp: fresh.fp, oldKey: identity.publicKeyData, sk: fresh.sk, ak: fresh.ak, at: now };
  const text = id.continuationText(statement);
  const oldSig = id.toBase64(await rsaSign(identity.privateKeyData, text));
  const newSig = id.toBase64(await id.sign(subtle(), fresh.signPrivate, text));
  return {
    ...identity,
    v: 4,
    fp: fresh.fp,
    sk: fresh.sk,
    ak: fresh.ak,
    akSig: fresh.akSig,
    signPrivate: fresh.signPrivate,
    agreePrivate: fresh.agreePrivate,
    publicKeyData: fresh.sk,
    privateKeyData: '',
    fingerprint: fresh.fp,
    legacy: {
      publicKeyData: identity.publicKeyData,
      privateKeyData: identity.privateKeyData,
      fingerprint: identity.fingerprint,
      until: id.legacyUntil(now),
    },
    continuation: { statement, akSig: fresh.akSig, oldSig, newSig },
    migratedAt: new Date(now).toISOString(),
  };
}

/* A contact's continuation, checked against the RSA key this device pinned
   for them — never only against the one the statement carries. */
async function checkContinuation(signed, pinnedOldKey) {
  const statement = signed?.statement;
  if (!statement || typeof statement !== 'object') return { ok: false, reason: 'malformed' };
  const { oldFp, newFp, oldKey, sk, ak, at } = statement;
  if (!/^[a-f0-9]{64}$/.test(String(oldFp)) || !/^[a-f0-9]{64}$/.test(String(newFp)) || oldFp === newFp) return { ok: false, reason: 'malformed' };
  if (!Number.isSafeInteger(at) || at - Date.now() > 10 * 60 * 1000) return { ok: false, reason: 'malformed' };
  if (!pinnedOldKey || oldKey !== pinnedOldKey) return { ok: false, reason: 'old-key-not-pinned' };
  const oldDigest = Array.from(new Uint8Array(await subtle().digest('SHA-256', id.fromBase64(oldKey)))).map((b) => b.toString(16).padStart(2, '0')).join('');
  if (oldDigest !== oldFp) return { ok: false, reason: 'old-key-not-fp' };
  if (!(await id.verifyAgreeKey(subtle(), { fp: newFp, sk, ak, akSig: signed.akSig }))) return { ok: false, reason: 'bad-agree-key' };
  const text = id.continuationText(statement);
  if (!(await rsaVerify(oldKey, id.fromBase64(signed.oldSig || ''), text))) return { ok: false, reason: 'bad-old-signature' };
  if (!(await id.verify(subtle(), sk, id.fromBase64(signed.newSig || ''), text))) return { ok: false, reason: 'bad-new-signature' };
  if (id.legacyUntil(at) <= Date.now()) return { ok: false, reason: 'expired' };
  return { ok: true };
}

/* The legacy key goes once its window closes. Returns the record as it
   should now be stored (the same object when nothing changed). */
function retireLegacy(identity, now = Date.now()) {
  if (identity?.v !== 4 || !identity.legacy) return identity;
  if (Number(identity.legacy.until || 0) > now) return identity;
  const { legacy, ...rest } = identity;
  void legacy;
  return { ...rest, legacyRetiredAt: new Date(now).toISOString() };
}

/* The fingerprint a key names, under its own kind's rule: SHA-256 of an RSA
   SPKI, or of 'poorija-id/4' and an Ed25519 key. */
async function fingerprintOfKey(publicKeyData) {
  if (id.keyKind(publicKeyData) === 'v4') return id.fingerprintV4(subtle(), publicKeyData);
  const digest = await subtle().digest('SHA-256', id.fromBase64(publicKeyData));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

globalThis.PoorijaIdentity = Object.freeze({
  supported,
  sign,
  verify,
  sealTo,
  openSealed,
  migrate,
  checkContinuation,
  retireLegacy,
  keyKind: id.keyKind,
  fingerprintOfKey,
  verifyAgreeKey: (fields) => id.verifyAgreeKey(subtle(), fields),
  LEGACY_WINDOW_MS: id.LEGACY_WINDOW_MS,
});
