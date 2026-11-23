/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* The six things found by using 2.15 on phones, kept fixed:
 *
 *   1. a call that arrives by peer is logged "via peer" in the conversation and
 *      in the call log, and an id no contact holds does not become a
 *      conversation of its own in the chat list;
 *   2. the pop-up menus of a call are one arrangement — equal tiles, nothing
 *      cut off, one open at a time;
 *   3. Settings shows the live state, opens a page at its top and gives back the
 *      place you were when you return;
 *   4. the system back and forward walk the app's screens instead of leaving;
 *   5. a burst of messages from one conversation is one toast that counts.
 *
 *   node tests/e2e/_local-stack.mjs navfixes
 */
import { openApp, identity, importIdentity, browser } from './_chat-harness.mjs';
import { createChecks } from './_check.mjs';

const { results, check } = createChecks({ entry: (n, ok, d) => ({ n, ok, d }) });
const decode = (card) => JSON.parse(Buffer.from(card.replace('poorija-chat-v1:', ''), 'base64').toString('utf8'));

const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const A = await openApp('SARA', { context: phone });
const B = await openApp('OMID');
const C = await openApp('REZA');
const cards = { A: await identity(A), B: await identity(B), C: await identity(C) };
await importIdentity(A, cards.B); await importIdentity(B, cards.A);
await importIdentity(A, cards.C); await importIdentity(C, cards.A);
await A.waitForTimeout(3000);
const fpB = decode(cards.B).fingerprint;

const openChat = (page, fp) => page.evaluate(async (key) => {
  const p = findPeerByAnyKey(key);
  chatState.activeConversationId = getConversationKey(p);
  chatState.activePeerClientId = p.clientId || '';
  setChatView('chats'); renderPeers(); renderActivePeer(); renderMessages();
  await new Promise((r) => setTimeout(r, 500));
}, fp);

/* ------------------------------------------------------------ 1. a peer call */
console.log('\n===== a call by peer =====');
await openChat(A, fpB);
await A.evaluate(() => document.getElementById('chatThreadMenuBtn')?.click());
await A.waitForTimeout(400);
await A.evaluate(() => document.getElementById('chatVoiceCallBtn')?.click());
for (let i = 0; i < 20; i += 1) {
  const done = await B.evaluate(() => {
    const v = (e) => e && !e.classList.contains('hidden') && e.offsetParent !== null;
    const a = document.getElementById('chatAcceptCallBtn'); const m = document.getElementById('chatModalAcceptBtn');
    if (v(a)) { a.click(); return 1; } if (v(m)) { m.click(); return 1; } return 0;
  });
  if (done) break;
  await B.waitForTimeout(500);
}
await A.waitForTimeout(4500);
check('the call is up', await A.evaluate(() => Boolean(chatState.currentCall && chatState.currentCallAnsweredAt)));

/* ------------------------------------------------------ 2. the call's menus */
console.log('\n===== the menus of a call =====');
await A.evaluate(() => document.getElementById('chatCallMoreBtn')?.click());
await A.waitForTimeout(500);
const more = await A.evaluate(() => {
  const sheet = document.getElementById('chatCallMoreSheet');
  const sr = sheet.getBoundingClientRect();
  const tiles = [...sheet.querySelectorAll('.chat-call-control')].filter((t) => t.offsetParent);
  return {
    vw: innerWidth, sheetLeft: sr.left, sheetRight: sr.right, sheetWidth: sr.width,
    tiles: tiles.map((t) => {
      const r = t.getBoundingClientRect(); const s = t.querySelector('span');
      return { w: r.width, h: r.height, left: r.left, right: r.right, radius: getComputedStyle(t).borderRadius, clipped: s ? s.scrollWidth - s.clientWidth : 0, label: s?.textContent || '' };
    }),
  };
});
check('the extras menu shows its tiles', more.tiles.length >= 4, `${more.tiles.length} tiles`);
check('every tile is the same width', Math.max(...more.tiles.map((t) => t.w)) - Math.min(...more.tiles.map((t) => t.w)) < 2, more.tiles.map((t) => Math.round(t.w)).join(','));
check('no tile is a circle (the labels were cut off by one)', more.tiles.every((t) => !/50%/.test(t.radius)), more.tiles.map((t) => t.radius).join(' '));
check('no label is cut off', more.tiles.every((t) => t.clipped <= 1), more.tiles.filter((t) => t.clipped > 1).map((t) => t.label).join(', '));
check('every tile is inside the menu', more.tiles.every((t) => t.left >= more.sheetLeft - 1 && t.right <= more.sheetRight + 1));
check('the menu fits the screen with a margin', more.sheetWidth <= more.vw - 16 && more.sheetWidth >= 280, `${Math.round(more.sheetWidth)} of ${more.vw}`);
check('tiles are big enough to press', more.tiles.every((t) => t.h >= 60), more.tiles.map((t) => Math.round(t.h)).join(','));
await A.evaluate(() => document.getElementById('chatCallReactBtn')?.click());
await A.waitForTimeout(400);
const react = await A.evaluate(() => ({
  moreOpen: !document.getElementById('chatCallMoreSheet').classList.contains('hidden'),
  barOpen: !document.getElementById('chatCallReactionBar').classList.contains('hidden'),
  barWidth: document.getElementById('chatCallReactionBar').getBoundingClientRect().width,
}));
check('opening the reactions closes the extras (one menu at a time)', react.barOpen && !react.moreOpen);
check('the reactions are as wide as the extras', Math.abs(react.barWidth - more.sheetWidth) < 3, `${Math.round(react.barWidth)} / ${Math.round(more.sheetWidth)}`);
await A.evaluate(() => document.getElementById('chatCallReactBtn')?.click());

