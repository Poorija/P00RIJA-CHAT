/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text.
 */

/* A conversation recorded today is not readable when the curve falls.
 *
 * A live session's key used to come from one exchange, on P-256, sealed under
 * RSA. Both are things a large quantum computer breaks, and a conversation
 * can be recorded now and kept until one exists. The exchange now carries a
 * second secret, by ML-KEM-768, and the session key is derived from both.
 *
 * What can go wrong with that is quieter than a crash:
 *
 *   THE SECOND SECRET IS NOT REALLY IN THE KEY. Then everything works and
 *     nothing was gained. So the key is recomputed here from the first
 *     secret alone, and must NOT match.
 *   IT CAN BE TAKEN OUT. An attacker who cannot break it removes it. So a
 *     contact who has done the hybrid exchange once must be refused when the
 *     second secret is missing, in either direction.
 *   IT CAN BE SWAPPED. The ML-KEM key travels in the clear. Somebody in the
 *     middle who replaced it would hold half the secret; the signature over
 *     it is what stops that, so a swapped key must end with no session key.
 *   ONE SIDE TALKS UNDER A KEY THE OTHER LACKS. The side that answers holds
 *     the key first; it must not use it until the other shows it has it.
 *
 *   node tests/e2e/hybrid.mjs      (brings up its own relay)
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

/* On the one function every frame of a live session leaves through.
   `__hold` swallows a frame type; `__rewrite` may change a frame on its way
   out, which is what somebody in the middle does; `__frames` keeps what left,
   and `__seen` what arrived. */
const tap = (page) => page.evaluate(() => {
  if (window.__tapped) return;
  window.__tapped = true;
  window.__frames = [];
  window.__hold = new Set();
  window.__rewrite = null;
  const original = window.safeConnectionSend;
  window.__sendThrough = original;
  window.safeConnectionSend = function tapped(connection, message, label) {
    let out = message;
    if (out && out.type && typeof window.__rewrite === 'function') out = window.__rewrite(JSON.parse(JSON.stringify(out))) || out;
    if (out && out.type) window.__frames.push(JSON.parse(JSON.stringify(out)));
    if (out && out.type && window.__hold.has(out.type)) return true;
    return original.call(this, connection, out, label);
  };
});
const sessionOf = (page, fp) => page.evaluate(async (key) => {
  const peer = findPeerByAnyKey(key);
  const session = peer && chatState.sessions.get(peer.peerId);
  if (!session) return null;
  let raw = '';
  if (session.cryptoKey) raw = Array.from(new Uint8Array(await crypto.subtle.exportKey('raw', session.cryptoKey))).map((b) => b.toString(16).padStart(2, '0')).join('');
  /* `fresh` is a key this connection exchanged, as against one revived from
     the connection before it (hydrateSessionKey), which is the old key both
     sides already held and is no sign of a new exchange. */
  return { ready: Boolean(session.keyReady), source: session.keySource || '', hybrid: Boolean(session.keyHybrid), key: raw,
    fresh: Boolean(session.cryptoKey) && session.keySource === 'negotiated' && session.keyNegotiatedFor === session.connection,
    pending: Boolean(session.kexPending), owner: sessionKeyOwner(session), pinned: findPeerByAnyKey(key)?.kexPinned || 0 };
}, fp);
const closeSession = (page, fp) => page.evaluate((key) => {
  const peer = findPeerByAnyKey(key);
  const session = peer && chatState.sessions.get(peer.peerId);
  try { session?.connection?.close(); } catch (e) { /* gone */ }
  if (peer) chatState.sessions.delete(peer.peerId);
}, fp);
const keyed = (page, fp, timeoutMs = 60000) => waitFor(page, (key) => {
  const peer = findPeerByAnyKey(key);
  const session = peer && chatState.sessions.get(peer.peerId);
  return Boolean(session?.keyReady && session.cryptoKey && session.connection?.open);
}, { timeoutMs, arg: fp });
const reconnect = async (A, B, fpA, fpB, text) => {
  await closeSession(A, fpB);
  await closeSession(B, fpA);
  await A.evaluate(() => { window.__frames = []; });
  await B.evaluate(() => { window.__frames = []; });
  await sleep(900);
  await say(A, text);
};

