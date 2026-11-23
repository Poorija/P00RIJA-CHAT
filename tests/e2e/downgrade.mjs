/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text.
 */

/* Nobody on the path can talk a live session out of forward secrecy.
 *
 * A live session's key is derived from two ephemeral halves (kex-offer,
 * kex-answer). There used to be a second way to get one: a key made by one
 * side and delivered wrapped to the other's identity key — the key that never
 * changes — as `chat-key`. It was kept for builds that had no exchange, and
 * the app fell back to it by itself when an answer was four seconds late.
 *
 * Whoever carries the traffic decides how late an answer is. Hold one frame
 * and the sender wrapped a key to the permanent key and went on talking under
 * it; record that, take the permanent key from a seized device a year later,
 * and the conversation opens. That is the whole of what forward secrecy is
 * supposed to prevent, switched off by a delay.
 *
 * Every build that exists has the exchange, so there is nothing left to fall
 * back for. These checks hold the frames a hostile path would hold, and ask
 * what LEFT each side: a key delivered that way must never be sent, never be
 * accepted, and never be revived from storage.
 *
 *   node tests/e2e/downgrade.mjs      (brings up its own relay)
 */
import { openApp, identity, importIdentity, browser, waitFor } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';

const results = [];
const check = (n, ok, d = '') => {
  results.push({ n, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + String(d).slice(0, 260) : ''}`);
};
const section = (title) => console.log(`\n===== ${title} =====`);
const decode = (card) => JSON.parse(Buffer.from(card.replace('poorija-chat-v1:', ''), 'base64').toString('utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
const received = (page, text, timeoutMs = 45000) => waitFor(page, (value) => Object.values(chatState.history)
  .some((list) => list.some((e) => e.text === value && e.direction === 'in')), { timeoutMs, arg: text });

/* Stands on the one function every frame of a live session leaves through.
   `window.__hold` names the frame types to swallow; `window.__left` is what
   went out, in order. Put in before the page's own scripts run, and taken up
   after them: safeConnectionSend is a top-level function of a classic script,
   so the name its callers use is this property of window. */
const tap = (page) => page.evaluate(() => {
  if (window.__tapped) return;
  window.__tapped = true;
  window.__left = [];
  window.__hold = new Set();
  const original = window.safeConnectionSend;
  window.__sendThrough = original;
  window.safeConnectionSend = function tapped(connection, message, label) {
    const type = message && message.type;
    if (type) window.__left.push(type);
    if (type && window.__hold.has(type)) return true;       /* the path ate it */
    return original.apply(this, arguments);
  };
});
const hold = (page, types) => page.evaluate((list) => { window.__hold = new Set(list); }, types);
const left = (page) => page.evaluate(() => window.__left.slice());
const sessionOf = (page, fp) => page.evaluate(async (key) => {
  const peer = findPeerByAnyKey(key);
  const session = peer && chatState.sessions.get(peer.peerId);
  if (!session) return null;
  let raw = '';
  if (session.cryptoKey) {
    try { raw = Array.from(new Uint8Array(await crypto.subtle.exportKey('raw', session.cryptoKey))).map((b) => b.toString(16).padStart(2, '0')).join(''); } catch (e) { raw = 'unexportable'; }
  }
  return { open: Boolean(session.connection?.open), ready: Boolean(session.keyReady), source: session.keySource || '', key: raw, owner: sessionKeyOwner(session),
    hybrid: Boolean(session.keyHybrid), pending: Boolean(session.kexPending), fresh: session.keyNegotiatedFor === session.connection };
}, fp);
const closeSession = (page, fp) => page.evaluate((key) => {
  const peer = findPeerByAnyKey(key);
  const session = peer && chatState.sessions.get(peer.peerId);
  try { session?.connection?.close(); } catch (e) { /* already gone */ }
  if (peer) chatState.sessions.delete(peer.peerId);
}, fp);

const stacks = await startTwoStacks();
try {
  const ARIA = await openApp('ARIA', { origin: stacks.a.url, relay: stacks.a.url });
  const BARAN = await openApp('BARAN', { origin: stacks.a.url, relay: stacks.a.url });
  /* Before they know each other: a session opens, and exchanges its key, the
     moment a card is taken in. */
  await tap(ARIA);
  await tap(BARAN);
  /* Held on both, since which of them answers depends on whose fingerprint
     sorts first — and that is the point: it must not matter. */
  await hold(ARIA, ['kex-answer']);
  await hold(BARAN, ['kex-answer']);
  const cards = { ARIA: await identity(ARIA), BARAN: await identity(BARAN) };
  const fp = { ARIA: decode(cards.ARIA).fingerprint, BARAN: decode(cards.BARAN).fingerprint };
  await importIdentity(ARIA, cards.BARAN);
  await importIdentity(BARAN, cards.ARIA);

  section('the answer to the exchange is held');
  await openConversation(ARIA, fp.BARAN);
  await openConversation(BARAN, fp.ARIA);
  await say(ARIA, `opening-${Date.now()}`);
  await Promise.race([
    waitFor(ARIA, () => window.__left.includes('kex-offer'), { timeoutMs: 40000 }),
    waitFor(BARAN, () => window.__left.includes('kex-offer'), { timeoutMs: 40000 }),
  ]);
  /* Longer than every fallback timer the app has (4 s and 6 s). */
  await sleep(9000);
  const heldA = await sessionOf(ARIA, fp.BARAN);
  const heldB = await sessionOf(BARAN, fp.ARIA);
  const sentA = await left(ARIA);
  const sentB = await left(BARAN);
  console.log('  ARIA  ' + JSON.stringify({ ...heldA, key: heldA?.key ? 'set' : '' }) + ' sent ' + JSON.stringify(sentA.filter((t) => /kex|chat-key/.test(t))));
  console.log('  BARAN ' + JSON.stringify({ ...heldB, key: heldB?.key ? 'set' : '' }) + ' sent ' + JSON.stringify(sentB.filter((t) => /kex|chat-key/.test(t))));
  check('an exchange was offered', sentA.includes('kex-offer') || sentB.includes('kex-offer'));
  check('neither side sends a key wrapped to the permanent key',
    !sentA.includes('chat-key') && !sentB.includes('chat-key'), `ARIA ${sentA.filter((t) => t === 'chat-key').length}, BARAN ${sentB.filter((t) => t === 'chat-key').length}`);
  check('neither side is working under such a key',
    heldA?.source !== 'legacy' && heldB?.source !== 'legacy', `${heldA?.source || '(none)'} / ${heldB?.source || '(none)'}`);
  /* The one who answered derives at once; the one whose answer was eaten has
     nothing, and must have nothing rather than something weaker. */
  const waiting = [heldA, heldB].filter((s) => s && s.owner);
  check('the side still waiting for the answer has no key at all',
    waiting.length === 1 && waiting[0].ready === false && waiting[0].key === '', JSON.stringify(waiting.map((s) => ({ ready: s.ready, source: s.source }))));

  section('a message sent while it waits');
  const during = `during-${Date.now()}`;
  await say(ARIA, during);
  check('still arrives, by the relay', await received(BARAN, during), during);
  const afterSend = await left(ARIA);
  check('and is not what makes a wrapped key go out', !afterSend.includes('chat-key'));

  section('the path lets go');
  await hold(ARIA, []);
  await hold(BARAN, []);
  /* A new connection is a new exchange. */
  await closeSession(ARIA, fp.BARAN);
  await closeSession(BARAN, fp.ARIA);
  await sleep(800);
  await say(ARIA, `again-${Date.now()}`);
  const agreed = await waitFor(ARIA, (key) => {
    const peer = findPeerByAnyKey(key);
    const session = peer && chatState.sessions.get(peer.peerId);
    return Boolean(session?.keyReady && session.keySource === 'negotiated' && session.connection?.open);
  }, { timeoutMs: 60000, arg: fp.BARAN });
  await waitFor(BARAN, (key) => {
    const peer = findPeerByAnyKey(key);
    const session = peer && chatState.sessions.get(peer.peerId);
    return Boolean(session?.keyReady && session.keySource === 'negotiated');
  }, { timeoutMs: 30000, arg: fp.ARIA });
  const freeA = await sessionOf(ARIA, fp.BARAN);
  const freeB = await sessionOf(BARAN, fp.ARIA);
  check('both derive a key from the exchange', Boolean(agreed) && freeA?.source === 'negotiated' && freeB?.source === 'negotiated', `${freeA?.source} / ${freeB?.source}`);
  /* Not "the two sessions hold the same key": when both sides dial at once
     there are two channels for a moment, each with an exchange of its own,
     and the session each side lists for the other may be a different one of
     the two. What has to hold is that what one says under its key, the other
     reads — in both directions. */
  const live = `live-${Date.now()}`;
  await say(ARIA, live);
  check('a message goes across under it', await received(BARAN, live), live);
  const back = `back-${Date.now()}`;
  await say(BARAN, back);
  check('and one comes back', await received(ARIA, back), back);

  section('a wrapped key is handed over anyway');
  /* What a build that still falls back would send, and what somebody on the
     path who held the right frames would try to make count. */
  const before = await sessionOf(BARAN, fp.ARIA);
  await ARIA.evaluate(async (key) => {
    const peer = findPeerByAnyKey(key);
    const session = chatState.sessions.get(peer.peerId);
    const forged = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const raw = await crypto.subtle.exportKey('raw', forged);
    /* Wrapped to their identity key however it is made now (RSA, or the
       X25519 agreement key of identity v4): the point is that a delivered
       key is refused, not how it is wrapped. */
    const wrapped = await sealToIdentity(peer, 'kex', new Uint8Array(raw));
    window.__sendThrough(session.connection, { type: 'chat-key', wrappedKey: PoorijaApp.arrayBufferToBase64(wrapped), fingerprint: chatState.identity.fingerprint }, 'chat-key');
  }, fp.BARAN);
  await sleep(2500);
  const after = await sessionOf(BARAN, fp.ARIA);
  check('it is not taken up', after?.source === 'negotiated' && after.key === before?.key, `${before?.source} -> ${after?.source}`);

  section('a key kept from before the exchange');
  /* What a device carries over from an older build, or from a backup: a
     session key on disk with nothing to say how it was made. */
  const revived = await BARAN.evaluate(async (key) => {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const record = { rawKey: PoorijaApp.arrayBufferToBase64(raw.buffer), fingerprint: key, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    chatState.sessionKeys[key] = record;
    const unknown = { peerId: 'peer-with-an-old-key', remoteFingerprint: key, conversationId: '' };
    await hydrateSessionKey(unknown);
    const negotiated = { peerId: 'peer-with-a-negotiated-key', remoteFingerprint: `${key}-other`, conversationId: '' };
    chatState.sessionKeys[negotiated.remoteFingerprint] = { ...record, fingerprint: negotiated.remoteFingerprint, source: 'negotiated' };
    await hydrateSessionKey(negotiated);
    delete chatState.sessionKeys[negotiated.remoteFingerprint];
    return { unknown: Boolean(unknown.cryptoKey), unknownKept: Boolean(chatState.sessionKeys[key]), negotiated: Boolean(negotiated.cryptoKey) };
  }, fp.ARIA);
  check('one that cannot say it was negotiated is not revived', revived.unknown === false, JSON.stringify(revived));
  check('and is dropped from the store', revived.unknownKept === false);
  check('one that was negotiated still is', revived.negotiated === true);

  section('two devices of one account');
  /* One fingerprint between them, so the rule that picks who offers the
     exchange cannot go by fingerprint. With nobody to offer and no key made
     any other way, a session between one's own devices would have no key. */
  const siblings = await ARIA.evaluate(() => {
    const mine = chatState.identity.fingerprint;
    const sortsAfter = sessionKeyOwner({ remoteFingerprint: mine, peerId: `${chatState.peerId}~` });
    const sortsBefore = sessionKeyOwner({ remoteFingerprint: mine, peerId: String(chatState.peerId).slice(0, -1) });
    return { sortsAfter, sortsBefore };
  });
  check('exactly one of them offers', siblings.sortsAfter === true && siblings.sortsBefore === false, JSON.stringify(siblings));

  section('nothing threw');
  const errors = [...ARIA.__errors, ...BARAN.__errors];
  check('no script error on either side', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await stacks.stop();
}
const bad = results.filter((r) => !r.ok);
console.log(`\n===== ${bad.length} failed of ${results.length} =====`);
process.exit(bad.length ? 1 : 0);
