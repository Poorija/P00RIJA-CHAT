/* The element tree of one Settings page, classes only. A diagnostic.
     node tests/e2e/_dump-page.mjs data */
import { openApp, browser } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
const id = process.argv[2] || 'data';
const stacks = await startTwoStacks();
try {
  const A = await openApp('A', { origin: stacks.a.url, relay: stacks.a.url, context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } });
  await A.evaluate((p) => { window.PoorijaMessenger.go('settings'); window.PoorijaSettingsPages.reset(); window.PoorijaSettingsPages.open(p); }, id);
  await A.waitForTimeout(800);
  const tree = await A.evaluate((p) => {
    const lines = [];
    const walk = (el, d) => {
      if (d > 7) return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none') return;
      const text = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(' ').slice(0, 34);
      lines.push(`${'  '.repeat(d)}${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 4).join('.') : ''}${text ? ' "' + text + '"' : ''}`);
      for (const c of el.children) walk(c, d + 1);
    };
    walk(document.querySelector(`[data-msgr-page="${p}"]`), 0);
    return lines.slice(0, 90).join('\n');
  }, id);
  console.log(tree);
} finally { await browser.close(); await stacks.stop(); }
