/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Identity v4 in the browser (docs/design/1.2-identity-v4.md).
 *
 * An account was one RSA-3072 key that both opened seals and signed. A v4
 * account is two keys that each do one thing:
 *
 *   sk  Ed25519, signs. The fingerprint is
 *       SHA-256( u32 len ‖ "poorija-id/4" ‖ u32 32 ‖ sk ).
 *   ak  X25519, agrees. Signed by sk ("poorija-agree/4" ‖ fp ‖ ak) so nobody
 *       can put their own agreement key beside somebody's signing key.
 *
 * A seal to an account (what RSA-OAEP did) is an ephemeral X25519 exchange
 * with its ak, HKDF-SHA-256 to an AES-256-GCM key, the purpose and the
 * recipient's fingerprint as additional data:
 *
 *     0x04 ‖ ephemeral (32) ‖ iv (12) ‖ ciphertext+tag
 *
 * The byte layouts here are the ones scripts/lib/identity-v4.js checks on the
 * relay; tests/unit/identity.test.mjs runs both against each other.
 *
 * Pure: every function takes `subtle` (WebCrypto) so it runs in the page and
 * in Node alike. No state, no storage.
 */

export const ID_LABEL = 'poorija-id/4';
export const AGREE_LABEL = 'poorija-agree/4';
export const CONT_LABEL = 'poorija-cont/4';
export const SEAL_LABEL = 'poorija-seal-v4';
export const SEAL_VERSION = 0x04;
export const LEGACY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();

export function field(value) {
  const bytes = value instanceof Uint8Array ? value : encoder.encode(String(value ?? ''));
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, false);
  out.set(bytes, 4);
  return out;
}
export function framed(parts) {
  const fields = parts.map(field);
  const out = new Uint8Array(fields.reduce((n, f) => n + f.length, 0));
  let offset = 0;
  for (const f of fields) { out.set(f, offset); offset += f.length; }
  return out;
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}
const hex = (buffer) => Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');

