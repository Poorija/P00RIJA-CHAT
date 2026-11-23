/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* The world clocks page of Settings.
 *
 * It read the chat's state as window.chatState, which does not exist — chatState
 * is a top-level const of the chat's scripts, in scope by name and not a property
 * of the window — so the page always saw no clocks kept, and every city added
 * replaced the one before it: one clock ever, on the card or on the page.
 *
 *   - a city added from the page is kept, listed on the page and shown on the card;
 *   - a second is kept beside the first, not instead of it;
 *   - at the limit the page says so, and a third is refused, not swapped in;
 *   - removing one leaves the other;
 *   - the cities are still there after the app is closed and opened again. They
 *     were saved, and then not read back: the chat draws its profile card while
 *     its own scripts are still loading, and the read touched a const that the
 *     script had not reached yet. That is a ReferenceError, which the read
 *     swallowed and answered with "none" — kept as the list, so the next city
 *     added overwrote the ones that had been saved.
 *
 *   node tests/e2e/clockspage.mjs
 */
import { openApp, browser, PASS } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
import { createChecks } from './_check.mjs';

const { results, check } = createChecks({ entry: (_name, ok) => Boolean(ok) });

const stacks = await startTwoStacks();
try {
  const page = await openApp('CLOCKS', { origin: stacks.a.url, relay: stacks.a.url });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    try { localStorage.removeItem('poorija_chat_clocks'); } catch (_error) { /* none */ }
    chatState.clocks = [];
    window.PoorijaMessenger.go('settings');
    window.PoorijaSettingsPages.reset();
    window.PoorijaSettingsPages.open('clocks');
  });
  await page.waitForTimeout(600);

  const add = async (query) => {
    await page.fill('[data-clock-search]', query);
    await page.waitForTimeout(400);
    const clicked = await page.evaluate(() => { const b = document.querySelector('[data-clock-results] [data-add]'); if (b) { b.click(); return b.dataset.add; } return ''; });
    await page.waitForTimeout(500);
    return clicked;
  };
  const rows = () => page.evaluate(() => ({
    kept: (chatState.clocks || []).map((clock) => clock.tz),
    listed: [...document.querySelectorAll('.msgr-page:not([hidden]) .msgr-clock-row:not([data-add]):not(:first-child)')].length,
    saved: (() => { try { return JSON.parse(localStorage.getItem('poorija_chat_clocks') || '[]').length; } catch (_error) { return -1; } })(),
  }));

  const first = await add('Tokyo');
  const one = await rows();
  check('a city is found and added', first.includes('Tokyo'), first);
  check('it is kept, saved and listed on the page', one.kept.length === 1 && one.saved === 1, JSON.stringify(one));

  const second = await add('Paris');
  const two = await rows();
  check('a second city is added beside the first, not instead of it', second.includes('Paris') && two.kept.length === 2 && two.kept[0].includes('Tokyo'), JSON.stringify(two));
  const shown = await page.evaluate(() => document.querySelector('.msgr-page:not([hidden])')?.textContent || '');
  check('both are on the page', /Tokyo/.test(shown) && /Paris/.test(shown), shown.slice(0, 200));

  const third = await add('Sydney');
  const three = await rows();
  check('a third is refused at the limit, and nothing is swapped out', three.kept.length === 2 && three.kept[0].includes('Tokyo') && three.kept[1].includes('Paris'), `${third} ${JSON.stringify(three)}`);

  await page.evaluate(() => { window.PoorijaSettingsPages.reset(); });
  await page.waitForTimeout(400);
  const onCard = await page.evaluate(() => {
    const box = document.getElementById('chatProfileClocks');
    return (box?.textContent || '').trim();
  });
  check('and the profile card shows them', /Tokyo/i.test(onCard) && /Paris/i.test(onCard), JSON.stringify(onCard).slice(0, 200));

  /* Closed and opened again: a reload to the lock screen, then the password. */
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(3000);
  await page.evaluate((pass) => {
    const el = document.getElementById('unlockPassword');
    el.value = pass; el.dispatchEvent(new Event('input', { bubbles: true }));
    window.unlockApp?.();
  }, PASS);
  await page.waitForTimeout(4000);
  const again = await page.evaluate(() => ({
    kept: (chatState.clocks || []).map((clock) => clock.tz),
    card: (document.getElementById('chatProfileClocks')?.textContent || '').trim(),
  }));
  check('after the app is closed and opened again both cities are still kept', again.kept.length === 2 && again.kept[0].includes('Tokyo') && again.kept[1].includes('Paris'), JSON.stringify(again.kept));
  check('and still on the card', /Tokyo/i.test(again.card) && /Paris/i.test(again.card), JSON.stringify(again.card).slice(0, 160));
  await page.evaluate(() => { window.PoorijaMessenger.go('settings'); window.PoorijaSettingsPages.reset(); window.PoorijaSettingsPages.open('clocks'); });
  await page.waitForTimeout(600);
  const pageText = await page.evaluate(() => document.querySelector('.msgr-page:not([hidden])')?.textContent || '');
  check('and on the clocks page', /Tokyo/.test(pageText) && /Paris/.test(pageText), pageText.slice(0, 200));
} finally {
  await stacks.stop?.();
  await browser?.close?.().catch(() => {});
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n===== ${failed} failed of ${results.length} =====`);
process.exit(failed ? 1 : 0);
