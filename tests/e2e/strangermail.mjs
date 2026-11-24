/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Mail written to a relay for somebody who lives on another one is found its way.
 *
 * Measured between the Finland and an Iran relay, in use: a person on one wrote to a
 * person on the other, the device did not know where they lived, wrote to its own
 * relay, was told "queued", and eighteen messages sat in that mailbox for good —
 * nothing ever carried them to where the recipient was. Three relays here, one
 * resident on each of two; a message written to the wrong one is carried to the right one
 * by the relays themselves, once and not back, and a person nobody hosts is left alone.
 *
 *   node tests/e2e/strangermail.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { relayTestIdentity } from './_relay-identity.mjs';
import { createFleet, waitUntil } from './_relay-fleet.mjs';
import { createChecks } from './_check.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const dirlib = require(path.join(ROOT, 'scripts', 'lib', 'relay-directory.js'));
const { results, check } = createChecks();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const operatorPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const operatorKey = operatorPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const operatorId = dirlib.operatorIdFor(operatorKey);
const names = ['a', 'b', 'c'];
const fleet = await createFleet(names, {
  env: Object.fromEntries(names.map((name) => [name, () => ({
    CHAT_OPERATOR_KEY: operatorKey, CHAT_ALERTS: '0', CHAT_STRANGER_SWEEP_MS: '1000', CHAT_STRANGER_ASK_MS: '1500',
  })])),
});
try {
  const doc = dirlib.signDirectory({
    v: 1, serial: 1, operator: { id: operatorId, key: operatorKey, name: 'Test family' },
    relays: names.map((name) => ({ id: fleet.relays[name].id, name, origins: [fleet.relays[name].origin], region: 'outside-iran', gateway: 0 })),
    revoked: [], signedAt: new Date().toISOString(),
  }, operatorPair.privateKey);
  for (const name of names) fs.writeFileSync(path.join(fleet.relays[name].dir, 'relay-directory.json'), JSON.stringify(doc));
  await fleet.startAll();
  const linked = await waitUntil(async () => {
    for (const name of names) {
      const set = await fleet.linked(name);
      if (names.filter((other) => other !== name).some((other) => !set.has(fleet.relays[other].id.slice(0, 16)))) return false;
    }
    return true;
  }, 30000);
  check('three relays, each linked to the other two', linked === true || Boolean(linked));

  const box = async (name, fp) => ((await fleet.post(name, '/Monitor_Server/identities')).identities || []).find((row) => row.fingerprint === fp.slice(0, 16))?.mailbox || 0;
  const bob = fleet.client('a', 'bob');            // lives on a
  const carol = relayTestIdentity();
  const carolHome = fleet.client('b', 'carol-1', carol);   // lives on b
  await bob.ready; await carolHome.ready;
  await carolHome.waitFor((message) => message.type === 'peers' || message.type === 'roster', 15000).catch(() => null);
  carolHome.close();                                // away: her mail is queued, not delivered
  await sleep(800);

  let n = 0;
  const write = async (fp, wrote = {}) => {
    const tag = `m${n += 1}`;
    /* A plain relay message to the person, through bob's own relay (a): no sealed route, which is what a
       device that does not know where they live does. */
    bob.send({ type: 'relay', toFingerprint: fp, payload: { type: 'offline-chat', notify: false, body: tag, ...wrote }, persist: true, tag });
    return bob.waitFor((message) => message.tag === tag, 10000).catch(() => null);
  };
  const first = await write(carol.fingerprint);
  check('the relay a person did not choose queues it, and says it does not know them', first?.type === 'queued' && first?.known === false, JSON.stringify(first));
  const arrived = await waitUntil(async () => await box('b', carol.fingerprint) >= 1 && await box('a', carol.fingerprint) === 0, 20000);
  check('and carries it to the relay where she lives, taking it off its own', arrived, `a ${await box('a', carol.fingerprint)} b ${await box('b', carol.fingerprint)}`);

  await write(carol.fingerprint); await write(carol.fingerprint);
  const more = await waitUntil(async () => await box('b', carol.fingerprint) === 3 && await box('a', carol.fingerprint) === 0, 20000);
  check('what is written later follows the same way', more, `a ${await box('a', carol.fingerprint)} b ${await box('b', carol.fingerprint)}`);

  const dan = relayTestIdentity();   // nobody hosts him
  await write(dan.fingerprint);
  await sleep(6000);
  check('a person no relay hosts stays where the message was written, and nothing loops', await box('a', dan.fingerprint) === 1 && await box('b', dan.fingerprint) === 0 && await box('c', dan.fingerprint) === 0,
    `a ${await box('a', dan.fingerprint)} b ${await box('b', dan.fingerprint)} c ${await box('c', dan.fingerprint)}`);

  const erin = relayTestIdentity();   // lives on a itself, away
  const erinHome = fleet.client('a', 'erin-1', erin);
  await erinHome.ready;
  await erinHome.waitFor((message) => message.type === 'peers' || message.type === 'roster', 15000).catch(() => null);
  erinHome.close();
  await sleep(600);
  await write(erin.fingerprint);
  await sleep(5000);
  check('mail for somebody who lives here is not sent anywhere', await box('a', erin.fingerprint) === 1 && await box('b', erin.fingerprint) === 0);
  bob.close();
} finally {
  await fleet.stopAll().catch(() => {});
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