/* ----------------------------------------- 1 again: end it, read what it wrote */
await A.evaluate(() => document.getElementById('chatEndCallControlBtn')?.click());
await A.waitForTimeout(2500);
const logged = await A.evaluate((fp) => {
  const peer = findPeerByAnyKey(fp);
  const key = getConversationKey(peer);
  const line = [...(chatState.history[key] || [])].reverse().find((e) => e.type === 'call-log');
  return { route: chatState.calls[0]?.route, lineRoute: line?.route, text: line ? callHistoryText(line) : '' };
}, fpB);
check('the call log records the road: peer', logged.route === 'peer', JSON.stringify(logged));
check('the conversation line records it too', logged.lineRoute === 'peer', JSON.stringify(logged));
check('and says so, "via peer"', /via peer/.test(logged.text), logged.text);

const ghost = await A.evaluate((fp) => {
  const ghostId = 'poorija-ghost-peer-0001';
  appendCall({ name: 'Ghost', peerId: ghostId, mode: 'voice', status: 'missed', direction: 'in' });
  const listed = allConversationRecords().some((r) => getConversationKey(r) === ghostId || r.peerId === ghostId);
  const rec = findPeerByAnyKey(fp);
  const sibling = `${rec.peerId}-ab12cd`;
  appendCall({ name: 'Sibling', peerId: sibling, mode: 'voice', status: 'missed', direction: 'in', createdAt: new Date(Date.now() + 120000).toISOString() });
  const key = getConversationKey(rec);
  chatState.history['orphan-call-only'] = [{ id: 'oc1', type: 'call-log', status: 'missed', direction: 'in', mode: 'voice', createdAt: new Date().toISOString() }];
  const orphanListed = allConversationRecords().some((r) => getConversationKey(r) === 'orphan-call-only');
  delete chatState.history['orphan-call-only'];
  return {
    listed, inLog: chatState.calls.some((c) => c.peerId === ghostId), ghostThread: Object.keys(chatState.history).includes(ghostId),
    siblingResolved: chatState.calls.some((c) => c.name === 'Sibling' && c.peerId === rec.peerId),
    siblingInLog: chatState.calls.some((c) => c.name === 'Sibling' && c.peerId === sibling),
    siblingThread: (chatState.history[key] || []).some((e) => e.type === 'call-log' && e.id && String(e.id).includes(sibling)),
    orphanListed,
  };
}, fpB);
check('an id no contact holds is not listed as a conversation', !ghost.listed && !ghost.ghostThread, JSON.stringify(ghost));
check('…but its call is in the call log', ghost.inLog);
check('an id that only extends a contact’s id is not attributed to the contact (anybody can register one)', !ghost.siblingResolved && !ghost.siblingThread && ghost.siblingInLog, JSON.stringify(ghost));
check('a thread of nothing but call lines is not listed', !ghost.orphanListed);

