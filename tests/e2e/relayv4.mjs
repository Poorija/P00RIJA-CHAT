/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* The relay takes an identity v4 account (roadmap 1.2, release 2.7a).
 *
 * A v4 account is an Ed25519 signing key whose fingerprint is
 * SHA-256("poorija-id/4" ‖ key). The relay used to know one kind of account:
 * an RSA key whose SPKI hashes to the fingerprint, proved by opening a nonce
 * sealed to it or by an RSA signature. A v4 account could not prove itself at
 * all — so the relay is shipped first, to all eight servers, before any app
 * makes such a key. What has to hold:
 *
 *   - a v4 socket proves itself with a signature, is verified, and is never
 *     sent a sealed challenge (an agreement key must never be used to open
 *     what a relay hands over);
 *   - a v4 key that does not name the fingerprint is refused, and an RSA
 *     account is challenged exactly as before;
 *   - push subscribe works with a v4 key;
 *   - an RSA account that moved (a continuation signed by its old RSA key and
 *     its new Ed25519 key) gets the mail queued under its old fingerprint on
 *     the new one, for the ninety days the old key keeps verifying — and a
 *     continuation missing either signature does not move anything.
 *
 *   node tests/e2e/relayv4.mjs     (PKG_RELAY = the relay's http origin)
 */
import { WebSocket } from 'ws';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { createChecks } from './_check.mjs';

const require = createRequire(import.meta.url);
const v4 = require('../../scripts/lib/identity-v4.js');

const RELAY = process.env.PKG_RELAY || 'http://localhost:11220';
const WS_URL = (process.env.RELAY_WS || RELAY.replace(/^http/, 'ws') + '/chat-signal');
const { results, check } = createChecks({ entry: (name, ok, detail) => ({ name, ok, detail }) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (path, body) => fetch(new URL(path, RELAY), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const raw32 = (keyObject) => keyObject.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const proofText = (purpose, fp, nonce) => Buffer.from(['relay-proof/1', purpose, fp, nonce].join('\n'));

function v4Account() {
  const signing = crypto.generateKeyPairSync('ed25519');
  const agree = crypto.generateKeyPairSync('x25519');
  const sk = raw32(signing.publicKey);
  const ak = raw32(agree.publicKey);
  const fp = v4.fingerprintV4(sk);
  const akSig = crypto.sign(null, v4.agreeKeyText(fp, ak), signing.privateKey).toString('base64');
  return { kind: 'v4', signing, sk, ak, fp, akSig, publicKeyData: sk, sign: (bytes) => crypto.sign(null, bytes, signing.privateKey).toString('base64') };
}
function rsaAccount() {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  return {
    kind: 'rsa', pair, key, fp: v4.fingerprintV3(key), publicKeyData: key,
    sign: (bytes) => crypto.sign('sha256', bytes, { key: pair.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }).toString('base64'),
  };
}
function continuation(old, next, { at = Date.now(), breakOld = false, breakNew = false } = {}) {
  const statement = { oldFp: old.fp, newFp: next.fp, oldKey: old.key, sk: next.sk, ak: next.ak, at };
  const text = v4.continuationText(statement);
  return {
    statement, akSig: next.akSig,
    oldSig: breakOld ? rsaAccount().sign(text) : old.sign(text),
    newSig: breakNew ? v4Account().sign(text) : next.sign(text),
  };
}

/* A socket that says hello with `account` and answers what it is asked the
   way the app does: a signature over the sign nonce, never the sealed one. */
function connect(account, { name = 'probe', extra = {} } = {}) {
  return new Promise((resolve, reject) => {
    const peerId = `probe-${name}-${crypto.randomUUID()}`;
    const ws = new WebSocket(`${WS_URL}?fingerprint=${account.fp}&peerId=${peerId}&username=${name}`);
    const inbox = [];
    const state = { ws, inbox, peerId, verified: false, challenge: null, closed: null };
    ws.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch (_error) { return; }
      inbox.push(message);
      if (message.type === 'id-challenge') {
        state.challenge = message;
        ws.send(JSON.stringify({ type: 'id-proof', sig: account.sign(proofText('socket', account.fp, message.sign)) }));
      }
      if (message.type === 'roster') state.verified = true;
    });
    ws.on('close', (code) => { state.closed = code; });
    ws.on('error', reject);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', username: name, peerId, fingerprint: account.fp, publicKeyData: account.publicKeyData, ...extra }));
      resolve(state);
    });
  });
}
const until = async (test, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await sleep(100); } return test(); };

