/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* A backgrounded phone is not online, and the message has to reach it.
 *
 * Part of the P00RIJA end-to-end suite. See tests/e2e/README.md.
 *
 *   npm run relay                 # terminal 1
 *   PORT=8123 npm run dev         # terminal 2
 *   PKG_URL=http://localhost:8123 node tests/e2e/awaypush.mjs
 *
 * An iOS web app that is backgrounded keeps its WebSocket, because the OS
 * answers the TCP ping from inside the network stack, while the page's
 * JavaScript is frozen and reads nothing off it. The relay saw a live socket,
 * took the live path and sent no push: the sender was shown "online" and the
 * phone stayed silent — a message lost with nobody told.
 *
 * Driven against the real relay over a real socket. The push vendor is the one
 * substitution, for the same reason push.mjs makes it: a headless browser has
 * no vendor push service, so the relay is asked what it TRIED to send. */
import { WebSocket } from 'ws';
import crypto from 'node:crypto';
import net from 'node:net';
import { createChecks } from './_check.mjs';

const RELAY = process.env.PKG_RELAY || 'http://localhost:11220';
const WS_URL = RELAY.replace('http', 'ws').replace(':11220', ':11221') + '/chat-signal';
const { results, check } = createChecks({ entry: (_name, ok) => ok });

/* A probe cannot invent an identity here, and should not be able to: the relay
   checks that the key hashes to the fingerprint AND that whoever claims it can
   open a challenge sealed to that key. Only a verified socket can be ROUTED to
   by fingerprint, so a probe that skips this proves nothing about the live
   path — it lands in the offline branch and quietly tests something else.
   So the probe holds a real RSA-OAEP key pair and answers properly. */
const keyPair = () => crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
const openPeer = (name, caps = []) => new Promise((resolve, reject) => {
  const { publicKey, privateKey } = keyPair();
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const publicKeyData = spki.toString('base64');
  const fingerprint = crypto.createHash('sha256').update(spki).digest('hex');
  const peerId = `probe-${name}-${crypto.randomUUID()}`;
  const ws = new WebSocket(`${WS_URL}?fingerprint=${fingerprint}&peerId=${peerId}&username=${name}`);
  const inbox = [];
  let verified = false;
  ws.on('message', (raw) => {
    let parsed;
    try { parsed = JSON.parse(raw.toString()); } catch (_error) { return; }
    inbox.push(parsed);
    if (parsed.type === 'id-challenge') {
      const nonce = crypto.privateDecrypt(
        { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(parsed.cipher, 'base64'),
      );
      ws.send(JSON.stringify({ type: 'id-proof', nonce: nonce.toString('base64') }));
      verified = true;
    }
  });
  ws.on('error', reject);
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'hello', username: name, peerId, fingerprint, publicKeyData, caps }));
    const waitForProof = (tries = 0) => {
      if (verified || tries > 40) return resolve({ ws, inbox, fingerprint, peerId, name, publicKeyData, privateKey });
      setTimeout(() => waitForProof(tries + 1), 100);
    };
    waitForProof();
  });
});
const peersSeenBy = async (peer) => {
  peer.inbox.length = 0;
  peer.ws.send(JSON.stringify({ type: 'get-peers' }));
  await new Promise((r) => setTimeout(r, 500));
  return peer.inbox.find((m) => m.type === 'peers')?.peers || [];
};
const statusOf = async (viewer, subject) =>
  (await peersSeenBy(viewer)).find((p) => p.fingerprint === subject.fingerprint)?.status || '(not listed)';

const A = await openPeer('sender');
const B = await openPeer('receiver');
await new Promise((r) => setTimeout(r, 800));
check('both probes proved their identity to the relay',
  [A, B].every((peer) => peer.inbox.some((m) => m.type === 'id-verified' || m.type === 'peers' || m.type === 'welcome')),
  'an unverified socket cannot be routed to, so the live path would never be reached');
/* Both heartbeat like the app does, so "awake" means what it means in the app. */
const beat = setInterval(() => {
  [A, B].forEach((peer) => {
    if (peer.ws.readyState === WebSocket.OPEN && !peer.frozen) {
      peer.ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
    }
  });
}, 2000);

