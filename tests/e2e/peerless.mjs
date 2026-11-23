/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* The relay is the messenger; PeerJS is only the direct-call layer.
 *
 * The relay socket used to be opened from PeerJS's 'open' event, so a network on
 * which PeerJS's own signalling socket (/peerjs) never answered left the whole
 * app on "Connecting…" — with the relay reachable, and no way to send or to
 * receive. Here /peerjs is made to hang for ever, on both sides, and
 *
 *   - the app connects to the relay anyway, and says so;
 *   - a message written by one reaches the other, sealed, through the relay;
 *   - it is announced to the relay under the account's address, so the other
 *     side finds it online.
 *
 *   node tests/e2e/peerless.mjs
 */
import { openApp, identity, importIdentity, browser, waitFor } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
import { createChecks } from './_check.mjs';

const { results, check } = createChecks({ maxDetail: 240, entry: (_name, ok) => Boolean(ok) });
const decode = (card) => JSON.parse(Buffer.from(card.replace('poorija-chat-v1:', ''), 'base64').toString('utf8'));

/* A socket to /peerjs that is opened and then says nothing, ever. */
const hangPeerJs = () => {
  const Real = window.WebSocket;
  function Hung(url, protocols) {
    if (!String(url).includes('/peerjs')) return protocols === undefined ? new Real(url) : new Real(url, protocols);
    const target = new EventTarget();
    const fake = Object.assign(target, {
      url: String(url), readyState: 0, bufferedAmount: 0, extensions: '', protocol: '', binaryType: 'blob',
      send() {}, close() { fake.readyState = 3; },
      onopen: null, onclose: null, onerror: null, onmessage: null,
      CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3,
    });
    window.__hungPeerSockets = (window.__hungPeerSockets || 0) + 1;
    return fake;
  }
  Hung.prototype = Real.prototype;
  Object.assign(Hung, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Hung;
};

const say = (page, text) => page.evaluate((value) => {
  const box = document.getElementById('chatComposer');
  box.value = value;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('chatSendMessageBtn').click();
}, text);
const received = (page, text, timeoutMs = 60000) => waitFor(page, (value) => Object.values(chatState.history)
  .some((list) => list.some((e) => e.text === value && e.direction === 'in')), { timeoutMs, arg: text });

const stacks = await startTwoStacks();
try {
  const ARIA = await openApp('ARIA', { origin: stacks.a.url, relay: stacks.a.url, init: hangPeerJs });
  const BARAN = await openApp('BARAN', { origin: stacks.a.url, relay: stacks.a.url, init: hangPeerJs });
  for (const page of [ARIA, BARAN]) {
    const state = await waitFor(page, () => chatState.connected === true && chatState.ws?.readyState === 1, { timeoutMs: 30000 });
    const view = await page.evaluate(() => ({
      hung: window.__hungPeerSockets || 0,
      peerOpen: Boolean(chatState.peer?.open),
      label: document.getElementById('chatConnectionStatus')?.textContent.trim() || '',
    }));
    check('PeerJS never opens here', view.hung > 0 && !view.peerOpen, JSON.stringify(view));
    check('and the app is connected to the relay anyway', Boolean(state) && /connected|متصل/i.test(view.label) && !/connecting|در حال/i.test(view.label), JSON.stringify(view));
  }
  const cards = { ARIA: await identity(ARIA), BARAN: await identity(BARAN) };
  const fp = { ARIA: decode(cards.ARIA).fingerprint, BARAN: decode(cards.BARAN).fingerprint };
  await importIdentity(ARIA, cards.BARAN);
  await importIdentity(BARAN, cards.ARIA);
  const seen = await waitFor(BARAN, (key) => {
    const peer = findPeerByAnyKey(key);
    return Boolean(peer && peer.status === 'online');
  }, { timeoutMs: 30000, arg: fp.ARIA });
  check('the other side is seen online through the relay\'s presence', seen);
  await ARIA.evaluate(async (key) => {
    const peer = findPeerByAnyKey(key);
    chatState.activeConversationId = getConversationKey(peer);
    chatState.activePeerClientId = peer.clientId || '';
    renderPeers(); renderActivePeer(); renderMessages();
    await new Promise((r) => setTimeout(r, 400));
  }, fp.BARAN);
  const text = `no-peer-${Date.now()}`;
  await say(ARIA, text);
  check('a message goes through the relay with no peer layer at all', await received(BARAN, text), text);
} catch (error) {
  check('the suite ran to the end', false, error?.stack || String(error));
} finally {
  await stacks.stop?.();
  await browser?.close?.().catch(() => {});
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n===== ${failed} failed of ${results.length} =====`);
process.exit(failed ? 1 : 0);
