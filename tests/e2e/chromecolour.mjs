/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* One colour across the top of every screen.
 *
 * The band under the phone's clock, the bar below it and the page were three
 * tones: the bar was a translucent glass over the page, the lock screen was a
 * 135-degree gradient over a flat strip, and a light theme left a pale strip
 * over the dark lock screen. Changing the theme made it worse for a third of a
 * second, because each of them faded to the new colour at its own pace.
 *
 * What is measured is what the browser paints, in each theme, on the lock
 * screen and in Settings, and straight after a theme change:
 *
 *   - html, body, the page background the bar sits on, and the theme-color the
 *     phone paints the band from are one colour;
 *   - the bar (#appHeader) is that colour too, solid;
 *   - the lock screen is flat dark, and the band follows it in either theme;
 *   - nothing fades while the theme is changing.
 *
 * What this cannot measure is the band the operating system paints around an
 * installed web app: it is read from the theme-color meta, which is equal to
 * what is checked here, and that is as far as a browser can say.
 *
 *   node tests/e2e/chromecolour.mjs
 */
import { openApp, browser, PASS } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
import { createChecks } from './_check.mjs';

const { results, check } = createChecks({ maxDetail: 260, entry: (_name, ok) => Boolean(ok) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const read = (page) => page.evaluate(() => {
  const rgb = (value) => String(value || '').replace(/\s+/g, '');
  const hex = (value) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(value || '').trim());
    if (!m) return '';
    const n = parseInt(m[1], 16);
    return `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`;
  };
  const paint = (node) => (node ? rgb(getComputedStyle(node).backgroundColor) : '');
  const shown = (node) => Boolean(node) && getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().height > 0;
  const header = document.getElementById('appHeader');
  const lock = document.getElementById('lockScreen');
  return {
    html: paint(document.documentElement),
    body: paint(document.body),
    header: shown(header) ? paint(header) : '',
    lock: shown(lock) ? paint(lock) : '',
    lockImage: lock ? getComputedStyle(lock).backgroundImage : '',
    meta: hex(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')),
    strip: hex(getComputedStyle(document.documentElement).getPropertyValue('--status-strip-bg')),
    switching: document.documentElement.classList.contains('theme-switching'),
  };
});
const unlock = (page) => page.evaluate((pass) => {
  const el = document.getElementById('unlockPassword');
  el.value = pass; el.dispatchEvent(new Event('input', { bubbles: true }));
  window.unlockApp?.();
}, PASS);

const stacks = await startTwoStacks();
try {
  const page = await openApp('CHROME', { origin: stacks.a.url, relay: stacks.a.url });
  await sleep(800);
  for (const theme of ['dark', 'light']) {
    console.log(`\n===== ${theme} =====`);
    await page.evaluate((name) => { window.setTheme(name); window.PoorijaMessenger.go('settings'); }, theme);
    await sleep(900);
    const app = await read(page);
    console.log('  ' + JSON.stringify(app));
    check(`${theme}: html, body, the bar and the band are one colour in Settings`,
      Boolean(app.html) && app.html === app.body && app.html === app.header && app.html === app.meta && app.html === app.strip, JSON.stringify(app));

    /* The change itself, not what it settles to. */
    const other = theme === 'dark' ? 'light' : 'dark';
    await page.evaluate((name) => window.setTheme(name), other);
    await sleep(60);
    const during = await read(page);
    await sleep(900);
    const after = await read(page);
    check(`${theme} to ${other}: the bar is the page's colour straight away, not fading to it`,
      during.html === during.body && during.html === during.header && during.html === during.meta && during.html === after.html, JSON.stringify({ during, after }));
    check('and the fade is switched off while it changes, and back on after', during.switching === true && after.switching === false, JSON.stringify({ during: during.switching, after: after.switching }));
    await page.evaluate((name) => window.setTheme(name), theme);
    await sleep(900);

    await page.evaluate(() => (window.lockApp || window.PoorijaApp.lockApp)());
    await sleep(1200);
    const locked = await read(page);
    console.log('  ' + JSON.stringify(locked));
    check(`${theme}: the lock screen is one flat dark colour, no gradient`, locked.lock === 'rgb(15,23,42)' && !/gradient/.test(locked.lockImage), JSON.stringify(locked));
    check(`${theme}: and the page behind it and the band are that colour too`, locked.html === locked.lock && locked.body === locked.lock && locked.meta === locked.lock && locked.strip === locked.lock, JSON.stringify(locked));
    await unlock(page);
    await sleep(2500);
    const back = await read(page);
    check(`${theme}: unlocked again, the band is the theme's colour, not the lock screen's`, back.html === back.meta && back.html === back.body && (theme === 'light' ? back.html !== 'rgb(15,23,42)' : true), JSON.stringify(back));
  }
} catch (error) {
  check('the suite ran to the end', false, error?.stack || String(error));
} finally {
  await stacks.stop?.();
  await browser?.close?.().catch(() => {});
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n===== ${failed} failed of ${results.length} =====`);
process.exit(failed ? 1 : 0);
