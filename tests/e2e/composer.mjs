/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text.
 */

/* The last button of the composer is a microphone while there is nothing to
 * send and the send button once there is (js/messenger.js, wireComposer).
 *
 * The chat sends on the button's pointerdown, so that the keyboard keeps its
 * focus, and a click follows. A press decided at the click alone finds the box
 * already emptied by the pointerdown and reads a message that has just gone as
 * a request for a recording: one tap, a message sent AND a voice message
 * started. The groups suite caught it (the mention and the admin checks send
 * with a real click and saw a recording start instead).
 *
 *   A TEXT       a press with text sends it, once, and starts no recording.
 *   B EMPTY      a press with nothing to send starts a recording and sends nothing.
 *   C KEYS       the same two, from the keyboard (no pointerdown at all).
 *   D THE LOOK   the button says which it is.
 *
 *   node tests/e2e/composer.mjs      (brings up its own relay)
 */
import { openApp, identity, importIdentity, browser, waitFor } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';

const results = [];
const check = (n, ok, d = '') => {
  results.push({ n, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + String(d).slice(0, 220) : ''}`);
};
const section = (title) => console.log(`\n===== ${title} =====`);
const decode = (card) => JSON.parse(Buffer.from(card.replace('poorija-chat-v1:', ''), 'base64').toString('utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const outgoing = (page) => page.evaluate(() => Object.values(chatState.history).flat().filter((e) => e.direction === 'out' && e.text).map((e) => e.text));
const recording = (page) => page.evaluate(() => {
  const overlay = document.getElementById('chatRecordingOverlay');
  return Boolean(overlay) && !overlay.classList.contains('hidden') && getComputedStyle(overlay).display !== 'none';
});
const look = (page) => page.evaluate(() => {
  const button = document.getElementById('chatSendMessageBtn');
  return { mic: button.classList.contains('is-mic'), icon: button.querySelector('i')?.className || '' };
});

const stacks = await startTwoStacks();
try {
  const A = await openApp('SARA', { origin: stacks.a.url, relay: stacks.a.url });
  const B = await openApp('OMID', { origin: stacks.a.url, relay: stacks.a.url });
  const cards = { A: await identity(A), B: await identity(B) };
  await importIdentity(A, cards.B);
  await importIdentity(B, cards.A);
  await A.evaluate(async (key) => {
    const peer = findPeerByAnyKey(key);
    chatState.activeConversationId = getConversationKey(peer);
    chatState.activePeerClientId = peer.clientId || '';
    renderPeers(); renderActivePeer(); renderMessages();
    await new Promise((r) => setTimeout(r, 600));
  }, decode(cards.B).fingerprint);
  await sleep(1500);

  section('D. the button says which it is');
  const emptyLook = await look(A);
  check('with nothing typed it is a microphone', emptyLook.mic === true && emptyLook.icon.includes('fa-microphone'), JSON.stringify(emptyLook));
  await A.fill('#chatComposer', 'typed');
  const typedLook = await look(A);
  check('with text it is the send button', typedLook.mic === false && typedLook.icon.includes('fa-paper-plane'), JSON.stringify(typedLook));
  await A.fill('#chatComposer', '');
  const clearedLook = await look(A);
  check('and a microphone again when the box is emptied', clearedLook.mic === true, JSON.stringify(clearedLook));

  section('A. a press with text');
  const text = `once-${Date.now()}`;
  await A.fill('#chatComposer', text);
  await A.click('#chatSendMessageBtn', { timeout: 15000 });
  await sleep(1500);
  const sent = (await outgoing(A)).filter((t) => t === text);
  check('sends the text, once', sent.length === 1, `${sent.length} copies`);
  check('and starts no recording', (await recording(A)) === false);
  check('the other side has it', await waitFor(B, (value) => Object.values(chatState.history).flat().some((e) => e.text === value && e.direction === 'in'), { timeoutMs: 30000, arg: text }));
  const afterSend = await look(A);
  check('and the button is a microphone again', afterSend.mic === true, JSON.stringify(afterSend));

  section('B. a press with nothing to send');
  const before = (await outgoing(A)).length;
  await A.click('#chatSendMessageBtn', { timeout: 15000 });
  await sleep(1500);
  check('starts a recording', (await recording(A)) === true);
  check('and sends nothing', (await outgoing(A)).length === before);
  section('C. from the keyboard');
  /* A second device: the first still holds the recording from B. */
  const A2 = await openApp('SARA2', { origin: stacks.a.url, relay: stacks.a.url });
  const card2 = await identity(A2);
  await importIdentity(A2, cards.B);
  await importIdentity(B, card2);
  await A2.evaluate(async (key) => {
    const peer = findPeerByAnyKey(key);
    chatState.activeConversationId = getConversationKey(peer);
    chatState.activePeerClientId = peer.clientId || '';
    renderPeers(); renderActivePeer(); renderMessages();
    await new Promise((r) => setTimeout(r, 600));
  }, decode(cards.B).fingerprint);
  await sleep(1500);
  const keyText = `keys-${Date.now()}`;
  await A2.fill('#chatComposer', keyText);
  await A2.focus('#chatSendMessageBtn');
  await A2.keyboard.press('Enter');
  await sleep(1500);
  const keyed = (await outgoing(A2)).filter((t) => t === keyText);
  check('Enter on the button with text sends it, once', keyed.length === 1, `${keyed.length} copies`);
  check('and starts no recording', (await recording(A2)) === false);
  const count = (await outgoing(A2)).length;
  await A2.focus('#chatSendMessageBtn');
  await A2.keyboard.press('Enter');
  await sleep(1500);
  check('Enter on the button with nothing starts a recording', (await recording(A2)) === true);
  check('and sends nothing', (await outgoing(A2)).length === count);

  section('nothing threw');
  const errors = [...A.__errors, ...A2.__errors, ...B.__errors];
  check('no script error on either side', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await stacks.stop();
}
const bad = results.filter((r) => !r.ok);
console.log(`\n===== ${bad.length} failed of ${results.length} =====`);
process.exit(bad.length ? 1 : 0);
