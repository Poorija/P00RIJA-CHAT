/* Screenshots of the unlocked app at a desktop and a phone size, for looking
   at a layout change. A diagnostic, not a suite.
     node tests/e2e/_shots.mjs <output-dir> */
import { openApp, browser } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
const out = process.argv[2] || 'tests/e2e/screenshots';
const stacks = await startTwoStacks();
try {
  const desk = await openApp('DESK', { origin: stacks.a.url, relay: stacks.a.url });
  await desk.waitForTimeout(800);
  await desk.screenshot({ path: `${out}/desktop.png` });
  console.log('desk ' + JSON.stringify(await desk.evaluate(() => {
    const bar = document.getElementById('mobileTabBar'); const cs = getComputedStyle(bar); const r = bar.getBoundingClientRect();
    return { cls: document.documentElement.className.split(/\s+/).filter((c) => /msgr|tabbar|chat-|mobile/.test(c)), display: cs.display, visibility: cs.visibility, opacity: cs.opacity, height: cs.height, z: cs.zIndex, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], tabbarH: getComputedStyle(document.documentElement).getPropertyValue('--tabbar-h'), children: bar.children.length, vh: innerHeight };
  })));
  const phone = await openApp('PHONE', { origin: stacks.a.url, relay: stacks.a.url,
    context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } });
  await phone.waitForTimeout(800);
  await phone.screenshot({ path: `${out}/phone.png` });
  await phone.evaluate(() => window.switchLanguage());
  await phone.waitForTimeout(700);
  await phone.screenshot({ path: `${out}/phone-fa.png` });
  await phone.evaluate(() => window.PoorijaMessenger.go('settings'));
  await phone.waitForTimeout(500);
  await phone.screenshot({ path: `${out}/phone-settings.png` });
  await phone.evaluate(() => window.PoorijaMessenger.openProfile());
  await phone.waitForTimeout(500);
  await phone.screenshot({ path: `${out}/phone-profile.png` });
  const info = await phone.evaluate(() => ({
    html: document.documentElement.className.split(/\s+/).filter((c) => /mobile|pwa|sidebar/.test(c)),
    bar: getComputedStyle(document.getElementById('mobileTabBar')).display,
    header: Math.round(document.getElementById('appHeader').getBoundingClientRect().height),
  }));
  console.log(JSON.stringify(info));
} finally { await browser.close(); await stacks.stop(); }