const stacks = await startTwoStacks();
try {
  const DARA = await openApp('DARA', { origin: stacks.a.url, relay: stacks.a.url });
  const NILU = await openApp('NILU', { origin: stacks.a.url, relay: stacks.a.url });
  await tap(DARA);
  await tap(NILU);
  for (const [name, page] of [['DARA', DARA], ['NILU', NILU]]) {
    page.on('pageerror', (e) => console.log(`  STACK ${name} ` + String(e.stack || e.message).split('\n').slice(0, 5).map((l) => l.trim().replace(/https?:\/\/[^/]+/, '')).join(' | ').slice(0, 420)));
  }
  const cards = { DARA: await identity(DARA), NILU: await identity(NILU) };
  const fp = { DARA: decode(cards.DARA).fingerprint, NILU: decode(cards.NILU).fingerprint };
  await importIdentity(DARA, cards.NILU);
  await importIdentity(NILU, cards.DARA);
  await openConversation(DARA, fp.NILU);
  await openConversation(NILU, fp.DARA);
  await say(DARA, `hello-${Date.now()}`);
  await Promise.all([keyed(DARA, fp.NILU), keyed(NILU, fp.DARA)]);

  section('two builds that can');
  const a = await sessionOf(DARA, fp.NILU);
  const b = await sessionOf(NILU, fp.DARA);
  const [OFFERER, ANSWERER] = a?.owner ? [DARA, NILU] : [NILU, DARA];
  const fpOf = (page) => (page === DARA ? fp.DARA : fp.NILU);
  console.log('  ' + JSON.stringify({ dara: { ...a, key: a?.key ? 'set' : '' }, nilu: { ...b, key: b?.key ? 'set' : '' } }));
  check('the session key came from the hybrid exchange, on both sides', a?.hybrid === true && b?.hybrid === true && a.source === 'negotiated' && b.source === 'negotiated');
  check('and it is the same key', Boolean(a?.key) && a.key === b?.key);
  const offer = (await OFFERER.evaluate(() => window.__frames.find((f) => f.type === 'kex-offer'))) || {};
  const answer = (await ANSWERER.evaluate(() => window.__frames.find((f) => f.type === 'kex-answer'))) || {};
  const confirm = (await OFFERER.evaluate(() => window.__frames.find((f) => f.type === 'kex-confirm'))) || {};
  const bytes = (b64) => (b64 ? Buffer.from(b64, 'base64').length : 0);
  check('the offer carries an ML-KEM-768 public key, signed', offer.v === 3 && bytes(offer.pq) === 1184 && bytes(offer.sig) >= 64, `${bytes(offer.pq)} bytes, sig ${bytes(offer.sig)}`);
  check('the answer carries an ML-KEM-768 ciphertext, signed', answer.v === 3 && bytes(answer.pqct) === 1088 && bytes(answer.sig) >= 64, `${bytes(answer.pqct)} bytes, sig ${bytes(answer.sig)}`);
  check('and the offerer confirms the key before either uses it', Boolean(confirm.tag) && confirm.kid === offer.kid);
  const pins = { dara: a?.pinned, nilu: b?.pinned };
  check('each remembers the other can do it', pins.dara === 3 && pins.nilu === 3, JSON.stringify(pins));
  const live = `under-the-hybrid-key-${Date.now()}`;
  await say(DARA, live);
  check('a message goes across under it', await received(NILU, live), live);

  section('what was seen is still known tomorrow');
  /* The refusal below rests on remembering that this contact can do the
     hybrid exchange. Contacts are written to storage through one function,
     and a field that function does not name is gone when the app next opens
     — taking the refusal with it, silently. So: write, read back as the app
     does on opening, and look. */
  const kept = await DARA.evaluate((key) => {
    saveContacts();
    const stored = loadEncrypted(CHAT_CONTACTS_STORAGE_KEY, []);
    const reopened = stored.map((peer) => normalizePeerRecord(peer));
    const record = reopened.find((peer) => peer.fingerprint === key);
    return { stored: stored.find((peer) => peer.fingerprint === key)?.kexPinned || 0, reopened: record?.kexPinned || 0 };
  }, fp.NILU);
  check('the contact is stored as one who can, and read back as one', kept.stored === 3 && kept.reopened === 3, JSON.stringify(kept));
  const outside = await DARA.evaluate((key) => {
    const record = findPeerByAnyKey(key);
    /* The relay repeats their presence with the mark cleared, then absent. */
    mergePeerRecord({ peerId: record.peerId, clientId: record.clientId, publicKeyData: record.publicKeyData, fingerprint: record.fingerprint, status: 'online', kexPinned: 0 }, { online: true });
    const afterCleared = findPeerByAnyKey(key).kexPinned || 0;
    mergePeerRecord({ peerId: record.peerId, clientId: record.clientId, publicKeyData: record.publicKeyData, fingerprint: record.fingerprint, status: 'online' }, { online: true });
    const afterAbsent = findPeerByAnyKey(key).kexPinned || 0;
    /* And a stranger arrives already marked, which only this device may do. */
    const stranger = mergePeerRecord({ peerId: 'poorija-peer-stranger-0001', clientId: 'stranger-0001', username: 'stranger', fingerprint: 'ab'.repeat(32), publicKeyData: record.publicKeyData.split('').reverse().join(''), status: 'online', kexPinned: 3 }, { online: true });
    const strangerPinned = stranger ? (stranger.kexPinned || 0) : -1;
    chatState.peers = chatState.peers.filter((peer) => peer.peerId !== 'poorija-peer-stranger-0001');
    return { afterCleared, afterAbsent, strangerPinned };
  }, fp.NILU);
  check('a record from outside cannot clear it', outside.afterCleared === 3 && outside.afterAbsent === 3, JSON.stringify(outside));
  check('nor mark a contact this device has not seen do it', outside.strangerPinned === 0, String(outside.strangerPinned));

  section('the second secret is really in the key');
  /* The session key as it would be if only the curve's secret went in: the
     classical exchange's own derivation, from the two ephemeral halves. The
     offerer's private half is gone by now, as it should be, so the test keeps
     the classical label and shows the keys differ by construction: a hybrid
     session must never produce the key the classical label gives for it. */
  const classicalWouldBe = await OFFERER.evaluate(async () => {
    /* Two fresh halves, both derivations, side by side. */
    const left = await generateEcdhPair();
    const right = await generateEcdhPair();
    const classical = await deriveSharedAesKey(left.keyPair.privateKey, right.keyPair.publicKey, 'poorija-session-v2');
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const hybrid = (await deriveHybridKeys(left.keyPair.privateKey, right.keyPair.publicKey, secret, 'transcript')).cryptoKey;
    const other = (await deriveHybridKeys(left.keyPair.privateKey, right.keyPair.publicKey, crypto.getRandomValues(new Uint8Array(32)), 'transcript')).cryptoKey;
    const moved = (await deriveHybridKeys(left.keyPair.privateKey, right.keyPair.publicKey, secret, 'another transcript')).cryptoKey;
    const hex = async (key) => Array.from(new Uint8Array(await crypto.subtle.exportKey('raw', key))).map((x) => x.toString(16).padStart(2, '0')).join('');
    return { classical: await hex(classical), hybrid: await hex(hybrid), other: await hex(other), moved: await hex(moved) };
  });
  check('the same curve secret gives a different key once the second secret is added', classicalWouldBe.hybrid !== classicalWouldBe.classical);
  check('a different second secret gives a different key', classicalWouldBe.hybrid !== classicalWouldBe.other);
  check('and so does a different exchange around the same two secrets', classicalWouldBe.hybrid !== classicalWouldBe.moved);

  section('the second secret is taken out of the offer');
  /* What somebody who cannot break it would do: strip it, and hope the two
     fall back to the exchange they can break. These two have done the hybrid
     exchange, so this must not be an exchange at all. */
  await OFFERER.evaluate(() => { window.__rewrite = (m) => { if (m.type === 'kex-offer') { delete m.pq; delete m.sig; delete m.v; } return m; }; });
  await reconnect(DARA, NILU, fp.DARA, fp.NILU, `stripped-offer-${Date.now()}`);
  await sleep(9000);
  const strippedOffer = [await sessionOf(DARA, fp.NILU), await sessionOf(NILU, fp.DARA)];
  check('no session key comes of it', strippedOffer.every((s) => !s || !s.fresh), JSON.stringify(strippedOffer.map((s) => s && { fresh: s.fresh, source: s.source, hybrid: s.hybrid })));
  await OFFERER.evaluate(() => { window.__rewrite = null; });

  section('the second secret is taken out of the answer');
  await ANSWERER.evaluate(() => { window.__rewrite = (m) => { if (m.type === 'kex-answer') { delete m.pqct; delete m.sig; delete m.v; } return m; }; });
  await reconnect(DARA, NILU, fp.DARA, fp.NILU, `stripped-answer-${Date.now()}`);
  await sleep(9000);
  const strippedAnswer = await sessionOf(OFFERER, fpOf(ANSWERER));
  check('the side that offered it does not settle for less', !strippedAnswer || !strippedAnswer.fresh, JSON.stringify(strippedAnswer && { fresh: strippedAnswer.fresh, source: strippedAnswer.source, hybrid: strippedAnswer.hybrid }));
  await ANSWERER.evaluate(() => { window.__rewrite = null; });

  section('the ML-KEM key is swapped on the way');
  /* Somebody in the middle puts their own key where the offerer's was. If it
     were accepted they would hold the second secret. */
  await OFFERER.evaluate(() => {
    window.__theirs = PoorijaMlKem.keygen();
    window.__rewrite = (m) => {
      if (m.type === 'kex-offer' && m.pq) m.pq = PoorijaApp.arrayBufferToBase64(window.__theirs.publicKey.buffer.slice(0, 1184));
      return m;
    };
  });
  await reconnect(DARA, NILU, fp.DARA, fp.NILU, `swapped-${Date.now()}`);
  await sleep(9000);
  const swapped = [await sessionOf(DARA, fp.NILU), await sessionOf(NILU, fp.DARA)];
  const answeredSwap = await ANSWERER.evaluate(() => window.__frames.some((f) => f.type === 'kex-answer'));
  check('the swapped key is not answered', answeredSwap === false);
  check('and no session key comes of it', swapped.every((s) => !s || !s.fresh), JSON.stringify(swapped.map((s) => s && { fresh: s.fresh, source: s.source })));
  await OFFERER.evaluate(() => { window.__rewrite = null; });

  section('the confirmation is held');
  await OFFERER.evaluate(() => { window.__hold = new Set(['kex-confirm']); });
  await reconnect(DARA, NILU, fp.DARA, fp.NILU, `unconfirmed-${Date.now()}`);
  await waitFor(OFFERER, () => window.__frames.some((f) => f.type === 'kex-confirm'), { timeoutMs: 40000 });
  await sleep(1500);
  const unconfirmed = await sessionOf(ANSWERER, fpOf(OFFERER));
  check('the side that answered holds the key and does not use it', unconfirmed?.pending === true && !unconfirmed.key && unconfirmed.ready === false, JSON.stringify(unconfirmed && { pending: unconfirmed.pending, ready: unconfirmed.ready, key: Boolean(unconfirmed.key) }));
  await OFFERER.evaluate(() => { window.__hold = new Set(); });

  section('left alone again');
  await reconnect(DARA, NILU, fp.DARA, fp.NILU, `again-${Date.now()}`);
  const backA = await keyed(DARA, fp.NILU);
  const backB = await keyed(NILU, fp.DARA);
  const endA = await sessionOf(DARA, fp.NILU);
  const endB = await sessionOf(NILU, fp.DARA);
  check('they exchange a hybrid key again', Boolean(backA) && Boolean(backB) && endA?.hybrid === true && endB?.hybrid === true && endA.key === endB.key);
  const last = `after-all-that-${Date.now()}`;
  await say(DARA, last);
  check('and a message goes across', await received(NILU, last), last);

  section('nothing threw');
  const errors = [...DARA.__errors, ...NILU.__errors];
  check('no script error on either side', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await stacks.stop();
}
const bad = results.filter((r) => !r.ok);
console.log(`\n===== ${bad.length} failed of ${results.length} =====`);
process.exit(bad.length ? 1 : 0);
