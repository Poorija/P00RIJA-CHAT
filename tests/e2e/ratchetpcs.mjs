/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* The session heals (roadmap 1.3b, release 2.9).
 *
 * In 2.8 every message has a key of its own, but a thief who takes a device's
 * chain keys reads every message still to come on those chains, for as long as
 * the session lasts. With the Diffie-Hellman step on every round trip, a thief
 * who copies the whole of BARAN's ratchet at one moment — and then watches
 * every frame and applies each to the copy — loses the conversation as soon as
 * BARAN has made a ratchet key the thief never saw. And every so often a step
 * mixes in an ML-KEM-768 secret, so a recording kept for a quantum computer
 * has to break that again too.
 *
 * Checked with the frames that really crossed the wire.
 *
 *   node tests/e2e/ratchetpcs.mjs      (brings up its own relay)
 */
import { openApp, identity, importIdentity, browser, waitFor } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
import { createChecks } from './_check.mjs';

const { results, check } = createChecks({ entry: (name, ok, detail) => ({ name, ok, detail }) });
const section = (title) => console.log(`\n===== ${title} =====`);
const decode = (card) => JSON.parse(Buffer.from(card.replace('poorija-chat-v1:', ''), 'base64').toString('utf8'));

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
const received = (page, text, timeoutMs = 60000) => waitFor(page, (value) => Object.values(chatState.history)
  .some((list) => list.some((e) => e.text === value && e.direction === 'in')), { timeoutMs, arg: text });
const tap = (page) => page.evaluate(() => {
  if (window.__tapped) return;
  window.__tapped = true;
  window.__frames = [];
  const original = window.safeConnectionSend;
  window.safeConnectionSend = function tapped(connection, message, label) {
    try { if (message && message.type) window.__frames.push(JSON.parse(JSON.stringify(message))); } catch (e) { /* binary */ }
    return original.apply(this, arguments);
  };
});
const lastText = (page) => page.evaluate(() => window.__frames.filter((f) => f.type === 'text').slice(-1)[0]?.payload || null);

const stacks = await startTwoStacks();
try {
  const ARIA = await openApp('ARIA', { origin: stacks.a.url, relay: stacks.a.url });
  const BARAN = await openApp('BARAN', { origin: stacks.a.url, relay: stacks.a.url });
  await tap(ARIA); await tap(BARAN);
  await waitFor(ARIA, () => chatState.identity?.v === 4, { timeoutMs: 30000 }).catch(() => null);
  await waitFor(BARAN, () => chatState.identity?.v === 4, { timeoutMs: 30000 }).catch(() => null);
  const cards = { ARIA: await identity(ARIA), BARAN: await identity(BARAN) };
  const fp = { ARIA: decode(cards.ARIA).fingerprint, BARAN: decode(cards.BARAN).fingerprint };
  await importIdentity(ARIA, cards.BARAN); await importIdentity(BARAN, cards.ARIA);
  await openConversation(ARIA, fp.BARAN); await openConversation(BARAN, fp.ARIA);

  section('a version-2 ratchet');
  const first = `first-${Date.now()}`;
  await say(ARIA, first);
  check('a message goes across', Boolean(await received(BARAN, first)), first);
  const p1 = await lastText(ARIA);
  check('on the version-2 ratchet, with a ratchet key on it', p1?.r === 2 && typeof p1.d === 'string' && p1.d.length === 44, JSON.stringify({ r: p1?.r, d: p1?.d?.length }));
  const pinned = await BARAN.evaluate((key) => findPeerByAnyKey(key)?.ratchetPinned, fp.ARIA);
  check('and the contact is remembered at that level', pinned === 2, String(pinned));

  section('a thief copies everything BARAN holds');
  await BARAN.evaluate((key) => {
    const session = chatState.sessions.get(findPeerByAnyKey(key).peerId);
    window.__stolen = JSON.parse(JSON.stringify(session.ratchet));
    window.__thiefRead = [];
  }, fp.ARIA);
  /* The thief follows along: every frame BARAN receives is also tried on the
     stolen copy, as a passive thief with the wire would. */
  const follow = (payload) => BARAN.evaluate(async ({ key, payload }) => {
    const session = chatState.sessions.get(findPeerByAnyKey(key).peerId);
    const ghost = { ratchet: window.__stolen, remoteFingerprint: '' };
    try {
      const plain = await PoorijaRatchet.open(ghost, payload, { kind: 'text', from: session.remoteFingerprint, to: chatState.identity.fingerprint, fingerprint: '' });
      window.__stolen = ghost.ratchet;
      const t = new TextDecoder().decode(plain);
      window.__thiefRead.push(t);
      return t;
    } catch (error) { return `refused: ${error?.name}`; }
  }, { key: fp.ARIA, payload });

  const second = `second-${Date.now()}`;
  await say(ARIA, second);
  await received(BARAN, second);
  check('right after the theft, the thief reads along', (await follow(await lastText(ARIA))) === second);

  section('two round trips later');
  for (let round = 0; round < 2; round += 1) {
    const reply = `reply-${round}-${Date.now()}`;
    await say(BARAN, reply);
    await received(ARIA, reply);
    const back = `back-${round}-${Date.now()}`;
    await say(ARIA, back);
    await received(BARAN, back);
    await follow(await lastText(ARIA));
  }
  const secret = `after-healing-${Date.now()}`;
  await say(ARIA, secret);
  check('BARAN still reads ARIA', Boolean(await received(BARAN, secret)), secret);
  const verdict = await follow(await lastText(ARIA));
  check('the thief does not', verdict !== secret && /^refused/.test(verdict), verdict);

  section('the post-quantum step');
  /* Pushed past the schedule (50 messages) without sending 50: the counter is
     moved on, as time or traffic would. */
  await ARIA.evaluate((key) => { const s = chatState.sessions.get(findPeerByAnyKey(key).peerId); s.ratchet.sincePq = 60; }, fp.BARAN);
  await BARAN.evaluate((key) => { const s = chatState.sessions.get(findPeerByAnyKey(key).peerId); s.ratchet.sincePq = 60; }, fp.ARIA);
  let sawQ = false;
  let sawK = false;
  for (let round = 0; round < 3; round += 1) {
    const a = `pq-a-${round}-${Date.now()}`;
    await say(ARIA, a);
    await received(BARAN, a);
    const pa = await lastText(ARIA);
    sawQ = sawQ || Boolean(pa?.q); sawK = sawK || Boolean(pa?.k);
    const b = `pq-b-${round}-${Date.now()}`;
    await say(BARAN, b);
    await received(ARIA, b);
    const pb = await lastText(BARAN);
    sawQ = sawQ || Boolean(pb?.q); sawK = sawK || Boolean(pb?.k);
  }
  check('an ML-KEM-768 ciphertext crossed inside the conversation', sawQ);
  check('and a fresh ML-KEM key was announced after it', sawK);
  const still = `still-${Date.now()}`;
  await say(BARAN, still);
  check('and the conversation goes on', Boolean(await received(ARIA, still)), still);

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
