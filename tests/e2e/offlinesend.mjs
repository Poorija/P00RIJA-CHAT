/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Sending while the SENDER is the one with no network.
 *
 * offline.mjs covers the other half — a contact who is not there. This is the
 * phone in a lift: the relay is unreachable from the sender's side, a message is
 * written anyway, and it has to
 *
 *   - stay in the thread, waiting (not vanish, not turn into "failed"),
 *   - go out by itself when the connection is back,
 *   - arrive once, and arrive for the person it was written to;
 *
 * and the same for what is not a line of text: a small file, a photo with its
 * caption and a message to a group — kept, not "failed" — and for the app being
 * closed and opened again while they wait.
 *
 *   node tests/e2e/offlinesend.mjs
 */
import { openApp, identity, importIdentity, browser, waitFor, PASS } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
import { createChecks } from './_check.mjs';

const { results, check } = createChecks({ maxDetail: 240, entry: (_name, ok) => Boolean(ok) });
const decode = (card) => JSON.parse(Buffer.from(card.replace('poorija-chat-v1:', ''), 'base64').toString('utf8'));
const openConversation = (page, fp) => page.evaluate(async (key) => {
  const peer = findPeerByAnyKey(key);
  chatState.activeConversationId = getConversationKey(peer);
  chatState.activePeerClientId = peer.clientId || '';
  renderPeers(); renderActivePeer(); renderMessages();
  await new Promise((r) => setTimeout(r, 400));
}, fp);
const say = (page, text) => page.evaluate((value) => {
  const box = document.getElementById('chatComposer');
  box.value = value;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('chatSendMessageBtn').click();
}, text);
const entryOf = (page, text) => page.evaluate((value) => {
  const entry = Object.values(chatState.history).flat().find((e) => e.text === value && e.direction === 'out');
  return entry ? { status: entry.status } : null;
}, text);
const received = (page, text, timeoutMs = 60000) => waitFor(page, (value) => Object.values(chatState.history)
  .some((list) => list.some((e) => e.text === value && e.direction === 'in')), { timeoutMs, arg: text });
const timesReceived = (page, text) => page.evaluate((value) => Object.values(chatState.history)
  .flat().filter((e) => e.text === value && e.direction === 'in').length, text);

