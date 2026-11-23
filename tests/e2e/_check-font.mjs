/* Does the font setting reach the screen? Sets the Persian and the English
   font and the size the way the Appearance page does and reads what is drawn.
   A diagnostic, not a suite.   node tests/e2e/_check-font.mjs */
import { openApp, identity, importIdentity, browser } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
const decode = (card) => JSON.parse(Buffer.from(card.replace('poorija-chat-v1:', ''), 'base64').toString('utf8'));
const stacks = await startTwoStacks();
try {
  const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
  const A = await openApp('A', { origin: stacks.a.url, relay: stacks.a.url, context: phone });
  const B = await openApp('B', { origin: stacks.a.url, relay: stacks.a.url });
  const cA = await identity(A), cB = await identity(B);
  await importIdentity(A, cB); await importIdentity(B, cA);
  await A.evaluate(async (k) => { const p = findPeerByAnyKey(k); chatState.activeConversationId = getConversationKey(p); chatState.activePeerClientId = p.clientId || ''; renderPeers(); renderActivePeer(); renderMessages(); const b = document.getElementById('chatComposer'); b.value = 'hello there'; b.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('chatSendMessageBtn').click(); }, decode(cB).fingerprint);
  await A.waitForTimeout(1500);
  const options = await A.evaluate(() => ({ fa: [...document.querySelectorAll('#settingFontFa option')].map((o) => o.value), en: [...document.querySelectorAll('#settingFontEn option')].map((o) => o.value), size: [...document.querySelectorAll('#settingFontSize option')].map((o) => o.value) }));
  console.log('options', JSON.stringify(options));
  const probe = async (label) => {
    const r = await A.evaluate(() => {
      const fam = (el) => el ? getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim() : null;
      const size = (el) => el ? getComputedStyle(el).fontSize : null;
      const bad = [];
      for (const el of document.querySelectorAll('body *')) {
        if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
        if (!(el.textContent || '').trim() || el.children.length) continue;
        const f = fam(el); const body = fam(document.body);
        if (f !== body && !/Font Awesome|Awesome|monospace|ui-monospace|Menlo|Consolas|SF Mono/i.test(getComputedStyle(el).fontFamily) && !/^(I|SVG)$/.test(el.tagName)) bad.push(`${el.tagName}.${String(el.className).slice(0, 30)}=${f}`);
      }
      return { body: fam(document.body), bodySize: size(document.body), bubble: fam(document.querySelector('.chat-message-text')), bubbleSize: size(document.querySelector('.chat-message-text')), composer: fam(document.getElementById('chatComposer')), tab: fam(document.querySelector('.msgr-tab')), bad: [...new Set(bad)].slice(0, 12) };
    });
    console.log(label, JSON.stringify(r));
  };
  await probe('default ');
  for (const [fa, en, sz] of [["'Vazirmatn', sans-serif", "'Inter', sans-serif", '16px'], [options.fa[1] || options.fa[0], options.en[1] || options.en[0], options.size[options.size.length - 1]]]) {
    await A.evaluate(({ fa, en, sz }) => { document.getElementById('settingFontFa').value = fa; document.getElementById('settingFontEn').value = en; document.getElementById('settingFontSize').value = sz; applyAppearanceSettings(); }, { fa, en, sz });
    await A.waitForTimeout(400);
    await probe(`set ${en.split(',')[0]} / ${sz}`);
  }
  for (const tab of ['chats', 'calls', 'groups', 'settings']) {
    await A.evaluate((t) => window.PoorijaMessenger.go(t), tab); await A.waitForTimeout(400);
    await probe(`tab ${tab}`);
  }
} finally { await browser.close(); await stacks.stop(); }
