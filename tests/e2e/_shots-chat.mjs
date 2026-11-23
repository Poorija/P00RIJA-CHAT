/* Screenshots of the messenger with real conversations in it, phone and
   desktop, light and dark. A diagnostic, not a suite.
     node tests/e2e/_shots-chat.mjs <output-dir> [tag] */
import fs from 'node:fs';
import { openApp, identity, importIdentity, browser, waitFor } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
const out = process.argv[2] || 'tests/e2e/screenshots';
const tag = process.argv[3] || 'now';
fs.mkdirSync(out, { recursive: true });
const decode = (card) => JSON.parse(Buffer.from(card.replace('poorija-chat-v1:', ''), 'base64').toString('utf8'));
const say = (page, text) => page.evaluate((value) => {
  const box = document.getElementById('chatComposer'); box.value = value;
  box.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('chatSendMessageBtn').click();
}, text);
const stacks = await startTwoStacks();
try {
  const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
  const SARA = await openApp('SARA', { origin: stacks.a.url, relay: stacks.a.url, context: phone });
  const OMID = await openApp('OMID', { origin: stacks.a.url, relay: stacks.a.url });
  const DESK = await openApp('DESK', { origin: stacks.a.url, relay: stacks.a.url });
  const lang = process.env.LANG_FA ? 'fa' : 'en';
  for (const pg of [SARA, OMID, DESK]) await pg.evaluate((l) => { if (PoorijaApp.state.language !== l) window.switchLanguage(); document.documentElement.lang = l; document.documentElement.dir = l === 'fa' ? 'rtl' : 'ltr'; }, lang);
  const cards = { SARA: await identity(SARA), OMID: await identity(OMID), DESK: await identity(DESK) };
  await importIdentity(SARA, cards.OMID); await importIdentity(OMID, cards.SARA);
  await importIdentity(DESK, cards.OMID); await importIdentity(OMID, cards.DESK);
  const open = (page, fp) => page.evaluate(async (key) => { const p = findPeerByAnyKey(key); chatState.activeConversationId = getConversationKey(p); chatState.activePeerClientId = p.clientId || ''; renderPeers(); renderActivePeer(); renderMessages(); await new Promise((r) => setTimeout(r, 400)); }, fp);
  await open(OMID, decode(cards.SARA).fingerprint);
  for (const t of ['Hey, are you free for a call later?', 'Sure — after 6 works. Bring the notes from yesterday?', 'Done. Sending the file now.', 'ok 👍']) { await say(OMID, t); await OMID.waitForTimeout(500); }
  await SARA.waitForTimeout(2500);
  await open(SARA, decode(cards.OMID).fingerprint);
  await say(SARA, 'Perfect, talk soon!'); await SARA.waitForTimeout(1500);
  await open(DESK, decode(cards.OMID).fingerprint);
  await say(DESK, 'Desktop view hello'); await DESK.waitForTimeout(1500);
  for (const scheme of ['light', 'dark']) {
    for (const [name, page] of [['phone', SARA], ['desk', DESK]]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.evaluate((s) => { try { setTheme(s); } catch (e) {} }, scheme);
      await page.waitForTimeout(500);
      // list (phone shows the list when no conversation is open)
      if (name === 'phone') {
        await page.evaluate(() => { chatState.activeConversationId = ''; chatState.activePeerClientId = ''; renderActivePeer(); renderMessages(); updateChatShellMode?.(); });
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${out}/${tag}-${name}-${scheme}-list.png` });
        await open(page, decode(cards.OMID).fingerprint);
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${out}/${tag}-${name}-${scheme}-thread.png` });
      } else {
        await page.screenshot({ path: `${out}/${tag}-${name}-${scheme}-thread.png` });
      }
    }
  }
  for (const section of ['calls', 'groups', 'settings']) {
    await SARA.evaluate((s) => window.PoorijaMessenger.go(s), section);
    await SARA.waitForTimeout(600);
    await SARA.screenshot({ path: `${out}/${tag}-phone-dark-${section}.png` });
  }
  console.log('errors', JSON.stringify([...SARA.__errors, ...OMID.__errors, ...DESK.__errors].slice(0, 5)));
} finally { await browser.close(); await stacks.stop(); }