const stacks = await startTwoStacks();
try {
  const ARIA = await openApp('ARIA', { origin: stacks.a.url, relay: stacks.a.url });
  const BARAN = await openApp('BARAN', { origin: stacks.a.url, relay: stacks.a.url });
  const cards = { ARIA: await identity(ARIA), BARAN: await identity(BARAN) };
  const fp = { ARIA: decode(cards.ARIA).fingerprint, BARAN: decode(cards.BARAN).fingerprint };
  await importIdentity(ARIA, cards.BARAN);
  await importIdentity(BARAN, cards.ARIA);
  await openConversation(ARIA, fp.BARAN);
  await openConversation(BARAN, fp.ARIA);
  const hello = `hello-${Date.now()}`;
  await say(ARIA, hello);
  check('they can talk while both are online', await received(BARAN, hello), hello);

  console.log('\n===== the sender loses the network =====');
  await ARIA.context().setOffline(true);
  /* A browser's offline switch does not reach a WebRTC data channel, and a phone
     with no network has none: the live channel goes down with the relay socket. */
  await ARIA.evaluate(() => {
    chatState.sessions.forEach((session) => { try { session.connection?.close(); } catch (_error) { /* gone */ } session.connection = null; });
    try { chatState.ws?.close(); } catch (_error) { /* gone */ }
  });
  const down = await waitFor(ARIA, () => chatState.connected === false, { timeoutMs: 15000 });
  check('the app notices it is offline', down);

  const first = `lift-1-${Date.now()}`;
  const second = `lift-2-${Date.now()}`;
  await say(ARIA, first);
  await ARIA.waitForTimeout(1500);
  await say(ARIA, second);
  await ARIA.waitForTimeout(2500);
  const e1 = await entryOf(ARIA, first);
  const e2 = await entryOf(ARIA, second);
  check('both messages are kept in the thread', Boolean(e1 && e2), JSON.stringify({ e1, e2 }));
  check('and neither is marked failed — they are waiting', Boolean(e1 && e2) && e1.status !== 'failed' && e2.status !== 'failed', JSON.stringify({ e1, e2 }));
  const shown = await ARIA.evaluate((a) => document.getElementById('chatMessages')?.textContent.includes(a), first);
  check('the sender sees them on screen', shown === true);
  check('nothing has reached BARAN yet', await timesReceived(BARAN, first) === 0 && await timesReceived(BARAN, second) === 0);

  console.log('\n===== the network comes back =====');
  await ARIA.context().setOffline(false);
  await ARIA.evaluate(() => window.dispatchEvent(new Event('online')));
  const back = await waitFor(ARIA, () => chatState.connected === true && chatState.ws?.readyState === 1, { timeoutMs: 45000 });
  check('the app connects again by itself', back);
  check('the first message arrives', await received(BARAN, first), first);
  check('and the second', await received(BARAN, second), second);
  await ARIA.waitForTimeout(4000);
  check('each arrives once, not twice', await timesReceived(BARAN, first) === 1 && await timesReceived(BARAN, second) === 1,
    `${await timesReceived(BARAN, first)} / ${await timesReceived(BARAN, second)}`);
  const after = { e1: await entryOf(ARIA, first), e2: await entryOf(ARIA, second) };
  check('the sender sees them as sent, no longer waiting', ['sent', 'relayed', 'delivered', 'seen'].includes(after.e1?.status) && ['sent', 'relayed', 'delivered', 'seen'].includes(after.e2?.status), JSON.stringify(after));

  console.log('\n===== a file, a photo and a group message, kept through the app being closed =====');
  const gname = `lift-group-${Date.now()}`;
  const gid = await ARIA.evaluate((b) => {
    const id = generateId('space');
    const space = upsertSharedSpace({ type: 'group', conversationId: id, name: 'lift', members: [chatState.identity.fingerprint, b],
      ownerPeerId: chatState.peerId, ownerFingerprint: chatState.identity.fingerprint, rev: 1, createdAt: new Date().toISOString() });
    broadcastSpaceRecord(space);
    return id;
  }, fp.BARAN);
  const sawGroup = await waitFor(BARAN, () => chatState.spaces.groups.some((g) => g.name === 'lift'), { timeoutMs: 60000 });
  check('a group with the two of them exists', sawGroup === true);
  void gname;

  await ARIA.context().setOffline(true);
  await ARIA.evaluate(() => {
    chatState.sessions.forEach((session) => { try { session.connection?.close(); } catch (_error) { /* gone */ } session.connection = null; });
    try { chatState.ws?.close(); } catch (_error) { /* gone */ }
  });
  await waitFor(ARIA, () => chatState.connected === false, { timeoutMs: 15000 });
  const stamp = Date.now();
  const fileBody = `a small file written in a lift ${stamp}`;
  await openConversation(ARIA, fp.BARAN);
  await ARIA.evaluate(async ({ body, stampValue }) => {
    await sendEncryptedBlob(new File([body], `note-${stampValue}.txt`, { type: 'text/plain' }), 'file');
    const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 80;
    const g = canvas.getContext('2d'); g.fillStyle = '#34c759'; g.fillRect(0, 0, 120, 80);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    await sendEncryptedBlob(new File([blob], `photo-${stampValue}.jpg`, { type: 'image/jpeg' }), 'file', 0, { photo: true, mediaWidth: 120, mediaHeight: 80, caption: 'from the lift' });
  }, { body: fileBody, stampValue: stamp });
  await ARIA.evaluate((id) => { chatState.activeConversationId = id; chatState.activePeerClientId = ''; renderPeers(); renderActivePeer(); renderMessages(); }, gid);
  await ARIA.waitForTimeout(400);
  const groupText = `group-in-a-lift-${stamp}`;
  await say(ARIA, groupText);
  await ARIA.waitForTimeout(2500);
  const held = await ARIA.evaluate(({ stampValue, text }) => {
    const all = Object.values(chatState.history).flat();
    const pick = (match) => { const e = all.find(match); return e ? { status: e.status, held: Boolean(e.heldForConnection), photo: Boolean(e.photo) } : null; };
    return { file: pick((e) => e.name === `note-${stampValue}.txt`), photo: pick((e) => e.name === `photo-${stampValue}.jpg`), group: pick((e) => e.text === text) };
  }, { stampValue: stamp, text: groupText });
  check('the file is kept and waiting, not failed', held.file?.status === 'queued' && held.file.held, JSON.stringify(held.file));
  check('so is the photo, still a photo', held.photo?.status === 'queued' && held.photo.held && held.photo.photo, JSON.stringify(held.photo));
  check('and the message to the group', held.group?.status === 'queued', JSON.stringify(held.group));

  /* The phone is put away and the app closed, and opened again with a network. */
  await ARIA.context().setOffline(false);
  await ARIA.reload({ waitUntil: 'load' });
  await ARIA.waitForTimeout(3000);
  await ARIA.evaluate((pass) => {
    const el = document.getElementById('unlockPassword');
    el.value = pass; el.dispatchEvent(new Event('input', { bubbles: true }));
    window.unlockApp?.();
  }, PASS);
  const backUp = await waitFor(ARIA, () => chatState.connected === true && chatState.ws?.readyState === 1, { timeoutMs: 60000 });
  check('opened again, the app connects', backUp === true);
  const gotFile = await waitFor(BARAN, (stampValue) => Object.values(chatState.history).flat().some((e) => e.direction === 'in' && e.name === `note-${stampValue}.txt` && e.downloadUrl), { timeoutMs: 90000, arg: stamp });
  check('the file arrives', gotFile === true);
  if (gotFile) {
    const text = await BARAN.evaluate(async (stampValue) => {
      const entry = Object.values(chatState.history).flat().find((e) => e.name === `note-${stampValue}.txt`);
      return (await (await fetch(entry.downloadUrl)).blob()).text();
    }, stamp);
    check('with every byte', text === fileBody, text);
  }
  const gotPhoto = await waitFor(BARAN, (stampValue) => Object.values(chatState.history).flat().some((e) => e.direction === 'in' && e.name === `photo-${stampValue}.jpg` && e.photo === true && e.caption === 'from the lift'), { timeoutMs: 90000, arg: stamp });
  check('the photo arrives as a photo, with its caption', gotPhoto === true);
  const gotGroup = await waitFor(BARAN, (text) => Object.values(chatState.history).flat().some((e) => e.direction === 'in' && e.text === text), { timeoutMs: 90000, arg: groupText });
  check('and the group message', gotGroup === true);
  await ARIA.waitForTimeout(3000);
  const counts = await BARAN.evaluate(({ stampValue, text }) => {
    const all = Object.values(chatState.history).flat().filter((e) => e.direction === 'in');
    return { file: all.filter((e) => e.name === `note-${stampValue}.txt`).length, photo: all.filter((e) => e.name === `photo-${stampValue}.jpg`).length, group: all.filter((e) => e.text === text).length };
  }, { stampValue: stamp, text: groupText });
  check('each once', counts.file === 1 && counts.photo === 1 && counts.group === 1, JSON.stringify(counts));
} catch (error) {
  check('the suite ran to the end', false, error?.stack || String(error));
} finally {
  await stacks.stop?.();
  await browser?.close?.().catch(() => {});
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n===== ${failed} failed of ${results.length} =====`);
process.exit(failed ? 1 : 0);
