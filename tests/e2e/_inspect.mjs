/* Computed style of elements in the live app, for working out which rule is in
   the way. A diagnostic, not a suite.
     node tests/e2e/_inspect.mjs <width> <selector> [<selector> ...]
   Set PSEUDO=::after to read a pseudo-element, CONV=1 to open a conversation. */
import { openApp, identity, importIdentity, browser } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
const width = Number(process.argv[2] || 390);
const selectors = process.argv.slice(3);
const decode = (card) => JSON.parse(Buffer.from(card.replace('poorija-chat-v1:', ''), 'base64').toString('utf8'));
const stacks = await startTwoStacks();
try {
  const mobile = width < 700 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {};
  const A = await openApp('A', { origin: stacks.a.url, relay: stacks.a.url, context: { viewport: { width, height: 860 }, ...mobile } });
  const B = await openApp('B', { origin: stacks.a.url, relay: stacks.a.url });
  const cA = await identity(A), cB = await identity(B);
  await importIdentity(A, cB); await importIdentity(B, cA);
  await A.evaluate((FA) => { const want = FA ? 'fa' : 'en'; if (PoorijaApp.state.language !== want) window.switchLanguage(); document.documentElement.dir = FA ? 'rtl' : 'ltr'; }, Boolean(process.env.FA));
  if (process.env.CONV) {
    await A.evaluate(async (k) => { const p = findPeerByAnyKey(k); chatState.activeConversationId = getConversationKey(p); chatState.activePeerClientId = p.clientId || ''; renderPeers(); renderActivePeer(); renderMessages(); }, decode(cB).fingerprint);
    await A.evaluate(() => { const b = document.getElementById('chatComposer'); b.value = 'hello there'; b.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('chatSendMessageBtn').click(); });
  }
  if (process.env.GO) await A.evaluate((g) => window.PoorijaMessenger.go(g), process.env.GO);
  await A.waitForTimeout(1500);
  const props = ['left', 'right', 'insetInlineEnd', 'direction', 'display', 'position', 'width', 'height', 'minHeight', 'maxHeight', 'padding', 'margin', 'border', 'borderRadius', 'background', 'boxShadow', 'transform', 'overflow', 'flexDirection', 'gridTemplateColumns', 'color', 'fontSize', 'content'];
  for (const sel of selectors) {
    const out = await A.evaluate(({ sel, props, pseudo }) => {
      const el = document.querySelector(sel); if (!el) return 'NOT FOUND';
      const c = getComputedStyle(el, pseudo || null); const b = el.getBoundingClientRect();
      const r = { rect: `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`, cls: el.className.toString().slice(0, 100) };
      for (const p of props) { const v = c[p]; if (v && v !== 'none' && v !== 'normal' && v !== '0px' && v !== 'auto') r[p] = String(v).slice(0, 110); }
      return r;
    }, { sel, props, pseudo: process.env.PSEUDO });
    if (process.env.HTML) console.log(sel, await A.evaluate(({ q, max }) => document.querySelector(q)?.outerHTML.replace(/\s+/g, ' ').replace(/<svg.*?<\/svg>/g, '').slice(0, max), { q: sel, max: Number(process.env.HTMLMAX || 2600) }));
    else console.log(sel, JSON.stringify(out, null, 1));
  }
} finally { await browser.close(); await stacks.stop(); }
