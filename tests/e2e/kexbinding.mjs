/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* The key exchange's signature covers its version and its ratchet fields
 * (binding 4, cap kx4; roadmap 5.2 finding F1).
 *
 * Binding 3 signed the key material and nothing about how the session is to
 * be keyed: whoever carried an offer could take `dr`, `rp` and `rq` out (or
 * change them) and the signature still held; only a pin set on an earlier
 * contact refused it. Here, made the way a hostile path would make them:
 *   - two current apps sign at binding 4, and each pins the other there;
 *   - an offer whose ratchet fields were changed in flight is refused, its
 *     signature still the sender's;
 *   - an offer signed the old way from a contact pinned at 4 is refused;
 *   - and after all that a message still crosses.
 *
 *   node tests/e2e/kexbinding.mjs
 */
import { openApp, identity, importIdentity, waitFor } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
import { createChecks } from './_check.mjs';

const { results, check } = createChecks({ maxDetail: 300 });
const decode = (c) => JSON.parse(Buffer.from(c.replace('poorija-chat-v1:', ''), 'base64').toString('utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (page, text) => page.evaluate((value) => {
  const box = document.getElementById('chatComposer');
  box.value = value; box.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('chatSendMessageBtn').click();
}, text);
const received = (page, text, timeoutMs = 45000) => waitFor(page, (value) => Object.values(chatState.history)
  .some((list) => list.some((e) => e.text === value && e.direction === 'in')), { timeoutMs, arg: text });
const open = (page, fp) => page.evaluate(async (key) => {
  const peer = findPeerByAnyKey(key);
  chatState.activeConversationId = getConversationKey(peer); chatState.activePeerClientId = peer.clientId || '';
  renderPeers(); renderActivePeer(); renderMessages();
}, fp);
/* Every kex-offer that reaches this page, kept as it arrived. The handler is
   a module's own function, called by name inside it, so a wrapper on window
   would see nothing; the offer is read off the channel's data instead. */
const tap = (page) => page.evaluate(() => {
  window.__offers = [];
  const watch = () => {
    for (const session of chatState.sessions.values()) {
      const c = session.connection;
      if (!c || c.__tapped) continue;
      c.__tapped = true;
      c.on('data', (m) => { if (m?.type === 'kex-offer') window.__offers.push(JSON.parse(JSON.stringify(m))); });
    }
  };
  setInterval(watch, 50);
});

const stacks = await startTwoStacks();
try {
  const A = await openApp('ARIA', { origin: stacks.a.url, relay: stacks.a.url });
  const B = await openApp('BARAN', { origin: stacks.a.url, relay: stacks.a.url });
  const cards = { A: await identity(A), B: await identity(B) };
  const fp = { A: decode(cards.A).fingerprint, B: decode(cards.B).fingerprint };
  await importIdentity(A, cards.B); await importIdentity(B, cards.A);
  await tap(A); await tap(B);
  await open(A, fp.B); await open(B, fp.A);
  const hello = `hello-${Date.now()}`;
  await say(A, hello);
  check('a first message crosses', Boolean(await received(B, hello)));
  await sleep(1500);
  /* A fresh exchange now that both pages are watching their channels. */
  await A.evaluate((k) => renegotiateSessionKey(chatState.sessions.get(findPeerByAnyKey(k).peerId)), fp.B);
  await sleep(4000);

  check('both say they read binding 4', (await A.evaluate(() => LOCAL_CAPS.includes('kx4'))) && (await B.evaluate(() => LOCAL_CAPS.includes('kx4'))));
  const offers = [...await A.evaluate(() => window.__offers), ...await B.evaluate(() => window.__offers)];
  const offer = offers.find((o) => o.v === 3 && o.sig);
  check('the key exchange was offered at binding 4', offer?.b === 4, JSON.stringify(offer ? { b: offer.b, v: offer.v, dr: offer.dr } : null));
  const pinned = { A: await A.evaluate((k) => findPeerByAnyKey(k).kexBinding, fp.B), B: await B.evaluate((k) => findPeerByAnyKey(k).kexBinding, fp.A) };
  check('and each side pinned the other at binding 4', pinned.A === 4 && pinned.B === 4, JSON.stringify(pinned));

  /* Who offered, and who answers: the offer is replayed to the answerer. */
  /* The page that received the offer is the answerer. */
  const answerer = (await A.evaluate(() => window.__offers.length)) ? A : B;
  const offererFp = answerer === A ? fp.B : fp.A;
  const feed = (frame) => answerer.evaluate(async ({ key, frame }) => {
    const session = chatState.sessions.get(findPeerByAnyKey(key).peerId);
    const before = session.kexAnswering || 0;
    const warned = [];
    const original = console.warn;
    console.warn = (...args) => { warned.push(args.join(' ')); original.apply(console, args); };
    try { await handleSessionMessage(session, frame); } catch (error) { warned.push(`threw ${error?.name}`); } finally { console.warn = original; }
    return { answered: (session.kexAnswering || 0) > before, warned };
  }, { key: offererFp, frame });

  const stripped = { ...offer, kid: `${offer.kid}-x` };
  delete stripped.dr; delete stripped.rp; delete stripped.rq;
  const r1 = await feed(stripped);
  check('an offer whose ratchet fields were taken out in flight is refused (its signature no longer holds)', r1.warned.some((w) => /not signed by the contact/.test(w)), JSON.stringify(r1.warned));
  const lowered = { ...offer, kid: `${offer.kid}-y`, dr: 1 };
  const r2 = await feed(lowered);
  check('and one whose ratchet was lowered from 2 to 1', r2.warned.some((w) => /not signed by the contact/.test(w)), JSON.stringify(r2.warned));
  const old = { ...offer, kid: `${offer.kid}-z` };
  delete old.b;
  const r3 = await feed(old);
  check('an offer signed the old way from a contact pinned at 4 is refused', r3.warned.some((w) => /signed the old way/.test(w)), JSON.stringify(r3.warned));

  const after = `after-${Date.now()}`;
  await say(B, after);
  check('and messages still cross', Boolean(await received(A, after)));
} finally {
  await stacks.stop();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n===== ${failed.length} failed of ${results.length} =====`);
process.exit(failed.length ? 1 : 0);
