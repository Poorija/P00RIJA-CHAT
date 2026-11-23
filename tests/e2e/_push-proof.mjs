/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Subscribing a device to push, the way the relay now requires.
 *
 * /push/subscribe no longer takes a fingerprint's word for it: anybody who could reach the relay could
 * register THEIR endpoint against SOMEBODY ELSE'S fingerprint and be told every time that person
 * received a message. The caller asks for a challenge (/push/challenge), answers it with the private
 * key behind the fingerprint, and sends the answer with the subscription. The suites that register
 * "straight at the relay" to test what it does with a queued envelope sent the subscription bare and
 * were refused with 403 — which read as "the push never fires", and tested nothing.
 *
 *   subscribeAsKey(relay, identity, body)   a probe that holds the RSA key (relayTestIdentity())
 *   subscribeInPage(page, relay, body)      a browser's own identity, proved by the page itself
 *
 * `body` is what goes beside the proof: { subscription, ttlDays, deviceId, lang }. */
import crypto from 'node:crypto';

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export async function subscribeAsKey(relay, identity, body) {
  const challenge = await post(new URL('/push/challenge', relay), { fingerprint: identity.fingerprint, publicKeyData: identity.publicKeyData }).then((r) => r.json());
  if (!challenge.ok) return { ok: false, status: 400, reason: challenge.reason };
  const nonce = crypto.privateDecrypt(
    { key: identity.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(challenge.cipher, 'base64'),
  ).toString('base64');
  const response = await post(new URL('/push/subscribe', relay), { ...body, fingerprint: identity.fingerprint, challengeId: challenge.challengeId, nonce });
  return { ok: response.ok, status: response.status };
}

export const subscribeInPage = (page, relay, body) => page.evaluate(async ({ relay: origin, body: payload }) => {
  /* The identity is there a moment after unlock: wait for it rather than fail on the first look. */
  let id = null;
  for (let attempt = 0; attempt < 40 && !id; attempt += 1) {
    id = await window.PoorijaChat.identityProof().catch(() => null);
    if (!id) await new Promise((r) => setTimeout(r, 250));
  }
  if (!id) return { ok: false, status: 0, reason: 'no identity in the page to prove' };
  const challenge = await fetch(new URL('/push/challenge', origin), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fingerprint: id.fingerprint, publicKeyData: id.publicKeyData }),
  }).then((r) => r.json());
  if (!challenge.ok) return { ok: false, status: 400, reason: challenge.reason };
  const sig = await id.prove(challenge);
  const response = await fetch(new URL('/push/subscribe', origin), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, fingerprint: id.fingerprint, challengeId: challenge.challengeId, sig }),
  });
  return { ok: response.ok, status: response.status };
}, { relay, body });
