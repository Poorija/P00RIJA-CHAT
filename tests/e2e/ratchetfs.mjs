/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* A key per message (roadmap 1.3, release 2.8).
 *
 * A live session used one AES key for everything, kept in the vault and
 * revived for up to seven days, and every sealed offline envelope carried that
 * key inside it. Whoever got the vault or the memory of one device at any
 * moment of those seven days read the whole of it, both ways.
 *
 * What has to hold now, checked the way a thief would check it — by taking
 * what is on the device after the messages were read and trying it on frames
 * that really crossed the wire:
 *   - every message is under a key of its own (no two payloads share one);
 *   - nothing the device holds afterwards (the session's key, the vault's
 *     stores) opens a message that was already read;
 *   - the vault no longer holds a session key for the contact;
 *   - a sealed offline envelope carries no session key;
 *   - messages that cross out of order, live and through the relay, all open
 *     exactly once; and the chains survive a reload.
 *
 *   node tests/e2e/ratchetfs.mjs      (brings up its own relay)
 */
import { openApp, identity, importIdentity, browser, waitFor, PASS } from './_chat-harness.mjs';
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
const received = (page, text, timeoutMs = 60000) => waitFor(page, (value) => Object.values(chatState.history)
  .some((list) => list.some((e) => e.text === value && e.direction === 'in')), { timeoutMs, arg: text });

const tap = (page) => page.evaluate(() => {
  if (window.__tapped) return;
  window.__tapped = true;
  window.__frames = [];
  const original = window.safeConnectionSend;
  window.safeConnectionSend = function tapped(connection, message, label) {
    try { if (message && message.type) window.__frames.push(JSON.parse(JSON.stringify(message))); } catch (e) { /* binary */ }
    return original.apply(this, arguments);
  };
});

