/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* The RECEIVER of mail that waited for it: the app is closed (or its socket is
 * dead, as on a locked iPhone), people write, and the app is opened again.
 *
 *   node tests/e2e/_local-stack.mjs offlinerecv
 *   E2E_ENGINE=webkit node tests/e2e/_local-stack.mjs offlinerecv     # Safari's engine
 *
 * offlinesend.mjs is the sender in a lift. This is the other end, and the one
 * a phone is: the notification came, the app was opened, and the thread has to
 * show what was written — whichever of the two reloaded, whichever way the page
 * came back (a reload, a cold start with the vault locked, a socket that the
 * OS kept while the page was frozen).
 */
import { openApp, identity, importIdentity, browser, waitFor, PASS } from './_chat-harness.mjs';
import { createChecks } from './_check.mjs';

const { results, check } = createChecks({ maxDetail: 240, entry: (_name, ok) => Boolean(ok) });
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
const got = (page, text) => page.evaluate((value) => Object.values(chatState.history)
  .some((list) => list.some((e) => e.text === value && e.direction === 'in')), text);
const received = (page, text, timeoutMs = 45000) => waitFor(page, (value) => Object.values(chatState.history)
  .some((list) => list.some((e) => e.text === value && e.direction === 'in')), { timeoutMs, arg: text });
const onScreen = (page, text) => page.evaluate((value) => document.getElementById('chatMessages')?.textContent.includes(value), text);
const cut = async (page) => {
  /* What a locked phone does to the page: nothing is read off the socket and
     the live channel is gone. The relay still believes it is connected for a
     while, which is the part that matters. */
  await page.evaluate(() => {
    chatState.sessions.forEach((session) => { try { session.connection?.close(); } catch (_error) { /* gone */ } session.connection = null; });
    try { chatState.ws?.close(); } catch (_error) { /* gone */ }
  });
};

