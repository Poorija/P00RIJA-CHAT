/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text.
 */

/* This app is the messenger out of P00RIJA Cryptography with the other tools
   taken away. Taking them away is the risk: js/app.js was written for a page
   that had every tool on it, and a function that reaches for a panel that is
   no longer there throws where nobody is looking.

   So this suite asks the two things that removal can break:

     ONLY CHAT     The tabs are the ones a messenger needs and no others, in
                   the sidebar, in the mobile bar and in the page itself.
     NOTHING THROWS  Setting up, unlocking, visiting every tab, switching the
                   language both ways and locking again raise no error.

   It brings up its own relay and its own copy of the page, so it needs
   nothing running:

     node tests/e2e/chatonly.mjs */
import { openApp, browser } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
import { createChecks } from './_check.mjs';

const KEPT = ['chat', 'locallink', 'vault', 'securitycenter', 'migration', 'settings', 'help', 'about'];
const { results, check } = createChecks({ entry: (n, ok) => ({ n, ok }) });

const stacks = await startTwoStacks();
const page = await openApp('SOLO', { origin: stacks.a.url, relay: stacks.a.url });
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  const text = message.text();
  /* A request the bench's relay answers with an error is the browser's line,
     not the app's; what the app itself logs as an error is what counts. */
  if (/Failed to load resource|net::ERR_/i.test(text)) return;
  consoleErrors.push(text.slice(0, 200));
});

console.log('\n===== only the messenger =====');
const online = await page.evaluate(() => (document.getElementById('chatPeerId')?.textContent || '').trim().length > 8);
check('the chat reaches its relay and is given an address', online === true);
const shape = await page.evaluate(() => ({
  unlocked: window.PoorijaApp?.state?.isLocked === false,
  active: window.PoorijaApp?.state?.activeTab,
  sidebar: Array.from(document.querySelectorAll('#sidebarNav button[id^="tab-"]')).map((b) => b.id.replace(/^tab-/, '')),
  panels: Array.from(document.querySelectorAll('[id^="content-"].tab-content')).map((p) => p.id.replace(/^content-/, '')),
  chatShown: !document.getElementById('content-chat').classList.contains('hidden'),
  title: document.title,
}));
console.log('  ' + JSON.stringify(shape));
check('the app unlocks', shape.unlocked === true);
check('it opens on the chat', shape.active === 'chat' && shape.chatShown === true, String(shape.active));
check('the sidebar holds the messenger\'s tabs and no others',
  shape.sidebar.length === KEPT.length && KEPT.every((id) => shape.sidebar.includes(id)), shape.sidebar.join(' '));
check('every panel on the page belongs to one of them',
  shape.panels.length === KEPT.length && shape.panels.every((id) => KEPT.includes(id)), shape.panels.join(' '));

console.log('\n===== nothing throws =====');
for (const tab of KEPT) {
  await page.evaluate((id) => window.switchTab(id), tab);
  await page.waitForTimeout(350);
}
const visited = await page.evaluate(() => window.PoorijaApp.state.activeTab);
check('every tab can be opened', visited === KEPT[KEPT.length - 1], String(visited));

for (const language of ['fa', 'en']) {
  await page.evaluate((lang) => {
    if (typeof window.setLanguage === 'function') return window.setLanguage(lang);
    window.PoorijaApp.state.language = lang;
    return window.updateLanguage?.();
  }, language);
  await page.waitForTimeout(500);
}
const languageNow = await page.evaluate(() => window.PoorijaApp.state.language);
check('the language switches both ways', languageNow === 'en', String(languageNow));

await page.evaluate(() => window.switchTab('chat'));
await page.waitForTimeout(300);
const mobile = await page.evaluate(() => Array.from(document.querySelectorAll('#mobileTabBar [data-mtab]')).map((b) => b.getAttribute('data-mtab')));
check('the mobile bar offers nothing that was taken away',
  mobile.every((id) => ['chat', 'locallink', 'vault', 'securitycenter', 'migration', 'settings', 'help', 'about', 'more'].includes(id)),
  mobile.join(' ') || '(not drawn at this width)');

await page.evaluate(() => { if (typeof window.lockApp === 'function') window.lockApp(); });
await page.waitForTimeout(600);

check('no script error from start to lock', page.__errors.length === 0, page.__errors.slice(0, 4).join(' | '));
check('and nothing logged as an error', consoleErrors.length === 0, consoleErrors.slice(0, 4).join(' | '));

await browser.close();
await stacks.stop();
const bad = results.filter((r) => !r.ok);
console.log(`\n===== ${bad.length} failed of ${results.length} =====`);
process.exit(bad.length ? 1 : 0);
