/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Sender Keys for groups (roadmap 3.1, release 2.11).
 *
 * A group message is sealed once, under the next key of the sender's own
 * chain for the group, and signed with the sender's group key; each member's
 * copy carries that one sealed text and the chain, inside the pairwise
 * ratchet. What has to hold, on a real relay with three apps:
 *
 *   - members read the message; what crossed the wire carries the sealed copy
 *     and not the words;
 *   - every member's copy is the SAME sealed text (sealed once);
 *   - a member who joins later cannot read what was said before they came;
 *   - a member who is removed cannot read anything said after: the sender's
 *     chain is renewed and handed only to those still in;
 *   - the sender a member's app shows is the one its session authenticated.
 *
 *   node tests/e2e/senderkeys.mjs      (brings up its own relay)
 */
import { openApp, identity, importIdentity, browser, waitFor } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
import { createChecks } from './_check.mjs';

const { results, check } = createChecks({ entry: (name, ok, detail) => ({ name, ok, detail }) });
const section = (title) => console.log(`\n===== ${title} =====`);
const decode = (card) => JSON.parse(Buffer.from(card.replace('poorija-chat-v1:', ''), 'base64').toString('utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Every sealed-once copy this app makes, and every frame it sends. */
const tap = (page) => page.evaluate(() => {
  window.__sealed = [];
  const original = PoorijaSenderKeys.sealForGroup;
  window.__realSeal = original;
  Object.defineProperty(window, 'PoorijaSenderKeys', { value: { ...PoorijaSenderKeys, sealForGroup: async (...args) => { const out = await original(...args); window.__sealed.push(JSON.parse(JSON.stringify(out))); return out; } }, configurable: true, writable: true });
  window.__frames = [];
  const send = window.safeConnectionSend;
  window.safeConnectionSend = function tapped(connection, message) {
    try { if (message?.type) window.__frames.push(JSON.parse(JSON.stringify(message))); } catch (_e) { /* binary */ }
    return send.apply(this, arguments);
  };
});
const groupText = (page, groupId, text) => waitFor(page, ({ id, value }) => (chatState.history[id] || []).some((e) => e.text === value && e.direction === 'in'), { timeoutMs: 60000, arg: { id: groupId, value: text } }).catch(() => false);
const say = (page, groupId, text) => page.evaluate(async ({ id, value }) => {
  const space = (chatState.spaces?.groups || []).find((g) => g.conversationId === id);
  const entry = { id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text: value, createdAt: new Date().toISOString(), direction: 'out', type: 'text' };
  (chatState.history[id] ||= []).push(entry);
  return deliverTextEntry({ ...space, type: 'group' }, entry, { interactive: false });
}, { id: groupId, value: text });
const setMembers = (page, groupId, fps) => page.evaluate(({ id, members }) => {
  const space = (chatState.spaces?.groups || []).find((g) => g.conversationId === id);
  const removed = (space.members || []).filter((key) => !members.includes(key));
  commitSpaceEdit(space, { members, removed: normalizeSpaceMembers([...(space.removed || []), ...removed]) }, '');
  for (const key of [...members, ...removed]) {
    const peer = findPeerByAnyKey(key);
    if (peer && typeof sendSpaceSync === 'function') sendSpaceSync(peer, { ...space, members });
  }
}, { id: groupId, members: fps });
/* A member trying a sealed copy with whatever chains its app holds. */
const tryOpen = (page, { groupId, senderFp, wire }) => page.evaluate(async ({ g, s, w }) => {
  try { return new TextDecoder().decode(await PoorijaSenderKeys.openFromGroup(g, s, w, null)); } catch (error) { return `refused: ${error?.reason || error?.name}`; }
}, { g: groupId, s: senderFp, w: wire });

const stacks = await startTwoStacks();
try {
  const ARIA = await openApp('ARIA', { origin: stacks.a.url, relay: stacks.a.url });
  const BARAN = await openApp('BARAN', { origin: stacks.a.url, relay: stacks.a.url });
  const CYRUS = await openApp('CYRUS', { origin: stacks.a.url, relay: stacks.a.url });
  const all = { ARIA, BARAN, CYRUS };
  for (const page of Object.values(all)) await waitFor(page, () => chatState.identity?.v === 4, { timeoutMs: 30000 }).catch(() => null);
  const cards = {};
  for (const [name, page] of Object.entries(all)) cards[name] = await identity(page);
  const fp = Object.fromEntries(Object.entries(cards).map(([name, card]) => [name, decode(card).fingerprint]));
  for (const [name, page] of Object.entries(all)) for (const other of Object.keys(all)) if (other !== name) await importIdentity(page, cards[other]);
  await sleep(3000);
  check('every app says it reads sender keys', (await Promise.all(Object.values(all).map((p) => p.evaluate(() => LOCAL_CAPS.includes('sk1'))))).every(Boolean));
  await tap(ARIA);

  section('a group of two, then a message');
  const groupId = await ARIA.evaluate((b) => {
    const space = { type: 'group', name: 'SK test', conversationId: `group-${Date.now()}-sk`, members: [b], createdAt: new Date().toISOString(),
      ownerPeerId: chatState.peerId || '', ownerClientId: chatState.clientId || '', ownerFingerprint: chatState.identity.fingerprint, permissions: {} };
    const made = upsertSharedSpace(space);
    if (made) { made.accepted = true; saveSpaces(); }
    broadcastSpaceRecord(space);
    return space.conversationId;
  }, fp.BARAN);
  await waitFor(BARAN, (id) => (chatState.spaces?.groups || []).some((g) => g.conversationId === id), { timeoutMs: 30000, arg: groupId }).catch(() => null);
  await BARAN.evaluate((id) => { const g = (chatState.spaces?.groups || []).find((x) => x.conversationId === id); if (g) { g.accepted = true; saveSpaces(); } }, groupId);
  const early = `before-cyrus-${Date.now()}`;
  await say(ARIA, groupId, early);
  check('BARAN reads it', Boolean(await groupText(BARAN, groupId, early)), early);
  const firstFrames = await ARIA.evaluate(() => window.__frames.filter((f) => f.type === 'space-message'));
  const sealed1 = await ARIA.evaluate(() => window.__sealed.slice(-1)[0]);
  check('the text was sealed once, under ARIA\'s chain for the group', Boolean(sealed1?.wire?.c) && sealed1.wire.sk === 1, JSON.stringify(sealed1?.wire || {}).slice(0, 120));
  check('and what crossed the wire never carries the words outside it', firstFrames.length >= 1 && firstFrames.every((f) => !JSON.stringify(f).includes(early)));

  section('CYRUS joins: what came before stays closed to him');
  await setMembers(ARIA, groupId, [fp.BARAN, fp.CYRUS]);
  await waitFor(CYRUS, (id) => (chatState.spaces?.groups || []).some((g) => g.conversationId === id), { timeoutMs: 30000, arg: groupId }).catch(() => null);
  await CYRUS.evaluate((id) => { const g = (chatState.spaces?.groups || []).find((x) => x.conversationId === id); if (g) { g.accepted = true; saveSpaces(); } }, groupId);
  await sleep(1500);
  const welcome = `welcome-cyrus-${Date.now()}`;
  await say(ARIA, groupId, welcome);
  check('CYRUS reads what is said after he joined', Boolean(await groupText(CYRUS, groupId, welcome)), welcome);
  check('and so does BARAN', Boolean(await groupText(BARAN, groupId, welcome)));
  const sealed2 = await ARIA.evaluate(() => window.__sealed.slice(-1)[0]);
  check('adding a member did not renew the chain (nobody left)', sealed2?.keyId === sealed1?.keyId);
  const beforeHim = await tryOpen(CYRUS, { groupId, senderFp: fp.ARIA, wire: sealed1.wire });
  check('given the earlier sealed copy, CYRUS cannot open it', /^refused/.test(beforeHim), beforeHim);
  const shared = await ARIA.evaluate(() => {
    const copies = window.__frames.filter((f) => f.type === 'space-message').slice(-2);
    return copies.length;
  });
  check('one copy went to each member', shared >= 2, String(shared));

  section('CYRUS is removed: nothing said after opens for him');
  await setMembers(ARIA, groupId, [fp.BARAN]);
  await sleep(1500);
  const after = `after-cyrus-${Date.now()}`;
  await say(ARIA, groupId, after);
  check('BARAN still reads ARIA', Boolean(await groupText(BARAN, groupId, after)), after);
  const sealed3 = await ARIA.evaluate(() => window.__sealed.slice(-1)[0]);
  check('ARIA\'s chain was renewed the moment someone it was handed to left', Boolean(sealed3?.rotated) && sealed3.keyId !== sealed2.keyId, `${sealed2?.keyId} -> ${sealed3?.keyId}`);
  await sleep(2000);
  check('CYRUS was not sent it', await CYRUS.evaluate(({ id, text }) => !(chatState.history[id] || []).some((e) => e.text === text), { id: groupId, text: after }));
  const leaked = await tryOpen(CYRUS, { groupId, senderFp: fp.ARIA, wire: sealed3.wire });
  check('and given the sealed copy anyway, everything CYRUS holds opens nothing', /^refused/.test(leaked), leaked);

  section('the sender is who the session says');
  const shown = await BARAN.evaluate(({ id, text }) => (chatState.history[id] || []).find((e) => e.text === text)?.senderFingerprint || '', { id: groupId, text: after });
  check('BARAN\'s app names ARIA, as her session authenticated her', shown === fp.ARIA, shown.slice(0, 12));

  section('nothing threw');
  const errors = Object.values(all).flatMap((page) => page.__errors || []);
  check('no script error', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await stacks.stop();
}
const failed = results.filter((result) => !result.ok);
console.log(`\n===== ${failed.length} failed of ${results.length} =====`);
failed.forEach((result) => console.log(`  FAIL ${result.name}${result.detail ? ` — ${result.detail}` : ''}`));
process.exit(failed.length ? 1 : 0);
