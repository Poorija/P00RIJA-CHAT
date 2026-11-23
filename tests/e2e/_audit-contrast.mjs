/* Text that cannot be read: walks every visible piece of text in the main
   screens and sheets, works out the colour it sits on, and lists the ones under
   a 3:1 ratio (4.5 for body text is the guideline; 3 catches what is plainly
   wrong). A diagnostic, not a suite.
     SCHEME=light LANG_FA=1 node tests/e2e/_audit-contrast.mjs */
import { openApp, identity, importIdentity, browser } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
const scheme = process.env.SCHEME || 'light';
const lang = process.env.LANG_FA ? 'fa' : 'en';
const decode = (card) => JSON.parse(Buffer.from(card.replace('poorija-chat-v1:', ''), 'base64').toString('utf8'));
const stacks = await startTwoStacks();
const scan = () => {
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const over = (top, under) => { const a = top.a + under.a * (1 - top.a); if (!a) return { r: 0, g: 0, b: 0, a: 0 }; return { r: (top.r * top.a + under.r * under.a * (1 - top.a)) / a, g: (top.g * top.a + under.g * under.a * (1 - top.a)) / a, b: (top.b * top.a + under.b * under.a * (1 - top.a)) / a, a }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const bgOf = (el) => {
    let layers = []; let n = el;
    while (n && n.nodeType === 1) { const cs = getComputedStyle(n); const c = parse(cs.backgroundColor); if (cs.backgroundImage && cs.backgroundImage !== 'none') return null; if (c && c.a > 0) { layers.push(c); if (c.a >= 0.99) break; } n = n.parentElement; }
    let base = { r: 255, g: 255, b: 255, a: 1 }; for (const l of layers.reverse()) base = over(l, base); return base;
  };
  const out = []; const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (['SCRIPT', 'STYLE', 'OPTION', 'SVG', 'PATH', 'I'].includes(el.tagName)) continue;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(' ');
    if (!own) continue;
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0 || r.width < 2 || r.height < 2) continue;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    let anc = el, hidden = false; while (anc) { const s = getComputedStyle(anc); if (s.display === 'none' || s.visibility === 'hidden' || (anc.hidden)) { hidden = true; break; } anc = anc.parentElement; } if (hidden) continue;
    const fg0 = parse(cs.color); const bg = bgOf(el); if (!fg0 || !bg) continue;
    let opacity = 1; let a2 = el; while (a2) { opacity *= +getComputedStyle(a2).opacity; a2 = a2.parentElement; }
    const fg = over({ ...fg0, a: fg0.a * opacity }, bg);
    const L1 = lum(fg), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    if (ratio < 3) { const key = `${el.tagName}.${String(el.className).slice(0, 40)}|${own.slice(0, 20)}`; if (!seen.has(key)) { seen.add(key); out.push(`${ratio.toFixed(2)}  ${el.tagName}.${String(el.className).trim().slice(0, 50)}  "${own.slice(0, 28)}"  parent=${String(el.parentElement?.className).trim().slice(0, 40)} fg=${cs.color} bg=rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`); } }
  }
  return out;
};
try {
  const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
  const A = await openApp('SARA', { origin: stacks.a.url, relay: stacks.a.url, context: phone });
  const B = await openApp('OMID', { origin: stacks.a.url, relay: stacks.a.url });
  for (const pg of [A, B]) await pg.evaluate(([l, s]) => { if (PoorijaApp.state.language !== l) window.switchLanguage(); document.documentElement.lang = l; document.documentElement.dir = l === 'fa' ? 'rtl' : 'ltr'; try { setTheme(s); } catch (e) {} }, [lang, scheme]);
  const cA = await identity(A); const cB = await identity(B);
  await importIdentity(A, cB); await importIdentity(B, cA);
  await A.emulateMedia({ colorScheme: scheme });
  await A.evaluate((s) => { try { setTheme(s); } catch (e) {} }, scheme);
  const report = async (name) => { await A.waitForTimeout(500); const rows = await A.evaluate(scan); console.log(`\n== ${name}: ${rows.length}`); rows.slice(0, 14).forEach((r) => console.log('  ' + r)); };
  const open = () => A.evaluate(async (k) => { const p = findPeerByAnyKey(k); chatState.activeConversationId = getConversationKey(p); chatState.activePeerClientId = p.clientId || ''; renderPeers(); renderActivePeer(); renderMessages(); }, decode(cB).fingerprint);
  await open();
  await A.evaluate(() => { const b = document.getElementById('chatComposer'); b.value = 'See you at six'; b.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('chatSendMessageBtn').click(); });
  await A.waitForTimeout(1500);
  await report('thread');
  await A.evaluate(() => document.getElementById('chatThreadMenuBtn').click()); await report('thread menu'); await A.evaluate(() => document.getElementById('chatThreadMenuBtn').click());
  await A.evaluate(() => document.getElementById('chatComposerPlusBtn').click()); await report('plus menu');
  await A.evaluate(() => document.getElementById('chatStickerBtn').click()); await report('stickers'); await A.evaluate(() => { document.getElementById('chatStickerBtn')?.click(); document.getElementById('chatComposerPlusBtn')?.click(); });
  await A.evaluate(() => { chatState.activeConversationId = ''; chatState.activePeerClientId = ''; renderActivePeer(); renderMessages(); updateChatShellMode(); });
  for (const tab of ['chats', 'calls', 'groups', 'local']) { await A.evaluate((t) => window.PoorijaMessenger.go(t), tab); await report('tab ' + tab); }
  for (const pg of ['root', 'me', 'privacy', 'appearance', 'language', 'notifications', 'data', 'connection', 'devices', 'password']) {
    await A.evaluate((id) => { window.PoorijaMessenger.go('settings'); window.PoorijaSettingsPages.reset(); if (id !== 'root') window.PoorijaSettingsPages.open(id); }, pg);
    await report('page ' + pg);
  }
  for (const row of ['help', 'about']) { await A.evaluate((r) => { window.PoorijaMessenger.go('settings'); window.PoorijaSettingsPages.reset(); window.PoorijaMessenger.openRow(r); }, row); await report('row ' + row); }
} finally { await browser.close(); await stacks.stop(); }
