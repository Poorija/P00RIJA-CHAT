/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* The door between js/crypto/kt.js and the chat's classic scripts (roadmap
 * 1.4, release 2.10). docs/design/1.4-key-transparency.md.
 *
 *   PoorijaKeyLog.check(origin, relayPin, { fp, sk, ak, akSig })
 *     -> { state: 'logged' | 'not-logged' | 'unsupported' | 'mismatch' | 'forked' | 'error', ... }
 *
 * asks the relay at `origin` for the log entries of `fp` with their inclusion
 * proofs against its newest signed head, checks the head's signature with the
 * relay's pinned key, checks it extends the last head this device saw of that
 * relay (a consistency proof), checks each proof, and says whether the keys
 * it was given are the ones logged.
 *
 * The heads seen are kept encrypted with the other stores (per relay id: the
 * newest size and root, and evidence if two did not agree). */

import * as kt from './kt.js';

const STORE_KEY = 'poorija_chat_kt_heads';
const TIMEOUT_MS = 6000;
const subtle = () => globalThis.crypto.subtle;
const sha256 = async (bytes) => new Uint8Array(await subtle().digest('SHA-256', bytes));
const b64 = (text) => Uint8Array.from(atob(String(text || '')), (c) => c.charCodeAt(0));

let store = null;
function all() {
  if (store) return store;
  const loaded = typeof globalThis.loadEncrypted === 'function' ? globalThis.loadEncrypted(STORE_KEY, null) : null;
  const unlocked = typeof globalThis.isUnlocked !== 'function' || globalThis.isUnlocked();
  const value = loaded && typeof loaded === 'object' ? loaded : {};
  if (unlocked) store = value;
  return value;
}
function save() {
  if (typeof globalThis.saveEncrypted === 'function') globalThis.saveEncrypted(STORE_KEY, all());
}
globalThis.addEventListener?.('poorija:lock', () => { store = null; });
globalThis.addEventListener?.('poorija:unlock', () => { store = null; });

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { mode: 'cors', cache: 'no-store', signal: controller.signal });
    if (response.status === 404) return { missing: true };
    if (!response.ok) return null;
    return await response.json();
  } catch (_error) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* A head v1 is signed by the relay's identity key (P-256 ECDSA, P1363), the
   key its id is the SHA-256 of. A head v2 (finding F2) by the relay's
   key-log key, which the head names (ktKey) and the identity key vouches
   for (ktKeySig over "poorija-kt-key/1\n<relayId>\n<ktKey>"). */
async function headSignatureHolds(head, keyBase64) {
  try {
    const raw = b64(keyBase64);
    const id = kt.toHex(await sha256(raw));
    if (id !== head.relayId) return false;
    const identity = await subtle().importKey('spki', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    if (head.v === 2) {
      if (typeof head.ktKey !== 'string' || typeof head.ktKeySig !== 'string') return false;
      const statement = new TextEncoder().encode(`poorija-kt-key/1\n${head.relayId}\n${head.ktKey}`);
      if (!await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, identity, b64(head.ktKeySig), statement)) return false;
      const logKey = await subtle().importKey('spki', b64(head.ktKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      return await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, logKey, b64(head.sig), kt.headBytes(head));
    }
    return await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, identity, b64(head.sig), kt.headBytes(head));
  } catch (_error) {
    return false;
  }
}

const wellFormed = (head) => head && /^[0-9a-f]{64}$/.test(head.relayId || '') && Number.isSafeInteger(head.size) && /^[0-9a-f]{64}$/.test(head.root || '') && Number.isSafeInteger(head.at) && typeof head.sig === 'string';

/* A new head of a relay against the last one this device kept. */
async function noteHead(origin, head) {
  const kept = all()[head.relayId];
  if (kept?.forked) return 'forked';
  /* A relay seen signing with its key-log key is not believed signing with
     its identity key again. */
  if (kept?.v === 2 && head.v !== 2) return 'unchecked';
  if (kept && !(kept.size === head.size && kept.root === head.root)) {
    let proof = [];
    if (kept.size !== head.size) {
      const [from, to] = kept.size < head.size ? [kept.size, head.size] : [head.size, kept.size];
      const answer = await getJson(new URL(`/kt/consistency?from=${from}&to=${to}`, origin));
      if (!answer?.ok || !Array.isArray(answer.proof)) return 'unchecked';
      proof = answer.proof;
    }
    const verdict = await kt.compareHeads(sha256, kept, head, proof);
    if (verdict === 'forked') {
      all()[head.relayId] = { ...kept, forked: { a: { size: kept.size, root: kept.root, at: kept.at, sig: kept.sig }, b: head, at: Date.now() } };
      save();
      return 'forked';
    }
    if (head.size < kept.size) return verdict;
  }
  all()[head.relayId] = { size: head.size, root: head.root, at: head.at, sig: head.sig, seenAt: Date.now(), ...(head.v === 2 ? { v: 2 } : {}) };
  save();
  return kept ? 'extends' : 'new';
}

async function check(origin, relayPin, { fp, sk, ak = '', akSig = '' }) {
  if (!origin || !relayPin?.key || !fp || !sk) return { state: 'error', reason: 'missing' };
  const answer = await getJson(new URL(`/kt/proof?fp=${encodeURIComponent(fp)}`, origin));
  if (answer?.missing) return { state: 'unsupported' };
  if (!answer?.ok || !wellFormed(answer.head)) return { state: 'error', reason: 'no-answer' };
  const head = answer.head;
  if (head.relayId !== relayPin.id || !(await headSignatureHolds(head, relayPin.key))) return { state: 'error', reason: 'bad-head' };
  const headVerdict = await noteHead(origin, head);
  if (headVerdict === 'forked') return { state: 'forked', relayId: head.relayId };
  /* A head that could not be shown to extend the one held is not believed:
     a relay that rewrote its log and will not prove otherwise would pass as
     "logged". Nothing is kept from it; the next check asks again. */
  if (headVerdict === 'unchecked') return { state: 'error', reason: 'unchecked' };
  const root = kt.fromHex(head.root);
  let logged = false;
  let other = false;
  for (const entry of Array.isArray(answer.entries) ? answer.entries : []) {
    if (!Number.isSafeInteger(entry?.index) || typeof entry.leaf !== 'string' || !Array.isArray(entry.proof)) continue;
    const leaf = b64(entry.leaf);
    const ok = await kt.verifyInclusion(sha256, { index: entry.index, size: head.size, leafHash: await kt.leafHash(sha256, leaf), proof: entry.proof.map(kt.fromHex), root });
    if (!ok) return { state: 'error', reason: 'bad-proof' };
    if (entry.type !== kt.TYPE_KEY) continue;
    const expected = kt.keyLeaf({ fp, sk, ak, akSig, at: Number(entry.at) || 0 });
    if (kt.toHex(expected) === kt.toHex(leaf)) logged = true;
    else other = true;
  }
  if (logged) return { state: 'logged', head: { size: head.size, at: head.at }, otherKeys: other };
  return { state: other ? 'mismatch' : 'not-logged', head: { size: head.size, at: head.at } };
}

/* What this device holds of every relay's log, for the diagnostics report. */
function heads() {
  return Object.entries(all()).map(([relayId, value]) => ({ relayId, size: value.size, at: value.at, forked: Boolean(value.forked) }));
}

globalThis.PoorijaKeyLog = Object.freeze({ check, heads, noteHead });
