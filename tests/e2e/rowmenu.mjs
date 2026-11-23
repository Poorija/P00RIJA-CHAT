/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* A conversation's menu in the chat list does what each of its items says:
 * pin, mute, archive and back out of the archive, mark unread, export, lock,
 * block. Driven the way a person drives it, on a phone-sized page: a long
 * press on the row (and the row's ⋯ button), then a tap on the item. */
import { openApp, identity, importIdentity, waitFor } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
import { createChecks } from './_check.mjs';

const { results, check } = createChecks();
const decode = (card) => JSON.parse(Buffer.from(card.replace('poorija-chat-v1:', ''), 'base64').toString('utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const stacks = await startTwoStacks();
try {
  const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
  const A = await openApp('SARA', { origin: stacks.a.url, relay: stacks.a.url, context: phone });
  const B = await openApp('OMID', { origin: stacks.a.url, relay: stacks.a.url });
  const cards = { A: await identity(A), B: await identity(B) };
  await importIdentity(A, cards.B);
  await importIdentity(B, cards.A);
  const key = await A.evaluate((fp) => getConversationKey(findPeerByAnyKey(fp)), decode(cards.B).fingerprint);
  /* Something to export: one message each way. */
  await A.evaluate(async (k) => { const history = (chatState.history[k] ||= []); history.push({ id: 'probe-1', direction: 'out', type: 'text', text: 'hello', createdAt: Date.now(), status: 'delivered' }); chatState.activeConversationId = ''; renderPeers(); }, key);
  await sleep(1200);
  const row = `#chatPeerList .ui-row[data-chat-conversation="${key}"]`;
  const record = () => A.evaluate((k) => {
    const r = conversationRecordById(k) || {};
    return { pinned: Boolean(r.pinned || chatState.pinnedConversations?.includes?.(k)), muted: Boolean(r.muted), archived: Boolean(r.archived), blocked: Boolean(r.blocked), unread: Boolean(chatState.manualUnread?.[k]), lock: conversationHasLock(k) };
  }, key);
  const openMenu = async () => {
    await A.waitForSelector(row, { timeout: 15000 });
    const box = await A.locator(row).boundingBox();
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    /* A finger held on the row: pointerdown, 600 ms, pointerup. */
    await A.evaluate(({ sel, x, y }) => {
      const target = document.elementFromPoint(x, y) || document.querySelector(sel);
      const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerType: 'touch', isPrimary: true, pointerId: 7 };
      target.dispatchEvent(new PointerEvent('pointerdown', init));
      setTimeout(() => target.dispatchEvent(new PointerEvent('pointerup', init)), 600);
    }, { sel: row, ...at });
    await sleep(900);
    await A.waitForSelector('.ui-menu', { timeout: 5000 });
    return A.$$eval('.ui-menu .ui-menu-item span', (nodes) => nodes.map((n) => n.textContent));
  };
  const choose = async (label) => {
    const items = await openMenu();
    const index = items.findIndex((t) => t === label);
    if (index < 0) return `no "${label}" in ${JSON.stringify(items)}`;
    await A.locator('.ui-menu .ui-menu-item').nth(index).click();
    await sleep(700);
    return '';
  };
  const longPress = async (sel = row) => {
    const box = await A.locator(sel).boundingBox();
    await A.evaluate(({ sel, x, y }) => {
      const target = document.elementFromPoint(x, y) || document.querySelector(sel);
      const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerType: 'touch', isPrimary: true, pointerId: 7 };
      target.dispatchEvent(new PointerEvent('pointerdown', init));
      setTimeout(() => target.dispatchEvent(new PointerEvent('pointerup', init)), 600);
    }, { sel, x: box.x + box.width / 2, y: box.y + box.height / 2 });
    await sleep(900);
  };
  const tapItem = async (label) => {
    const items = await A.$$eval('.ui-menu .ui-menu-item span', (nodes) => nodes.map((n) => n.textContent));
    const index = items.indexOf(label);
    if (index < 0) return `no "${label}" in ${JSON.stringify(items)}`;
    await A.locator('.ui-menu .ui-menu-item').nth(index).click();
    await sleep(800);
    return '';
  };
  const viaMenu = async (label) => { await longPress(); return tapItem(label); };

  check('the menu lists the seven things a conversation can do', JSON.stringify(await openMenu()) === JSON.stringify(['Pin', 'Mute', 'Archive', 'Mark as unread', 'Export conversation', 'Lock this conversation', 'Block']));
  await A.keyboard.press('Escape');

  let miss = await viaMenu('Pin');
  check('Pin pins it', !miss && (await record()).pinned, miss);
  miss = await viaMenu('Unpin');
  check('and Unpin, pressed next, unpins it (the press after a long press is not swallowed)', !miss && !(await record()).pinned, miss);
  miss = await viaMenu('Mute');
  check('Mute mutes it', !miss && (await record()).muted, miss);
  miss = await viaMenu('Unmute');
  check('Unmute', !miss && !(await record()).muted, miss);
  miss = await viaMenu('Mark as unread');
  check('Mark as unread', !miss && (await record()).unread, miss);
  miss = await viaMenu('Mark as read');
  check('Mark as read', !miss && !(await record()).unread, miss);

  const download = A.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  miss = await viaMenu('Export conversation');
  const file = await download;
  const dialogUp = await A.evaluate(() => Boolean(document.querySelector('.poorija-dialog-backdrop:not(.hidden)')));
  check('Export conversation starts an export (a file or the export dialog)', !miss && (Boolean(file) || dialogUp), miss || `download ${Boolean(file)} dialog ${dialogUp}`);
  await A.keyboard.press('Escape'); await sleep(400);

  miss = await viaMenu('Lock this conversation');
  const asked = await A.evaluate(() => Boolean(document.querySelector('.poorija-dialog-backdrop:not(.hidden) input')));
  check('Lock asks for the conversation\'s password', !miss && asked, miss);
  await A.keyboard.press('Escape'); await sleep(400);

  miss = await viaMenu('Archive');
  check('Archive archives it', !miss && (await record()).archived, miss);
  await A.click('[data-chat-archive-shelf]');
  await sleep(600);
  miss = await viaMenu('Unarchive');
  check('and in the archive, Unarchive brings it back', !miss && !(await record()).archived, miss);
  await A.evaluate(() => { chatState.showArchived = false; renderPeers(); });
  await sleep(500);

  miss = await viaMenu('Block');
  await sleep(500);
  await A.locator('button:has-text("OK"), button:has-text("Block"), button:has-text("Yes"), button:has-text("Confirm")').last().click({ timeout: 5000 }).catch(() => {});
  await sleep(800);
  check('Block (after its question) blocks it', !miss && (await record()).blocked, miss);
  miss = await viaMenu('Unblock');
  check('Unblock', !miss && !(await record()).blocked, miss);

  const moreBox = await A.locator(`${row} .ui-row-more`).boundingBox().catch(() => null);
  check('each row shows a ⋯ button', Boolean(moreBox && moreBox.width > 10));
  if (moreBox) {
    await A.locator(`${row} .ui-row-more`).click();
    await sleep(500);
    const opened = await A.evaluate(() => Boolean(document.querySelector('.ui-menu')));
    const thread = await A.evaluate(() => Boolean(chatState.activeConversationId));
    check('and it opens the menu, not the conversation', opened && !thread, `${opened} ${thread}`);
    await A.keyboard.press('Escape'); await sleep(300);
  }

  const swipe = async (dx) => {
    const box = await A.locator(row).boundingBox();
    const y = box.y + box.height / 2; const x0 = box.x + box.width / 2;
    await A.evaluate(async ({ x0, y, dx, sel }) => {
      /* The row's own name, not whatever is on top at that point: a toast from
         the previous step can still be over the row. */
      const target = document.querySelector(`${sel} .ui-row-name`);
      const fire = (type, x) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerType: 'touch', isPrimary: true, pointerId: 9 }));
      fire('pointerdown', x0);
      for (let i = 1; i <= 8; i++) { fire('pointermove', x0 + (dx * i) / 8); await new Promise((r) => setTimeout(r, 16)); }
      fire('pointerup', x0 + dx);
    }, { x0, y, dx, sel: row });
    await sleep(900);
  };
  await swipe(-120);
  check('a swipe toward the end of the line archives the row', (await record()).archived && !(await A.evaluate(() => Boolean(chatState.activeConversationId))));
  await A.evaluate((k) => { toggleConversationArchive(k); chatState.showArchived = false; renderPeers(); }, key);
  await sleep(600);
  await swipe(120);
  check('a swipe the other way marks it unread', (await record()).unread);
  await swipe(30);
  check('a short swipe does nothing', (await record()).unread && !(await record()).archived);
} finally {
  await stacks.stop?.();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n===== ${failed.length} failed of ${results.length} =====`);
process.exit(failed.length ? 1 : 0);