export function toBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary);
}
export function fromBase64(text) {
  const binary = atob(String(text || ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/* 32 raw bytes in base64 is a v4 key; anything else is an RSA SPKI. The
   relay draws the same line (identity-v4.js keyKind). */
export function keyKind(publicKeyData) {
  if (!publicKeyData) return '';
  try { return fromBase64(publicKeyData).length === 32 ? 'v4' : 'rsa'; } catch (_error) { return 'rsa'; }
}

export async function fingerprintV4(subtle, signingKeyBase64) {
  return hex(await subtle.digest('SHA-256', framed([ID_LABEL, fromBase64(signingKeyBase64)])));
}

/* Does WebCrypto here have both curves? A device without them stays on its
   RSA identity (it does not migrate), which is always safe. */
export async function supported(subtle) {
  try {
    const sign = await subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    await subtle.sign('Ed25519', sign.privateKey, new Uint8Array(1));
    const a = await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
    const b = await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
    await subtle.deriveBits({ name: 'X25519', public: b.publicKey }, a.privateKey, 256);
    return true;
  } catch (_error) {
    return false;
  }
}

/* A new v4 identity: both pairs, the fingerprint and the agreement key's
   signature. The private halves are PKCS#8 in base64, for the vault. */
export async function generate(subtle) {
  const sign = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const agree = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const sk = toBase64(await subtle.exportKey('raw', sign.publicKey));
  const ak = toBase64(await subtle.exportKey('raw', agree.publicKey));
  const fp = await fingerprintV4(subtle, sk);
  const akSig = toBase64(await subtle.sign('Ed25519', sign.privateKey, agreeKeyText(fp, ak)));
  return {
    v: 4,
    fp,
    sk,
    ak,
    akSig,
    signPrivate: toBase64(await subtle.exportKey('pkcs8', sign.privateKey)),
    agreePrivate: toBase64(await subtle.exportKey('pkcs8', agree.privateKey)),
  };
}

export function agreeKeyText(fp, ak) {
  return framed([AGREE_LABEL, fp, ak]);
}

async function signingKey(subtle, signPrivateBase64) {
  return subtle.importKey('pkcs8', fromBase64(signPrivateBase64), { name: 'Ed25519' }, false, ['sign']);
}
async function verifyingKey(subtle, skBase64) {
  return subtle.importKey('raw', fromBase64(skBase64), { name: 'Ed25519' }, false, ['verify']);
}

export async function sign(subtle, signPrivateBase64, bytes) {
  return new Uint8Array(await subtle.sign('Ed25519', await signingKey(subtle, signPrivateBase64), bytes));
}
export async function verify(subtle, skBase64, signature, bytes) {
  try {
    const sig = signature instanceof Uint8Array ? signature : new Uint8Array(signature);
    if (sig.length !== 64) return false;
    return await subtle.verify('Ed25519', await verifyingKey(subtle, skBase64), sig, bytes);
  } catch (_error) {
    return false;
  }
}

/* The agreement key belongs to the signing key, and both to the fingerprint. */
export async function verifyAgreeKey(subtle, { fp, sk, ak, akSig }) {
  if (keyKind(sk) !== 'v4' || keyKind(ak) !== 'v4') return false;
  if (await fingerprintV4(subtle, sk) !== fp) return false;
  try { return await verify(subtle, sk, fromBase64(akSig), agreeKeyText(fp, ak)); } catch (_error) { return false; }
}

async function sealKey(subtle, shared, ephemeral, recipientAk, purpose) {
  const material = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: concat(ephemeral, fromBase64(recipientAk)), info: framed([SEAL_LABEL, purpose]) },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

/* Seals `plain` to the account (fp, ak) for `purpose`. Only the holder of
   ak's private half opens it, and only for that purpose. */
export async function seal(subtle, { fp, ak }, purpose, plain, random) {
  if (!purpose) throw new TypeError('seal: purpose is required');
  const eph = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const ephRaw = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
  const theirs = await subtle.importKey('raw', fromBase64(ak), { name: 'X25519' }, false, []);
  const shared = await subtle.deriveBits({ name: 'X25519', public: theirs }, eph.privateKey, 256);
  const key = await sealKey(subtle, shared, ephRaw, ak, purpose);
  const iv = random(12);
  const cipher = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: framed([SEAL_LABEL, purpose, fp]) }, key, plain));
  return concat(new Uint8Array([SEAL_VERSION]), ephRaw, iv, cipher);
}
export function isSeal(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return view.length >= 1 + 32 + 12 + 16 && view[0] === SEAL_VERSION;
}
export async function open(subtle, { fp, ak, agreePrivate }, purpose, sealed) {
  const view = sealed instanceof Uint8Array ? sealed : new Uint8Array(sealed);
  if (!isSeal(view)) throw Object.assign(new Error('not a v4 seal'), { name: 'OperationError' });
  const ephRaw = view.subarray(1, 33);
  const iv = view.subarray(33, 45);
  const cipher = view.subarray(45);
  const mine = await subtle.importKey('pkcs8', fromBase64(agreePrivate), { name: 'X25519' }, false, ['deriveBits']);
  const theirs = await subtle.importKey('raw', ephRaw, { name: 'X25519' }, false, []);
  const shared = await subtle.deriveBits({ name: 'X25519', public: theirs }, mine, 256);
  const key = await sealKey(subtle, shared, ephRaw, ak, purpose);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: framed([SEAL_LABEL, purpose, fp]) }, key, cipher));
}

/* The continuation: the old RSA account is from `at` the v4 account. */
export function continuationText({ oldFp, newFp, sk, ak, at }) {
  return framed([CONT_LABEL, oldFp, newFp, sk, ak, String(at)]);
}
export function legacyUntil(at) {
  return Number(at || 0) + LEGACY_WINDOW_MS;
}
