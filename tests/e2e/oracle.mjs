/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text.
 */

/* The relay cannot borrow a device's private key.
 *
 * To prove a client holds the identity it claims, the relay seals a nonce to
 * that identity's public key and the client opens it and sends it back. The
 * same key, the same way, is what a message's key is sealed to when its
 * recipient is away: 32 bytes, RSA-OAEP, to the identity key.
 *
 * A nonce is 32 bytes too. So the relay — which stores every sealed envelope
 * on its way to an offline device — could take the seal off one, call it a
 * challenge, and be handed the message's key by the recipient's own device,
 * which had no way to tell the two apart. The identity key never left the
 * device; it did not have to.
 *
 * This suite is the relay doing exactly that, by both doors it has (the
 * socket's challenge, and the one that guards a push subscription), and asks
 * whether the key comes back.
 *
 *   node tests/e2e/oracle.mjs      (brings up its own relay)
 */
import { openApp, identity, importIdentity, browser, waitFor } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';

const results = [];
const check = (n, ok, d = '') => {
  results.push({ n, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + String(d).slice(0, 240) : ''}`);
};
const section = (title) => console.log(`\n===== ${title} =====`);
const decode = (card) => JSON.parse(Buffer.from(card.replace('poorija-chat-v1:', ''), 'base64').toString('utf8'));

const stacks = await startTwoStacks();
try {
  const MINA = await openApp('MINA', { origin: stacks.a.url, relay: stacks.a.url });
  const REZA = await openApp('REZA', { origin: stacks.a.url, relay: stacks.a.url });
  const cards = { MINA: await identity(MINA), REZA: await identity(REZA) };
  const fp = { MINA: decode(cards.MINA).fingerprint, REZA: decode(cards.REZA).fingerprint };
  await importIdentity(MINA, cards.REZA);
  await importIdentity(REZA, cards.MINA);
  await waitFor(MINA, (key) => Boolean(findPeerByAnyKey(key)?.publicKeyData), { timeoutMs: 30000, arg: fp.REZA });

  /* MINA seals a message key to REZA's identity key, the way an envelope for
     an offline device is sealed when there is no prekey to seal to. The seal
     is what the relay stores; the key is what it must never learn. */
  const sealed = await MINA.evaluate(async (key) => {
    const record = findPeerByAnyKey(key);
    const cryptoKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', cryptoKey));
    /* As for a contact on a build before the hybrid exchange and the ratchet:
       the only kind still sealed to the identity key (28-offline-envelopes.js,
       identitySealRefused). REZA's own pins are left as they are. */
    const seal = await sealSessionKeyFor({ cryptoKey }, { ...record, kexPinned: 0, ratchetPinned: 0 });
    return { seal, key: PoorijaApp.arrayBufferToBase64(raw.buffer) };
  }, fp.REZA);
  check('MINA seals a message key to REZA', Boolean(sealed.seal) && sealed.key.length > 20);

  section('REZA can still open what was sealed to him');
  const opened = await REZA.evaluate(async ({ seal, key }) => {
    const cryptoKey = await openOfflineSeal(seal).catch(() => null);
    if (!cryptoKey) return false;
    return PoorijaApp.arrayBufferToBase64(await crypto.subtle.exportKey('raw', cryptoKey)) === key;
  }, sealed);
  check('the seal opens for the person it was made for', opened === true);

  section('the relay calls the seal a challenge');
  /* Everything REZA's device sends the relay, while it answers. */
  const viaSocket = await REZA.evaluate(async ({ seal }) => {
    const sent = [];
    const socket = chatState.ws;
    const original = socket.send.bind(socket);
    socket.send = (data) => { sent.push(String(data)); };
    try {
      await handleIdentityChallenge({ type: 'id-challenge', cipher: seal });
    } finally {
      socket.send = original;
    }
    return sent;
  }, sealed);
  const leakedBySocket = viaSocket.some((frame) => frame.includes(sealed.key));
  console.log('  REZA sent ' + JSON.stringify(viaSocket.map((frame) => frame.slice(0, 60))));
  check('over the socket: the message key does not come back', leakedBySocket === false, leakedBySocket ? 'the key was sent to the relay' : 'not sent');

  const viaPush = await REZA.evaluate(async ({ seal }) => {
    const proof = await window.PoorijaChat?.identityProof?.();
    /* Whatever the build offers for answering: the old `solve`, which opened
       the challenge, or `prove`, handed a challenge with only a seal in it. */
    const answer = proof?.solve ? (c) => proof.solve(c) : proof?.prove ? (c) => proof.prove({ challengeId: 'x', cipher: c }) : null;
    if (!answer) return { answer: '', error: 'nothing to answer with' };
    try { return { answer: String(await answer(seal) || '') }; } catch (error) { return { answer: '', error: String(error?.message || error).slice(0, 90) }; }
  }, sealed);
  check('for a push subscription: the message key does not come back', viaPush.answer !== sealed.key && !viaPush.answer.includes(sealed.key), viaPush.error || (viaPush.answer ? 'something else was returned' : 'nothing returned'));

  section('an honest challenge is still answered');
  /* The relay announces only identities that proved themselves, so REZA
     being online on MINA's screen is the relay saying his proof held. */
  const announced = await waitFor(MINA, (key) => findPeerByAnyKey(key)?.status === 'online', { timeoutMs: 30000, arg: fp.REZA });
  check('REZA proved his identity to the relay, and is announced', Boolean(announced));
  const how = await REZA.evaluate(async () => {
    const sent = [];
    const socket = chatState.ws;
    const original = socket.send.bind(socket);
    socket.send = (data) => { sent.push(JSON.parse(String(data))); };
    try {
      await handleIdentityChallenge({ type: 'id-challenge', cipher: 'AAAA', sign: PoorijaApp.arrayBufferToBase64(crypto.getRandomValues(new Uint8Array(32)).buffer) });
    } finally { socket.send = original; }
    const proof = sent.find((frame) => frame.type === 'id-proof') || {};
    return { signed: Boolean(proof.sig) && proof.sig.length >= 86, echoed: 'nonce' in proof };
  });
  check('by a signature, with nothing opened and nothing echoed', how.signed === true && how.echoed === false, JSON.stringify(how));
  const push = await REZA.evaluate(async (relay) => {
    const proof = await window.PoorijaChat.identityProof();
    const challenge = await fetch(new URL('/push/challenge', relay), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fingerprint: proof.fingerprint, publicKeyData: proof.publicKeyData }) }).then((r) => r.json());
    if (!challenge?.ok || !challenge.sign) return { ok: false, why: 'the relay offered nothing to sign' };
    const good = await fetch(new URL('/push/poll-token', relay), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fingerprint: proof.fingerprint, challengeId: challenge.challengeId, sig: await proof.prove(challenge) }) });
    const second = await fetch(new URL('/push/challenge', relay), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fingerprint: proof.fingerprint, publicKeyData: proof.publicKeyData }) }).then((r) => r.json());
    const bad = await fetch(new URL('/push/poll-token', relay), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fingerprint: proof.fingerprint, challengeId: second.challengeId, sig: await proof.prove(challenge) }) });
    return { ok: true, good: good.status, bad: bad.status };
  }, stacks.a.url);
  check('the relay takes a signed proof for a push token', push.ok && push.good === 200, JSON.stringify(push));
  check('and refuses a signature made for another challenge', push.ok && push.bad === 403, JSON.stringify(push));

  section('nothing threw');
  const errors = [...MINA.__errors, ...REZA.__errors];
  check('no script error on either side', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await stacks.stop();
}
const bad = results.filter((r) => !r.ok);
console.log(`\n===== ${bad.length} failed of ${results.length} =====`);
process.exit(bad.length ? 1 : 0);
