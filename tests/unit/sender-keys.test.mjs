/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text.
 */

/* js/crypto/sender-keys.js on its own.   node --test tests/unit/ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import * as sk from '../../js/crypto/sender-keys.js';

const subtle = webcrypto.subtle;
const random = (n) => webcrypto.getRandomValues(new Uint8Array(n));
const bytes = (t) => new TextEncoder().encode(t);
const text = (b) => new TextDecoder().decode(b);
const G = 'group-1';

async function member(fp) {
  const chain = await sk.createSendingChain(subtle, random, { groupId: G, senderFp: fp });
  return { fp, chain };
}
async function receiver(sender) {
  return sk.acceptDistribution(subtle, sk.distribution(sender.chain), { groupId: G, senderFp: sender.fp });
}

test('one message, sealed once, opens for every member who holds the sender key', async () => {
  const ali = await member('ali');
  const atBita = await receiver(ali);
  const atCyrus = await receiver(ali);
  const wire = await sk.seal(subtle, random, ali.chain, bytes('hello group'));
  assert.equal(text((await sk.open(subtle, atBita, wire)).plain), 'hello group');
  assert.equal(text((await sk.open(subtle, atCyrus, wire)).plain), 'hello group');
});

test('every message has its own key, and a copy of one is refused', async () => {
  const ali = await member('ali');
  let at = await receiver(ali);
  const one = await sk.seal(subtle, random, ali.chain, bytes('one'));
  const two = await sk.seal(subtle, random, ali.chain, bytes('two'));
  assert.notEqual(one.c, two.c);
  ({ chain: at } = await sk.open(subtle, at, one));
  ({ chain: at } = await sk.open(subtle, at, two));
  await assert.rejects(sk.open(subtle, at, one), { reason: 'replay' });
});

test('out of order: an early message still opens, once', async () => {
  const ali = await member('ali');
  let at = await receiver(ali);
  const m = [];
  for (let i = 0; i < 4; i += 1) m.push(await sk.seal(subtle, random, ali.chain, bytes(`m${i}`)));
  ({ chain: at } = await sk.open(subtle, at, m[3]));
  assert.equal(Object.keys(at.skipped).length, 3);
  const r1 = await sk.open(subtle, at, m[1]); at = r1.chain;
  assert.equal(text(r1.plain), 'm1');
  await assert.rejects(sk.open(subtle, at, m[1]), { reason: 'replay' });
});

test('a member holding the chain key still cannot write as the sender', async () => {
  const ali = await member('ali');
  const atBita = await receiver(ali);
  /* Bita has Ali's chain key: she can make a message key, but not Ali's signature. */
  const forger = { ...JSON.parse(JSON.stringify(atBita)), signPrivate: (await member('x')).chain.signPrivate };
  const forged = await sk.seal(subtle, random, forger, bytes('I am Ali'));
  await assert.rejects(sk.open(subtle, atBita, forged), { reason: 'bad-signature' });
});

test('a tampered message moves nothing', async () => {
  const ali = await member('ali');
  const at = await receiver(ali);
  const wire = await sk.seal(subtle, random, ali.chain, bytes('real'));
  const before = JSON.stringify(at);
  await assert.rejects(sk.open(subtle, at, { ...wire, n: wire.n + 5 }));
  await assert.rejects(sk.open(subtle, at, wire, { kind: 'reaction' }));
  assert.equal(JSON.stringify(at), before);
  assert.equal(text((await sk.open(subtle, at, wire)).plain), 'real');
});

test('a member who joins later cannot read what came before', async () => {
  const ali = await member('ali');
  const early = await sk.seal(subtle, random, ali.chain, bytes('before you came'));
  /* Dara joins: she is handed Ali's chain as it is now. */
  const atDara = await sk.acceptDistribution(subtle, sk.distribution(ali.chain), { groupId: G, senderFp: 'ali' });
  await assert.rejects(sk.open(subtle, atDara, early), { reason: 'replay' });
  const late = await sk.seal(subtle, random, ali.chain, bytes('welcome'));
  assert.equal(text((await sk.open(subtle, atDara, late)).plain), 'welcome');
});

test('a member who is removed cannot read what comes after the new chain', async () => {
  const ali = await member('ali');
  const atEve = await receiver(ali);
  /* Eve is removed: Ali starts a new chain and hands it only to those still in. */
  const fresh = await sk.createSendingChain(subtle, random, { groupId: G, senderFp: 'ali' });
  const atBita = await sk.acceptDistribution(subtle, sk.distribution(fresh), { groupId: G, senderFp: 'ali' });
  const after = await sk.seal(subtle, random, fresh, bytes('after Eve left'));
  await assert.rejects(sk.open(subtle, atEve, after), { reason: 'unknown-chain' });
  assert.equal(text((await sk.open(subtle, atBita, after)).plain), 'after Eve left');
});

test('a distribution for another group, another sender, or with a wrong id is refused', async () => {
  const ali = await member('ali');
  const dist = sk.distribution(ali.chain);
  await assert.rejects(sk.acceptDistribution(subtle, dist, { groupId: 'other', senderFp: 'ali' }), { reason: 'bad-distribution' });
  await assert.rejects(sk.acceptDistribution(subtle, dist, { groupId: G, senderFp: 'bob' }), { reason: 'bad-distribution' });
  await assert.rejects(sk.acceptDistribution(subtle, { ...dist, keyId: '0'.repeat(32) }, { groupId: G, senderFp: 'ali' }), { reason: 'bad-distribution' });
});

test('state survives JSON (what is stored)', async () => {
  const ali = await member('ali');
  const at = JSON.parse(JSON.stringify(await receiver(ali)));
  const sender = JSON.parse(JSON.stringify(ali.chain));
  const wire = await sk.seal(subtle, random, sender, bytes('stored'));
  assert.equal(text((await sk.open(subtle, at, wire)).plain), 'stored');
});