console.log('\n===== a peer that is awake reads as online =====');
check('the receiver is listed as online', await statusOf(A, B) === 'online', await statusOf(A, B));

console.log('\n===== the app says it is going away =====');
B.frozen = true;                       // stop heartbeating, like a frozen tab
B.ws.send(JSON.stringify({ type: 'presence-state', state: 'away' }));
await new Promise((r) => setTimeout(r, 700));
const awayStatus = await statusOf(A, B);
check('the sender no longer sees them as online', awayStatus !== 'online', awayStatus);
check('and is told they are away rather than dropped', awayStatus === 'away', awayStatus);
check('the socket is still registered', B.ws.readyState === WebSocket.OPEN, String(B.ws.readyState));

/* Standing in for the vendor's push service. A TCP connection is the whole
   question — "did the relay reach for it" — and it is one web-push cannot fake
   its way past, so nothing here has to decrypt anything. */
const pushed = [];
const fakeVendor = net.createServer((socket) => { pushed.push(Date.now()); socket.on('error', () => {}); socket.destroy(); });
await new Promise((resolve) => fakeVendor.listen(0, resolve));
const vendorPort = fakeVendor.address().port;
/* A subscription has to prove the key it names, the way the app does it:
   the relay seals a nonce to the key and only the holder can hand it back. */
