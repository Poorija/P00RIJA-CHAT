/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Coming back to the app has to end in a connection, whatever state the
 * phone left the transport in. Against a real relay, three things a phone does
 * to it, each of which used to leave the app on "Disconnected" until it was
 * closed completely and opened again:
 *
 *   - a connect that was suspended between two awaits never returns, and while
 *     it is "in flight" every later request to connect is queued behind it;
 *   - a socket that reports OPEN and carries nothing (the phone slept) was
 *     believed alive on return, on no evidence;
 *   - a socket that was abandoned fires its close long after a new one is up,
 *     and that late close printed "disconnected" over the live connection and
 *     stopped its heartbeat;
 *   - a phone that locks itself when it is put away comes back to the lock
 *     screen with a connection that died behind it, and every path that repairs
 *     one asked whether the vault was open — so nothing was repaired until the
 *     password had been typed, and the first seconds after it read "Connecting";
 *   and, as a guard rather than a regression: an app opened on Settings, the
 *     tab it was left on, connects without Chats ever being opened.
 *
 *   node tests/e2e/resume.mjs
 */
import { openApp, browser, PASS } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
import { createChecks } from './_check.mjs';

const { results, check } = createChecks({ entry: (_name, ok) => Boolean(ok) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const state = (page) => page.evaluate(() => ({
  connected: chatState.connected === true,
  ws: chatState.ws ? chatState.ws.readyState : -1,
  label: document.getElementById('chatConnectionStatus')?.textContent.trim() || '',
  heartbeat: Boolean(chatState.heartbeatTimer),
  inFlight: Boolean(chatState.transportConnectInFlight),
}));
async function until(page, ok, ms = 20000) {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    last = await state(page);
    if (ok(last)) return last;
    await sleep(400);
  }
  return last;
}
const comeBack = (page) => page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
});

const stacks = await startTwoStacks();
try {
  const page = await openApp('RESUME', { origin: stacks.a.url, relay: stacks.a.url });
  const first = await until(page, (view) => view.connected && view.ws === 1, 20000);
  check('connected to begin with', first.connected && first.ws === 1, JSON.stringify(first));

  console.log('\n===== a connect that never returned =====');
  await page.evaluate(() => {
    /* The phone froze the page in the middle of a connect: it is "in flight" since a minute ago, and the socket is gone. */
    chatState.transportConnectInFlight = true;
    chatState._transportInFlightSince = Date.now() - 60000;
    chatState.ws.close();
  });
  await sleep(600);
  await comeBack(page);
  const stuck = await until(page, (view) => view.connected && view.ws === 1, 25000);
  check('on return it connects again, not waiting behind the connect that never came back', stuck.connected && stuck.ws === 1 && !stuck.inFlight, JSON.stringify(stuck));

  console.log('\n===== a socket that says open and answers nothing =====');
  const before = await page.evaluate(() => { window.__deadSocket = chatState.ws; chatState.ws.send = () => {}; return chatState.ws.readyState; });
  check('it is open, and sends into nothing', before === 1);
  await comeBack(page);
  /* The ping gets a few seconds to be answered before the socket is given up. */
  await sleep(7000);
  const healed = await until(page, (view) => view.connected && view.ws === 1, 25000);
  const replaced = await page.evaluate(() => chatState.ws !== window.__deadSocket);
  check('it is not believed: the socket that did not answer is replaced', healed.connected && replaced, JSON.stringify({ healed, replaced }));
  check('and the new one has its heartbeat', healed.heartbeat, JSON.stringify(healed));

  console.log('\n===== a late close from a socket that was given up =====');
  await page.evaluate(() => {
    const old = chatState.ws;
    window.__old = old;
    chatState.ws = null;
    try { old.close(); } catch (_error) { /* gone */ }
    connectPresence();
  });
  const up = await until(page, (view) => view.connected && view.ws === 1, 20000);
  check('a new socket is up', up.connected && up.ws === 1, JSON.stringify(up));
  await page.evaluate(() => window.__old.dispatchEvent(new Event('close')));
  await sleep(500);
  const late = await state(page);
  check('the late close of the old one does not take the connection down', late.connected && late.ws === 1 && late.heartbeat, JSON.stringify(late));
  check('and the label still says connected', /متصل|connected/i.test(late.label) && !/قطع|disconnected/i.test(late.label), late.label);

  console.log('\n===== a connection that died behind the lock screen =====');
  await page.evaluate(() => { (window.lockApp || window.PoorijaApp?.lockApp)(); });
  await sleep(1200);
  /* The app may notice and remake the socket faster than a sleep can look: the death is watched for, every 10 ms,
     from before the close, rather than read once 800 ms later (when a fast reconnect had already put a new socket there). */
  await page.evaluate(() => {
    window.__deadSeen = false;
    window.__deadFrom = chatState.ws;
    window.__deadWatch = setInterval(() => { if (!chatState.ws || chatState.ws.readyState !== 1 || chatState.ws !== window.__deadFrom) window.__deadSeen = true; }, 10);
    chatState.ws.close();
  });
  await sleep(800);
  const dead = await state(page);
  const noticed = await page.evaluate(() => { clearInterval(window.__deadWatch); return window.__deadSeen; });
  check('locked, and the dead connection is noticed (it is gone, or already replaced)', (noticed || !dead.connected) && await page.evaluate(() => window.PoorijaApp.state.isLocked === true), JSON.stringify({ noticed, ...dead }));
  await comeBack(page);
  const behind = await until(page, (view) => view.connected && view.ws === 1, 25000);
  check('it is made again while the screen is still locked, without the password', behind.connected && behind.ws === 1, JSON.stringify(behind));
  check('and the app is still locked', await page.evaluate(() => window.PoorijaApp.state.isLocked === true));
  await page.evaluate((pass) => {
    const el = document.getElementById('unlockPassword');
    el.value = pass; el.dispatchEvent(new Event('input', { bubbles: true }));
    window.unlockApp?.();
  }, PASS);
  await sleep(2500);
  const opened = await state(page);
  check('and it is still connected, not "Connecting", once the password is typed', opened.connected && opened.ws === 1 && /connected|متصل/i.test(opened.label) && !/connecting|در حال/i.test(opened.label), JSON.stringify(opened));

  console.log('\n===== opened on Settings =====');
  await page.reload({ waitUntil: 'load' });
  await sleep(3000);
  await page.evaluate((pass) => {
    window.PoorijaApp.state.activeTab = 'settings';
    const el = document.getElementById('unlockPassword');
    el.value = pass; el.dispatchEvent(new Event('input', { bubbles: true }));
    window.unlockApp?.();
  }, PASS);
  const onSettings = await until(page, (view) => view.connected && view.ws === 1, 30000);
  check('it connects although Chats is not the tab it opened on', onSettings.connected && onSettings.ws === 1, JSON.stringify(onSettings));
  check('and the card in Settings says so', await page.evaluate(() => /connected|متصل/i.test(document.getElementById('chatConnectionStatus')?.textContent || '')));
} finally {
  await stacks.stop?.();
  await browser?.close?.().catch(() => {});
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n===== ${failed} failed of ${results.length} =====`);
process.exit(failed ? 1 : 0);
