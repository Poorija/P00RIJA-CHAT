/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

'use strict';

/* The relay's key-transparency log (roadmap 1.4, release 2.10;
   docs/design/1.4-key-transparency.md).

   An append-only Merkle log (RFC 9162 tree hash) of the v4 keys this relay has
   seen proven, and the identity moves it accepted. The relay signs its tree
   head; relays exchange heads over their transit links; a client checks that a
   contact's key is in the log of the relay that served it and that every head
   it sees of a relay extends the last one.

   The leaf and head bytes, the tree and the proofs are the same as
   js/crypto/kt.js, which the app checks with (tests/unit/kt.test.mjs holds the
   two to each other). This copy is synchronous on node:crypto: it runs inside
   the relay's request handlers, and the relay image carries no js/.

   Storage is the relay's database (scripts/lib/state-db.js), a row per leaf
   in store 'kt-leaf' keyed by its zero-padded index, and the heads of other
   relays in 'kt-peer-head' keyed by relay id. */

const crypto = require('crypto');

const LEAF_TAG = 'poorija-kt/1';
const HEAD_TAG = 'poorija-kt-head/1';
const TYPE_KEY = 1;
const TYPE_MOVE = 2;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeUInt32BE(Math.floor(n / 2 ** 32), 0); b.writeUInt32BE(n >>> 0, 4); return b; };
const lp = (buf) => Buffer.concat([u32(buf.length), buf]);
const text = (s) => Buffer.from(String(s ?? ''), 'utf8');

/** @param {{ type: number, fp: string, body?: Array<string|Buffer>, at: number }} record */
function leafBytes({ type, fp, body = [], at }) {
  return Buffer.concat([lp(text(LEAF_TAG)), Buffer.of(type), lp(text(fp)), lp(Buffer.concat(body.map((p) => lp(Buffer.isBuffer(p) ? p : text(p))))), u64(Number(at) || 0)]);
}
const keyLeaf = ({ fp, sk, ak = '', akSig = '', at }) => leafBytes({ type: TYPE_KEY, fp, body: [sk, ak, akSig], at });
const moveLeaf = ({ oldFp, newFp, statement, at }) => leafBytes({ type: TYPE_MOVE, fp: oldFp, body: [newFp, statement], at });
function headBytes({ relayId, size, root, at }) {
  return Buffer.concat([lp(text(HEAD_TAG)), lp(text(relayId)), u64(size), Buffer.isBuffer(root) ? root : Buffer.from(root, 'hex'), u64(at)]);
}

const leafHash = (leaf) => sha256(Buffer.concat([Buffer.of(0), leaf]));
const nodeHash = (l, r) => sha256(Buffer.concat([Buffer.of(1), l, r]));
function split(n) { let k = 1; while (k * 2 < n) k *= 2; return k; }

/* A tree over leaf hashes with every full subtree's hash remembered, so a root
   or a proof costs log n hashes once the leaves are in. */
function createTree() {
  const hashes = [];
  const memo = new Map();
  function subtree(lo, hi) {
    const n = hi - lo;
    if (n === 0) return sha256(Buffer.alloc(0));
    if (n === 1) return hashes[lo];
    /* A subtree of a power-of-two size never changes once full. */
    const full = (n & (n - 1)) === 0;
    const key = full ? `${lo}:${n}` : '';
    if (full && memo.has(key)) return memo.get(key);
    const k = split(n);
    const out = nodeHash(subtree(lo, lo + k), subtree(lo + k, hi));
    if (full) memo.set(key, out);
    return out;
  }
  function path(m, lo, hi) {
    const n = hi - lo;
    if (n <= 1) return [];
    const k = split(n);
    if (m < k) return [...path(m, lo, lo + k), subtree(lo + k, hi)];
    return [...path(m - k, lo + k, hi), subtree(lo, lo + k)];
  }
  function subproof(m, lo, hi, b) {
    const n = hi - lo;
    if (m === n) return b ? [] : [subtree(lo, hi)];
    const k = split(n);
    if (m <= k) return [...subproof(m, lo, lo + k, b), subtree(lo + k, hi)];
    return [...subproof(m - k, lo + k, hi, false), subtree(lo, lo + k)];
  }
  return {
    get size() { return hashes.length; },
    push(hash) { hashes.push(hash); },
    hashAt: (i) => hashes[i],
    root: (size = hashes.length) => subtree(0, size),
    inclusion(index, size = hashes.length) {
      if (!(index >= 0 && index < size && size <= hashes.length)) throw new RangeError('index outside the tree');
      return path(index, 0, size);
    },
    consistency(from, to = hashes.length) {
      if (!(from >= 0 && from <= to && to <= hashes.length)) throw new RangeError('sizes outside the tree');
      if (from === 0 || from === to) return [];
      return subproof(from, 0, to, true);
    },
  };
}

