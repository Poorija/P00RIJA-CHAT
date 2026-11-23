/* Screenshots of the states around the main screens: menus, dialogs, the
   group maker, search, profile, connection settings, Local, a call.
   A diagnostic, not a suite.
     node tests/e2e/_shots-states.mjs <output-dir> [tag]            (English, dark)
     SCHEME=light LANG_FA=1 node tests/e2e/_shots-states.mjs <dir> x  */
import fs from 'node:fs';
import { openApp, identity, importIdentity, browser } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
const out = process.argv[2] || 'tests/e2e/screenshots';
const tag = process.argv[3] || 'state';
const scheme = process.env.SCHEME || 'dark';
const lang = process.env.LANG_FA ? 'fa' : 'en';
fs.mkdirSync(out, { recursive: true });
const decode = (card) => JSON.parse(Buffer.from(card.replace('poorija-chat-v1:', ''), 'base64').toString('utf8'));
const stacks = await startTwoStacks();
try {
  const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
  const A = await openApp('SARA', { origin: stacks.a.url, relay: stacks.a.url, context: phone });
  const B = await openApp('OMID', { origin: stacks.a.url, relay: stacks.a.url });
  for (const pg of [A, B]) await pg.evaluate(([l, s]) => { if (PoorijaApp.state.language !== l) window.switchLanguage(); document.documentElement.lang = l; document.documentElement.dir = l === 'fa' ? 'rtl' : 'ltr'; try { setTheme(s); } catch (e) { /* */ } }, [lang, scheme]);
  const cA = await identity(A); const cB = await identity(B);
  await importIdentity(A, cB); await importIdentity(B, cA);
  await A.emulateMedia({ colorScheme: scheme });
  const open = async () => A.evaluate(async (k) => { const p = findPeerByAnyKey(k); chatState.activeConversationId = getConversationKey(p); chatState.activePeerClientId = p.clientId || ''; renderPeers(); renderActivePeer(); renderMessages(); await new Promise((r) => setTimeout(r, 400)); }, decode(cB).fingerprint);
  const shot = async (name) => { await A.waitForTimeout(500); await A.screenshot({ path: `${out}/${tag}-${name}.png` }); console.log('shot', name); };
  const only = (process.env.ONLY || '').split(',').filter(Boolean);
  const tryStep = async (name, fn) => { if (only.length && !only.includes(name)) return; try { await fn(); } catch (e) { console.log('step failed', name, String(e.message || e).slice(0, 120)); } };

  await open();
  await A.evaluate(() => { const b = document.getElementById('chatComposer'); b.value = 'See you at six'; b.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('chatSendMessageBtn').click(); });
  await A.waitForTimeout(1200);

  await tryStep('thread menu', async () => { await A.evaluate(() => document.getElementById('chatThreadMenuBtn').click()); await shot('thread-menu'); await A.evaluate(() => document.getElementById('chatThreadMenuBtn').click()); });
  await tryStep('plus menu', async () => { await A.evaluate(() => document.getElementById('chatComposerPlusBtn').click()); await shot('plus-menu'); await A.evaluate(() => document.getElementById('chatComposerPlusBtn').click()); });
  await tryStep('sticker panel', async () => { await A.evaluate(() => { document.getElementById('chatComposerPlusBtn').click(); document.getElementById('chatStickerBtn').click(); }); await shot('stickers'); await A.evaluate(() => document.getElementById('chatStickerCloseBtn')?.click()); });
  await tryStep('typing', async () => { await A.evaluate(() => { const b = document.getElementById('chatComposer'); b.value = 'a long draft message to see the send button and wrapping behaviour of the field'; b.dispatchEvent(new Event('input', { bubbles: true })); }); await shot('typing'); await A.evaluate(() => { const b = document.getElementById('chatComposer'); b.value = ''; b.dispatchEvent(new Event('input', { bubbles: true })); }); });
  await tryStep('message actions', async () => { await A.evaluate(() => document.querySelector('#chatMessages .chat-message-bubble.me')?.click()); await shot('message-selected'); });

  await tryStep('call', async () => {
    await B.evaluate(async (k) => { const p = findPeerByAnyKey(k); chatState.activeConversationId = getConversationKey(p); chatState.activePeerClientId = p.clientId || ''; renderPeers(); renderActivePeer(); renderMessages(); }, decode(cA).fingerprint);
    await A.evaluate(() => document.getElementById('chatVideoCallBtn').click());
    await B.waitForTimeout(3500);
    await B.screenshot({ path: `${out}/${tag}-call-ring-desk.png` });
    await B.evaluate(() => (document.getElementById('chatAcceptCallBtn') || document.getElementById('chatModalAcceptBtn'))?.click());
    await A.waitForTimeout(4000);
    await A.mouse.click(195, 420);
    await A.waitForTimeout(600);
    await shot('call');
    await B.screenshot({ path: `${out}/${tag}-call-desk.png` });
    await A.evaluate(() => document.getElementById('chatFloatingEndCallBtn')?.click());
    await A.waitForTimeout(800);
  });
  await A.evaluate(() => { chatState.activeConversationId = ''; chatState.activePeerClientId = ''; renderActivePeer(); renderMessages(); updateChatShellMode(); });
  await A.waitForTimeout(400);
  await tryStep('row menu', async () => { await A.evaluate(() => { window.PoorijaMessenger.go('chats'); }); await A.waitForTimeout(500); await A.evaluate(() => { const r = document.querySelector('#chatPeerList .ui-row').getBoundingClientRect(); document.querySelector('#chatPeerList .ui-row').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 120, clientY: r.top + 30 })); }); await shot('row-menu'); await A.keyboard.press('Escape'); });
  await tryStep('head menu', async () => { await A.evaluate(() => document.getElementById('uiHeadMore').click()); await shot('head-menu'); await A.keyboard.press('Escape'); });
  await tryStep('new chat', async () => { await A.evaluate(() => document.getElementById('uiHeadNew').click()); await shot('new-chat'); await A.evaluate(() => document.querySelector('#chatStartChatModal [data-chat-modal-close]')?.click()); });
  await tryStep('search', async () => { await A.evaluate(() => document.getElementById('uiHeadSearch').click()); await shot('search'); await A.evaluate(() => document.querySelector('.chat-fsearch-close')?.click()); await A.keyboard.press('Escape'); });
  await tryStep('group maker', async () => { await A.evaluate(() => { window.PoorijaMessenger.go('groups'); }); await A.waitForTimeout(300); await A.evaluate(() => document.getElementById('uiHeadNew').click()); await shot('group-maker'); await A.evaluate(() => document.querySelector('[data-group-maker-close]')?.click()); await A.evaluate(() => document.querySelector('#chatStartChatModal [data-chat-modal-close]')?.click()); });
  for (const pg of ['root', 'me', 'privacy', 'appearance', 'language', 'notifications', 'data', 'connection', 'devices', 'password']) {
    await tryStep('page-' + pg, async () => {
      await A.evaluate((id) => { window.PoorijaMessenger.go('settings'); window.PoorijaSettingsPages.reset(); if (id !== 'root') window.PoorijaSettingsPages.open(id); }, pg);
      await shot('page-' + pg);
    });
  }
  await tryStep('profile', async () => { await A.evaluate(() => { window.PoorijaMessenger.go('settings'); window.PoorijaMessenger.openProfile(); }); await shot('profile'); });
  await tryStep('connection', async () => { await A.evaluate(() => { window.PoorijaMessenger.go('settings'); window.PoorijaMessenger.openRow('connection'); }); await shot('connection'); });
  await tryStep('local', async () => { await A.evaluate(() => window.PoorijaMessenger.go('local')); await shot('local'); });
  await tryStep('help', async () => { await A.evaluate(() => { window.PoorijaMessenger.go('settings'); window.PoorijaMessenger.openRow('help'); }); await shot('help'); });
  await tryStep('about', async () => { await A.evaluate(() => { window.PoorijaMessenger.go('settings'); window.PoorijaMessenger.openRow('about'); }); await shot('about'); });
  await tryStep('security', async () => { await A.evaluate(() => { window.PoorijaMessenger.go('settings'); window.PoorijaMessenger.openRow('securitycenter'); }); await shot('security'); });
  await tryStep('dialog', async () => { await A.evaluate(() => { window.PoorijaMessenger.go('chats'); window.PoorijaDialogs.confirm('Delete this conversation? This cannot be undone.', { title: 'Delete conversation', danger: true }); }); await shot('dialog'); await A.keyboard.press('Escape'); });
  await tryStep('toast', async () => { await A.evaluate(() => { notify('Message copied', 'success'); }); await shot('toast'); });
  console.log('errors', JSON.stringify(A.__errors.slice(0, 4)));
} finally { await browser.close(); await stacks.stop(); }
