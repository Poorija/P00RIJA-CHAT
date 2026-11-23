/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text.
 */

/* js/crypto/kt.js on its own.   node --test tests/unit/ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, sign as cryptoSign } from 'node:crypto';
import * as kt from '../../js/crypto/kt.js';

const sha256 = async (bytes) => new Uint8Array(createHash('sha256').update(bytes).digest());
const hex = kt.toHex;

/* The RFC 6962 test vectors (the same tree in RFC 9162): eight leaves, the
   roots of the first n of them. */
const LEAVES = ['', '00', '10', '2021', '3031', '40414243', '5051525354555657', '606162636465666768696a6b6c6d6e6f'].map(kt.fromHex);
const ROOTS = [
  '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
  'fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125',
  'aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77',
  'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7',
  '4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4',
  '76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef',
  'ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c',
  '5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328',
];

async function hashes(n) {
  return Promise.all(LEAVES.slice(0, n).map((leaf) => kt.leafHash(sha256, leaf)));
}

test('the tree hash matches the RFC 6962 vectors', async () => {
  const all = await hashes(8);
  for (let n = 1; n <= 8; n += 1) assert.equal(hex(await kt.rootOf(sha256, all, n)), ROOTS[n - 1], `n=${n}`);
  assert.equal(hex(await kt.rootOf(sha256, [], 0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

async function grown(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(await kt.leafHash(sha256, kt.keyLeaf({ fp: `fp${i}`, sk: `sk${i}`, ak: `ak${i}`, akSig: 's', at: i })));
  return out;
}

test('every leaf of every tree up to 40 proves its inclusion, and nothing else does', async () => {
  const all = await grown(40);
  for (let size = 1; size <= 40; size += 1) {
    const root = await kt.rootOf(sha256, all, size);
    for (let index = 0; index < size; index += 1) {
      const proof = await kt.inclusionProof(sha256, all, index, size);
      assert.ok(await kt.verifyInclusion(sha256, { index, size, leafHash: all[index], proof, root }), `size ${size} index ${index}`);
      if (size > 1) {
        const other = all[(index + 1) % size];
        assert.equal(await kt.verifyInclusion(sha256, { index, size, leafHash: other, proof, root }), false);
      }
    }
  }
});

test('every pair of sizes up to 40 proves one extends the other', async () => {
  const all = await grown(40);
  for (let to = 1; to <= 40; to += 1) {
    const toRoot = await kt.rootOf(sha256, all, to);
    for (let from = 1; from <= to; from += 1) {
      const fromRoot = await kt.rootOf(sha256, all, from);
      const proof = await kt.consistencyProof(sha256, all, from, to);
      assert.ok(await kt.verifyConsistency(sha256, { from, to, fromRoot, toRoot, proof }), `${from} -> ${to}`);
    }
  }
});

test('a log that rewrote history is caught', async () => {
  const honest = await grown(20);
  const rewritten = honest.slice();
  rewritten[3] = await kt.leafHash(sha256, kt.keyLeaf({ fp: 'fp3', sk: 'a key the relay made', at: 3 }));
  const old = { size: 10, root: await kt.rootOf(sha256, honest, 10) };
  const forged = { size: 20, root: await kt.rootOf(sha256, rewritten, 20) };
  const proof = await kt.consistencyProof(sha256, rewritten, 10, 20);
  assert.equal(await kt.compareHeads(sha256, old, forged, proof), 'forked');
  const real = { size: 20, root: await kt.rootOf(sha256, honest, 20) };
  assert.equal(await kt.compareHeads(sha256, old, real, await kt.consistencyProof(sha256, honest, 10, 20)), 'extends');
  assert.equal(await kt.compareHeads(sha256, real, { size: 20, root: forged.root }), 'forked');
  assert.equal(await kt.compareHeads(sha256, real, { size: 20, root: kt.toHex(real.root) }), 'same');
});

test('a record is its own bytes: no two kinds or fields run together', () => {
  const a = kt.keyLeaf({ fp: 'ab', sk: 'c', at: 1 });
  const b = kt.keyLeaf({ fp: 'a', sk: 'bc', at: 1 });
  assert.notEqual(hex(a), hex(b));
  const move = kt.moveLeaf({ oldFp: 'ab', newFp: 'c', statement: '', at: 1 });
  assert.notEqual(hex(a), hex(move));
});

/* ---- the relay's copy (scripts/lib/key-log.js) agrees byte for byte ------- */
import { createRequire } from 'node:module';
const relay = createRequire(import.meta.url)('../../scripts/lib/key-log.js');
import { generateKeyPairSync } from 'node:crypto';

test('the relay builds the same leaves, roots and proofs the app checks', async () => {
  const records = Array.from({ length: 23 }, (_, i) => ({ fp: `f${i}`, sk: `s${i}`, ak: `a${i}`, akSig: `g${i}`, at: 1000 + i }));
  for (const rec of records) assert.equal(hex(kt.keyLeaf(rec)), relay.keyLeaf(rec).toString('hex'));
  assert.equal(hex(kt.moveLeaf({ oldFp: 'o', newFp: 'n', statement: 'st', at: 5 })), relay.moveLeaf({ oldFp: 'o', newFp: 'n', statement: 'st', at: 5 }).toString('hex'));
  const tree = relay.createTree();
  const app = [];
  for (const rec of records) {
    tree.push(relay.leafHash(relay.keyLeaf(rec)));
    app.push(await kt.leafHash(sha256, kt.keyLeaf(rec)));
  }
  for (let size = 1; size <= records.length; size += 1) {
    const root = await kt.rootOf(sha256, app, size);
    assert.equal(tree.root(size).toString('hex'), hex(root));
    for (let i = 0; i < size; i += 1) {
      const proof = tree.inclusion(i, size).map((p) => new Uint8Array(p));
      assert.ok(await kt.verifyInclusion(sha256, { index: i, size, leafHash: app[i], proof, root }));
    }
    for (let from = 1; from <= size; from += 1) {
      const proof = tree.consistency(from, size).map((p) => new Uint8Array(p));
      assert.ok(await kt.verifyConsistency(sha256, { from, to: size, fromRoot: await kt.rootOf(sha256, app, from), toRoot: root, proof }));
    }
  }
});

test('the relay log: a key once, a signed head, a proof, and a fork caught', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  let t = 1_000_000;
  const log = relay.createKeyLog({ relayId: 'a'.repeat(64), privateKey, now: () => t, headEveryMs: 0 });
  assert.equal(log.logKey({ fp: 'x', sk: 'k1', ak: 'a1', akSig: 's1' }), 0);
  assert.equal(log.logKey({ fp: 'x', sk: 'k1', ak: 'a1', akSig: 's1' }), null, 'the same keys are not logged twice');
  t += 1;
  assert.equal(log.logKey({ fp: 'y', sk: 'k2' }), 1);
  const head = log.currentHead();
  assert.equal(head.size, 2);
  assert.ok(relay.headSignatureHolds(head, pub));
  assert.equal(relay.headSignatureHolds({ ...head, size: 3 }, pub), false);
  const { entries } = log.proofFor('y');
  const leafH = await kt.leafHash(sha256, new Uint8Array(Buffer.from(entries[0].leaf, 'base64')));
  assert.ok(await kt.verifyInclusion(sha256, { index: entries[0].index, size: head.size, leafHash: leafH, proof: entries[0].proof.map(kt.fromHex), root: kt.fromHex(head.root) }));

  const peers = relay.createPeerHeads();
  assert.equal(await peers.note(head, pub, async () => []), 'new');
  t += 1;
  log.logKey({ fp: 'z', sk: 'k3' });
  const next = log.currentHead();
  assert.equal(await peers.note(next, pub, async (from, to) => log.consistency(from, to)), 'extends');
  /* The same relay signs a head of a different log of the same size. */
  const lie = { v: 1, relayId: head.relayId, size: next.size, root: 'f'.repeat(64), at: t + 5 };
  lie.sig = relay.signHead(lie, privateKey);
  assert.equal(await peers.note(lie, pub, async () => []), 'forked');
  assert.deepEqual(peers.forked(), [head.relayId]);
});

/* Head v2 (roadmap 5.2, finding F2): signed by the relay's key-log key, which
   the identity key vouches for; the identity key itself signs no head. */
test('head v2: signed by the log key the identity key vouches for, checked the same in the relay and the app', async () => {
  const identity = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const logKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const idPub = identity.publicKey.export({ type: 'spki', format: 'der' });
  const relayId = createHash('sha256').update(idPub).digest('hex');
  const ktPublic = logKey.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const statementSig = cryptoSign('sha256', relay.ktKeyText(relayId, ktPublic), { key: identity.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
  const log = relay.createKeyLog({ relayId, privateKey: identity.privateKey, ktKey: { privateKey: logKey.privateKey, publicKey: ktPublic, statementSig } });
  log.logKey({ fp: 'x', sk: 'k1' });
  const head = log.currentHead();
  const pub = idPub.toString('base64');
  assert.equal(head.v, 2);
  assert.equal(head.ktKey, ktPublic);
  assert.ok(relay.headSignatureHolds(head, pub), 'the relay believes it');
  /* Not by the identity key: the same head signed by it, under v2, fails. */
  const byIdentity = { ...head, sig: relay.signHead(head, identity.privateKey) };
  assert.equal(relay.headSignatureHolds(byIdentity, pub), false);
  /* A log key the identity key did not vouch for. */
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const otherPub = other.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const forged = { ...head, ktKey: otherPub };
  forged.sig = relay.signHead(forged, other.privateKey);
  assert.equal(relay.headSignatureHolds(forged, pub), false, 'another key in ktKey is refused');
  /* The relay's peer-head store: once v2 is seen, a v1 head of the same relay is refused. */
  const peers = relay.createPeerHeads();
  assert.equal(await peers.note(head, pub, async () => []), 'new');
  const v1 = { v: 1, relayId, size: head.size, root: head.root, at: head.at + 1 };
  v1.sig = relay.signHead(v1, identity.privateKey);
  assert.equal(relay.headSignatureHolds(v1, pub), true, 'a v1 head on its own still checks');
  assert.equal(await peers.note(v1, pub, async () => []), 'bad-signature', 'but not after v2');
});
