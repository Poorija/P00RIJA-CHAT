/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Chrome on Android: no white anywhere on the way in.
 *
 * What was reported: a white bar, and a white start screen, in Chrome on a
 * phone — where the same app on an iPhone is one clean dark surface.
 *
 * The first thing on the screen is not the app. It is the page's own background
 * between the first byte and the first stylesheet, and then the screen that
 * comes before the app (language, password), which is dark whatever the
 * theme. Painted from the saved theme, or from the browser's white when there is
 * none, those first frames were white on a light theme or a fresh install.
 *
 * This opens the app as a Pixel 7 does (touch, 412 px wide, Android user agent),
 * in both the light and the dark mode of the phone, with the stylesheets held
 * back so that the first frame is really looked at, and reads the colour of the
 * screen at its four corners and its middle — what is painted, not what the
 * stylesheet says:
 *
 *   - before any stylesheet has arrived, the page is dark, not white;
 *   - on the language screen, and on the password screen, every corner and the
 *     middle is dark and they are one colour;
 *   - the bar of the browser (theme-color) and the manifest's start colour are
 *     that same dark.
 *
 *   node tests/e2e/androidchrome.mjs
 */
import { chromium, devices } from 'playwright';
import { startTwoStacks } from './_two-stacks.mjs';
import { createChecks } from './_check.mjs';

const { results, check } = createChecks({ maxDetail: 300, entry: (_name, ok) => Boolean(ok) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/* The colour under a point of a screenshot: drawn into a canvas and read back. */
async function colours(reader, png, points) {
  return reader.evaluate(async ({ b64, spots }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${b64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const g = canvas.getContext('2d');
    g.drawImage(image, 0, 0);
    return spots.map(([fx, fy]) => {
      const x = Math.min(image.width - 1, Math.max(0, Math.round(image.width * fx)));
      const y = Math.min(image.height - 1, Math.max(0, Math.round(image.height * fy)));
      return [...g.getImageData(x, y, 1, 1).data].slice(0, 3);
    });
  }, { b64: png.toString('base64'), spots: points });
}
/* The corners and the middle of both sides: the edges of the screen, where white shows. */
const SPOTS = [[0.01, 0.005], [0.99, 0.005], [0.01, 0.995], [0.99, 0.995], [0.01, 0.5], [0.99, 0.5]];
const NAMES = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'left', 'right'];

const stacks = await startTwoStacks();
const browser = await chromium.launch();
try {
  const reader = await (await browser.newContext()).newPage();
  await reader.goto('about:blank');
  /* What a visitor has saved decides what the page paints first. */
  const VISITORS = [
    { name: 'a fresh install', saved: {} },
    { name: 'a returning visitor on the light theme', saved: { poorija_theme: 'light', poorija_lang: 'en' } },
    { name: 'a returning visitor on the dark theme, in Persian', saved: { poorija_theme: 'dark', poorija_lang: 'fa' } },
  ];
  for (const scheme of ['light', 'dark']) {
    for (const visitor of VISITORS) {
      console.log(`\n===== a Pixel 7 in ${scheme} mode: ${visitor.name} =====`);
      const context = await browser.newContext({ ...devices['Pixel 7'], colorScheme: scheme, ignoreHTTPSErrors: true });
      await context.addInitScript((saved) => {
        try { for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value); } catch (_error) { /* blocked */ }
      }, visitor.saved);
      const page = await context.newPage();
      /* No stylesheet arrives until the first frame has been looked at. */
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      await page.route(/\.css(\?|$)/, async (route) => { await held; await route.continue(); });
      await page.goto(`${stacks.a.url}/index.html`, { waitUntil: 'commit' });
      await sleep(900);
      /* What the page is while nothing but its own markup has arrived. Chrome paints
         nothing until the render-blocking stylesheets are in, and then shows its own
         canvas: so the canvas the page asks for is dark (color-scheme), the root is
         dark by an inline rule, and the saved theme has not painted it pale. */
      const early = await page.evaluate(() => ({
        scheme: document.querySelector('meta[name="color-scheme"]')?.getAttribute('content') || '',
        html: getComputedStyle(document.documentElement).backgroundColor,
        inline: document.documentElement.style.backgroundColor,
        dir: document.documentElement.dir,
        before: (() => {
          const scheme = document.querySelector('meta[name="color-scheme"]');
          const sheet = document.querySelector('link[rel="stylesheet"]');
          return Boolean(scheme && sheet && (scheme.compareDocumentPosition(sheet) & Node.DOCUMENT_POSITION_FOLLOWING));
        })(),
      }));
      check(`${scheme}, ${visitor.name}: before any stylesheet, the canvas is declared dark, ahead of the stylesheets`, early.scheme === 'dark' && early.before, JSON.stringify(early));
      check(`${scheme}, ${visitor.name}: and the root is dark, not painted in the saved theme's colour`, early.html === 'rgb(15, 23, 42)' && early.inline === '', JSON.stringify(early));
      release();
      await page.waitForLoadState('load');
      await sleep(2500);
      const settled = await colours(reader, await page.screenshot(), SPOTS);
      const view = await page.evaluate(() => ({
        meta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') || '',
        dir: document.documentElement.dir, lang: document.documentElement.lang,
        html: getComputedStyle(document.documentElement).backgroundColor,
      }));
      check(`${scheme}, ${visitor.name}: the first screen is dark at every corner and side`, settled.every((c) => luma(c) < 70), JSON.stringify(settled.map((c, i) => `${NAMES[i]} ${c.join(',')}`)));
      check(`${scheme}, ${visitor.name}: and it is one colour, top to bottom`, Math.max(...settled.map(luma)) - Math.min(...settled.map(luma)) < 14, JSON.stringify(settled));
      check(`${scheme}, ${visitor.name}: the browser's bar (theme-color) is that dark`, /^#0f172a$/i.test(view.meta), view.meta);
      if (visitor.saved.poorija_lang) {
        const want = visitor.saved.poorija_lang === 'fa' ? 'rtl' : 'ltr';
        check(`${scheme}, ${visitor.name}: the text runs the way the saved language does (${want})`, view.dir === want && view.lang === visitor.saved.poorija_lang, JSON.stringify(view));
      }
      /* The screen must not be cut off at the top: its first line can be reached. */
      const top = await page.evaluate(() => {
        const gate = document.querySelector('#mobileInstallGate:not(.hidden), #langScreen:not(.hidden), #lockScreen:not(.hidden)');
        if (!gate) return { gate: false };
        const first = gate.querySelector('img, h1, .install-gate-card') || gate.firstElementChild;
        gate.scrollTop = 0;
        return { gate: gate.id, firstTop: Math.round(first?.getBoundingClientRect().top ?? 0), scroll: gate.scrollTop };
      });
      check(`${scheme}, ${visitor.name}: the top of the screen is reachable, not cut off above the window`, !top.gate || top.firstTop >= -1, JSON.stringify(top));
      await context.close();
    }
  }

  console.log('\n===== the installed app =====');
  const manifest = await (await fetch(`${stacks.a.url}/manifest.webmanifest`)).json();
  check('the manifest starts the installed app on the dark, not on white', /^#0f172a$/i.test(manifest.background_color) && /^#0f172a$/i.test(manifest.theme_color), `${manifest.background_color} ${manifest.theme_color}`);
} catch (error) {
  check('the suite ran to the end', false, error?.stack || String(error));
} finally {
  await browser.close().catch(() => {});
  await stacks.stop?.();
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n===== ${failed} failed of ${results.length} =====`);
process.exit(failed ? 1 : 0);