/* ------------------------------------------------------------- 3. Settings */
console.log('\n===== Settings =====');
const mainTop = () => A.evaluate(() => document.querySelector('.dashboard-main-content')?.scrollTop ?? -1);
await A.evaluate(() => PoorijaMessenger.go('settings'));
await A.waitForTimeout(900);
await A.evaluate(() => PoorijaSettingsPages.open('data'));
await A.waitForTimeout(700);
await A.evaluate(() => { document.querySelector('.dashboard-main-content').scrollTop = 450; });
await A.waitForTimeout(300);
const scrolled = await mainTop();
await A.evaluate(() => PoorijaSettingsPages.open('appearance'));
await A.waitForTimeout(700);
check('a page opens at its top, not where the last one ended', (await mainTop()) === 0, `${scrolled} → ${await mainTop()}`);
await A.evaluate(() => { document.querySelector('.dashboard-main-content').scrollTop = 300; });
await A.evaluate(() => PoorijaSettingsPages.back());
await A.waitForTimeout(700);
check('back lands where the page was left', Math.abs((await mainTop()) - scrolled) <= 2 && scrolled > 100, `${scrolled} → ${await mainTop()}`);
await A.evaluate(() => PoorijaSettingsPages.back());
await A.waitForTimeout(500);
const pill = () => A.evaluate(() => document.querySelector('.msgr-hc-status span')?.textContent || '');
const before = await pill();
await A.evaluate(() => setConnectionState(false, ['قطع شد؛ در حال تلاش دوباره', 'Disconnected; retrying']));
await A.waitForTimeout(900);
const dropped = await pill();
await A.evaluate(() => setConnectionState(true, ['متصل به سرور چت', 'Connected to chat server']));
await A.waitForTimeout(900);
check('the status on Settings follows the connection, with no page change', /Disconnected/.test(dropped) && /Connected to chat server/.test(await pill()), `${before} / ${dropped}`);
await A.evaluate(() => PoorijaSettingsPages.open('connection'));
await A.waitForTimeout(500);
const conn = () => A.evaluate(() => document.querySelector('[data-msgr-page="connection"] .msgr-stat .msgr-hc-status')?.getAttribute('data-tone') || '');
await A.evaluate(() => setConnectionState(false, ['قطع شد', 'Disconnected']));
await A.waitForTimeout(2000);
const toneDown = await conn();
await A.evaluate(() => setConnectionState(true, ['متصل به سرور چت', 'Connected to chat server']));
await A.waitForTimeout(2000);
check('the connection page shows the live state', toneDown === 'offline' && (await conn()) === 'online', `${toneDown} → ${await conn()}`);
await A.evaluate(() => PoorijaSettingsPages.reset());

/* ------------------------------------------------------ 4. back and forward */
console.log('\n===== back and forward =====');
await A.evaluate(() => { chatState.activeConversationId = ''; chatState.activePeerClientId = ''; updateChatShellMode(); PoorijaMessenger.go('chats'); });
await A.waitForTimeout(700);
const where = () => A.evaluate(() => PoorijaNav.snapshot());
const wait = (ms = 700) => A.waitForTimeout(ms);
const len0 = await A.evaluate(() => history.length);
await A.evaluate(() => PoorijaMessenger.go('calls')); await wait(450);
await A.evaluate(() => PoorijaMessenger.go('settings')); await wait(450);
await A.evaluate(() => PoorijaSettingsPages.open('data')); await wait(450);
await A.evaluate(() => PoorijaSettingsPages.open('appearance')); await wait(450);
check('every screen change is a history entry', (await A.evaluate(() => history.length)) >= len0 + 3);
await A.evaluate(() => history.back()); await wait();
check('back goes up one Settings page', JSON.stringify((await where()).pages) === '["root","data"]', JSON.stringify(await where()));
await A.evaluate(() => history.back()); await wait();
check('and up again', JSON.stringify((await where()).pages) === '["root"]');
await A.evaluate(() => history.forward()); await wait();
check('forward goes down again', JSON.stringify((await where()).pages) === '["root","data"]');
await A.evaluate(() => history.back()); await wait();
await A.evaluate(() => history.back()); await wait();
const calls = await where();
check('back from Settings returns to the calls list, not out of the app', calls.tab === 'chat' && calls.view === 'calls', JSON.stringify(calls));
await A.evaluate(() => history.back()); await wait();
await A.evaluate(() => PoorijaMessenger.go('chats')); await wait(450);
await openChat(A, fpB); await wait(900);
check('a conversation is a screen of its own on a phone', Boolean((await where()).conv));
await A.evaluate(() => history.back()); await wait(900);
check('back closes the conversation', !(await where()).conv && !(await A.evaluate(() => document.documentElement.classList.contains('chat-conversation-active'))));
await A.evaluate(() => history.forward()); await wait(900);
check('forward opens it again', Boolean((await where()).conv));
await A.evaluate(() => openFullSheet({ title: 'x', build: (b) => { b.textContent = 'hi'; } })); await wait(500);
const sheetScreen = JSON.stringify(await where());
await A.evaluate(() => history.back()); await wait();
check('back with a sheet open closes the sheet and stays', (await A.evaluate(() => document.getElementById('chatFullSheet').classList.contains('hidden'))) && JSON.stringify(await where()) === sheetScreen);
await A.evaluate(() => history.back()); await wait(900);
check('and the next back leaves the conversation', !(await where()).conv);

