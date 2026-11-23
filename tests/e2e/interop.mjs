/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text.
 */

/* P00RIJA Chat and P00RIJA Cryptography talk to each other.
 *
 * The two apps are one messenger in two shells, and somebody on one is meant
 * to reach somebody on the other through the same relay. Every other suite
 * loads the same build on both sides, so none of them would notice the two
 * drifting apart — and they have drifted on purpose: Chat offers a key
 * exchange with a post-quantum half and publishes a prekey with one, and
 * Cryptography knows neither.
 *
 * This suite opens one page from each tree on one relay and asks what has to
 * be true for the claim to hold:
 *
 *   LIVE       a session is keyed and a message crosses, each way, whichever
 *              of the two happens to be the side that offers the exchange.
 *   BY RELAY   with no channel between them, a message sealed by one is
 *              opened by the other, each way.
 *   HONESTLY   the side that can do more does not pretend it did: the session
 *              is not called hybrid, and the other is not remembered as able.
 *
 * The relay and the first page come from the tree this file is in; the second
 * page from the other tree. Run it from both to cover both relays:
 *
 *   node tests/e2e/interop.mjs                 (in P00RIJA-CHAT)
 *   node tests/e2e/interop.mjs                 (in P00RIJA-Cryptography, with P00RIJA-CHAT beside it)
 *   OTHER_ROOT=/path/to/the/other/tree node tests/e2e/interop.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp, identity, importIdentity, browser, waitFor } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/* The two apps are separate projects in sibling folders: this one is P00RIJA-CHAT, the other P00RIJA-Cryptography beside it
   (until 2026-11-19 this one was a folder inside the other). OTHER_ROOT says where the other is when it is somewhere else. */
const guess = path.basename(HERE) === 'P00RIJA-CHAT' ? path.join(path.dirname(HERE), 'P00RIJA-Cryptography') : path.join(path.dirname(HERE), 'P00RIJA-CHAT');
const OTHER = path.resolve(process.env.OTHER_ROOT || guess);
const nameOf = (root) => { try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch (e) { return {}; } };
const here = nameOf(HERE);
const other = nameOf(OTHER);
const label = (pkg, root) => `${path.basename(root)} ${pkg.version || '?'}`;

