/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* A call whose ICE never leaves "new" or "checking" is restarted after nine
 * seconds; one that connects, or is closed, is not. The watch used to sit after
 * a return inside the listener and never ran.
 *
 *   node tests/e2e/_local-stack.mjs icestall
 *
 * A peer connection is replaced by an object that has the two things the code
 * asks of it (an event target and an ICE state), and the recovery it would
 * start is replaced by a counter. The shipped code is everything between. */
import { openApp, browser } from './_chat-harness.mjs';
import { createChecks } from './_check.mjs';

const { results, check } = createChecks({ maxDetail: 200, entry: (_name, ok) => Boolean(ok) });
try {
  const page = await openApp('ARIA');
  const run = (scenario) => page.evaluate(async (which) => {
    const handlers = {};
    const pc = {
      iceConnectionState: 'new',
      addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
      removeEventListener() {},
    };
    const fire = (type) => (handlers[type] || []).forEach((fn) => fn({}));
    const recoveries = [];
    const original = window.attemptCallRecovery;
    window.attemptCallRecovery = (_pc, reason) => { recoveries.push(reason); };
    const hadCall = chatState.currentCall;
    chatState.currentCall = { peerConnection: pc };
    try {
      window.bindCallIceRecovery(pc, chatState.currentCall);
      if (which === 'checking') { pc.iceConnectionState = 'checking'; fire('iceconnectionstatechange'); }
      if (which === 'connected') { pc.iceConnectionState = 'checking'; fire('iceconnectionstatechange'); pc.iceConnectionState = 'connected'; fire('iceconnectionstatechange'); }
      if (which === 'closed') { pc.iceConnectionState = 'checking'; fire('iceconnectionstatechange'); window.endCurrentCall = () => {}; pc.iceConnectionState = 'closed'; fire('iceconnectionstatechange'); }
      await new Promise((resolve) => setTimeout(resolve, 9800));
      return recoveries;
    } finally {
      window.attemptCallRecovery = original;
      chatState.currentCall = hadCall;
    }
  }, scenario);
  const stuck = await run('checking');
  check('ICE still checking after nine seconds is restarted, once', stuck.length === 1 && stuck[0] === 'stalled', JSON.stringify(stuck));
  const ok = await run('connected');
  check('a call that connects is left alone', ok.length === 0, JSON.stringify(ok));
  const closed = await run('closed');
  check('a call that closes is left alone', closed.length === 0, JSON.stringify(closed));
  const failed = results.filter((x) => !x).length;
  console.log(`\n===== ${failed} failed of ${results.length} =====`);
  process.exitCode = failed ? 1 : 0;
} finally {
  await browser.close();
}