/* ------------------------------------------------------------- 5. the toasts */
console.log('\n===== toasts =====');
const fpA = decode(cards.A).fingerprint;
for (const page of [B, C]) await openChat(page, fpA);
await A.evaluate(() => {
  chatState.activeConversationId = ''; chatState.activePeerClientId = ''; updateChatShellMode(); PoorijaMessenger.go('settings');
  toastLog.length = 0; window.__toastKeys = [];
  const original = PoorijaApp.showNotification;
  PoorijaApp.showNotification = (message, type, options) => { window.__toastKeys.push(options && options.key); return original.call(PoorijaApp, message, type, options); };
});
const say = (page, text) => page.evaluate((value) => { const box = document.getElementById('chatComposer'); box.value = value; box.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('chatSendMessageBtn').click(); }, text);
for (const text of ['one', 'two', 'three', 'four']) { await say(B, text); await B.waitForTimeout(300); }
await say(C, 'hello'); await C.waitForTimeout(800);
await A.waitForTimeout(1500);
const toasts = await A.evaluate(() => ({ lines: toastLog.map((x) => x.message), keys: window.__toastKeys }));
check('the first message of a burst shows what it says', /: one$/.test(toasts.lines[0] || ''), toasts.lines[0]);
check('after that the same toast counts them', /: 4 messages$/.test(toasts.lines[3] || ''), JSON.stringify(toasts.lines));
check('a conversation’s messages share one toast key', new Set(toasts.keys.slice(0, 4)).size === 1 && Boolean(toasts.keys[0]), JSON.stringify(toasts.keys));
check('somebody else’s message is a toast of its own', Boolean(toasts.keys[4]) && toasts.keys[4] !== toasts.keys[0], JSON.stringify(toasts.keys));
const tally = await A.evaluate(() => {
  forgetToastTally('tally-test');
  const out = [];
  for (const type of ['sticker', 'sticker', 'sticker', 'text']) out.push(tallyIncomingForToast('tally-test', { type }, { preview: 'preview' }));
  forgetToastTally('tally-test');
  return { out, sameId: toastId('info', 'key:chat-x') === toastId('info', 'key:chat-x') };
});
check('kinds are counted: "3 stickers and 1 message"', tally.out[3] === '3 stickers and 1 message', JSON.stringify(tally.out));
check('a toast with a key keeps its id whatever it says', tally.sameId);

const errors = [];
for (const [tag, page] of [['A', A], ['B', B], ['C', C]]) {
  const bad = (page.__errors || []).filter((x) => !/SSL|Failed to load resource|Permission|NotAllowed|getDisplayMedia/i.test(String(x)));
  if (bad.length) errors.push(`${tag}: ${bad.slice(0, 2).join(' | ')}`);
}
check('no uncaught page errors', errors.length === 0, errors.join(' / '));

const failing = results.filter((r) => !r.ok);
console.log(`\n===== ${failing.length} failing of ${results.length} =====`);
failing.forEach((f) => console.log(`  FAIL ${f.n} — ${f.d}`));
await browser.close();
process.exit(failing.length ? 1 : 0);
