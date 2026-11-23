/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Identity v4, as the relay sees it (docs/design/1.2-identity-v4.md).
 *
 * An account used to be one RSA-3072 key, its fingerprint SHA-256 of that
 * key's SPKI. A v4 account is an Ed25519 signing key and an X25519 agreement
 * key signed by it; its fingerprint is
 *
 *     SHA-256( u32(len) "poorija-id/4" ‖ u32(32) ed25519_public )
 *
 * so a v4 fingerprint can never equal a v3 one. The relay needs three things:
 *
 *   - to tell which kind of key a hello or a push subscription carries, and
 *     that it is the key the fingerprint names (keyMatchesFingerprint);
 *   - to check a proof made with it (verifyProof), over exactly the bytes a
 *     v3 client signs with RSA (`relay-proof/1`);
 *   - to check a continuation statement (verifyContinuation): the old RSA key
 *     and the new Ed25519 key both signing "this account is now that one",
 *     which is what lets the relay alias the old mailbox to the new for the
 *     90 days the old key keeps verifying.
 *
 * A v4 key is carried as the 32 raw bytes in base64 (not an SPKI), which is
 * how it is told apart from an RSA SPKI before anything is parsed.
 */
'use strict';

const crypto = require('crypto');

const ID_LABEL = 'poorija-id/4';
const CONT_LABEL = 'poorija-cont/4';
const AGREE_LABEL = 'poorija-agree/4';
/* How long the old key keeps verifying after a move (owner's decision). */
const LEGACY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
/* A continuation dated this far in the future is not taken. */
const CLOCK_SKEW_MS = 10 * 60 * 1000;
/* Ed25519 public keys as SPKI are this fixed prefix plus the 32 bytes. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function field(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ''), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}
function framed(parts) {
  return Buffer.concat(parts.map(field));
}

function rawKey(base64) {
  if (typeof base64 !== 'string' || base64.length > 64) return null;
  let bytes;
  try { bytes = Buffer.from(base64, 'base64'); } catch (_error) { return null; }
  return bytes.length === 32 && bytes.toString('base64') === base64.replace(/\s+/g, '') ? bytes : null;
}

/* 'v4' for 32 raw bytes, 'rsa' for anything else (an SPKI the v3 rules
   judge), '' for nothing. Judged by shape only. */
function keyKind(publicKeyData) {
  if (!publicKeyData) return '';
  return rawKey(String(publicKeyData)) ? 'v4' : 'rsa';
}

function fingerprintV4(signingKeyBase64) {
  const key = rawKey(signingKeyBase64);
  if (!key) return '';
  return crypto.createHash('sha256').update(framed([ID_LABEL, key])).digest('hex');
}
function fingerprintV3(spkiBase64) {
  try { return crypto.createHash('sha256').update(Buffer.from(String(spkiBase64 || ''), 'base64')).digest('hex'); } catch (_error) { return ''; }
}

/* Does this key name this fingerprint, under the rules of its own kind? */
function keyMatchesFingerprint(publicKeyData, fingerprint) {
  const kind = keyKind(publicKeyData);
  if (!kind || !fingerprint) return false;
  return (kind === 'v4' ? fingerprintV4(publicKeyData) : fingerprintV3(publicKeyData)) === fingerprint;
}

function ed25519Public(signingKeyBase64) {
  const key = rawKey(signingKeyBase64);
  if (!key) return null;
  try { return crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, key]), format: 'der', type: 'spki' }); } catch (_error) { return null; }
}
function verifyEd25519(signingKeyBase64, message, signatureBase64) {
  const key = ed25519Public(signingKeyBase64);
  if (!key) return false;
  let signature;
  try { signature = Buffer.from(String(signatureBase64 || ''), 'base64'); } catch (_error) { return false; }
  if (signature.length !== 64) return false;
  try { return crypto.verify(null, message, key, signature); } catch (_error) { return false; }
}
function verifyRsa(spkiBase64, message, signatureBase64) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(String(spkiBase64 || '').replace(/\s+/g, ''), 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'rsa') return false;
    return crypto.verify('sha256', message, { key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(String(signatureBase64 || ''), 'base64'));
  } catch (_error) {
    return false;
  }
}