const stacks = await startTwoStacks();
try {
  const ARIA = await openApp('ARIA', { origin: stacks.a.url, relay: stacks.a.url });
  const BARAN = await openApp('BARAN', { origin: stacks.a.url, relay: stacks.a.url });
  await tap(ARIA); await tap(BARAN);
  await waitFor(ARIA, () => chatState.identity?.v === 4, { timeoutMs: 30000 }).catch(() => null);
  await waitFor(BARAN, () => chatState.identity?.v === 4, { timeoutMs: 30000 }).catch(() => null);
  const cards = { ARIA: await identity(ARIA), BARAN: await identity(BARAN) };
  const fp = { ARIA: decode(cards.ARIA).fingerprint, BARAN: decode(cards.BARAN).fingerprint };
  await importIdentity(ARIA, cards.BARAN); await importIdentity(BARAN, cards.ARIA);
  await openConversation(ARIA, fp.BARAN); await openConversation(BARAN, fp.ARIA);

  section('a key for each message');
  const texts = [];
  for (let i = 0; i < 4; i += 1) {
    const value = `m${i}-${Date.now()}`;
    texts.push(value);
    await say(ARIA, value);
    await received(BARAN, value);
  }
  const sent = await ARIA.evaluate(() => window.__frames.filter((f) => f.type === 'text').map((f) => f.payload));
  check('every message crossed on the chain', sent.length >= 4 && sent.every((p) => (p.r === 1 || p.r === 2) && typeof p.c === 'string'), JSON.stringify(sent.map((p) => ({ r: p.r, n: p.n }))));
  check('each with its own number', new Set(sent.map((p) => p.n)).size === sent.length, JSON.stringify(sent.map((p) => p.n)));

  section('what is left on the device opens nothing already read');
  const theft = await BARAN.evaluate(async ({ key, payloads }) => {
    const peer = findPeerByAnyKey(key);
    const session = chatState.sessions.get(peer.peerId);
    const tried = [];
    /* The session's own key, as the old code would have used it. */
    for (const p of payloads) {
      try {
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(p.iv) }, session.cryptoKey, PoorijaApp.base64ToArrayBuffer(p.cipher));
        tried.push('session-key-opened');
      } catch (e) { tried.push('no'); }
    }
    /* The chain as it is now, as a thief would take it: every one read is a replay. */
    const stolen = { ...session, ratchet: JSON.parse(JSON.stringify(session.ratchet)) };
    for (const p of payloads) {
      try { await PoorijaRatchet.open(stolen, p, { kind: 'text', from: session.remoteFingerprint, to: chatState.identity.fingerprint, fingerprint: '' }); tried.push('chain-opened'); } catch (e) { tried.push(e?.name || 'no'); }
    }
    const vault = chatState.sessionKeys[peer.peerId] || chatState.sessionKeys[key] || null;
    return { tried, vaultKey: Boolean(vault?.rawKey), skippedHeld: Object.keys(session.ratchet.recv.skipped || {}).length };
  }, { key: fp.ARIA, payloads: sent });
  check('the session key opens none of them', !theft.tried.includes('session-key-opened'), JSON.stringify(theft.tried));
  check('the chain as it stands opens none of them', !theft.tried.includes('chain-opened'), JSON.stringify(theft.tried));
  check('the vault holds no session key for the contact', theft.vaultKey === false);
  check('and no key is kept for a message already read', theft.skippedHeld === 0, String(theft.skippedHeld));

  section('out of order, and twice');
  const order = await BARAN.evaluate(async (key) => {
    const peer = findPeerByAnyKey(key);
    const session = chatState.sessions.get(peer.peerId);
    return { n: session.ratchet.recv.n };
  }, fp.ARIA);
  const make = await ARIA.evaluate(async (key) => {
    const peer = findPeerByAnyKey(key);
    const session = chatState.sessions.get(peer.peerId);
    const out = [];
    for (let i = 0; i < 3; i += 1) {
      const payload = await encryptForSession(session, new TextEncoder().encode(`ooo-${i}`), 'text');
      out.push({ type: 'text', id: `ooo-${i}-${Date.now()}`, createdAt: new Date().toISOString(), expiresAt: '', timerSeconds: 0, payload });
    }
    return out;
  }, fp.BARAN);
  const deliver = (frame) => BARAN.evaluate(async ({ key, frame }) => {
    const session = chatState.sessions.get(findPeerByAnyKey(key).peerId);
    try { await handleSessionMessage(session, frame); return 'ok'; } catch (e) { return e?.name || 'err'; }
  }, { key: fp.ARIA, frame });
  await deliver(make[2]); await deliver(make[0]); await deliver(make[1]);
  await sleep(400);
  const counts = await Promise.all([0, 1, 2].map((i) => countIn(BARAN, `ooo-${i}`)));
  check('three messages delivered 3, 1, 2 all open', counts.every((c) => c === 1), JSON.stringify(counts));
  const again = await deliver({ ...make[0], id: `${make[0].id}-again` });
  await sleep(300);
  check('and a copy of one is refused', (await countIn(BARAN, 'ooo-0')) === 1, again);
  void order;

  section('a sealed envelope');
  const envelope = await ARIA.evaluate(async (key) => {
    const peer = findPeerByAnyKey(key);
    const session = chatState.sessions.get(peer.peerId);
    let captured = null;
    const realSend = window.sendRelayEnvelope;
    window.sendRelayEnvelope = (record, env) => { captured = env; return true; };
    try {
      const payload = await encryptForSession(session, new TextEncoder().encode('sealed-one'), 'text');
      await sendSealedRelay(peer, session, { type: 'text', id: `sealed-${Date.now()}`, createdAt: new Date().toISOString(), payload }, {});
    } finally { window.sendRelayEnvelope = realSend; }
    return captured ? JSON.stringify(captured) : '';
  }, fp.BARAN);
  check('an envelope was made', envelope.length > 0);
  check('it carries no session key', !/sessionKeyRaw":"[A-Za-z0-9+/]/.test(envelope), envelope.slice(0, 120));

  section('after a reload');
  const chainBefore = await BARAN.evaluate((key) => chatState.sessions.get(findPeerByAnyKey(key).peerId)?.ratchet?.recv?.id || '', fp.ARIA);
  await BARAN.evaluate(() => PoorijaRatchet.flush());
  await sleep(300);
  await BARAN.reload({ waitUntil: 'load' });
  await sleep(2200);
  await BARAN.evaluate((pass) => { const el = document.getElementById('unlockPassword'); if (el) { el.value = pass; el.dispatchEvent(new Event('input', { bubbles: true })); } }, PASS);
  await BARAN.evaluate(() => window.unlockApp?.());
  await sleep(4500);
  await BARAN.evaluate(() => window.switchTab?.('chat'));
  await waitFor(BARAN, () => typeof isChatInitialized !== 'undefined' && isChatInitialized && chatState.ws?.readyState === 1, { timeoutMs: 40000 }).catch(() => null);
  const restored = await BARAN.evaluate((key) => {
    const peer = findPeerByAnyKey(key);
    const s = { remoteFingerprint: peer?.fingerprint || key };
    return PoorijaRatchet.restore(s, s.remoteFingerprint) ? s.ratchet.recv.id : '';
  }, fp.ARIA);
  check('the chains are kept across the reload', Boolean(restored) && restored === chainBefore, `${restored} vs ${chainBefore}`);
  const after = `after-reload-${Date.now()}`;
  await say(ARIA, after);
  check('the conversation goes on, on the chains kept', Boolean(await received(BARAN, after, 90000)), after);

  section('nothing threw');
  const errors = [...ARIA.__errors];
  check('no script error', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await stacks.stop();
}
const failed = results.filter((result) => !result.ok);
console.log(`\n===== ${failed.length} failed of ${results.length} =====`);
failed.forEach((result) => console.log(`  FAIL ${result.name}${result.detail ? ` — ${result.detail}` : ''}`));
process.exit(failed.length ? 1 : 0);
