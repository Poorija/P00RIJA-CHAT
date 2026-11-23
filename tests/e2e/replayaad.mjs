/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* A ciphertext belongs to one session, one sender, one recipient, one kind
 * and one place in the order — and a copy of it is refused (roadmap 1.1).
 *
 * Before, every payload under a session key was AES-GCM with no additional
 * data. Whoever carried the traffic could hand the same `text` frame in
 * twice and it was shown twice; could take the payload of a `text` and
 * deliver it as an `edit` that rewrote an older message; and could take a
 * payload BARAN sent to ARIA and show it to ARIA as if ARIA had... nothing
 * in the ciphertext said who wrote it or for whom.
 *
 * The checks here are made the way a hostile path would make them: by
 * replaying, re-typing and re-addressing frames that really went out, and
 * by stripping the binding from a contact who has already shown they use it.
 *
 *   node tests/e2e/replayaad.mjs      (brings up its own relay)
 */
import { openApp, identity, importIdentity, browser, waitFor } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
import { createChecks } from './_check.mjs';

const { results, check } = createChecks({ entry: (name, ok, detail) => ({ name, ok, detail }) });
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
const countIn = (page, text) => page.evaluate((value) => Object.values(chatState.history)
  .reduce((n, list) => n + list.filter((e) => e.text === value && e.direction === 'in').length, 0), text);
const received = (page, text, timeoutMs = 45000) => waitFor(page, (value) => Object.values(chatState.history)
  .some((list) => list.some((e) => e.text === value && e.direction === 'in')), { timeoutMs, arg: text });

/* Every frame that leaves through safeConnectionSend, kept as sent. */
const tap = (page) => page.evaluate(() => {
  if (window.__tapped) return;
  window.__tapped = true;
  window.__frames = [];
  const original = window.safeConnectionSend;
  window.__sendThrough = original;
  window.safeConnectionSend = function tapped(connection, message, label) {
    try { if (message && message.type) window.__frames.push(JSON.parse(JSON.stringify(message))); } catch (e) { /* binary */ }
    return original.apply(this, arguments);
  };
});
/* Hands a frame to the receiver exactly as if it had come down the channel. */
const inject = (page, fp, frame) => page.evaluate(async ({ key, frame }) => {
  const peer = findPeerByAnyKey(key);
  const session = chatState.sessions.get(peer.peerId);
  try { await handleSessionMessage(session, frame); return 'handled'; } catch (error) { return `threw ${error?.name || error}`; }
}, { key: fp, frame });
const lastFrame = (page, type, predicate = '') => page.evaluate(({ type, predicate }) => {
  const list = window.__frames.filter((f) => f.type === type);
  return list.length ? list[list.length - 1] : null;
}, { type, predicate });

