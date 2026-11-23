/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text.
 */

/* A message for a contact who can do better is not sealed with less.
 *
 * A message for somebody who is away is sealed to their prekey, and for a
 * contact on this app that prekey has a post-quantum half. The relay hands
 * the prekey over. When it handed over one without that half — or none — the
 * sender sealed anyway: to the P-256 half alone, or to the identity key. So
 * a relay that wanted a message it could keep for the day those break only
 * had to leave the second half out, and wait.
 *
 * For a contact who has been seen to have that half, the sender now waits
 * instead. The message stays on this device, marked as waiting, and goes the
 * moment a prekey with both halves — signed by the contact — is in hand. A
 * relay can already keep a message from arriving; what it can no longer do
 * is choose how well it is sealed.
 *
 *   node tests/e2e/holdhybrid.mjs      (brings up its own relay)
 */
import { openApp, identity, importIdentity, browser, waitFor } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';

const results = [];
const check = (n, ok, d = '') => {
  results.push({ n, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + String(d).slice(0, 260) : ''}`);
};
const section = (title) => console.log(`\n===== ${title} =====`);
const decode = (card) => JSON.parse(Buffer.from(card.replace('poorija-chat-v1:', ''), 'base64').toString('utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const openConversation = (page, fp) => page.evaluate(async (key) => {
  const peer = findPeerByAnyKey(key);
  chatState.activeConversationId = getConversationKey(peer);
  chatState.activePeerClientId = peer.clientId || '';
  renderPeers(); renderActivePeer(); renderMessages();
  await new Promise((r) => setTimeout(r, 400));
}, fp);
const say = (page, text) => page.evaluate((value) => {
  const box = document.getElementById('chatComposer');
  box.value = value;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('chatSendMessageBtn').click();
}, text);
const has = (page, text) => page.evaluate((value) => Object.values(chatState.history)
  .some((list) => list.some((e) => e.text === value && e.direction === 'in')), text);
const received = (page, text, timeoutMs = 45000) => waitFor(page, (value) => Object.values(chatState.history)
  .some((list) => list.some((e) => e.text === value && e.direction === 'in')), { timeoutMs, arg: text });
const entryOf = (page, text) => page.evaluate((value) => {
  const entry = Object.values(chatState.history).flat().find((e) => e.text === value && e.direction === 'out');
  return entry ? { status: entry.status || '', heldFor: entry.heldFor || '' } : null;
}, text);

const stacks = await startTwoStacks();
try {
  const SARA = await openApp('SARA', { origin: stacks.a.url, relay: stacks.a.url });
  const OMID = await openApp('OMID', { origin: stacks.a.url, relay: stacks.a.url });
  const cards = { SARA: await identity(SARA), OMID: await identity(OMID) };
  const fp = { SARA: decode(cards.SARA).fingerprint, OMID: decode(cards.OMID).fingerprint };
  await importIdentity(SARA, cards.OMID);
  await importIdentity(OMID, cards.SARA);
  await openConversation(SARA, fp.OMID);
  await openConversation(OMID, fp.SARA);

  section('a contact seen to have both halves');
  await waitFor(SARA, (key) => Boolean(findPeerByAnyKey(key)?.prekeyPq), { timeoutMs: 45000, arg: fp.OMID });
  await sleep(800);
  const known = await SARA.evaluate((key) => ({ pinned: findPeerByAnyKey(key)?.kexPinned || 0 }), fp.OMID);
  check('is remembered as one, from the prekey alone', known.pinned === 3, JSON.stringify(known));

  /* From here SARA has no channel to OMID, and the relay stops handing over
     OMID's prekey: every record of him that arrives has it taken off, the way
     a relay would, and what SARA already held is taken as having run out.
     SARA also keeps a note of every seal she makes. */
  await SARA.evaluate((key) => {
    const peer = findPeerByAnyKey(key);
    try { chatState.sessions.get(peer.peerId)?.connection?.close(); } catch (e) { /* gone */ }
    chatState.sessions.delete(peer.peerId);
    window.ensureDirectSession = async () => null;
    window.startSecureSession = async () => null;
    window.__withheld = { prekeyId: peer.prekeyId, prekeyPublic: peer.prekeyPublic, prekeyExpiresAt: peer.prekeyExpiresAt, prekeySig: peer.prekeySig, prekeyPq: peer.prekeyPq, prekeyPqSig: peer.prekeyPqSig };
    window.__withhold = true;
    const merge = window.mergePeerRecord;
    window.mergePeerRecord = function withholding(record, options) {
      if (window.__withhold && record && (record.fingerprint === key || record.peerId === peer.peerId)) {
        record = { ...record, prekeyId: '', prekeyPublic: '', prekeyExpiresAt: '', prekeySig: '', prekeyPq: '', prekeyPqSig: '' };
      }
      return merge.call(this, record, options);
    };
    const considered = window.considerPrekey;
    window.considerPrekey = async function withheld(record, candidate) {
      if (window.__withhold && record === findPeerByAnyKey(key)) return false;
      return considered.call(this, record, candidate);
    };
    Object.assign(peer, { prekeyId: '', prekeyPublic: '', prekeyExpiresAt: '', prekeySig: '', prekeyPq: '', prekeyPqSig: '' });
    window.__seals = [];
    const prekey = window.sealWithPrekey;
    window.sealWithPrekey = async function watched(...args) {
      const kex = await prekey.apply(this, args);
      if (args[0] === findPeerByAnyKey(key)) window.__seals.push(kex ? `prekey v${kex.v}` : 'none');
      return kex;
    };
    const rsa = window.sealSessionKeyFor;
    window.sealSessionKeyFor = async function watchedRsa(...args) {
      const seal = await rsa.apply(this, args);
      if (seal && args[1] === findPeerByAnyKey(key)) window.__seals.push('identity key');
      return seal;
    };
  }, fp.OMID);

  section('the relay hands over no prekey');
  const waiting = `waiting-${Date.now()}`;
  await say(SARA, waiting);
  await sleep(7000);
  const seals = await SARA.evaluate(() => window.__seals.slice());
  const heldEntry = await entryOf(SARA, waiting);
  console.log('  ' + JSON.stringify({ seals, entry: heldEntry }));
  check('nothing is sealed to the identity key, or to one half', !seals.includes('identity key') && !seals.includes('prekey v2'), seals.join(', ') || '(no seal made)');
  check('the message has not gone', (await has(OMID, waiting)) === false);
  check('and is marked as waiting on SARA\'s side, not as failed', heldEntry?.heldFor === 'prekey' && heldEntry.status !== 'failed', JSON.stringify(heldEntry));

  section('the relay hands over the first half and leaves the second out');
  /* The genuine prekey, signed, with nothing wrong in it — only shorter. */
  await SARA.evaluate((key) => {
    Object.assign(findPeerByAnyKey(key), { ...window.__withheld, prekeyPq: '', prekeyPqSig: '' });
    window.__seals = [];
  }, fp.OMID);
  const halved = `halved-${Date.now()}`;
  await say(SARA, halved);
  await sleep(6000);
  const halvedSeals = await SARA.evaluate(() => window.__seals.slice());
  const halvedEntry = await entryOf(SARA, halved);
  check('nothing is sealed to that half alone', !halvedSeals.includes('prekey v2') && !halvedSeals.includes('identity key'), halvedSeals.join(', ') || '(no seal made)');
  check('the message waits', (await has(OMID, halved)) === false && halvedEntry?.heldFor === 'prekey', JSON.stringify(halvedEntry));

  section('the prekey with both halves has run out');
  await SARA.evaluate((key) => {
    Object.assign(findPeerByAnyKey(key), { ...window.__withheld, prekeyExpiresAt: new Date(Date.now() - 60000).toISOString() });
    window.__seals = [];
  }, fp.OMID);
  const stale = `stale-${Date.now()}`;
  await say(SARA, stale);
  await sleep(6000);
  const staleSeals = await SARA.evaluate(() => window.__seals.slice());
  const staleEntry = await entryOf(SARA, stale);
  check('nothing is sealed to it, or to the identity key', !staleSeals.some((s) => s.startsWith('prekey v')) && !staleSeals.includes('identity key'), staleSeals.join(', ') || '(no seal made)');
  check('the message waits', (await has(OMID, stale)) === false && staleEntry?.heldFor === 'prekey', JSON.stringify(staleEntry));
  const kept = await SARA.evaluate(async (text) => {
    await new Promise((r) => setTimeout(r, 500));
    const raw = JSON.stringify(chatState.history);
    return raw.includes(text) && Object.values(JSON.parse(raw)).flat().find((e) => e.text === text)?.heldFor === 'prekey';
  }, stale);
  check('and what it waits for is part of what is stored', kept === true);

  section('a prekey with both halves comes in');
  await SARA.evaluate(async (key) => {
    window.__withhold = false;
    Object.assign(findPeerByAnyKey(key), { prekeyId: '', prekeyPublic: '', prekeyExpiresAt: '', prekeySig: '', prekeyPq: '', prekeyPqSig: '' });
    window.__seals = [];
    await window.considerPrekey(findPeerByAnyKey(key), window.__withheld);
  }, fp.OMID);
  check('the message goes by itself', await received(OMID, waiting), waiting);
  check('and the two that came after it', (await received(OMID, halved)) && (await received(OMID, stale)));
  const after = await SARA.evaluate(() => window.__seals.slice());
  const sentEntry = await entryOf(SARA, waiting);
  check('sealed with both halves', after.includes('prekey v3') && !after.includes('identity key') && !after.includes('prekey v2'), after.join(', '));
  check('and is no longer marked as waiting', sentEntry?.heldFor === '', JSON.stringify(sentEntry));

  section('a contact never seen with a second half');
  /* One on a build without it, or a ratchet: there is nothing to hold out
     for, so a message key is sealed to the identity key, the way it always
     was. A contact with a ratchet or a hybrid pin (OMID now) never gets that
     seal (28-offline-envelopes.js identitySealRefused), so it is asked for an
     older contact's record: the same person, with nothing seen. */
  const plainSeals = await SARA.evaluate(async (key) => {
    const peer = findPeerByAnyKey(key);
    const old = { ...peer, kexPinned: 0, ratchetPinned: 0, prekeyId: '', prekeyPublic: '', prekeyPq: '', prekeyPqSig: '' };
    const cryptoKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const forOld = await sealSessionKeyFor({ cryptoKey }, old);
    const forOmid = await sealSessionKeyFor(chatState.sessions.get(peer.peerId) || { cryptoKey }, peer);
    return [forOld ? 'identity key' : 'none', forOmid ? 'identity key (to OMID)' : 'none to OMID'];
  }, fp.OMID);
  check('with the seal that was always there for them', plainSeals[0] === 'identity key', plainSeals.join(', '));
  check('and never to a contact with a ratchet', plainSeals[1] === 'none to OMID', plainSeals.join(', '));

  section('nothing threw');
  const errors = [...SARA.__errors, ...OMID.__errors];
  check('no script error on either side', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await stacks.stop();
}
const bad = results.filter((r) => !r.ok);
console.log(`\n===== ${bad.length} failed of ${results.length} =====`);
process.exit(bad.length ? 1 : 0);