try {
  const ARIA = await openApp('ARIA');
  const BARAN = await openApp('BARAN');
  const cards = { ARIA: await identity(ARIA), BARAN: await identity(BARAN) };
  const fp = { ARIA: decode(cards.ARIA).fingerprint, BARAN: decode(cards.BARAN).fingerprint };
  await importIdentity(ARIA, cards.BARAN);
  await importIdentity(BARAN, cards.ARIA);
  await openConversation(ARIA, fp.BARAN);
  await openConversation(BARAN, fp.ARIA);
  const hello = `hello-${Date.now()}`;
  await say(ARIA, hello);
  check('they can talk while both are online', await received(BARAN, hello), hello);
  const reply = `reply-${Date.now()}`;
  await say(BARAN, reply);
  check('and the other way', await received(ARIA, reply), reply);

  console.log('\n===== the receiver is away; the app is then opened again =====');
  await BARAN.context().setOffline(true);
  await cut(BARAN);
  await waitFor(BARAN, () => chatState.connected === false, { timeoutMs: 15000 });
  await ARIA.waitForTimeout(1500);
  const waiting = [`wait-1-${Date.now()}`, `wait-2-${Date.now()}`, `wait-3-${Date.now()}`];
  for (const text of waiting) { await say(ARIA, text); await ARIA.waitForTimeout(700); }
  await ARIA.waitForTimeout(2000);
  await BARAN.context().setOffline(false);
  await BARAN.reload({ waitUntil: 'load' });
  await BARAN.waitForTimeout(3000);
  await BARAN.evaluate((pass) => {
    const el = document.getElementById('unlockPassword');
    el.value = pass; el.dispatchEvent(new Event('input', { bubbles: true }));
    window.unlockApp?.();
  }, PASS);
  await waitFor(BARAN, () => chatState.connected === true && chatState.ws?.readyState === 1, { timeoutMs: 60000 });
  for (const text of waiting) check(`the app opened again has "${text.slice(0, 6)}…" in its history`, await received(BARAN, text), text);
  await openConversation(BARAN, fp.ARIA);
  for (const text of waiting) check(`and shows "${text.slice(0, 6)}…" on screen`, await onScreen(BARAN, text), text);

  console.log('\n===== the page is frozen, as a backgrounded phone freezes it; it thaws =====');
  if (process.env.E2E_ENGINE !== 'webkit') {
    const cdp = await BARAN.context().newCDPSession(BARAN);
    await cdp.send('Page.enable');
    await BARAN.evaluate(() => document.dispatchEvent(new Event('freeze')));
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
    await ARIA.waitForTimeout(1500);
    const sleeping = [`frozen-1-${Date.now()}`, `frozen-2-${Date.now()}`];
    for (const text of sleeping) { await say(ARIA, text); await ARIA.waitForTimeout(800); }
    await ARIA.waitForTimeout(6000);
    await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    await BARAN.evaluate(() => document.dispatchEvent(new Event('resume')));
    for (const text of sleeping) check(`after the thaw, "${text.slice(0, 8)}…" is in the history`, await received(BARAN, text, 40000), text);
    await openConversation(BARAN, fp.ARIA);
    for (const text of sleeping) check(`and on screen`, await onScreen(BARAN, text), text);
  }

  console.log('\n===== the sender is the one that restarts; the receiver keeps its page, as a phone does =====');
  /* The receiver's page lives on for days; the sender's is reloaded often. The
     counter an envelope carries (to catch a replay) starts again at the sender
     — it must not be taken at the receiver for a replay of what it has seen. */
  const reconnect = async (page) => {
    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitFor(page, () => chatState.connected === true && chatState.ws?.readyState === 1, { timeoutMs: 45000 });
  };
  const away = async (page) => {
    await page.context().setOffline(true);
    await cut(page);
    await waitFor(page, () => chatState.connected === false, { timeoutMs: 15000 });
    await page.waitForTimeout(1200);
  };
  await away(BARAN);
  const firstWave = [`w1-a-${Date.now()}`, `w1-b-${Date.now()}`, `w1-c-${Date.now()}`];
  for (const text of firstWave) { await say(ARIA, text); await ARIA.waitForTimeout(600); }
  await ARIA.waitForTimeout(1500);
  await reconnect(BARAN);
  for (const text of firstWave) check(`first wave, "${text.slice(0, 5)}…" arrives`, await received(BARAN, text), text);
  await away(BARAN);
  await ARIA.context().setOffline(false);
  await ARIA.reload({ waitUntil: 'load' });
  await ARIA.waitForTimeout(3000);
  await ARIA.evaluate((pass) => {
    const el = document.getElementById('unlockPassword');
    el.value = pass; el.dispatchEvent(new Event('input', { bubbles: true }));
    window.unlockApp?.();
  }, PASS);
  await waitFor(ARIA, () => chatState.connected === true && chatState.ws?.readyState === 1, { timeoutMs: 60000 });
  await openConversation(ARIA, fp.BARAN);
  const secondWave = [`w2-a-${Date.now()}`, `w2-b-${Date.now()}`];
  for (const text of secondWave) { await say(ARIA, text); await ARIA.waitForTimeout(600); }
  await ARIA.waitForTimeout(1500);
  await reconnect(BARAN);
  for (const text of secondWave) check(`after the sender restarted, "${text.slice(0, 5)}…" still arrives`, await received(BARAN, text, 30000), text);
  await openConversation(BARAN, fp.ARIA);
  for (const text of secondWave) check('and is on screen', await onScreen(BARAN, text), text);

  console.log('\n===== the receiver is locked, takes the messages, and is thrown away by the OS before it is opened =====');
  /* Auto-lock is a screen, not a teardown: the app stays connected and takes
     what arrives, holding it in memory because writes wait for the key. The
     relay is told each one arrived (the ack), and a phone that discards the
     page now has nothing — the notification is all that is left. */
  await openConversation(ARIA, fp.BARAN);
  await BARAN.evaluate(() => window.lockApp?.());
  /* The live channel between the two phones is gone (a phone in a pocket has
     none); what reaches this one comes by the relay. */
  await BARAN.evaluate(() => {
    chatState.sessions.forEach((session) => { try { session.connection?.close(); } catch (_error) { /* gone */ } session.connection = null; });
    try { chatState.peer?.disconnect?.(); } catch (_error) { /* gone */ }
  });
  await BARAN.waitForTimeout(1500);
  const whileLocked = [`locked-1-${Date.now()}`, `locked-2-${Date.now()}`];
  for (const text of whileLocked) { await say(ARIA, text); await ARIA.waitForTimeout(700); }
  const tookThem = await waitFor(BARAN, (list) => list.every((text) => Object.values(chatState.history).some((l) => l.some((e) => e.text === text && e.direction === 'in'))), { timeoutMs: 30000, arg: whileLocked });
  check('the locked app takes them (in memory)', tookThem === true);
  await BARAN.reload({ waitUntil: 'load' });       /* the OS threw the page away */
  await BARAN.waitForTimeout(3000);
  await BARAN.evaluate((pass) => {
    const el = document.getElementById('unlockPassword');
    el.value = pass; el.dispatchEvent(new Event('input', { bubbles: true }));
    window.unlockApp?.();
  }, PASS);
  await waitFor(BARAN, () => chatState.connected === true && chatState.ws?.readyState === 1, { timeoutMs: 60000 });
  for (const text of whileLocked) check(`after the page was discarded and the app opened, "${text.slice(0, 8)}…" is there`, await received(BARAN, text, 25000), text);
  await openConversation(BARAN, fp.ARIA);
  for (const text of whileLocked) check('and on screen', await onScreen(BARAN, text), text);

  console.log('\n===== the same, with the live channel still up: what comes over it is kept as well =====');
  await openConversation(ARIA, fp.BARAN);
  await BARAN.evaluate(() => window.lockApp?.());
  await BARAN.waitForTimeout(1200);
  const overLive = [`locked-live-1-${Date.now()}`, `locked-live-2-${Date.now()}`];
  for (const text of overLive) { await say(ARIA, text); await ARIA.waitForTimeout(700); }
  check('the locked app takes them', await waitFor(BARAN, (list) => list.every((text) => Object.values(chatState.history).some((l) => l.some((e) => e.text === text && e.direction === 'in'))), { timeoutMs: 30000, arg: overLive }) === true);
  await BARAN.reload({ waitUntil: 'load' });
  await BARAN.waitForTimeout(3000);
  await BARAN.evaluate((pass) => {
    const el = document.getElementById('unlockPassword');
    el.value = pass; el.dispatchEvent(new Event('input', { bubbles: true }));
    window.unlockApp?.();
  }, PASS);
  await waitFor(BARAN, () => chatState.connected === true && chatState.ws?.readyState === 1, { timeoutMs: 60000 });
  for (const text of overLive) check(`after the page was discarded, "${text.slice(0, 12)}…" is still there`, await received(BARAN, text, 25000), text);

  const failed = results.filter((ok) => !ok).length;
  console.log(`\n===== ${failed} failed of ${results.length} =====`);
  process.exitCode = failed ? 1 : 0;
} finally {
  await browser.close();
}
