/* The screens before the app: language, first password, lock. A diagnostic.
     node tests/e2e/_shots-gate.mjs <output-dir> [tag] */
import fs from 'node:fs';
import { browser } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
const out = process.argv[2] || 'tests/e2e/screenshots';
const tag = process.argv[3] || 'gate';
fs.mkdirSync(out, { recursive: true });
const stacks = await startTwoStacks();
try {
  for (const scheme of ['dark', 'light']) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: scheme });
    await ctx.addInitScript(() => { try { delete Navigator.prototype.serviceWorker; localStorage.setItem('poorija_theme', 'DARKLIGHT'); } catch (e) {} });
    const page = await ctx.newPage();
    await page.addInitScript((s) => { try { localStorage.setItem('poorija_theme', s); } catch (e) {} }, scheme);
    await page.goto(stacks.a.url + '/index.html', { waitUntil: 'load' });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${out}/${tag}-${scheme}-1-language.png` });
    await page.evaluate(() => window.selectLanguage?.('fa'));
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${out}/${tag}-${scheme}-2-setup.png` });
    await page.evaluate(() => window.scrollTo(0, 0));
    console.log(scheme, 'done');
    await ctx.close();
  }
} finally { await browser.close(); await stacks.stop(); }
