/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Key transparency (roadmap 1.4, release 2.10): the Merkle log both sides
 * share — the relay builds it and proves things about it, the app checks.
 * docs/design/1.4-key-transparency.md.
 *
 * The tree is RFC 9162's (Certificate Transparency 2.0): a leaf hashes as
 * SHA-256(0x00 ‖ leaf), a node as SHA-256(0x01 ‖ left ‖ right), and a tree
 * of n leaves splits at the largest power of two below n. Inclusion and
 * consistency proofs are that RFC's, verified by its algorithms (§2.1.3.2 and
 * §2.1.4.2), so a proof made here checks anywhere that implements it.
 *
 * Everything takes a `sha256(bytes) -> Promise<Uint8Array>` so the same file
 * runs on WebCrypto in the page and on node:crypto in the relay. */

const enc = new TextEncoder();

export const LEAF_TAG = 'poorija-kt/1';
export const HEAD_TAG = 'poorija-kt-head/1';
export const TYPE_KEY = 1;
export const TYPE_MOVE = 2;

export function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
function u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; }
function u64(n) {
  const b = new Uint8Array(8);
  const v = new DataView(b.buffer);
  v.setUint32(0, Math.floor(n / 2 ** 32));
  v.setUint32(4, n >>> 0);
  return b;
}
const lp = (bytes) => concat(u32(bytes.length), bytes);
export const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function fromHex(h) {
  const s = String(h || '');
  if (!/^([0-9a-f]{2})*$/i.test(s)) throw new TypeError('not hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
const utf8 = (s) => enc.encode(String(s ?? ''));
const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/* The bytes of one record. `body` is the parts given, each length-prefixed. */
/** @param {{ type: number, fp: string, body?: Array<string|Uint8Array>, at: number }} record */
export function leafBytes({ type, fp, body = [], at }) {
  return concat(lp(utf8(LEAF_TAG)), Uint8Array.of(type), lp(utf8(fp)), lp(concat(...body.map((p) => lp(typeof p === 'string' ? utf8(p) : p)))), u64(Number(at) || 0));
}
/* An account's v4 keys: what a relay logs when the account proves them. */
export function keyLeaf({ fp, sk, ak = '', akSig = '', at }) {
  return leafBytes({ type: TYPE_KEY, fp, body: [sk, ak, akSig], at });
}
export function moveLeaf({ oldFp, newFp, statement, at }) {
  return leafBytes({ type: TYPE_MOVE, fp: oldFp, body: [newFp, statement], at });
}
/* What a relay signs about its log. */
export function headBytes({ relayId, size, root, at }) {
  return concat(lp(utf8(HEAD_TAG)), lp(utf8(relayId)), u64(size), typeof root === 'string' ? fromHex(root) : root, u64(at));
}

export async function leafHash(sha256, leaf) { return sha256(concat(Uint8Array.of(0), leaf)); }
async function nodeHash(sha256, left, right) { return sha256(concat(Uint8Array.of(1), left, right)); }

/* Largest power of two strictly below n (n >= 2). */
function split(n) { let k = 1; while (k * 2 < n) k *= 2; return k; }

/* MTH(D[lo:hi]) over leaf hashes. */
async function subtree(sha256, hashes, lo, hi) {
  const n = hi - lo;
  if (n === 0) return sha256(new Uint8Array(0));
  if (n === 1) return hashes[lo];
  const k = split(n);
  return nodeHash(sha256, await subtree(sha256, hashes, lo, lo + k), await subtree(sha256, hashes, lo + k, hi));
}
export async function rootOf(sha256, hashes, size = hashes.length) { return subtree(sha256, hashes, 0, size); }

/* PATH(m, D[lo:hi]): the audit path for leaf m. */
async function path(sha256, hashes, m, lo, hi) {
  const n = hi - lo;
  if (n <= 1) return [];
  const k = split(n);
  if (m < k) return [...(await path(sha256, hashes, m, lo, lo + k)), await subtree(sha256, hashes, lo + k, hi)];
  return [...(await path(sha256, hashes, m - k, lo + k, hi)), await subtree(sha256, hashes, lo, lo + k)];
}
export async function inclusionProof(sha256, hashes, index, size = hashes.length) {
  if (!(index >= 0 && index < size && size <= hashes.length)) throw new RangeError('index outside the tree');
  return path(sha256, hashes, index, 0, size);
}

/* SUBPROOF(m, D[lo:hi], b). */
async function subproof(sha256, hashes, m, lo, hi, b) {
  const n = hi - lo;
  if (m === n) return b ? [] : [await subtree(sha256, hashes, lo, hi)];
  const k = split(n);
  if (m <= k) return [...(await subproof(sha256, hashes, m, lo, lo + k, b)), await subtree(sha256, hashes, lo + k, hi)];
  return [...(await subproof(sha256, hashes, m - k, lo + k, hi, false)), await subtree(sha256, hashes, lo, lo + k)];
}
export async function consistencyProof(sha256, hashes, from, to = hashes.length) {
  if (!(from >= 0 && from <= to && to <= hashes.length)) throw new RangeError('sizes outside the tree');
  if (from === 0 || from === to) return [];
  return subproof(sha256, hashes, from, 0, to, true);
}

/* RFC 9162 §2.1.3.2. */
export async function verifyInclusion(sha256, { index, size, leafHash: lh, proof, root }) {
  if (!(index >= 0 && index < size)) return false;
  let fn = index;
  let sn = size - 1;
  let r = lh;
  for (const p of proof) {
    if (sn === 0) return false;
    if ((fn & 1) === 1 || fn === sn) {
      r = await nodeHash(sha256, p, r);
      if ((fn & 1) === 0) {
        while ((fn & 1) === 0 && fn !== 0) { fn >>= 1; sn >>= 1; }
      }
    } else {
      r = await nodeHash(sha256, r, p);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && equal(r, root);
}

/* RFC 9162 §2.1.4.2. */
export async function verifyConsistency(sha256, { from, to, fromRoot, toRoot, proof }) {
  if (from > to) return false;
  if (from === to) return proof.length === 0 && equal(fromRoot, toRoot);
  if (from === 0) return proof.length === 0;
  let path = proof.slice();
  if ((from & (from - 1)) === 0) path = [fromRoot, ...path];
  if (!path.length) return false;
  let fn = from - 1;
  let sn = to - 1;
  while ((fn & 1) === 1) { fn >>= 1; sn >>= 1; }
  let fr = path[0];
  let sr = path[0];
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if ((fn & 1) === 1 || fn === sn) {
      fr = await nodeHash(sha256, c, fr);
      sr = await nodeHash(sha256, c, sr);
      if ((fn & 1) === 0) {
        while ((fn & 1) === 0 && fn !== 0) { fn >>= 1; sn >>= 1; }
      }
    } else {
      sr = await nodeHash(sha256, sr, c);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && equal(fr, fromRoot) && equal(sr, toRoot);
}

/* Two signed heads of one relay: do they describe one log? `proof` is the
   consistency proof from the smaller to the larger (unused when the sizes are
   equal). Returns 'same' | 'extends' | 'forked'. */
export async function compareHeads(sha256, a, b, proof = []) {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  const sr = typeof small.root === 'string' ? fromHex(small.root) : small.root;
  const br = typeof big.root === 'string' ? fromHex(big.root) : big.root;
  if (small.size === big.size) return equal(sr, br) ? 'same' : 'forked';
  const ok = await verifyConsistency(sha256, {
    from: small.size, to: big.size, fromRoot: sr, toRoot: br,
    proof: proof.map((p) => (typeof p === 'string' ? fromHex(p) : p)),
  });
  return ok ? 'extends' : 'forked';
}
