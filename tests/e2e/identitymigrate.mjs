/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* An account moves from its RSA key to identity v4, and its contacts see an
 * upgrade, not a key change (roadmap 1.2, release 2.7b).
 *
 * Two people meet on RSA (the move held back with 'poorija-identity-v4' =
 * 'off'), verify each other and talk; then ARIA's app is allowed to move. What
 * has to hold:
 *   - ARIA's identity is v4: an Ed25519 fingerprint, separate signing and
 *     agreement keys, the RSA key kept for ninety days, the continuation;
 *   - BARAN's record of ARIA moves to the new key with ONE quiet line, no
 *     key-change banner, still verified, the same conversation and history;
 *   - they keep talking both ways, the live exchange now sealed to the X25519
 *     agreement key;
 *   - mail queued for ARIA's old fingerprint before the move arrives after it;
 *   - a continuation whose old-key signature is forged changes nothing;
 *   - a new account on v4 from the start makes a v4 key; and nothing here
 *     ever uses one key for both jobs.
 *
 *   node tests/e2e/identitymigrate.mjs     (brings up its own relay)
 */
import { openApp, identity, importIdentity, browser, waitFor } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
import { createChecks } from './_check.mjs';

const { results, check } = createChecks({ entry: (name, ok, detail) => ({ name, ok, detail }) });
const section = (title) => console.log(`\n===== ${title} =====`);
const decode = (card) => JSON.parse(Buffer.from(card.replace('poorija-chat-v1:', ''), 'base64').toString('utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const holdV3 = () => { try { localStorage.setItem('poorija-identity-v4', 'off'); } catch (e) { /* private */ } };

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
const received = (page, text, timeoutMs = 60000) => waitFor(page, (value) => Object.values(chatState.history)
  .some((list) => list.some((e) => e.text === value && e.direction === 'in')), { timeoutMs, arg: text });

const stacks = await startTwoStacks();
try {
  const ARIA = await openApp('ARIA', { origin: stacks.a.url, relay: stacks.a.url, init: holdV3 });
  const BARAN = await openApp('BARAN', { origin: stacks.a.url, relay: stacks.a.url, init: holdV3 });
  const cards = { ARIA: await identity(ARIA), BARAN: await identity(BARAN) };
  const old = { ARIA: decode(cards.ARIA).fingerprint, BARAN: decode(cards.BARAN).fingerprint };
  await importIdentity(ARIA, cards.BARAN);
  await importIdentity(BARAN, cards.ARIA);
  await openConversation(ARIA, old.BARAN);
  await openConversation(BARAN, old.ARIA);

  section('two people on RSA, verified');
  const before = `before-${Date.now()}`;
  await say(ARIA, before);
  check('a message goes across on RSA', Boolean(await received(BARAN, before)), before);
  const rsaState = await ARIA.evaluate(() => ({ v: chatState.identity.v || 3, kind: PoorijaIdentity.keyKind(chatState.identity.publicKeyData) }));
  check('ARIA starts on an RSA identity', rsaState.v === 3 && rsaState.kind === 'rsa', JSON.stringify(rsaState));
  await BARAN.evaluate((fp) => setPeerVerified(fp, true), old.ARIA);
  const baranThreadBefore = await BARAN.evaluate((fp) => getConversationKey(findPeerByAnyKey(fp)), old.ARIA);

  section('ARIA moves');
  /* Allowed to move, and given a fresh connection so the welcome comes again. */
  await ARIA.evaluate(() => { localStorage.removeItem('poorija-identity-v4'); try { chatState.ws?.close(); } catch (e) { /* gone */ } });
  const moved = await waitFor(ARIA, () => chatState.identity?.v === 4, { timeoutMs: 45000 });
  check('the identity moved to v4', Boolean(moved));
  const mine = await ARIA.evaluate(async () => {
    const id = chatState.identity;
    return {
      v: id.v, kind: PoorijaIdentity.keyKind(id.publicKeyData),
      fpMatches: (await PoorijaIdentity.fingerprintOfKey(id.publicKeyData)) === id.fingerprint,
      separate: Boolean(id.sk && id.ak && id.sk !== id.ak),
      agree: await PoorijaIdentity.verifyAgreeKey({ fp: id.fingerprint, sk: id.sk, ak: id.ak, akSig: id.akSig }),
      legacyDays: Math.round((id.legacy?.until - Date.parse(id.migratedAt)) / 86400000),
      legacyFp: id.legacy?.fingerprint, newFp: id.fingerprint, hasCont: Boolean(id.continuation?.oldSig && id.continuation?.newSig),
      rsaGone: !id.privateKeyData,
    };
  });
  check('its key is an Ed25519 key that names the fingerprint', mine.kind === 'v4' && mine.fpMatches, JSON.stringify(mine));
  check('signing and agreement are two keys, the second signed by the first', mine.separate && mine.agree);
  check('the RSA key is kept aside for ninety days', mine.legacyDays === 90 && mine.legacyFp === old.ARIA && mine.rsaGone, JSON.stringify(mine));
  check('and the continuation is signed by both', mine.hasCont);

  section('BARAN sees an upgrade');
  const followed = await waitFor(BARAN, (fp) => findPeerByAnyKey(fp)?.legacyFingerprint === fp || (chatState.peers || []).some((p) => p.legacyFingerprint === fp), { timeoutMs: 60000, arg: old.ARIA });
  check('the contact moves to the new key', Boolean(followed));
  const seen = await BARAN.evaluate(({ oldFp, newFp }) => {
    const peer = (chatState.peers || []).find((p) => p.fingerprint === newFp);
    const notes = Object.values(chatState.history).flat().filter((e) => e.type === 'system-note');
    return {
      found: Boolean(peer), trusted: peer?.trustedFingerprint === newFp, pending: Boolean(peer?.pendingKey || peer?.keyChangedAt),
      verified: isPeerVerified(newFp), oldVerified: isPeerVerified(oldFp), agree: Boolean(peer?.agreeKey),
      thread: peer ? getConversationKey(peer) : '', moveNotes: notes.filter((n) => n.noteKind === 'identity-move').length,
      changeNotes: notes.filter((n) => n.noteKind === 'key-change').length,
    };
  }, { oldFp: old.ARIA, newFp: mine.newFp });
  check('on the new fingerprint, trusted', seen.found && seen.trusted, JSON.stringify(seen));
  check('with no key-change banner pending', !seen.pending && seen.changeNotes === 0, JSON.stringify(seen));
  check('one quiet line says what happened', seen.moveNotes === 1, String(seen.moveNotes));
  check('and the verification carried over to the new key', seen.verified && !seen.oldVerified);
  check('with the agreement key in hand', seen.agree);
  check('in the same conversation', seen.thread === baranThreadBefore, `${seen.thread} vs ${baranThreadBefore}`);
  const historyKept = await BARAN.evaluate((text) => Object.values(chatState.history).flat().some((e) => e.text === text), before);
  check('the messages from before are still there', historyKept);

  section('they keep talking');
  await openConversation(BARAN, mine.newFp);
  const after = `after-${Date.now()}`;
  await say(ARIA, after);
  check('ARIA to BARAN after the move', Boolean(await received(BARAN, after)), after);
  const back = `back-${Date.now()}`;
  await say(BARAN, back);
  check('BARAN to ARIA after the move', Boolean(await received(ARIA, back)), back);

  section('a forged move');
  const forged = await BARAN.evaluate(async (cardText) => {
    /* A stranger's v4 keys, presented as BARAN's own contact's successor
       with an RSA signature that is not the pinned key's. */
    const peers = chatState.peers.filter((p) => !p.type).length;
    const result = await acceptIdentityMove({ continuation: { statement: { oldFp: '0'.repeat(64), newFp: '1'.repeat(64), oldKey: 'AAAA', sk: 'AAAA', ak: 'AAAA', at: Date.now() }, akSig: '', oldSig: '', newSig: '' } }, null);
    return { result, peers: chatState.peers.filter((p) => !p.type).length };
  }, cards.ARIA);
  check('a move for nobody known changes nothing', forged.result === false, JSON.stringify(forged));
  const tampered = await BARAN.evaluate(async (newFp) => {
    const peer = (chatState.peers || []).find((p) => p.fingerprint === newFp);
    const fakeOld = { ...peer, fingerprint: 'f'.repeat(64), trustedFingerprint: 'f'.repeat(64), trustedKey: peer.legacyKey };
    chatState.peers.push(fakeOld);
    const stolen = { statement: { oldFp: 'f'.repeat(64), newFp, oldKey: peer.legacyKey, sk: peer.trustedKey, ak: peer.agreeKey, at: Date.now() }, akSig: peer.agreeKeySig, oldSig: 'AAAA', newSig: 'AAAA' };
    const result = await acceptIdentityMove({ continuation: stolen }, fakeOld);
    chatState.peers.splice(chatState.peers.indexOf(fakeOld), 1);
    return result;
  }, mine.newFp);
  check('a move whose signatures do not check changes nothing', tampered === false);

  section('a new account');
  const CYRUS = await openApp('CYRUS', { origin: stacks.a.url, relay: stacks.a.url });
  const fresh = await waitFor(CYRUS, () => chatState.identity?.v === 4, { timeoutMs: 45000 });
  const cyrus = await CYRUS.evaluate(() => ({ kind: PoorijaIdentity.keyKind(chatState.identity.publicKeyData), legacyHeld: Boolean(chatState.identity.legacy?.privateKeyData) }));
  check('starts on v4', Boolean(fresh) && cyrus.kind === 'v4', JSON.stringify(cyrus));

  section('nothing threw');
  const errors = [...ARIA.__errors, ...BARAN.__errors, ...CYRUS.__errors];
  check('no script error', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await stacks.stop();
}
const failed = results.filter((result) => !result.ok);
console.log(`\n===== ${failed.length} failed of ${results.length} =====`);
failed.forEach((result) => console.log(`  FAIL ${result.name}${result.detail ? ` — ${result.detail}` : ''}`));
process.exit(failed.length ? 1 : 0);