/* A proof of holding the account's key, over the text every client signs
   (identityProofText in server.js), with whichever kind of key it has. */
function verifyProof(publicKeyData, message, signatureBase64) {
  const kind = keyKind(publicKeyData);
  if (kind === 'v4') return verifyEd25519(publicKeyData, message, signatureBase64);
  if (kind === 'rsa') return verifyRsa(publicKeyData, message, signatureBase64);
  return false;
}

/* The bytes the agreement key is signed over, so an X25519 key cannot be
   swapped in beside somebody's signing key. */
function agreeKeyText(fingerprint, agreeKeyBase64) {
  return framed([AGREE_LABEL, String(fingerprint || ''), String(agreeKeyBase64 || '')]);
}
function verifyAgreeKey({ fp, sk, ak, akSig }) {
  if (!rawKey(ak) || fingerprintV4(sk) !== fp) return false;
  return verifyEd25519(sk, agreeKeyText(fp, ak), akSig);
}

/* The continuation: "the account whose key was `oldKey` (fingerprint
   oldFp) is from `at` the account `newFp`, keys `sk` and `ak`". */
function continuationText(statement) {
  return framed([CONT_LABEL, statement.oldFp, statement.newFp, statement.sk, statement.ak, String(statement.at)]);
}
/* Checks both signatures and the shape. `pinnedOldKey`, when given, must be
   the old key: a relay or a contact checks against what it already holds,
   never only against the key the statement brought with it. Returns
   { ok: true } or { ok: false, reason }. */
function verifyContinuation(signed, { pinnedOldKey = '', now = Date.now() } = {}) {
  const statement = signed?.statement;
  if (!statement || typeof statement !== 'object' || Array.isArray(statement)) return { ok: false, reason: 'malformed' };
  const { oldFp, newFp, oldKey, sk, ak, at } = statement;
  if (typeof oldFp !== 'string' || !/^[a-f0-9]{64}$/.test(oldFp)) return { ok: false, reason: 'malformed' };
  if (typeof newFp !== 'string' || !/^[a-f0-9]{64}$/.test(newFp) || newFp === oldFp) return { ok: false, reason: 'malformed' };
  if (!Number.isSafeInteger(at) || at < 0) return { ok: false, reason: 'malformed' };
  if (at - now > CLOCK_SKEW_MS) return { ok: false, reason: 'future' };
  if (keyKind(oldKey) !== 'rsa' || fingerprintV3(oldKey) !== oldFp) return { ok: false, reason: 'old-key-not-fp' };
  if (pinnedOldKey && pinnedOldKey !== oldKey) return { ok: false, reason: 'old-key-not-pinned' };
  if (fingerprintV4(sk) !== newFp) return { ok: false, reason: 'new-key-not-fp' };
  if (!verifyAgreeKey({ fp: newFp, sk, ak, akSig: signed.akSig })) return { ok: false, reason: 'bad-agree-key' };
  const text = continuationText(statement);
  if (!verifyRsa(oldKey, text, signed.oldSig)) return { ok: false, reason: 'bad-old-signature' };
  if (!verifyEd25519(sk, text, signed.newSig)) return { ok: false, reason: 'bad-new-signature' };
  return { ok: true };
}

/* Until when the old fingerprint answers for the new one. */
function legacyUntil(statement) {
  return Number(statement?.at || 0) + LEGACY_WINDOW_MS;
}

module.exports = {
  ID_LABEL,
  CONT_LABEL,
  AGREE_LABEL,
  LEGACY_WINDOW_MS,
  keyKind,
  fingerprintV4,
  fingerprintV3,
  keyMatchesFingerprint,
  verifyProof,
  verifyEd25519,
  agreeKeyText,
  verifyAgreeKey,
  continuationText,
  verifyContinuation,
  legacyUntil,
};
