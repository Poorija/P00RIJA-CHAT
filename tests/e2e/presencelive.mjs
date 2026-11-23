/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* What the header and the list say about a contact follows the contact,
 * live, with nothing on this side touched: on the same relay and across two
 * relays of the family alike. Both open: Online. The contact puts the app in
 * the background: "Last seen recently" within seconds (another relay used to
 * keep saying Online, because the page's own timers cleared "away" there).
 * Back in front: Online again.
 *
 *   node tests/e2e/presencelive.mjs
 */
import { openApp, identity, importIdentity, waitFor } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
import { createChecks } from './_check.mjs';

const { results, check } = createChecks();
const decode = (c) => JSON.parse(Buffer.from(c.replace('poorija-chat-v1:', ''), 'base64').toString('utf8'));
const setHidden = (page, hidden) => page.evaluate((h) => {
  Object.defineProperty(document, 'visibilityState', { value: h ? 'hidden' : 'visible', configurable: true });
  Object.defineProperty(document, 'hidden', { value: h, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}, hidden);
const header = (page) => page.evaluate(() => document.getElementById('chatActivePeerMeta')?.textContent || '');
/* Says it, and keeps saying it for six seconds: a label that flickers back is
   the bug this suite is about. */
const headerSays = async (page, pattern, timeoutMs) => {
  const test = (src) => new RegExp(src).test(document.getElementById('chatActivePeerMeta')?.textContent || '');
  if (!await waitFor(page, test, { timeoutMs, arg: pattern })) return false;
  for (let i = 0; i < 12; i++) { await page.waitForTimeout(500); if (!await page.evaluate(test, pattern)) return false; }
  return true;
};

const stacks = await startTwoStacks();
try {
  for (const where of ['same relay', 'two relays']) {
    const A = await openApp(`SARA${where.length}`, { origin: stacks.a.url, relay: stacks.a.url });
    const far = where === 'same relay' ? stacks.a.url : stacks.b.url;
    const B = await openApp(`OMID${where.length}`, { origin: far, relay: far });
    const ca = await identity(A), cb = await identity(B);
    await importIdentity(A, cb); await importIdentity(B, ca);
    await A.evaluate((fp) => { const p = findPeerByAnyKey(fp); chatState.activeConversationId = getConversationKey(p); chatState.activePeerClientId = p.clientId || ''; updateChatShellMode?.(); renderPeers(); renderActivePeer(); }, decode(cb).fingerprint);
    check(`${where}: both open, the header says Online`, await headerSays(A, '^Online', 30000), await header(A));
    /* A message each way first, so a live direct channel is open and its
       heartbeat runs: that channel must not keep a backgrounded contact
       "Online" (it did, on the live servers, where the channel opened). */
    await A.fill('#chatComposer', 'hello'); await A.click('#chatSendMessageBtn');
    await waitFor(B, () => Object.values(chatState.history).flat().some((e) => e.text === 'hello' && e.direction === 'in'), { timeoutMs: 60000 });
    await A.waitForTimeout(3000);
    const channel = await A.evaluate((fp) => peerChannelLive(findPeerByAnyKey(fp)), decode(cb).fingerprint);
    console.log(`  (${where}: a live direct channel: ${channel})`);
    await setHidden(B, true);
    check(`${where}: the contact puts the app away, and within 15 s it says Last seen recently`, await headerSays(A, 'Last seen recently', 15000), await header(A));
    await setHidden(B, false);
    check(`${where}: back in front, Online again within 15 s, with nothing pressed here`, await headerSays(A, '^Online', 15000), await header(A));
    await A.context().close(); await B.context().close();
  }
} finally {
  await stacks.stop();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n===== ${failed.length} failed of ${results.length} =====`);
process.exit(failed.length ? 1 : 0);
