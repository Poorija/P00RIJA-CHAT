/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* A receipt for somebody who is away is kept, for two days and without waking
 * them; a typing indicator is not. Receipts were dropped like typing, so a tick
 * sent while the sender's app was away, or while a link between relays was
 * down, was lost for good: eighteen of fifty-six senders never got "seen" in a
 * run across eight relays. A mailbox keeps no more than 300 of them.
 *
 *   node tests/e2e/_local-stack.mjs receiptkeep
 */
import { relayTestIdentity } from './_relay-identity.mjs';
import { createFleet, sleep, waitUntil } from './_relay-fleet.mjs';
import { createChecks } from './_check.mjs';

const { results, check } = createChecks();
const fleet = await createFleet(['a'], { env: { a: () => ({ CHAT_ALERTS: '0', CHAT_RECEIPT_SWEEP_MS: '500', CHAT_RECEIPT_KEEP_MS: '2500' }) } });
try {
  await fleet.startAll();
  const box = async (fp) => ((await fleet.post('a', '/Monitor_Server/identities')).identities || []).find((row) => row.fingerprint === fp.slice(0, 16))?.mailbox || 0;
  const bob = fleet.client('a', 'bob');
  const carol = relayTestIdentity();
  const carolHome = fleet.client('a', 'carol-1', carol);
  await bob.ready; await carolHome.ready;
  await carolHome.waitFor((m) => m.type === 'peers' || m.type === 'roster', 15000).catch(() => null);
  carolHome.close();
  await sleep(600);
  let n = 0;
  const write = async (payload) => {
    const tag = `m${n += 1}`;
    bob.send({ type: 'relay', toFingerprint: carol.fingerprint, payload: { type: 'offline-chat', ...payload }, persist: true, tag });
    return bob.waitFor((m) => m.tag === tag, 10000).catch(() => null);
  };
  const typing = await write({ eph: 1 });
  check('a typing indicator for somebody away is dropped', typing?.type === 'error' && await box(carol.fingerprint) === 0, JSON.stringify(typing));
  const receipt = await write({ eph: 2, notify: false });
  check('a receipt for somebody away is kept', receipt?.type === 'queued' && await box(carol.fingerprint) === 1, JSON.stringify(receipt));
  const plain = await write({ body: 'hello' });
  check('and mail is kept as it was', plain?.type === 'queued' && await box(carol.fingerprint) === 2);
  const expired = await waitUntil(async () => await box(carol.fingerprint) === 1, 8000);
  check('receipts are not kept for ever, the message is', expired, `${await box(carol.fingerprint)}`);
  /* A person whose socket is open but who reads nothing (a phone in a pocket):
     the receipt takes the live path, and its copy in the box is aged out and
     capped like any other. It was kept for good. */
  const dave = relayTestIdentity();
  const daveHere = fleet.client('a', 'dave-1', dave);
  await daveHere.ready;
  await daveHere.waitFor((m) => m.type === 'peers' || m.type === 'roster', 15000).catch(() => null);
  const live = await (async () => {
    const tag = `m${n += 1}`;
    bob.send({ type: 'relay', toFingerprint: dave.fingerprint, payload: { type: 'offline-chat', eph: 2, notify: false }, persist: true, tag });
    return bob.waitFor((m) => m.tag === tag, 10000).catch(() => null);
  })();
  check('a receipt for a connected socket is kept in the box until it is acknowledged', live?.type === 'queued' && await box(dave.fingerprint) === 1, JSON.stringify(live));
  const liveGone = await waitUntil(async () => await box(dave.fingerprint) === 0, 8000);
  check('and, never acknowledged, it ages out as a receipt does', liveGone, `${await box(dave.fingerprint)}`);
  daveHere.close();
  bob.close();
} finally {
  await fleet.stopAll().catch(() => {});
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