const stacks = await startTwoStacks();
try {
  const ARIA = await openApp('ARIA', { origin: stacks.a.url, relay: stacks.a.url });
  const BARAN = await openApp('BARAN', { origin: stacks.a.url, relay: stacks.a.url });
  const CYRUS = await openApp('CYRUS', { origin: stacks.a.url, relay: stacks.a.url });
  await tap(ARIA); await tap(BARAN); await tap(CYRUS);
  const cards = { ARIA: await identity(ARIA), BARAN: await identity(BARAN), CYRUS: await identity(CYRUS) };
  const fp = Object.fromEntries(Object.entries(cards).map(([k, v]) => [k, decode(v).fingerprint]));
  await importIdentity(ARIA, cards.BARAN); await importIdentity(BARAN, cards.ARIA);
  await importIdentity(ARIA, cards.CYRUS); await importIdentity(CYRUS, cards.ARIA);
  await openConversation(ARIA, fp.BARAN);
  await openConversation(BARAN, fp.ARIA);

  section('a live session is bound');
  const first = `first-${Date.now()}`;
  await say(ARIA, first);
  check('a message goes across', Boolean(await received(BARAN, first)), first);
  const firstFrame = await lastFrame(ARIA, 'text');
  /* 1.1's binding (a: 1, seq) or, from 2.8, the ratchet's (r: 1, chain id,
     n): both bind the payload to its session, sender, recipient, kind and
     place, and a number used once is refused. */
  const p0 = firstFrame?.payload || {};
  check('the payload carries its place in the order', Number.isSafeInteger(p0.seq) || Number.isSafeInteger(p0.n), JSON.stringify({ ...p0, cipher: '…' }));
  check('and says it is bound', p0.a === 1 || ((p0.r === 1 || p0.r === 2) && typeof p0.c === 'string'), JSON.stringify({ a: p0.a, r: p0.r }));
  const back = `back-${Date.now()}`;
  await say(BARAN, back);
  check('one comes back', Boolean(await received(ARIA, back)), back);

  section('the same frame, again');
  /* The outer id is not what is protected — it travels beside the
     ciphertext and anyone on the path can write a new one. */
  const replay = await inject(BARAN, fp.ARIA, { ...firstFrame, id: `${firstFrame.id}-again` });
  await sleep(600);
  check('a replayed text under a new id is not shown twice', (await countIn(BARAN, first)) === 1, `${await countIn(BARAN, first)} copies, ${replay}`);
  check('it is refused as a replay, not as a broken key', replay === 'threw SessionPayloadRefused', replay);
  /* Through the channel's own data handler this time, which renegotiates on
     a broken key: a replay must not be a way to reset the session. */
  const keyBefore = await BARAN.evaluate(async (key) => {
    const session = chatState.sessions.get(findPeerByAnyKey(key).peerId);
    return PoorijaApp.arrayBufferToBase64(await crypto.subtle.exportKey('raw', session.cryptoKey));
  }, fp.ARIA);
  await BARAN.evaluate(({ key, frame }) => {
    const session = chatState.sessions.get(findPeerByAnyKey(key).peerId);
    session.connection.emit('data', frame);
  }, { key: fp.ARIA, frame: { ...firstFrame, id: `${firstFrame.id}-third` } });
  await sleep(1500);
  const keyAfter = await BARAN.evaluate(async (key) => {
    const session = chatState.sessions.get(findPeerByAnyKey(key).peerId);
    return session.cryptoKey ? PoorijaApp.arrayBufferToBase64(await crypto.subtle.exportKey('raw', session.cryptoKey)) : '';
  }, fp.ARIA);
  check('and a replay through the channel does not renegotiate the session', keyAfter === keyBefore && Boolean(keyAfter));
  check('nor is it shown', (await countIn(BARAN, first)) === 1);

  section('many sessions later, an old one still refuses its replays');
  /* The windows of numbers seen were kept for the 256 most recently used
     session ids: after 300 other sessions, the first session's window was
     gone, and a frame of it could be opened again. Kept by age now (past a
     session key's lifetime), not by count. */
  const longAfter = await BARAN.evaluate(async () => {
    const A = PoorijaSessionAad;
    const mk = async () => ({ cryptoKey: await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']) });
    const opt = { kind: 'text', from: 'a'.repeat(64), to: 'b'.repeat(64) };
    const first = await mk();
    const frame = await A.seal(first, new TextEncoder().encode('once'), opt);
    await A.open(first, frame, opt);
    for (let i = 0; i < 300; i++) { const s = await mk(); await A.open(s, await A.seal(s, new TextEncoder().encode('x'), opt), opt); }
    await new Promise((r) => setTimeout(r, 400));
    A.reset();
    try { await A.open(first, frame, opt); return 'opened again'; } catch (error) { return `refused: ${error?.name}`; }
  });
  check('after 300 other sessions and a reload of the windows, the first session\'s frame is still refused', /^refused: Replay/.test(longAfter), longAfter);

  section('a session key is never sealed to the identity key of a contact with more');
  const sealed = await ARIA.evaluate(async (key) => {
    const peer = findPeerByAnyKey(key);
    const session = chatState.sessions.get(peer.peerId);
    const live = await sealSessionKeyFor(session, peer);
    /* And for a contact only pinned (no live ratchet on this session). */
    const bare = { cryptoKey: await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']) };
    const pinned = await sealSessionKeyFor(bare, { ...peer, kexPinned: 3 });
    const legacy = await sealSessionKeyFor(bare, { ...peer, kexPinned: 0, ratchetPinned: 0 });
    return { ratchet: Boolean(session?.ratchet), live, pinned, legacy: legacy.length > 0 };
  }, fp.BARAN);
  check('with a ratchet or a hybrid pin, no identity seal of the session key is made (a contact with neither still gets one)', sealed.ratchet && sealed.live === '' && sealed.pinned === '' && sealed.legacy, JSON.stringify(sealed));

  section('the same ciphertext, as another kind of message');
  /* An edit of the first message whose new text is the payload of a later one. */
  const later = `later-${Date.now()}`;
  await say(ARIA, later);
  await received(BARAN, later);
  const laterFrame = await lastFrame(ARIA, 'text');
  const retyped = await inject(BARAN, fp.ARIA, { type: 'edit', messageId: firstFrame.id, payload: laterFrame.payload, createdAt: new Date().toISOString() });
  await sleep(600);
  const edited = await BARAN.evaluate((id) => Object.values(chatState.history).flat().find((e) => e.id === id)?.text, firstFrame.id);
  check('a text payload delivered as an edit does not rewrite anything', edited === first, `${edited} (${retyped})`);

  section('a payload moved to another conversation');
  /* CYRUS and ARIA have a session of their own. A payload ARIA sent BARAN,
     handed to ARIA's session with CYRUS's fingerprint on it, or to another
     session altogether, must not open. */
  await openConversation(ARIA, fp.CYRUS);
  await openConversation(CYRUS, fp.ARIA);
  const toCyrus = `cyrus-${Date.now()}`;
  await say(ARIA, toCyrus);
  check('ARIA and CYRUS talk', Boolean(await received(CYRUS, toCyrus)), toCyrus);
  /* The direct form: under BARAN's own session with ARIA, swap who the
     frame says it is between. A frame ARIA sent is opened by BARAN as from
     ARIA; the same bytes opened as if BARAN had sent them to ARIA must fail. */
  const swapped = await BARAN.evaluate(async ({ key, frame }) => {
    const peer = findPeerByAnyKey(key);
    const session = chatState.sessions.get(peer.peerId);
    try {
      const names = { kind: 'text', from: chatState.identity.fingerprint, to: session.remoteFingerprint };
      if (frame.payload.r) await PoorijaRatchet.open(session, frame.payload, { ...names, fingerprint: session.remoteFingerprint });
      else await PoorijaSessionAad.open(session, frame.payload, names);
      return 'opened';
    } catch (error) { return error?.name || String(error); }
  }, { key: fp.ARIA, frame: firstFrame });
  check('a payload read as written the other way round does not open', swapped === 'OperationError' || swapped === 'ChainError', swapped);

  section('a contact who binds cannot be talked out of it');
  const pinned = await BARAN.evaluate((key) => { const p = findPeerByAnyKey(key); return Boolean(p?.aadPinned || p?.ratchetPinned); }, fp.ARIA);
  check('BARAN remembers that ARIA binds', pinned === true);
  const plain = await ARIA.evaluate(async (key) => {
    const peer = findPeerByAnyKey(key);
    const session = chatState.sessions.get(peer.peerId);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, session.cryptoKey, new TextEncoder().encode('stripped'));
    return { iv: Array.from(iv), cipher: PoorijaApp.arrayBufferToBase64(cipher) };
  }, fp.BARAN);
  const strippedFrame = { type: 'text', id: `strip-${Date.now()}`, createdAt: new Date().toISOString(), expiresAt: '', timerSeconds: 0, payload: plain };
  await inject(BARAN, fp.ARIA, strippedFrame);
  await sleep(600);
  check('an unbound payload from a contact who binds is refused', (await countIn(BARAN, 'stripped')) === 0, `${await countIn(BARAN, 'stripped')} shown`);

  section('a counter that goes back');
  const counterBack = await BARAN.evaluate(async ({ key, frame }) => {
    const peer = findPeerByAnyKey(key);
    const session = chatState.sessions.get(peer.peerId);
    const stale = frame.payload.r ? { ...frame.payload, n: frame.payload.n + 1 } : { ...frame.payload, seq: frame.payload.seq - 100000000 };
    try { await decryptForSession(session, stale, 'text'); return 'opened'; } catch (error) { return error?.name || String(error); }
  }, { key: fp.ARIA, frame: firstFrame });
  check('a number changed on the way does not open', counterBack === 'OperationError' || counterBack === 'SessionPayloadRefused', counterBack);

  section('the replay window is kept');
  /* Written with the other stores (the 1.1 window, or the ratchet's chain
     position), so reopening the app is not a way to have a frame accepted a
     second time. */
  const kept = await BARAN.evaluate(async (key) => {
    const peer = findPeerByAnyKey(key);
    const session = chatState.sessions.get(peer.peerId);
    /* The position on the receiving chain (and, on 2.9, the steps it took). */
    return session.ratchet ? (session.ratchet.recv?.n || 0) + Object.keys(session.ratchet.chains || {}).length * 1000 + (session.ratchet.v === 2 ? 1 : 0) : await PoorijaSessionAad.seenCount(session);
  }, fp.ARIA);
  check('the numbers seen are remembered for the session', kept >= 2, String(kept));

  section('nothing threw');
  const errors = [...ARIA.__errors, ...CYRUS.__errors];
  check('no script error', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await stacks.stop();
}
const failed = results.filter((result) => !result.ok);
console.log(`\n===== ${failed.length} failed of ${results.length} =====`);
failed.forEach((result) => console.log(`  FAIL ${result.name}${result.detail ? ` — ${result.detail}` : ''}`));
process.exit(failed.length ? 1 : 0);
