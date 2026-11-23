/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* The six symbols a call shows are made from the call's own keys.
 *
 * They were made from the two pinned identity keys alone, which do not change from
 * call to call. A server that carries the signalling can answer each side with its
 * own DTLS fingerprint, end the encryption at itself and pass the media on, and both
 * phones still show the same six symbols, made from the same two identities.
 *
 * Two real peer connections are made here, in the page, and negotiated as a call is:
 *
 *   - each side reads the fingerprints from the descriptions it applied and arrives at
 *     the same string, whichever of them is local;
 *   - the six symbols are the same on both ends, and are not the symbols made without
 *     the fingerprints;
 *   - a server that substitutes its own fingerprint in what one side receives makes
 *     the two strings differ, and the symbols with them — the case the identity-only
 *     code could not see;
 *   - a description that lists several fingerprints gives no code (a server could list
 *     the same ones in both and make the sets equal);
 *   - nothing is shown while a side has no description yet.
 *
 *   node tests/e2e/callcode.mjs
 */
import { openApp, browser } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
import { createChecks } from './_check.mjs';

const { results, check } = createChecks({ maxDetail: 300, entry: (_name, ok) => Boolean(ok) });

const stacks = await startTwoStacks();
try {
  const page = await openApp('CODE', { origin: stacks.a.url, relay: stacks.a.url });
  await page.waitForTimeout(1000);
  const out = await page.evaluate(async () => {
    const negotiate = async (tamper) => {
      const a = new RTCPeerConnection();
      const b = new RTCPeerConnection();
      a.createDataChannel('x');
      const offer = await a.createOffer();
      await a.setLocalDescription(offer);
      /* B receives the offer, and with a server in the middle, its fingerprint is not A's. */
      const received = tamper ? { type: offer.type, sdp: offer.sdp.replace(/^(a=fingerprint:\S+ ).*$/gm, '$1' + 'AA:'.repeat(31) + 'AA') } : offer;
      await b.setRemoteDescription(received);
      const answer = await b.createAnswer();
      await b.setLocalDescription(answer);
      await a.setRemoteDescription(answer);
      const result = { a: callTransportFingerprints(a), b: callTransportFingerprints(b) };
      a.close(); b.close();
      return result;
    };
    const honest = await negotiate(false);
    const middle = await negotiate(true);
    const ids = ['id-of-alice-0123456789', 'id-of-bob-9876543210'];
    const symbols = async (local, remote, binding) => (await verificationEmoji(local, remote, 6, binding)).map((pick) => pick.e).join('');
    return {
      honest, middle,
      alice: await symbols(ids[0], ids[1], honest.a),
      bob: await symbols(ids[1], ids[0], honest.b),
      unbound: await symbols(ids[0], ids[1], ''),
      aliceMiddle: await symbols(ids[0], ids[1], middle.a),
      bobMiddle: await symbols(ids[1], ids[0], middle.b),
      none: callTransportFingerprints({ localDescription: { sdp: 'v=0\r\na=fingerprint:sha-256 AB:CD\r\n' }, remoteDescription: null }),
      /* A server lists the same three fingerprints in what both phones receive, its own among them. */
      listed: (() => {
        const line = (fp) => `a=fingerprint:sha-256 ${fp}\r\n`;
        const all = ['AA:11', 'BB:22', 'EE:55'];
        const sdp = (own) => ({ sdp: `v=0\r\n${line(own)}` });
        const phoneA = { localDescription: sdp('AA:11'), remoteDescription: { sdp: `v=0\r\n${all.map(line).join('')}` } };
        const phoneB = { localDescription: sdp('BB:22'), remoteDescription: { sdp: `v=0\r\n${all.map(line).join('')}` } };
        return { a: callTransportFingerprints(phoneA), b: callTransportFingerprints(phoneB) };
      })(),
      reflected: (() => {
        const own = { sdp: 'v=0\r\na=fingerprint:sha-256 AA:11\r\n' };
        const other = { sdp: 'v=0\r\na=fingerprint:sha-256 BB:22\r\n' };
        return { a: callTransportFingerprints({ localDescription: own, remoteDescription: own }), b: callTransportFingerprints({ localDescription: other, remoteDescription: other }) };
      })(),
      nothing: callTransportFingerprints(null),
    };
  });
  console.log('  ' + JSON.stringify({ honest: out.honest.a.slice(0, 40), alice: out.alice, bob: out.bob, unbound: out.unbound, aliceMiddle: out.aliceMiddle, bobMiddle: out.bobMiddle }));
  check('each side reads the fingerprints of the call it applied', out.honest.a.length > 40 && out.honest.b.length > 40, `${out.honest.a.length} / ${out.honest.b.length}`);
  check('and arrives at the same string, whichever description is its own', out.honest.a === out.honest.b, `${out.honest.a.slice(0, 60)} | ${out.honest.b.slice(0, 60)}`);
  check('the six symbols are the same on both phones', out.alice === out.bob && out.alice.length >= 6, `${out.alice} | ${out.bob}`);
  check('and they are not the symbols made from the identities alone', out.alice !== out.unbound, `${out.alice} | ${out.unbound}`);
  check('a server that substitutes its own fingerprint makes the two strings differ', out.middle.a !== out.middle.b, `${out.middle.a.slice(0, 50)} | ${out.middle.b.slice(0, 50)}`);
  check('and the symbols differ with them, which the identity-only code could not show', out.aliceMiddle !== out.bobMiddle, `${out.aliceMiddle} | ${out.bobMiddle}`);
  check('a description listing several fingerprints gives no code, so it cannot be steered by listing the same ones on both sides', out.listed.a === '' && out.listed.b === '', JSON.stringify(out.listed));
  check('a description reflected back at its sender gives a code that differs from the other side\'s', out.reflected.a !== '' && out.reflected.a !== out.reflected.b, JSON.stringify(out.reflected));
  check('with no remote description, or no connection at all, there is nothing to show', out.none === '' && out.nothing === '', JSON.stringify({ none: out.none, nothing: out.nothing }));
} catch (error) {
  check('the suite ran to the end', false, error?.stack || String(error));
} finally {
  await stacks.stop?.();
  await browser?.close?.().catch(() => {});
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n===== ${failed} failed of ${results.length} =====`);
process.exit(failed ? 1 : 0);
