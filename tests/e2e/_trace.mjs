/* Prints the stack of every script error raised while setting the app up and
   walking its tabs. A diagnostic, not a suite: the leading underscore keeps
   run-all.mjs from picking it up.
     PKG_URL=http://localhost:8124 node tests/e2e/_trace.mjs */
import { chromium } from 'playwright';
const BASE = process.env.PKG_URL || 'http://localhost:8123';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
await ctx.addInitScript(() => { try { localStorage.setItem('poorija_lang', 'en'); delete Navigator.prototype.serviceWorker; } catch (e) {} });
const page = await ctx.newPage();
page.on('dialog', (d) => d.accept());
const seen = new Set();
page.on('pageerror', (e) => {
  const where = (e.stack || '').split('\n').slice(0, 5).map((l) => l.trim().replace(BASE, '')).join('\n      ');
  if (seen.has(where)) return; seen.add(where);
  console.log('  ERROR ' + where);
});
await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
await page.waitForTimeout(2000);
await page.evaluate(() => {
  const set = (id, v) => { const el = document.getElementById(id); if (!el) return; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
  set('setupPassword', 'Transfer#Harness2026!'); set('confirmPassword', 'Transfer#Harness2026!');
  document.querySelectorAll('#initialSetup select').forEach((s, i) => { if (s.options.length > i + 1) { s.selectedIndex = i + 1; s.dispatchEvent(new Event('change', { bubbles: true })); } });
  document.querySelectorAll('#initialSetup input[type="text"]').forEach((inp, i) => { inp.value = 'answer' + i; inp.dispatchEvent(new Event('input', { bubbles: true })); });
  const cb = document.getElementById('acceptTermsCheckbox'); if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
});
await page.waitForTimeout(400);
await page.evaluate(() => document.getElementById('setupBtn')?.click());
await page.waitForTimeout(9000);
const state = await page.evaluate(() => ({ locked: window.PoorijaApp?.state?.isLocked, tab: window.PoorijaApp?.state?.activeTab }));
console.log('  after setup ' + JSON.stringify(state));
for (const tab of ['chat', 'locallink', 'vault', 'securitycenter', 'migration', 'settings', 'help', 'about', 'chat']) {
  await page.evaluate((id) => window.switchTab(id), tab).catch((e) => console.log('  switchTab ' + tab + ' threw ' + e.message.slice(0, 120)));
  await page.waitForTimeout(400);
}
await page.evaluate(() => window.switchLanguage?.()); await page.waitForTimeout(700);
await page.evaluate(() => window.switchLanguage?.()); await page.waitForTimeout(700);
await page.evaluate(() => window.lockApp?.()); await page.waitForTimeout(700);
console.log(`  ${seen.size} distinct error(s)`);
await browser.close();
