/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Key transparency (roadmap 1.4, release 2.10).
 *
 * Each relay keeps an append-only log of the v4 keys it has seen proven and
 * signs its head; linked relays hand each other their heads; the app checks a
 * contact's key against the log and every head against the last. What has to
 * hold, on two real stacks linked to each other:
 *
 *   - a key is logged when its holder proves it, once, and not before;
 *   - a contact's key checks against the head of their relay, signed by the
 *     relay key the app pinned, and the safety panel says so;
 *   - the two relays exchange heads, and each holds the other's;
 *   - a relay that signs a head of a different log is caught: by the app,
 *     which holds the earlier head, and by the other relay;
 *   - before a large file to a contact whose safety number was never compared
 *     a line above the composer says so; not for a verified contact;
 *   - the relay's state is in its database (state.db), the log included.
 *
 *   node tests/e2e/keytransparency.mjs      (brings up its own two stacks)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { openApp, identity, importIdentity, browser, waitFor } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
import { createChecks } from './_check.mjs';
import { readStateStore } from './_relay-store.mjs';

const require = createRequire(import.meta.url);
const keyLog = require('../../scripts/lib/key-log.js');
const { results, check } = createChecks({ entry: (name, ok, detail) => ({ name, ok, detail }) });
const section = (title) => console.log(`\n===== ${title} =====`);
const decode = (card) => JSON.parse(Buffer.from(card.replace('poorija-chat-v1:', ''), 'base64').toString('utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const getJson = (url) => fetch(url).then((r) => r.json());

const stacks = await startTwoStacks();
try {
  section('nothing is logged before it is proven');
  const empty = await getJson(`${stacks.a.url}/kt/head`);
  check('a relay answers with a signed head', empty.ok && empty.head?.relayId === stacks.a.identity.id && keyLog.headSignatureHolds(empty.head, stacks.a.identity.keys.p256.publicKey), JSON.stringify(empty.head || {}).slice(0, 120));

  const ARIA = await openApp('ARIA', { origin: stacks.a.url, relay: stacks.a.url });
  const BARAN = await openApp('BARAN', { origin: stacks.a.url, relay: stacks.a.url });
  await waitFor(ARIA, () => chatState.identity?.v === 4, { timeoutMs: 30000 }).catch(() => null);
  await waitFor(BARAN, () => chatState.identity?.v === 4, { timeoutMs: 30000 }).catch(() => null);
  const cards = { ARIA: await identity(ARIA), BARAN: await identity(BARAN) };
  const fp = { ARIA: decode(cards.ARIA).fingerprint, BARAN: decode(cards.BARAN).fingerprint };

  section('a proven key is logged, once');
  const logged = async (who) => {
    const answer = await getJson(`${stacks.a.url}/kt/proof?fp=${fp[who]}`);
    return answer.entries?.filter((entry) => entry.type === keyLog.TYPE_KEY) || [];
  };
  let ariaEntries = [];
  for (let i = 0; i < 30 && !ariaEntries.length; i += 1) { ariaEntries = await logged('ARIA'); if (!ariaEntries.length) await sleep(1000); }
  check('ARIA\'s v4 keys are in her relay\'s log once she has proven them', ariaEntries.length === 1, JSON.stringify(ariaEntries.map((e) => e.index)));
  const ariaKeys = await ARIA.evaluate(() => ({ sk: chatState.identity.publicKeyData, ak: chatState.identity.ak, akSig: chatState.identity.akSig }));
  const expected = keyLog.keyLeaf({ fp: fp.ARIA, ...ariaKeys, at: ariaEntries[0]?.at }).toString('base64');
  check('the leaf is exactly her signing key, her agreement key and its signature', ariaEntries[0]?.leaf === expected);
  /* A new socket proves the same keys again. */
  await ARIA.evaluate(() => reconnectRelayTransport?.(0));
  await waitFor(ARIA, () => chatState.connected && chatState.ws?.readyState === 1, { timeoutMs: 30000 }).catch(() => null);
  await sleep(4000);
  check('proving the same keys again adds nothing', (await logged('ARIA')).length === 1);
  const stranger = await getJson(`${stacks.a.url}/kt/proof?fp=${'e'.repeat(64)}`);
  check('a fingerprint nobody proved has nothing in the log', stranger.ok && stranger.entries.length === 0);
  check('a malformed one is refused', (await fetch(`${stacks.a.url}/kt/proof?fp=../x`)).status === 400);

  section('the app checks a contact\'s key against the log');
  await importIdentity(BARAN, cards.ARIA);
  await importIdentity(ARIA, cards.BARAN);
  await sleep(1500);
  const verdict = await BARAN.evaluate(async (key) => {
    const peer = findPeerByAnyKey(key);
    return checkContactKeyLog(peer, { force: true });
  }, fp.ARIA);
  check('BARAN finds ARIA\'s key logged by her relay', verdict?.state === 'logged', JSON.stringify(verdict));
  const panelLine = await BARAN.evaluate(async (key) => {
    const peer = findPeerByAnyKey(key);
    chatState.activeConversationId = getConversationKey(peer);
    chatState.activePeerClientId = peer.clientId || '';
    renderPeers(); renderActivePeer();
    openSafetyPanel();
    await new Promise((r) => setTimeout(r, 800));
    const line = document.querySelector('#chatSafetyPanel [data-safety-keylog]');
    const out = line ? { state: line.dataset.safetyKeylog, text: line.textContent } : null;
    closeSafetyPanel();
    return out;
  }, fp.ARIA);
  check('and the safety panel says so', panelLine?.state === 'logged' && /transparency log/i.test(panelLine.text), JSON.stringify(panelLine));
  const forged = await BARAN.evaluate(async ({ key }) => {
    const peer = findPeerByAnyKey(key);
    const relay = { id: relayPinFor(chatServerOrigin()).id, key: relayPinFor(chatServerOrigin()).publicKey };
    return PoorijaKeyLog.check(chatServerOrigin(), relay, { fp: peer.fingerprint, sk: peer.publicKeyData, ak: 'A'.repeat(43) + '=', akSig: peer.agreeKeySig });
  }, { key: fp.ARIA });
  check('a key the relay did not log for her does not pass', forged.state === 'mismatch', JSON.stringify(forged));

  section('the two relays hand each other their heads');
  let peersOfB = null;
  for (let i = 0; i < 40; i += 1) {
    peersOfB = await getJson(`${stacks.b.url}/kt/heads`);
    if (peersOfB.peers?.some((entry) => entry.relayId === stacks.a.identity.id && entry.head.size >= 2)) break;
    await sleep(2000);
  }
  const heldOfA = peersOfB?.peers?.find((entry) => entry.relayId === stacks.a.identity.id);
  check('relay B holds relay A\'s signed head, as A signed it', Boolean(heldOfA) && keyLog.headSignatureHolds(heldOfA.head, stacks.a.identity.keys.p256.publicKey) && heldOfA.head.size >= 2, JSON.stringify(heldOfA?.head || {}).slice(0, 120));
  check('and does not call it forked', heldOfA && !heldOfA.forked);

  section('a relay that shows a different log is caught');
  /* Relay A's key signs a head of the same size over another root — the lie
     a relay would tell to show one person a key the others never see. */
  const real = (await getJson(`${stacks.a.url}/kt/head`)).head;
  const { createPrivateKey } = await import('node:crypto');
  /* Signed as relay A signs its heads now: with its key-log key, which its
     identity key vouches for (head v2). */
  const privateKey = createPrivateKey({ key: Buffer.from(stacks.a.identity.keys.ktSign.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  const lie = { ...real, root: 'f'.repeat(64), at: real.at + 1 };
  lie.sig = keyLog.signHead(lie, privateKey);
  /* The identity key no longer signs heads (finding F2): a head of the
     same log signed by it the old way, after a v2 one was kept, is not
     taken as one. */
  const idKey = createPrivateKey({ key: Buffer.from(stacks.a.identity.keys.p256.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  const oldWay = { v: 1, relayId: real.relayId, size: real.size, root: real.root, at: real.at + 2 };
  oldWay.sig = keyLog.signHead(oldWay, idKey);
  check('heads are signed with the relay\'s key-log key (v2), which its identity key vouches for', real.v === 2 && typeof real.ktKey === 'string' && keyLog.headSignatureHolds(real, stacks.a.identity.keys.p256.publicKey), JSON.stringify({ v: real.v }));
  const oldVerdict = await BARAN.evaluate((head) => PoorijaKeyLog.noteHead(location.origin, head), oldWay);
  check('a head signed the old way by the identity key, after a v2 one, is not believed', oldVerdict === 'unchecked', oldVerdict);
  const appVerdict = await BARAN.evaluate((head) => PoorijaKeyLog.noteHead(location.origin, head), lie);
  check('the app, holding the earlier head, calls it forked', appVerdict === 'forked', appVerdict);
  const peerHeads = keyLog.createPeerHeads();
  await peerHeads.note(real, stacks.a.identity.keys.p256.publicKey, async () => []);
  check('and so does a relay holding the earlier one', (await peerHeads.note(lie, stacks.a.identity.keys.p256.publicKey, async () => [])) === 'forked');
  const later = await BARAN.evaluate(async (key) => {
    const peer = findPeerByAnyKey(key);
    return checkContactKeyLog(peer, { force: true });
  }, fp.ARIA);
  check('from then on the contact\'s check says so', later?.state === 'forked', JSON.stringify(later));

  section('the line above the composer');
  const banner = await ARIA.evaluate(async (key) => {
    const peer = findPeerByAnyKey(key);
    chatState.activeConversationId = getConversationKey(peer);
    chatState.activePeerClientId = peer.clientId || '';
    renderPeers(); renderActivePeer(); renderMessages();
    await new Promise((r) => setTimeout(r, 300));
    noteHighRiskAction(peer, 'file', 2 * 1024 * 1024);
    const small = !document.getElementById('chatKeyBanner') || document.getElementById('chatKeyBanner').hidden;
    noteHighRiskAction(peer, 'file', 40 * 1024 * 1024);
    const node = document.getElementById('chatKeyBanner');
    const shown = Boolean(node && !node.hidden && node.getClientRects().length);
    const text = node?.textContent || '';
    node?.querySelector('[data-key-banner-later]')?.click();
    await new Promise((r) => setTimeout(r, 200));
    const gone = !node || node.hidden;
    noteHighRiskAction(peer, 'screen');
    const snoozed = !node || node.hidden;
    return { small, shown, text, gone, snoozed };
  }, fp.BARAN);
  check('not for a small file', banner.small === true);
  check('a large file to an unverified contact shows it, naming the safety number', banner.shown && /safety number/i.test(banner.text), JSON.stringify(banner));
  check('"Not now" puts it away for that contact', banner.gone && banner.snoozed);
  const verifiedBanner = await BARAN.evaluate(async (key) => {
    const peer = findPeerByAnyKey(key);
    setPeerVerified(peer.fingerprint, true);
    noteHighRiskAction(peer, 'screen');
    const node = document.getElementById('chatKeyBanner');
    return Boolean(node && !node.hidden);
  }, fp.ARIA);
  check('not for a contact whose number was compared', verifiedBanner === false);

  section('the state is in the database');
  check('relay A keeps a state.db', fs.existsSync(path.join(stacks.a.dir, 'state.db')));
  const leaves = readStateStore(stacks.a.dir, 'kt-leaf') || {};
  check('with the log in it, a row per leaf', Object.keys(leaves).length >= 2, `${Object.keys(leaves).length} row(s)`);
  check('and no per-file mailboxes beside it', !fs.existsSync(path.join(stacks.a.dir, 'mailboxes')) || !fs.readdirSync(path.join(stacks.a.dir, 'mailboxes')).some((name) => name.endsWith('.json')));

  section('nothing threw');
  const errors = [...ARIA.__errors, ...BARAN.__errors];
  check('no script error', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await stacks.stop();
}
const failed = results.filter((result) => !result.ok);
console.log(`\n===== ${failed.length} failed of ${results.length} =====`);
failed.forEach((result) => console.log(`  FAIL ${result.name}${result.detail ? ` — ${result.detail}` : ''}`));
process.exit(failed.length ? 1 : 0);