function verifyConsistency({ from, to, fromRoot, toRoot, proof }) {
  if (from > to) return false;
  if (from === to) return proof.length === 0 && fromRoot.equals(toRoot);
  if (from === 0) return proof.length === 0;
  let list = proof.slice();
  if ((from & (from - 1)) === 0) list = [fromRoot, ...list];
  if (!list.length) return false;
  let fn = from - 1;
  let sn = to - 1;
  while ((fn & 1) === 1) { fn >>= 1; sn >>= 1; }
  let fr = list[0];
  let sr = list[0];
  for (const c of list.slice(1)) {
    if (sn === 0) return false;
    if ((fn & 1) === 1 || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      if ((fn & 1) === 0) while ((fn & 1) === 0 && fn !== 0) { fn >>= 1; sn >>= 1; }
    } else {
      sr = nodeHash(sr, c);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && fr.equals(fromRoot) && sr.equals(toRoot);
}

/* ---- signed heads --------------------------------------------------------- */

function signHead(head, privateKey) {
  return crypto.sign('sha256', headBytes(head), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
}
/* Head v2 (roadmap 5.2, finding F2): signed with the relay's key-log key, not
   its identity key. The head names that key (ktKey) and carries the identity
   key's word for it (ktKeySig, over ktKeyText), so a verifier who has pinned
   the identity key can believe it. The head bytes themselves are as in v1. */
function ktKeyText(relayId, ktKey) {
  return Buffer.from(`poorija-kt-key/1\n${relayId}\n${ktKey}`, 'utf8');
}
function headV2Holds(head, identityKeyBase64) {
  try {
    if (head.v !== 2 || typeof head.ktKey !== 'string' || typeof head.ktKeySig !== 'string') return false;
    const identity = crypto.createPublicKey({ key: Buffer.from(String(identityKeyBase64 || ''), 'base64'), format: 'der', type: 'spki' });
    if (!crypto.verify('sha256', ktKeyText(head.relayId, head.ktKey), { key: identity, dsaEncoding: 'ieee-p1363' }, Buffer.from(head.ktKeySig, 'base64'))) return false;
    const ktKey = crypto.createPublicKey({ key: Buffer.from(head.ktKey, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify('sha256', headBytes(head), { key: ktKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(String(head.sig || ''), 'base64'));
  } catch (_error) {
    return false;
  }
}
function headSignatureHolds(head, publicKeyBase64) {
  if (head?.v === 2) return headV2Holds(head, publicKeyBase64);
  return headSignatureHoldsV1(head, publicKeyBase64);
}
function headSignatureHoldsV1(head, publicKeyBase64) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify('sha256', headBytes(head), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(String(head.sig || ''), 'base64'));
  } catch (_error) {
    return false;
  }
}
const HEX64 = /^[0-9a-f]{64}$/;
function wellFormedHead(head) {
  return Boolean(head) && HEX64.test(String(head.relayId || '')) && Number.isSafeInteger(head.size) && head.size >= 0
    && HEX64.test(String(head.root || '')) && Number.isSafeInteger(head.at) && typeof head.sig === 'string' && head.sig.length < 200;
}

/* Two signed heads of one relay: 'same', 'extends' (with a proof that checks)
   or 'forked'. */
function compareHeads(a, b, proofHex = []) {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size === big.size) return small.root === big.root ? 'same' : 'forked';
  const ok = verifyConsistency({
    from: small.size, to: big.size,
    fromRoot: Buffer.from(small.root, 'hex'), toRoot: Buffer.from(big.root, 'hex'),
    proof: proofHex.map((p) => Buffer.from(String(p), 'hex')),
  });
  return ok ? 'extends' : 'forked';
}

/* ---- the log -------------------------------------------------------------- */

/* `db` is the state database (or null: then the log lives in memory for the
   run, and says so in its head as `ephemeral`). `relayId` and `privateKey`
   sign heads. */
/* A head is signed as soon as the log grew (a key just proven is provable at
   once; a signature is cheap), and at least every headAtLeastMs, so a head
   also says "nothing changed". What is held back to once a minute is the
   gossip of heads to other relays (server.js, announceKeyHead). */
/* An account rotates its agreement key now and then and moves at most once,
   so a handful of leaves each is plenty; a fingerprint past it is someone
   minting keys to grow the log, and its further keys are not logged. */
const MAX_LEAVES_PER_FP = 8;
/**
 * @typedef {{ get(store: string, key?: string): any, has(store: string, key?: string): boolean,
 *   put(store: string, key: string, value: any): void, delete(store: string, key?: string): void,
 *   keys(store: string): string[], entries(store: string): Array<[string, any]> }} StateDb
 */
/** @param {{ db?: StateDb|null, relayId: string, privateKey: any, ktKey?: { privateKey: any, publicKey: string, statementSig: string } | null, now?: () => number, headEveryMs?: number, headAtLeastMs?: number, maxPerFp?: number }} options */
function createKeyLog({ db = null, relayId, privateKey, ktKey = null, now = () => Date.now(), headEveryMs = 0, headAtLeastMs = 60 * 60 * 1000, maxPerFp = MAX_LEAVES_PER_FP }) {
  const tree = createTree();
  const byFp = new Map();
  const seen = new Set();
  const pad = (i) => String(i).padStart(12, '0');
  if (db) {
    for (const [, row] of db.entries('kt-leaf')) {
      if (!row || typeof row.leaf !== 'string') continue;
      const leaf = Buffer.from(row.leaf, 'base64');
      const hash = leafHash(leaf);
      const index = tree.size;
      tree.push(hash);
      seen.add(hash.toString('hex'));
      if (!byFp.has(row.fp)) byFp.set(row.fp, []);
      byFp.get(row.fp).push({ index, type: row.type, leaf: row.leaf, at: row.at });
    }
  }
  let head = null;
  function append({ type, fp, leaf, at }) {
    const hash = leafHash(leaf);
    const hex = hash.toString('hex');
    if (seen.has(hex)) return null;
    if ((byFp.get(fp) || []).length >= maxPerFp) return null;
    const index = tree.size;
    tree.push(hash);
    seen.add(hex);
    const entry = { index, type, leaf: leaf.toString('base64'), at };
    if (!byFp.has(fp)) byFp.set(fp, []);
    byFp.get(fp).push(entry);
    if (db) db.put('kt-leaf', pad(index), { fp, type, leaf: entry.leaf, at });
    return index;
  }
  /* A key is logged once per (fp, keys): the time a relay first saw it is
     part of the leaf, so the same keys proven again are not a new leaf. */
  function logKey({ fp, sk, ak = '', akSig = '' }) {
    const known = (byFp.get(fp) || []).some((entry) => entry.type === TYPE_KEY && entry.keys === `${sk}|${ak}|${akSig}`);
    if (known) return null;
    for (const entry of byFp.get(fp) || []) {
      if (entry.type !== TYPE_KEY || entry.keys) continue;
      entry.keys = keysOfLeaf(entry.leaf);
      if (entry.keys === `${sk}|${ak}|${akSig}`) return null;
    }
    const at = now();
    const index = append({ type: TYPE_KEY, fp, leaf: keyLeaf({ fp, sk, ak, akSig, at }), at });
    const entry = (byFp.get(fp) || []).find((e) => e.index === index);
    if (entry) entry.keys = `${sk}|${ak}|${akSig}`;
    return index;
  }
  function logMove({ oldFp, newFp, statement }) {
    const at = now();
    return append({ type: TYPE_MOVE, fp: oldFp, leaf: moveLeaf({ oldFp, newFp, statement, at }), at });
  }
  /* The newest signed head; a new one when the log grew (at most every
     headEveryMs) or the last is older than headAtLeastMs. */
  function currentHead() {
    const t = now();
    const grew = !head || head.size !== tree.size;
    const stale = !head || t - head.at > headAtLeastMs;
    const tooSoon = head && t - head.at < headEveryMs;
    if ((grew && !tooSoon) || stale || !head) {
      /* With a key-log key, head v2 signed by it; without (a relay given
         none), v1 signed by the identity key, as before. */
      const fresh = ktKey
        ? { v: 2, relayId, size: tree.size, root: tree.root().toString('hex'), at: t, ktKey: ktKey.publicKey, ktKeySig: ktKey.statementSig }
        : { v: 1, relayId, size: tree.size, root: tree.root().toString('hex'), at: t };
      fresh.sig = signHead(fresh, ktKey ? ktKey.privateKey : privateKey);
      head = fresh;
    }
    return head;
  }
  function proofFor(fp) {
    const h = currentHead();
    return {
      head: h,
      entries: (byFp.get(fp) || []).filter((entry) => entry.index < h.size).map((entry) => ({
        index: entry.index, type: entry.type, leaf: entry.leaf, at: entry.at,
        proof: tree.inclusion(entry.index, h.size).map((p) => p.toString('hex')),
      })),
    };
  }
  function consistency(from, to) {
    return tree.consistency(from, to).map((p) => p.toString('hex'));
  }
  return { logKey, logMove, currentHead, proofFor, consistency, get size() { return tree.size; }, rootAt: (n) => tree.root(n).toString('hex') };
}

/* The parts of a key leaf (for comparing a proven key with one logged). */
function keysOfLeaf(base64) {
  try {
    const buf = Buffer.from(base64, 'base64');
    let at = 0;
    const take = () => { const n = buf.readUInt32BE(at); at += 4; const out = buf.subarray(at, at + n); at += n; return out; };
    take(); /* tag */
    at += 1; /* type */
    take(); /* fp */
    const body = take();
    let b = 0;
    const part = () => { const n = body.readUInt32BE(b); b += 4; const out = body.subarray(b, b + n).toString('utf8'); b += n; return out; };
    return `${part()}|${part()}|${part()}`;
  } catch (_error) {
    return '';
  }
}

/* ---- what this relay holds of the others' heads ---------------------------- */

/* A peer's signed head is kept when it checks; if it is not one log with the
   one held, both are kept as evidence and the relay is marked forked. The
   consistency proof is fetched by the caller (`fetchProof(from, to)`). */
/** @param {{ db?: StateDb|null }} [options] */
function createPeerHeads({ db = null } = {}) {
  const held = new Map();
  if (db) for (const [id, value] of db.entries('kt-peer-head')) held.set(id, value);
  const save = (id) => { if (db) db.put('kt-peer-head', id, held.get(id)); };
  async function note(head, publicKeyBase64, fetchProof) {
    if (!wellFormedHead(head) || !headSignatureHolds(head, publicKeyBase64)) return 'bad-signature';
    const entry = held.get(head.relayId);
    /* A relay seen signing with its key-log key is not believed signing
       with its identity key again (the downgrade that would be). */
    if (entry && entry.head?.v === 2 && head.v !== 2) return 'bad-signature';
    if (!entry) { held.set(head.relayId, { head, forked: null, checkedAt: Date.now() }); save(head.relayId); return 'new'; }
    if (entry.forked) return 'forked';
    let old = entry.head;
    if (old.size === head.size && old.root === head.root) return 'same';
    let proof = [];
    if (old.size !== head.size) {
      try { proof = await fetchProof(Math.min(old.size, head.size), Math.max(old.size, head.size)); } catch (_error) { return 'unchecked'; }
      /* Another head of this relay may have been taken while the proof was
         on its way; judged against that one, a proof for another pair of
         sizes says nothing. */
      if (entry.head !== old) {
        old = entry.head;
        if (old.size === head.size && old.root === head.root) return 'same';
        if (entry.forked) return 'forked';
        return 'unchecked';
      }
    }
    const verdict = compareHeads(old, head, proof || []);
    if (verdict === 'forked') {
      entry.forked = { a: old, b: head, at: Date.now() };
      save(head.relayId);
      return 'forked';
    }
    if (head.size >= old.size) entry.head = head;
    entry.checkedAt = Date.now();
    save(head.relayId);
    return verdict;
  }
  return {
    note,
    all: () => [...held.entries()].map(([id, entry]) => ({ relayId: id, head: entry.head, forked: entry.forked || null })),
    forked: () => [...held.values()].filter((entry) => entry.forked).map((entry) => entry.head.relayId),
  };
}

module.exports = {
  LEAF_TAG, HEAD_TAG, TYPE_KEY, TYPE_MOVE,
  keyLeaf, moveLeaf, headBytes, leafHash, createTree, verifyConsistency, compareHeads,
  signHead, headSignatureHolds, headV2Holds, ktKeyText, wellFormedHead, createKeyLog, createPeerHeads, keysOfLeaf,
};
