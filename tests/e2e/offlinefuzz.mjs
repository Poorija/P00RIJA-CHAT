/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Two people who live on one relay, whose apps are closed, locked, frozen and
 * opened again in an order nobody planned — and every line either wrote must
 * be on the other's screen in the end.
 *
 *   node tests/e2e/_local-stack.mjs offlinefuzz
 *   E2E_ENGINE=webkit FUZZ_ROUNDS=14 FUZZ_SEED=7 node tests/e2e/_local-stack.mjs offlinefuzz
 *
 * offlinerecv.mjs walks four fixed paths; the bugs that cost a person their
 * messages were all in the order of things (a counter that started again at the
 * sender, a chain the receiver had moved past), so this one draws the order at
 * random from a seed and says which draw lost a message.
 */
import { openApp, identity, importIdentity, browser, waitFor, PASS } from './_chat-harness.mjs';
import { createChecks } from './_check.mjs';

const ROUNDS = Number(process.env.FUZZ_ROUNDS || 8);
let seedState = Number(process.env.FUZZ_SEED || 1) >>> 0 || 1;
const rnd = () => { seedState = (Math.imul(seedState, 1664525) + 1013904223) >>> 0; return seedState / 4294967296; };
const pick = (list) => list[Math.floor(rnd() * list.length)];

const { results, check } = createChecks({ maxDetail: 300, entry: (_name, ok) => Boolean(ok) });
const decode = (card) => JSON.parse(Buffer.from(card.replace('poorija-chat-v1:', ''), 'base64').toString('utf8'));
const openConversation = (page, fp) => page.evaluate(async (key) => {
  const peer = findPeerByAnyKey(key);
  chatState.activeConversationId = getConversationKey(peer);
  chatState.activePeerClientId = peer.clientId || '';
  renderPeers(); renderActivePeer(); renderMessages();
  await new Promise((r) => setTimeout(r, 300));
}, fp);
const say = (page, text) => page.evaluate((value) => {
  const box = document.getElementById('chatComposer');
  box.value = value;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('chatSendMessageBtn').click();
}, text);
const has = (page, text) => page.evaluate((value) => Object.values(chatState.history)
  .some((list) => list.some((e) => e.text === value && e.direction === 'in')), text);
const cut = async (page) => {
  await page.context().setOffline(true);
  await page.evaluate(() => {
    chatState.sessions.forEach((session) => { try { session.connection?.close(); } catch (_error) { /* gone */ } session.connection = null; });
    try { chatState.ws?.close(); } catch (_error) { /* gone */ }
  });
  await waitFor(page, () => chatState.connected === false, { timeoutMs: 15000 });
};
const back = async (page) => {
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitFor(page, () => chatState.connected === true && chatState.ws?.readyState === 1, { timeoutMs: 45000 });
};
const reopen = async (page, fp) => {
  await page.context().setOffline(false);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(2500);
  await page.evaluate((pass) => {
    const el = document.getElementById('unlockPassword');
    el.value = pass; el.dispatchEvent(new Event('input', { bubbles: true }));
    window.unlockApp?.();
  }, PASS);
  await waitFor(page, () => chatState.connected === true && chatState.ws?.readyState === 1, { timeoutMs: 60000 });
  await openConversation(page, fp);
};
const lock = (page) => page.evaluate(() => window.lockApp?.());
const unlock = async (page) => {
  await page.evaluate((pass) => {
    const el = document.getElementById('unlockPassword');
    el.value = pass; el.dispatchEvent(new Event('input', { bubbles: true }));
    window.unlockApp?.();
  }, PASS);
  await waitFor(page, () => window.PoorijaApp?.state?.isLocked === false, { timeoutMs: 20000 });
};