const results = [];
const check = (n, ok, d = '') => {
  results.push({ n, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + String(d).slice(0, 260) : ''}`);
};
const section = (title) => console.log(`\n===== ${title} =====`);
const decode = (card) => JSON.parse(Buffer.from(card.replace('poorija-chat-v1:', ''), 'base64').toString('utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

if (!fs.existsSync(path.join(OTHER, 'scripts', 'dev-static.js')) || !fs.existsSync(path.join(OTHER, 'index.html'))) {
  console.error(`No other tree to talk to at ${OTHER}. Set OTHER_ROOT.`);
  process.exit(2);
}

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
const keyed = (page, fp, timeoutMs = 60000) => waitFor(page, (key) => {
  const peer = findPeerByAnyKey(key);
  const session = peer && chatState.sessions.get(peer.peerId);
  return Boolean(session?.cryptoKey && session.connection?.open);
}, { timeoutMs, arg: fp });
const sessionOf = (page, fp) => page.evaluate((key) => {
  const peer = findPeerByAnyKey(key);
  const session = peer && chatState.sessions.get(peer.peerId);
  return session ? { source: session.keySource || '', hybrid: Boolean(session.keyHybrid), owner: sessionKeyOwner(session),
    pinned: peer.kexPinned || 0, theirPq: Boolean(peer.prekeyPq), theirPrekey: Boolean(peer.prekeyPublic) } : null;
}, fp);
/* No channel between them from here on: what is sent goes sealed, by the
   relay. Says what each seal was, as the sender made it. */
const cutChannel = (page, fp) => page.evaluate((key) => {
  const peer = findPeerByAnyKey(key);
  try { chatState.sessions.get(peer.peerId)?.connection?.close(); } catch (e) { /* gone */ }
  chatState.sessions.delete(peer.peerId);
  window.ensureDirectSession = async () => null;
  window.startSecureSession = async () => null;
  if (!window.__seals) {
    window.__seals = [];
    const prekey = window.sealWithPrekey;
    window.sealWithPrekey = async function watched(...args) {
      const kex = await prekey.apply(this, args);
      window.__seals.push(kex ? `prekey v${kex.v}` : 'no prekey seal');
      return kex;
    };
  }
}, fp);

const stacks = await startTwoStacks();
const otherPort = await freePort();
const otherStatic = spawn(process.execPath, ['scripts/dev-static.js'], { cwd: OTHER, env: { ...process.env, PORT: String(otherPort) }, stdio: 'ignore' });
const otherUrl = `http://localhost:${otherPort}`;
try {
  for (let i = 0; i < 40; i += 1) {
    try { if ((await fetch(`${otherUrl}/index.html`)).ok) break; } catch (e) { /* not up yet */ }
    await sleep(250);
  }
  console.log(`\n  relay and one page: ${label(here, HERE)}\n  the other page:     ${label(other, OTHER)}`);

  /* Which side offers the key exchange is decided by whose fingerprint sorts
     first, so a pair covers one of the two cases at random. Pairs are made
     until both have been seen, a few times at most. */
  const seen = new Set();
  for (let round = 1; round <= 4 && seen.size < 2; round += 1) {
    const HOME = await openApp(`HOME${round}`, { origin: stacks.a.url, relay: stacks.a.url });
    const AWAY = await openApp(`AWAY${round}`, { origin: otherUrl, relay: stacks.a.url });
    const cards = { HOME: await identity(HOME), AWAY: await identity(AWAY) };
    const fp = { HOME: decode(cards.HOME).fingerprint, AWAY: decode(cards.AWAY).fingerprint };
    const offerer = fp.HOME < fp.AWAY ? 'home' : 'away';
    if (seen.has(offerer)) { await HOME.context().close(); await AWAY.context().close(); continue; }
    seen.add(offerer);
    const who = offerer === 'home' ? label(here, HERE) : label(other, OTHER);
    section(`${who} offers the key exchange`);

    const builds = { home: await HOME.evaluate(() => PoorijaApp.APP_VERSION_SEMVER), away: await AWAY.evaluate(() => PoorijaApp.APP_VERSION_SEMVER) };
    check('one page is from each tree', builds.home === here.version && builds.away === other.version, JSON.stringify(builds));
    await importIdentity(HOME, cards.AWAY);
    await importIdentity(AWAY, cards.HOME);
    await openConversation(HOME, fp.AWAY);
    await openConversation(AWAY, fp.HOME);
    await say(HOME, `hello-${Date.now()}`);
    const live = (await keyed(HOME, fp.AWAY)) && (await keyed(AWAY, fp.HOME));
    check('a live session is keyed on both sides', Boolean(live));
    const h = await sessionOf(HOME, fp.AWAY);
    const a = await sessionOf(AWAY, fp.HOME);
    console.log('  ' + JSON.stringify({ home: h, away: a }));
    const there = `there-${Date.now()}`;
    await say(HOME, there);
    check('a message crosses one way', await received(AWAY, there), there);
    const back = `back-${Date.now()}`;
    await say(AWAY, back);
    check('and the other', await received(HOME, back), back);
    /* What each side says about the session it has. Only one of the two can
       do the hybrid exchange, so it cannot have happened. */
    const bothCan = [h, a].every((s) => s && typeof s.hybrid === 'boolean') && await HOME.evaluate(() => typeof kexHybridAvailable === 'function' && kexHybridAvailable())
      && await AWAY.evaluate(() => typeof kexHybridAvailable === 'function' && kexHybridAvailable());
    if (!bothCan) {
      check('the session is not called hybrid by the side that could have done it', h?.hybrid !== true && a?.hybrid !== true, JSON.stringify({ home: h?.hybrid, away: a?.hybrid }));
      check('and the other is not remembered as able to', (h?.pinned || 0) === 0 && (a?.pinned || 0) === 0, JSON.stringify({ home: h?.pinned, away: a?.pinned }));
    } else {
      check('both can do the hybrid exchange, and did', h?.hybrid === true && a?.hybrid === true);
    }

    section(`${who} offered; now with no channel, by the relay`);
    await cutChannel(HOME, fp.AWAY);
    await cutChannel(AWAY, fp.HOME);
    await sleep(600);
    const sealedThere = `sealed-there-${Date.now()}`;
    await say(HOME, sealedThere);
    check('a sealed message crosses one way', await received(AWAY, sealedThere), sealedThere);
    const sealedBack = `sealed-back-${Date.now()}`;
    await say(AWAY, sealedBack);
    check('and the other', await received(HOME, sealedBack), sealedBack);
    const seals = { home: await HOME.evaluate(() => window.__seals || []), away: await AWAY.evaluate(() => window.__seals || []) };
    console.log('  sealed as ' + JSON.stringify(seals));
    check('each sealed to the other\'s prekey, not to the identity key', seals.home.length > 0 && seals.away.length > 0
      && seals.home.every((s) => s.startsWith('prekey')) && seals.away.every((s) => s.startsWith('prekey')), JSON.stringify(seals));

    const errors = [...HOME.__errors, ...AWAY.__errors];
    check('no script error on either side', errors.length === 0, errors.slice(0, 3).join(' | '));
    await HOME.context().close();
    await AWAY.context().close();
  }
  section('both cases');
  check('each tree was seen offering the exchange', seen.size === 2, [...seen].join(', '));
} finally {
  await browser.close();
  try { otherStatic.kill(); } catch (e) { /* gone */ }
  await stacks.stop();
}
const bad = results.filter((r) => !r.ok);
console.log(`\n===== ${bad.length} failed of ${results.length} =====`);
process.exit(bad.length ? 1 : 0);
