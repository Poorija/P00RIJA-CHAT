/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* A voice message can be sent.
 *
 * The button at the end of the composer is a microphone while there is nothing to send and Send once there is.
 * "Nothing to send" was decided from the text box alone, so with a recording finished and waiting in the
 * preview the box was still empty, the button still a microphone, and a tap on it started a SECOND recording:
 * the first could be played, discarded or disguised but never sent from the button.
 *
 *   - with no text and no recording the button is the microphone;
 *   - with a recording waiting it is Send (the paper plane), and says so;
 *   - a tap on it sends the recording — one voice message goes out, the other side receives it — and does NOT
 *     start another recording;
 *   - afterwards it is the microphone again.
 *
 *   node tests/e2e/voicesend.mjs
 */
import { openApp, identity, importIdentity, browser, waitFor } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
import { createChecks } from './_check.mjs';

const { results, check } = createChecks({ maxDetail: 300, entry: (_name, ok) => Boolean(ok) });
const decode = (card) => JSON.parse(Buffer.from(card.replace('poorija-chat-v1:', ''), 'base64').toString('utf8'));
const stacks = await startTwoStacks();
try {
  const A = await openApp('A', { origin: stacks.a.url, relay: stacks.a.url, context: { viewport: { width: 1280, height: 860 } } });
  const B = await openApp('B', { origin: stacks.a.url, relay: stacks.a.url });
  const cards = { A: await identity(A), B: await identity(B) };
  await importIdentity(A, cards.B);
  await importIdentity(B, cards.A);
  const open = (page, fingerprint) => page.evaluate(async (key) => {
    const peer = findPeerByAnyKey(key);
    chatState.activeConversationId = getConversationKey(peer);
    chatState.activePeerClientId = peer.clientId || '';
    renderPeers(); renderActivePeer(); renderMessages();
    await new Promise((r) => setTimeout(r, 500));
  }, fingerprint);
  await open(A, decode(cards.B).fingerprint);
  await open(B, decode(cards.A).fingerprint);

  const button = () => A.evaluate(() => {
    const send = document.getElementById('chatSendMessageBtn');
    return { mic: send.classList.contains('is-mic'), icon: send.querySelector('i')?.className || '', title: send.title };
  });
  const recording = () => A.evaluate(() => Boolean(document.getElementById('chatRecordingOverlay')?.checkVisibility?.()));
  const voiceSent = () => A.evaluate(() => Object.values(chatState.history).flat().filter((e) => e.direction === 'out' && e.type === 'voice').length);

  const idle = await button();
  check('with nothing to send the button is the microphone', idle.mic === true && /microphone/.test(idle.icon), JSON.stringify(idle));

  await A.click('#chatComposerPlusBtn');
  await A.click('#chatVoiceMessageBtn');
  await A.waitForSelector('#chatFinishRecordingBtn', { state: 'visible', timeout: 15000 });
  await A.waitForTimeout(2200);
  await A.evaluate(() => document.getElementById('chatFinishRecordingBtn')?.click());
  await A.waitForSelector('#chatVoicePreview', { state: 'visible', timeout: 15000 });
  await A.waitForTimeout(600);
  const waiting = await button();
  check('with a recording waiting in the preview it is Send, not the microphone', waiting.mic === false && /paper-plane/.test(waiting.icon), JSON.stringify(waiting));

  await A.click('#chatSendMessageBtn');
  await A.waitForTimeout(2500);
  check('a tap on it does not start a second recording', (await recording()) === false);
  const arrived = await waitFor(B, () => Object.values(chatState.history).flat().some((e) => e.direction === 'in' && e.type === 'voice'), { timeoutMs: 45000 });
  check('the recording was sent, and the other side received it', arrived === true, `sent ${await voiceSent()}`);
  check('and the draft is gone', await A.evaluate(() => !chatState.voiceDraft));
  const after = await button();
  check('afterwards the button is the microphone again', after.mic === true, JSON.stringify(after));
} catch (error) {
  check('the suite ran to the end', false, error?.stack || String(error));
} finally {
  await stacks.stop?.();
  await browser?.close?.().catch(() => {});
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n===== ${failed} failed of ${results.length} =====`);
process.exit(failed ? 1 : 0);