try {
  const pages = { ARIA: await openApp('ARIA'), BARAN: await openApp('BARAN') };
  const warnings = { ARIA: [], BARAN: [] };
  for (const [name, page] of Object.entries(pages)) {
    page.on('console', (m) => { const t = m.text(); if (/\[Chat\]|\[Transport\]|ratchet|replay|refused|unreadable/i.test(t) && /warn|error/.test(m.type())) warnings[name].push(t.slice(0, 200)); });
  }
  const cards = { ARIA: await identity(pages.ARIA), BARAN: await identity(pages.BARAN) };
  const fp = { ARIA: decode(cards.ARIA).fingerprint, BARAN: decode(cards.BARAN).fingerprint };
  await importIdentity(pages.ARIA, cards.BARAN);
  await importIdentity(pages.BARAN, cards.ARIA);
  const peerOf = { ARIA: 'BARAN', BARAN: 'ARIA' };
  for (const name of ['ARIA', 'BARAN']) await openConversation(pages[name], fp[peerOf[name]]);

  let counter = 0;
  const sent = []; // { from, to, text, round, how }
  const write = async (from, how, round) => {
    const text = `m${++counter}-${from[0]}-${Date.now() % 100000}`;
    await say(pages[from], text);
    sent.push({ from, to: peerOf[from], text, round, how });
    await pages[from].waitForTimeout(500);
  };
  const missing = async (settleMs) => {
    const lost = [];
    for (const m of sent) {
      if (m.arrived) continue;
      if (await waitFor(pages[m.to], (t) => Object.values(chatState.history).some((l) => l.some((e) => e.text === t && e.direction === 'in')), { timeoutMs: settleMs, arg: m.text })) m.arrived = true;
      else lost.push(m);
    }
    return lost;
  };

  await write('ARIA', 'live', 0);
  await write('BARAN', 'live', 0);
  check('round 0: both online, both directions', (await missing(30000)).length === 0);

  const plan = [];
  for (let round = 1; round <= ROUNDS; round += 1) {
    const sender = pick(['ARIA', 'BARAN']);
    const receiver = peerOf[sender];
    const how = process.env.FUZZ_ONLY || pick(['away-then-reconnect', 'away-then-reopen', 'locked', 'sender-reopens', 'both-away-reopen', 'live', 'locked-handshake-kill']);
    plan.push(`${round}:${sender}->${receiver}:${how}`);
    console.log(`\n--- round ${round}: ${sender} writes to ${receiver}; ${how}`);
    if (how === 'away-then-reconnect') {
      await cut(pages[receiver]); await pages[sender].waitForTimeout(1500);
      await write(sender, how, round); await write(sender, how, round);
      await pages[sender].waitForTimeout(1500);
      await back(pages[receiver]);
    } else if (how === 'away-then-reopen') {
      await cut(pages[receiver]); await pages[sender].waitForTimeout(1500);
      await write(sender, how, round); await write(sender, how, round);
      await pages[sender].waitForTimeout(1500);
      await reopen(pages[receiver], fp[sender]);
    } else if (how === 'locked') {
      await lock(pages[receiver]); await pages[receiver].waitForTimeout(800);
      await write(sender, how, round); await write(sender, how, round);
      await pages[sender].waitForTimeout(2500);
      await unlock(pages[receiver]);
    } else if (how === 'sender-reopens') {
      await reopen(pages[sender], fp[receiver]);
      await write(sender, how, round);
    } else if (how === 'both-away-reopen') {
      await cut(pages[receiver]); await pages[sender].waitForTimeout(1200);
      await write(sender, how, round);
      await reopen(pages[sender], fp[receiver]);
      await write(sender, how, round);
      await reopen(pages[receiver], fp[sender]);
    } else if (how === 'locked-handshake-kill') {
      /* A phone that locks itself, meets the other side's fresh handshake while
         locked, and is then thrown away by the OS and opened again. */
      await lock(pages[receiver]); await pages[receiver].waitForTimeout(800);
      await reopen(pages[sender], fp[receiver]);
      await pages[sender].waitForTimeout(4000);
      await reopen(pages[receiver], fp[sender]);
      await cut(pages[receiver]); await pages[sender].waitForTimeout(1500);
      await write(sender, how, round); await write(sender, how, round);
      await pages[sender].waitForTimeout(1500);
      await back(pages[receiver]);
    } else {
      await write(sender, how, round);
    }
    const lost = await missing(25000);
    check(`round ${round} (${sender}→${receiver}, ${how}): every line arrived`, lost.length === 0, lost.map((m) => `${m.text}[${m.how}]`).join(' '));
    if (lost.length) {
      console.log('   warnings at the receiver:', JSON.stringify(warnings[receiver].slice(-6)));
      console.log('   warnings at the sender:', JSON.stringify(warnings[sender].slice(-4)));
      for (const m of lost) m.arrived = 'lost';
    }
    await openConversation(pages.ARIA, fp.BARAN).catch(() => {});
    await openConversation(pages.BARAN, fp.ARIA).catch(() => {});
  }
  console.log('\nplan:', plan.join('  '));
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n===== ${failed} failed of ${results.length} =====`);
  process.exitCode = failed ? 1 : 0;
} finally {
  await browser.close();
}
