/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* A message handed to a live channel that is then closed before it was delivered
 * is sent again, by whatever way is open; one that did arrive is not shown twice.
 *
 *   node tests/e2e/_local-stack.mjs resendsent
 *   E2E_ENGINE=webkit node tests/e2e/_local-stack.mjs resendsent */
import { openApp, identity, importIdentity, browser, waitFor } from './_chat-harness.mjs';
import { createChecks } from './_check.mjs';

const { results, check } = createChecks({ maxDetail: 300, entry: (_name, ok) => Boolean(ok) });
const decode = (card) => JSON.parse(Buffer.from(card.replace('poorija-chat-v1:', ''), 'base64').toString('utf8'));
const openConversation = (page, fp) => page.evaluate(async (key) => {
  const peer = findPeerByAnyKey(key);
  chatState.activeConversationId = getConversationKey(peer);
  chatState.activePeerClientId = peer.clientId || '';
  renderPeers(); renderActivePeer(); renderMessages();
  await new Promise((r) => setTimeout(r, 300));
}, fp);
const write = (page, text) => page.evaluate((t) => {
  const box = document.getElementById('chatComposer');
  box.value = t;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('chatSendMessageBtn').click();
}, text);
const copies = (page, text) => page.evaluate((t) => Object.values(chatState.history).flat().filter((e) => e.direction === 'in' && e.text === t).length, text);
const statusOf = (page, text) => page.evaluate((t) => Object.values(chatState.history).flat().find((e) => e.direction === 'out' && e.text === t)?.status || 'none', text);

try {
  const ARIA = await openApp('ARIA');
  const BARAN = await openApp('BARAN');
  const cards = { ARIA: await identity(ARIA), BARAN: await identity(BARAN) };
  const fp = { ARIA: decode(cards.ARIA).fingerprint, BARAN: decode(cards.BARAN).fingerprint };
  await importIdentity(ARIA, cards.BARAN);
  await importIdentity(BARAN, cards.ARIA);
  await openConversation(ARIA, fp.BARAN); await openConversation(BARAN, fp.ARIA);

  /* A live, keyed channel first. */
  await write(ARIA, 'warm-up');
  await waitFor(BARAN, () => Object.values(chatState.history).flat().some((e) => e.direction === 'in' && e.text === 'warm-up'), { timeoutMs: 40000 });
  const live = await waitFor(ARIA, () => [...chatState.sessions.values()].some((s) => s.connection?.open && s.cryptoKey), { timeoutMs: 40000 });
  if (!live) {
    /* No direct channel on this engine in this sandbox (the relay carries everything): nothing to hand to a channel. */
    console.log('   NOTE no direct channel could be opened here; the live-channel scenarios do not apply');
    process.exitCode = 0;
    await browser.close();
    process.exit(0);
  }
  check('a live, keyed channel is up before the test', Boolean(live));

  /* 1. Handed to the channel, lost in it, the channel closes. */
  /* The channel takes what it is given and delivers none of it. */
  await ARIA.evaluate(() => {
    chatState.sessions.forEach((s) => {
      if (!s.connection?.open) return;
      const original = s.connection.send.bind(s.connection);
      s.connection.send = (...args) => { if (window.__dropText) return undefined; return original(...args); };
    });
    window.__dropText = true;
  });
  /* The channel delivers nothing and the sender's own way to the relay is shut for the whole of the wait the app
     gives a channel (ten seconds): the resend it makes then goes nowhere, and what it was is a message at "sent". */
  await write(ARIA, 'lost-in-the-channel');
  await waitFor(ARIA, () => Object.values(chatState.history).flat().some((e) => e.direction === 'out' && e.text === 'lost-in-the-channel' && e.status === 'sent'), { timeoutMs: 20000 });
  check('the message was handed to the channel and is "sent"', (await statusOf(ARIA, 'lost-in-the-channel')) === 'sent');
  await ARIA.context().setOffline(true);
  await ARIA.evaluate(() => { try { chatState.ws?.close(); } catch (_e) { /* gone */ } });
  await ARIA.waitForTimeout(14000);
  check('it has not arrived (the channel dropped it, the relay was shut)', (await copies(BARAN, 'lost-in-the-channel')) === 0);
  check('and it is no longer "sent": it is waiting to go', ['queued', 'relayed'].includes(await statusOf(ARIA, 'lost-in-the-channel')), await statusOf(ARIA, 'lost-in-the-channel'));
  await ARIA.evaluate(() => { window.__dropText = false; });
  await ARIA.context().setOffline(false);
  await ARIA.evaluate(() => window.dispatchEvent(new Event('online')));
  const got = await waitFor(BARAN, () => Object.values(chatState.history).flat().some((e) => e.direction === 'in' && e.text === 'lost-in-the-channel'), { timeoutMs: 90000 });
  check('when a way opened, it went and arrived', Boolean(got));
  await ARIA.waitForTimeout(3000);
  check('and it is shown once', (await copies(BARAN, 'lost-in-the-channel')) === 1, String(await copies(BARAN, 'lost-in-the-channel')));

  /* Arrived, then the channel closes: nothing shown twice. */
  await waitFor(ARIA, () => chatState.connected === true && chatState.ws?.readyState === 1, { timeoutMs: 60000 }).catch(() => null);
  await write(ARIA, 'arrived-then-closed');
  await waitFor(BARAN, () => Object.values(chatState.history).flat().some((e) => e.direction === 'in' && e.text === 'arrived-then-closed'), { timeoutMs: 60000 });
  await ARIA.evaluate(() => { chatState.sessions.forEach((s) => { try { s.connection?.close(); } catch (_e) { /* gone */ } }); });
  await ARIA.waitForTimeout(13000);
  check('a message that arrived before the channel closed is shown once', (await copies(BARAN, 'arrived-then-closed')) === 1, String(await copies(BARAN, 'arrived-then-closed')));

  const failed = results.filter((ok) => !ok).length;
  console.log(`\n===== ${failed} failed of ${results.length} =====`);
  process.exitCode = failed ? 1 : 0;
} finally {
  await browser.close();
}