const challenge = await (await fetch(`${RELAY}/push/challenge`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ fingerprint: B.fingerprint, publicKeyData: B.publicKeyData }),
})).json();
const proofNonce = crypto.privateDecrypt(
  { key: B.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
  Buffer.from(String(challenge.cipher || ''), 'base64'),
).toString('base64');
await fetch(`${RELAY}/push/subscribe`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ fingerprint: B.fingerprint, challengeId: challenge.challengeId, nonce: proofNonce, ttlDays: 30, lang: 'en', subscription: {
    endpoint: `http://localhost:${vendorPort}/send/awayprobe`,
    keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM=', auth: 'tBHItJI5svbpez7KI4CCXg==' } } }),
});
const sendChat = async (body) => {
  B.inbox.length = 0; A.inbox.length = 0; pushed.length = 0;
  A.ws.send(JSON.stringify({
    type: 'relay', toFingerprint: B.fingerprint, persist: true,
    payload: { type: 'offline-chat', signal: 'chat', notify: true, body },
  }));
  await new Promise((r) => setTimeout(r, 1500));
};

console.log('\n===== a message to an AWAKE peer is delivered and does NOT wake the device =====');
B.frozen = false;
B.ws.send(JSON.stringify({ type: 'presence-state', state: 'active' }));
await new Promise((r) => setTimeout(r, 500));
await sendChat('while-awake');
check('the live frame arrives', B.inbox.some((m) => m.type === 'relay'),
  B.inbox.map((m) => m.type).join(', ') || 'nothing');
check('and no push is sent to a phone the person is looking at', pushed.length === 0,
  `${pushed.length} push attempt(s)`);

console.log('\n===== the same message to an AWAY peer wakes the device =====');
B.frozen = true;
B.ws.send(JSON.stringify({ type: 'presence-state', state: 'away' }));
await new Promise((r) => setTimeout(r, 500));
await sendChat('while-away');
check('the live frame is still delivered', B.inbox.some((m) => m.type === 'relay'),
  B.inbox.map((m) => m.type).join(', ') || 'nothing');
check('and the sender is told it was queued too', A.inbox.some((m) => m.type === 'queued'),
  'so nothing is lost if the freeze outlives the socket');
check('THE DEVICE IS WOKEN — the bug this suite exists for', pushed.length > 0,
  `${pushed.length} push attempt(s); before the fix a registered-but-frozen socket got none`);

console.log('\n===== typing is still not worth waking anybody for =====');
B.inbox.length = 0; pushed.length = 0;
A.ws.send(JSON.stringify({
  type: 'relay', toFingerprint: B.fingerprint,
  payload: { type: 'typing' },
}));
await new Promise((r) => setTimeout(r, 1200));
check('an ephemeral payload sends no push even to an away peer', pushed.length === 0,
  `${pushed.length} push attempt(s)`);

console.log('\n===== coming back =====');
B.frozen = false;
A.inbox.length = 0;
B.ws.send(JSON.stringify({ type: 'presence-state', state: 'active' }));
await new Promise((r) => setTimeout(r, 1200));
/* Read from what the relay BROADCAST, not from a get-peers: that request is answered a few times at once and then
   once every ten seconds per socket (a thousand of them in a row were gigabytes of table), and this probe had
   already asked several times. A socket that has been given the table is told only what changed: a peers-delta
   upsert for the one peer, or the whole table when the socket is not yet in step. Either carries the answer. */
const statusFromBroadcast = (inbox, fingerprint) => {
  for (const message of [...inbox].reverse()) {
    if (message.type === 'peers-delta') {
      const row = (message.upsert || []).find((p) => p.fingerprint === fingerprint);
      if (row) return row.status || '(no status)';
    }
    if (message.type === 'peers') {
      const row = (message.peers || []).find((p) => p.fingerprint === fingerprint);
      if (row) return row.status || '(no status)';
    }
  }
  return '(no broadcast)';
};
const backStatus = statusFromBroadcast(A.inbox, B.fingerprint);
console.log('  after active, A received: ' + JSON.stringify(A.inbox.map((m) => m.type)));
check('the peer reads as online again, from the relay\'s own broadcast', backStatus === 'online', backStatus);

console.log('\n===== a heartbeat that simply stops counts as away too =====');
/* The case where the platform freezes the page before the handler can send:
   nothing announces anything, the pings just stop. */
B.frozen = true;
const waited = Number(process.env.CHAT_APP_AWAKE_TTL_MS || 25000) + 3000;
console.log(`  waiting ${Math.round(waited / 1000)}s for the heartbeat to lapse...`);
await new Promise((r) => setTimeout(r, waited));
const lapsed = await statusOf(A, B);
check('a peer that stopped heartbeating is not online', lapsed !== 'online', lapsed);

console.log('\n===== and the app, which reads deltas, is told without asking =====');
/* The app says it reads deltas (caps pd1): it is given the whole table once and then only what changed. Presence
   used to leave out whether a peer was awake, so for such a client a frozen phone stayed "online" for ever. */
B.frozen = false;
B.ws.send(JSON.stringify({ type: 'presence-state', state: 'active' }));
const watcher = await openPeer('watcher', ['pd1']);
watcher.inbox.length = 0;
const asBeat = setInterval(() => { if (!B.frozen && B.ws.readyState === WebSocket.OPEN) B.ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() })); }, 4000);
await new Promise((r) => setTimeout(r, 2500));
B.ws.send(JSON.stringify({ type: 'presence-state', state: 'away' }));
const until = Date.now() + 10000;
const seenAway = () => watcher.inbox.some((m) => m.type === 'peers-delta' && (m.upsert || []).some((p) => p.fingerprint === B.fingerprint && p.status === 'away'));
while (!seenAway() && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
check('a delta-reading client is told, by a delta, that the peer went away', seenAway(), JSON.stringify(watcher.inbox.map((m) => m.type)));
watcher.inbox.length = 0;
B.ws.send(JSON.stringify({ type: 'presence-state', state: 'active' }));
const backUntil = Date.now() + 10000;
const seenBack = () => watcher.inbox.some((m) => m.type === 'peers-delta' && (m.upsert || []).some((p) => p.fingerprint === B.fingerprint && p.status === 'online'));
while (!seenBack() && Date.now() < backUntil) await new Promise((r) => setTimeout(r, 200));
check('and that they came back', seenBack(), JSON.stringify(watcher.inbox.map((m) => m.type)));
clearInterval(asBeat);
watcher.ws.close();

clearInterval(beat);
A.ws.close(); B.ws.close(); fakeVendor.close();
const failed = results.filter((r) => !r).length;
console.log(`\n===== ${failed} failed of ${results.length} =====`);
process.exit(failed ? 1 : 0);