const sockets = [];
try {
  console.log('\n===== a v4 account proves itself =====');
  const A = v4Account();
  const a = await connect(A, { name: 'aria' }); sockets.push(a);
  await until(() => a.verified || a.closed !== null);
  check('a v4 socket is verified', a.verified, JSON.stringify(a.inbox.map((m) => m.type)));
  check('and was asked to sign, not to open anything', Boolean(a.challenge?.sign) && !a.challenge?.cipher, JSON.stringify(a.challenge));

  console.log('\n===== a v4 key that is not the fingerprint =====');
  const B = v4Account();
  const liar = { ...B, fp: v4Account().fp };
  const l = await connect(liar, { name: 'liar' }); sockets.push(l);
  await until(() => l.closed !== null || l.inbox.some((m) => m.type === 'error'));
  check('is refused', !l.verified && l.inbox.some((m) => m.type === 'error' && /identity-mismatch/.test(m.reason)), JSON.stringify(l.inbox));
  /* The v3 rule applied to a v4 key is a different fingerprint, and must not
     be taken either: a key is judged by its own kind only. */
  const crossed = { ...B, fp: v4.fingerprintV3(B.sk) };
  const c = await connect(crossed, { name: 'crossed' }); sockets.push(c);
  await until(() => c.closed !== null || c.inbox.some((m) => m.type === 'error'));
  check('nor is a v4 key under the v3 rule', !c.verified, JSON.stringify(c.inbox.map((m) => m.type)));

  console.log('\n===== an RSA account, as before =====');
  const R = rsaAccount();
  const r = await connect(R, { name: 'rsa' }); sockets.push(r);
  await until(() => r.verified || r.closed !== null);
  check('is still challenged both ways and verified by its signature', r.verified && Boolean(r.challenge?.cipher) && Boolean(r.challenge?.sign));

  console.log('\n===== push subscribe with a v4 key =====');
  const challenge = await post('/push/challenge', { fingerprint: A.fp, publicKeyData: A.sk }).then((res) => res.json());
  check('a challenge is issued for a v4 key', challenge.ok === true && Boolean(challenge.sign), JSON.stringify(challenge));
  check('with nothing sealed in it', !challenge.cipher, String(Boolean(challenge.cipher)));
  const wrongChallenge = await post('/push/challenge', { fingerprint: v4Account().fp, publicKeyData: A.sk }).then((res) => res.json());
  check('and refused for a v4 key that is not the fingerprint', wrongChallenge.ok === false, JSON.stringify(wrongChallenge));
  const subscribed = await post('/push/subscribe', {
    fingerprint: A.fp, challengeId: challenge.challengeId, sig: A.sign(proofText('push', A.fp, challenge.sign)), ttlDays: 1, lang: 'en',
    subscription: { endpoint: 'https://push.invalid/v4', keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM=', auth: 'tBHItJI5svbpez7KI4CCXg==' } },
  });
  check('the subscription is taken', subscribed.ok, String(subscribed.status));

  console.log('\n===== an account that moved =====');
  const OLD = rsaAccount();
  const NEW = v4Account();
  /* Mail for the old account while nobody holds it. */
  const sender = await connect(rsaAccount(), { name: 'sender' }); sockets.push(sender);
  await until(() => sender.verified);
  sender.ws.send(JSON.stringify({ type: 'relay', toFingerprint: OLD.fp, persist: true, payload: { type: 'offline-chat', signal: 'chat', body: 'before-the-move' } }));
  await sleep(700);

  /* A continuation with a broken old signature moves nothing. */
  const forged = continuation(OLD, NEW, { breakOld: true });
  const forgedSocket = await connect(NEW, { name: 'forged', extra: { continuation: forged } }); sockets.push(forgedSocket);
  await until(() => forgedSocket.verified);
  await sleep(800);
  check('a continuation the old key did not sign moves no mail',
    !forgedSocket.inbox.some((m) => JSON.stringify(m).includes('before-the-move')), JSON.stringify(forgedSocket.inbox.map((m) => m.type)));
  forgedSocket.ws.close();
  await sleep(300);

  const brokenNew = continuation(OLD, NEW, { breakNew: true });
  const brokenSocket = await connect(NEW, { name: 'broken', extra: { continuation: brokenNew } }); sockets.push(brokenSocket);
  await until(() => brokenSocket.verified);
  await sleep(800);
  check('nor one the new key did not sign',
    !brokenSocket.inbox.some((m) => JSON.stringify(m).includes('before-the-move')));
  brokenSocket.ws.close();
  await sleep(300);

  const signed = continuation(OLD, NEW);
  const moved = await connect(NEW, { name: 'moved', extra: { continuation: signed } }); sockets.push(moved);
  await until(() => moved.verified);
  await until(() => moved.inbox.some((m) => JSON.stringify(m).includes('before-the-move')), 5000);
  check('the new account gets the mail queued under the old fingerprint',
    moved.inbox.some((m) => JSON.stringify(m).includes('before-the-move')), JSON.stringify(moved.inbox.map((m) => m.type)));

  /* Mail written to the old fingerprint after the move goes to the new one. */
  moved.inbox.length = 0;
  sender.ws.send(JSON.stringify({ type: 'relay', toFingerprint: OLD.fp, persist: true, payload: { type: 'offline-chat', signal: 'chat', body: 'after-the-move' } }));
  await until(() => moved.inbox.some((m) => JSON.stringify(m).includes('after-the-move')), 5000);
  check('and what is written to the old fingerprint afterwards', moved.inbox.some((m) => JSON.stringify(m).includes('after-the-move')),
    JSON.stringify(moved.inbox.map((m) => m.type)));

  /* The old key can no longer come back and claim the mailbox for itself. */
  const back = await connect(OLD, { name: 'old-again' }); sockets.push(back);
  await until(() => back.verified || back.closed !== null, 5000);
  back.inbox.length = 0;
  sender.ws.send(JSON.stringify({ type: 'relay', toFingerprint: OLD.fp, persist: true, payload: { type: 'offline-chat', signal: 'chat', body: 'third' } }));
  await sleep(1200);
  check('a socket proving the old key does not get mail meant for the moved account',
    !back.inbox.some((m) => JSON.stringify(m).includes('third')), JSON.stringify(back.inbox.map((m) => m.type)));

  const health = await fetch(new URL('/chat-health', RELAY)).then((res) => res.json()).catch(() => ({}));
  check('the relay says it takes v4 identities', Array.isArray(health.identity) && health.identity.includes('v4'), JSON.stringify(health.identity));
} finally {
  for (const s of sockets) { try { s.ws.close(); } catch (_error) { /* gone */ } }
}
const failed = results.filter((result) => !result.ok);
console.log(`\n===== ${failed.length} failed of ${results.length} =====`);
failed.forEach((result) => console.log(`  FAIL ${result.name}${result.detail ? ` — ${result.detail}` : ''}`));
process.exit(failed.length ? 1 : 0);
