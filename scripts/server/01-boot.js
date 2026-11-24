/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const os = require('os');
const dns = require('dns').promises;
const fs = require('fs');
const fsp = require('node:fs/promises');
const path = require('path');
const express = require('express');
const { ExpressPeerServer } = require('peer');
const webpush = require('web-push');
const { pushKindFor, pushBodyFor, pushTagFor, normalizePushLang, pushSendOptions, sanitizeNoticeHint } = require('./lib/push-wording.js');
const { loadOrCreateRelayIdentity, publicRelayIdentity, formatRelayId, relayPqPrivateKey, relayIdFor } = require('./lib/relay-identity.js');
const { createRelayPeers, parseTransitPeers, makeIdentityFetcher } = require('./lib/relay-peers.js');
const { openTransit, transitFacts, sealTransit } = require('./lib/relay-transit.js');
/* The 3.34 dashboard sheet the relay serves at /Monitor_Server — HTML lives
   in its own module so the server file stays about the server. */
const { monitorDashboardHtml } = require('./lib/monitor-dashboard.js');
const { monitorLoginHtml, monitorClassicHtml } = require('./lib/monitor-pages.js');
const { linkPreview } = require('./lib/link-preview.js');
const telegramStickers = require('./lib/telegram-stickers.js');
const { createFrontDoor, parseFronts, parseDoors } = require('./lib/relay-front.js');
const { relayPrivateKey } = require('./lib/relay-identity.js');
const relayIdentityLib = require('./lib/relay-identity.js');
const { verifyDirectory, planChanges, verifyTlsFor, operatorIdFor, verifyHandover, followHandovers } = require('./lib/relay-directory.js');
const partnerRules = require('./lib/relay-partners.js');
const signatureRules = require('./lib/operator-signature.js');
const {
  readMeminfo, turnPortsInUse, networkBytes, evaluate: evaluateAlerts, limitsFrom, createAlertState, sendTelegram, telegramCall,
} = require('./lib/relay-alerts.js');
const relayReport = require('./lib/relay-report.js');
const telegramConfig = require('./lib/telegram-settings.js');
const { textFor } = require('./lib/telegram-text.js');
const guestRules = require('./lib/relay-guests.js');
/* Identity v4 (docs/design/1.2-identity-v4.md): an Ed25519 key beside the
   RSA one, and the continuation that moves an account from one to the other. */
const identityV4 = require('./lib/identity-v4.js');
const stateDbLib = require('./lib/state-db.js');
const keyLogLib = require('./lib/key-log.js');
const { WebSocketServer, WebSocket } = require('ws');

// Simple .env loader for native runs. CHAT_ENV_FILE names another file, or
// "none" for no file at all (a test of a relay started with nothing set).
const envPath = process.env.CHAT_ENV_FILE || path.join(__dirname, '..', '.env');
if (envPath !== 'none' && fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach((line) => {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match) {
      const key = match[1];
      let value = match[2] || '';
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
      if (!process.env[key]) process.env[key] = value;
    }
  });
}

const DOMAIN = process.env.DOMAIN || 'localhost';
const HOST = process.env.CHAT_SIGNAL_HOST || '0.0.0.0';
/* Where the relay's own ports listen, when that is not everywhere. The relay
   speaks plain HTTP: in the full stack nginx in front of it carries TLS, and
   the plain ports (11220, 11221, 11222) used to answer the whole internet as
   well — anyone could talk to the relay unencrypted, and a client that found
   11220 did. CHAT_LISTEN_HOSTS names the addresses to listen on instead:
   loopback for this machine and the Docker bridge for nginx (an interface
   name such as docker0 stands for its IPv4 address). Unset keeps the old
   behaviour, which the standalone relay — serving clients itself — needs. */
/* An interface's IPv4 address, even while the interface is down. Node lists
   only interfaces that are up and running, and docker0 is down whenever no
   container sits on the default bridge — which is exactly the full stack's
   case (nginx has a network of its own) — while its address still answers
   nginx's host-gateway connections. So `ip` is asked when Node does not know. */
function interfaceIpv4(name) {
  const listed = (os.networkInterfaces()[name] || []).find((entry) => entry.family === 'IPv4' || entry.family === 4);
  if (listed) return listed.address;
  if (!/^[A-Za-z0-9_.-]{1,15}$/.test(name)) return '';
  for (const binary of ['ip', '/sbin/ip', '/usr/sbin/ip', '/bin/ip']) {
    try {
      const out = require('child_process').execFileSync(binary, ['-4', '-o', 'addr', 'show', 'dev', name], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
      const match = out.match(/inet (\d+\.\d+\.\d+\.\d+)\//);
      if (match) return match[1];
    } catch (_error) { /* not this binary, or no such interface */ }
  }
  return '';
}
function resolveListenHosts(value) {
  const hosts = [];
  for (const raw of String(value || '').split(/[,\s]+/)) {
    const name = raw.trim();
    if (!name) continue;
    if (net.isIP(name)) { hosts.push(name); continue; }
    const address = interfaceIpv4(name);
    if (address) hosts.push(address);
    else console.error(`[Listen] interface "${name}" has no IPv4 address here; skipped — whatever reaches the relay through it will be refused`);
  }
  return Array.from(new Set(hosts));
}
const LISTEN_HOSTS = resolveListenHosts(process.env.CHAT_LISTEN_HOSTS);
/* One server, several addresses: a plain listener per extra address hands
   its sockets to the real server, so every request and upgrade handler
   attached to it sees them as its own. */
/* The queue of connections not yet accepted. Node's default of 511 overflows
   when everybody reconnects at once — after a restart, or a network blip at
   a carrier — and the overflow is dropped handshakes that wait for their own
   retry. The kernel still caps it at net.core.somaxconn. */
const LISTEN_BACKLOG = Number(process.env.CHAT_LISTEN_BACKLOG || 4096);
function listenOn(target, port, fallbackHost, onReady) {
  const hosts = LISTEN_HOSTS.length ? LISTEN_HOSTS : [fallbackHost];
  const [first, ...rest] = hosts;
  target.listen({ port, host: first, backlog: LISTEN_BACKLOG }, onReady);
  for (const host of rest) {
    const extra = net.createServer((socket) => target.emit('connection', socket));
    extra.on('error', (error) => console.warn(`[Listen] ${host}:${port} not available: ${error.code || error.message}`));
    extra.listen({ port, host, backlog: LISTEN_BACKLOG });
  }
}
const PORT = Number(process.env.CHAT_SIGNAL_PORT || 11220);
const PRESENCE_PORT = Number(process.env.CHAT_PRESENCE_PORT || 11221);

// Improve path fallbacks for native runs (use relative path if /data is not writable)
const defaultDataDir = fs.existsSync('/data') && (function() { try { fs.accessSync('/data', fs.constants.W_OK); return true; } catch(e) { return false; } })()
  ? '/data'
  : path.join(__dirname, '..', 'data', 'chat-signal');

const PUSH_STORE_PATH = process.env.CHAT_PUSH_STORE_PATH || path.join(defaultDataDir, 'push-subscriptions.json');
const OFFLINE_STORE_PATH = process.env.CHAT_OFFLINE_STORE_PATH || path.join(defaultDataDir, 'offline-messages.json');
/* The relay's state in one SQLite database (roadmap 2.4; scripts/lib/state-db.js).
   Beside the stores it replaces, so a test bed that points them into its own
   directory gets its own database too. CHAT_STATE_DB=off keeps the JSON files
   (the way back for one release); CHAT_STATE_DB_PATH puts it elsewhere. */
const STATE_DB_PATH = process.env.CHAT_STATE_DB_PATH || path.join(path.dirname(OFFLINE_STORE_PATH), 'state.db');
/* The group-call SFU (roadmap 3.2, scripts/sfu.js) checks the room
   capabilities this relay mints with a secret both read from here: made once,
   0600, beside the rest of the state. CHAT_SFU_PORT is where the SFU listens on
   this machine; CHAT_SFU_PUBLIC is the address the apps reach it at (nginx's
   /sfu on the public port). */
const SFU_SECRET_PATH = process.env.CHAT_SFU_SECRET_PATH || path.join(path.dirname(OFFLINE_STORE_PATH), 'sfu-secret');
const SFU_PORT = Number(process.env.CHAT_SFU_PORT || 11223);
const sfuRoomsLib = require('./lib/sfu-rooms.js');
function sfuSecret() {
  try {
    const kept = fs.readFileSync(SFU_SECRET_PATH);
    if (kept.length >= 32) return kept;
  } catch (_error) { /* first start */ }
  const fresh = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(SFU_SECRET_PATH), { recursive: true });
    fs.writeFileSync(SFU_SECRET_PATH, fresh, { mode: 0o600 });
  } catch (error) { console.warn('[SFU] the room secret could not be written:', error.message); }
  return fresh;
}
const SFU_SECRET = sfuSecret();
/* Where the apps reach the SFU: nginx's /sfu on this relay's own origin, unless
   CHAT_SFU_PUBLIC names an address (a test stack, or an SFU elsewhere). */
const SFU_PUBLIC = /^(wss?:\/\/|\/)[^\s]{0,200}$/.test(String(process.env.CHAT_SFU_PUBLIC || '')) ? String(process.env.CHAT_SFU_PUBLIC) : '/sfu';
/* Whether an SFU answers on this machine: asked now and every minute, and
   said in /chat-health, so an app offers the large-call mode only where it
   works. */
let sfuUp = false;
function checkSfu() {
  const req = http.get({ host: '127.0.0.1', port: SFU_PORT, path: '/sfu/health', timeout: 2000 }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => { try { sfuUp = JSON.parse(body).ok === true; } catch (_error) { sfuUp = false; } });
  });
  req.on('timeout', () => req.destroy());
  req.on('error', () => { sfuUp = false; });
}
setTimeout(checkSfu, 3000).unref?.();
setInterval(checkSfu, Math.max(1000, Number(process.env.CHAT_SFU_CHECK_MS) || 60 * 1000)).unref?.();
const STATE_DB_WANTED = String(process.env.CHAT_STATE_DB || 'on').toLowerCase() !== 'off';
let stateDbHandle;
function stateDb() {
  if (stateDbHandle !== undefined) return stateDbHandle;
  stateDbHandle = STATE_DB_WANTED ? stateDbLib.openStateDb(STATE_DB_PATH) : null;
  if (STATE_DB_WANTED && !stateDbHandle) console.error(`[State] SQLite not available (${STATE_DB_PATH}); this run keeps state in JSON files.`);
  return stateDbHandle;
}
/* A whole-file store: what it holds (undefined when nothing yet), and a write.
   With no database, the file as before. */
function readWholeStore(store, file) {
  const db = stateStore(store, { file });
  if (db) return db.get(store, '');
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeWholeStore(store, file, value) {
  const db = stateStore(store, { file });
  if (db) { db.put(store, '', value); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, value);
}
/* One store, by name, with the old files it is imported from on first use. */
function stateStore(store, legacy) {
  const db = stateDb();
  if (!db) return null;
  try { stateDbLib.adopt(db, store, typeof legacy === 'function' ? legacy() : legacy); } catch (error) {
    console.error(`[State] ${store}: import from the old files failed (${error.message}); they are left as they were.`);
  }
  return db;
}
/* What build this relay is, so a deployment can be verified rather than
   assumed. Two relays that carry for each other have to be kept in step, and
   until now nothing a relay said identified which tree it was built from —
   which made "are they in step?" a question with no answer.
   Read from the package.json that ships beside the server, and tolerant of it
   being absent: an unknown version is worth reporting as unknown, not worth
   refusing to start over. */
const RELAY_BUILD = (() => {
  /* A buildTag is what distinguishes the tree's own package.json from
     config/relay-overrides.json, which the deployed image copies to
     package.json and which carries a placeholder version of 1.0.0. Reporting
     that as the build would be worse than reporting nothing, so a candidate
     without a buildTag is not the one being looked for.
     The two images lay the file out differently — the deployed relay runs from
     /app/scripts, the distribution from /app — so both shapes are tried. */
  for (const candidate of ['../app-version.json', './app-version.json',
    './package.json', '../package.json']) {
    try {
      const pkg = require(candidate);
      if (pkg?.version && pkg?.buildTag) {
        return { version: String(pkg.version), buildTag: String(pkg.buildTag) };
      }
    } catch (_error) { /* try the next one */ }
  }
  return { version: '', buildTag: '' };
})();

/* This relay's own name, and the private half it proves with. See
   scripts/lib/relay-identity.js for why it is an X25519 key and why the id
   covers that key alone. */
/* Beside the rest of the server state rather than in the default data
   directory, which is the same rule the policy and self-destruct stores
   follow: a deployment that moved its data somewhere else moved ALL of it,
   and an identity left behind is a relay that silently renames itself the
   first time somebody runs it with a different store path. */
const RELAY_IDENTITY_PATH = process.env.CHAT_RELAY_IDENTITY_PATH
  || path.join(path.dirname(OFFLINE_STORE_PATH), 'relay-identity.json');
const relayIdentity = loadOrCreateRelayIdentity(RELAY_IDENTITY_PATH);
if (relayIdentity.source !== 'file') {
  console.log(`[Relay] Relay identity ${formatRelayId(relayIdentity.id)}`);
}
/* Transit peers: the other relays this one will hand traffic to, and take it
   from. Named by identity with an address attached, because an address alone
   names whoever holds the hostname today.
   Empty means transit is off, which is the default. A relay that carried for
   anyone who asked would be an open relay — somebody else's traffic at this
   operator's expense — and the arrangement this exists for is between two
   operators who have already agreed with each other. */
const TRANSIT_PEERS = parseTransitPeers(process.env.CHAT_TRANSIT_PEERS || '');
/* Off by default, and it matters less than it looks: the link is
   authenticated by relay identity whatever the transport says. See the note
   above makeIdentityFetcher. */
const TRANSIT_VERIFY_TLS = process.env.CHAT_TRANSIT_INSECURE_TLS !== '1';
const relayPrivate = relayPrivateKey(relayIdentity);
/* Key transparency (roadmap 1.4; scripts/lib/key-log.js): the log of the v4
   keys this relay has seen proven, with its signed head, and the heads of the
   relays it links with. */
/* The heads are signed with a key of the log's own (finding F2), which the
   identity key vouches for once; the identity key itself then only agrees
   transit seals and proves the relay. */
const ktSigning = (() => {
  try {
    const ktPrivate = relayIdentityLib.ktPrivateKey(relayIdentity);
    const ktPublic = relayIdentity.keys?.ktSign?.publicKey || '';
    if (!ktPrivate || !ktPublic) return null;
    const statementSig = crypto.sign('sha256', relayIdentityLib.ktKeyStatement(relayIdentity.id, ktPublic), { key: relayPrivate, dsaEncoding: 'ieee-p1363' }).toString('base64');
    return { privateKey: ktPrivate, publicKey: ktPublic, statementSig };
  } catch (error) {
    console.warn('[KT] no key-log key; heads are signed with the identity key:', error.message);
    return null;
  }
})();
const keyLog = keyLogLib.createKeyLog({ db: stateDb(), relayId: relayIdentity.id, privateKey: relayPrivate, ktKey: ktSigning });
const peerKeyHeads = keyLogLib.createPeerHeads({ db: stateDb() });
/* A log that is not kept starts again empty on every restart, and a head of
   size N held by anyone could then never be extended: every relay and every
   app that saw it would call this relay forked from then on. Without the
   database the log is not offered at all (404, which an app reads as "this
   relay keeps no log") and no head is gossiped. */
const KEY_LOG_SERVED = Boolean(stateDb());
/* The front door (scripts/lib/relay-front.js), set up just below. Declared
   first because the link callbacks reach it. */
let frontDoor = null;
/* Hosts a partner's directory named, which relay links may dial only at an
   address that is not private. Filled where partner gateways are allowed. */
const partnerHosts = new Set();
const relayLinkLookup = partnerRules.guardedLookup({
  resolve: (hostname) => dns.lookup(hostname, { all: true, verbatim: true }),
  isPartnerHost: (hostname) => partnerHosts.has(String(hostname || '').toLowerCase()),
  allowPrivate: process.env.CHAT_PARTNER_ALLOW_PRIVATE === '1',
});
class RelayLinkSocket extends WebSocket {
  constructor(address, protocols, options) {
    const opts = protocols && typeof protocols === 'object' && !Array.isArray(protocols) ? protocols : (options || {});
    super(address, Array.isArray(protocols) ? protocols : [], { ...opts, lookup: relayLinkLookup });
  }
}
const relayPeers = createRelayPeers({
  identity: publicRelayIdentity(relayIdentity),
  privateKey: relayPrivate,
  pqPrivateKey: relayPqPrivateKey(relayIdentity),
  allowlist: TRANSIT_PEERS.map((peer) => peer.id),
  WebSocketImpl: RelayLinkSocket,
  fetchIdentity: makeIdentityFetcher({ verifyTls: TRANSIT_VERIFY_TLS }),
  verifyTls: TRANSIT_VERIFY_TLS,
  /* A family relay's inside IP address is dialled without the certificate
     name check: the link proves the relay's key whatever the transport says. */
  verifyTlsFor: (peerId, origin) => verifyTlsFor({ origin, familyMember: isFamilyPeer(peerId), verifyTls: TRANSIT_VERIFY_TLS }),
  onFrame: (payload, link) => {
    if (partnerFrameRefused(payload, link)) return;
    if (frontDoor?.onFrame(payload, link)) return;
    handleTransitFrame(payload, link);
  },
  onLinkUp: (link) => { frontDoor?.linkUp(link); offerKeyHeadTo(link); offerDirectoryTo(link); partnersLinkUp(link); shareFamilyLinks(); sendRosterCopiesTo(link); guestHomeLinkChanged(link, true); },
  /* Function declarations below are hoisted, so this resolves at call time. */
  onLinkDown: (link) => { frontDoor?.linkDown(link); failTransitWaitsFor(link?.peerId); partnersLinkDown(link); familyLinksFrom.delete(link?.peerId); shareFamilyLinks(); guestHomeLinkChanged(link, false); },
});
/* CHAT_FRONTS on the relay people can reach: `<relay id>@<public origin>` for
   each relay it answers for (nginx hands that origin's connections to
   CHAT_FRONT_PORT, 9011 and up). CHAT_FRONT_DOORS on the relay behind it:
   the ids of the relays allowed to carry its streams. Both need the transit
   link between the two already configured. */
const FRONTS = parseFronts(process.env.CHAT_FRONTS, process.env.CHAT_FRONT_PORT || 9011);
const FRONT_DOORS = parseDoors(process.env.CHAT_FRONT_DOORS);
/* Started at boot, below, once ALLOWED_ORIGINS exists. */
function startFrontDoor() {
  if (!FRONTS.length && !FRONT_DOORS.length) return;
  frontDoor = createFrontDoor({
    relayPeers,
    fronts: FRONTS,
    doors: FRONT_DOORS,
    localPort: PORT,
    listenHosts: LISTEN_HOSTS.length ? LISTEN_HOSTS : ['127.0.0.1'],
    /* Only this relay's own names: origins listed for CORS or as mirrors are
       other servers' names, and a client looking a door up by name must not
       be sent here for a relay that is not this one. */
    ownOrigins: ALLOWED_ORIGINS.filter((origin) => {
      try { return /^https?:$/.test(new URL(origin).protocol) && (!DOMAIN || new URL(origin).hostname === String(DOMAIN).toLowerCase()); } catch (_error) { return false; }
    }),
  });
  frontDoor.listen();
}
if (relayPeers.enabled()) {
  console.log(`[Transit] enabled for ${TRANSIT_PEERS.length} relay(s)`);
  /* Dialled once at start and redialled on its own backoff afterwards. An
     entry with no address is one this relay will answer but never call. */
  for (const peer of TRANSIT_PEERS) {
    if (peer.origin) setTimeout(() => relayPeers.dial(peer.id, peer.origin).catch(() => {}), 500).unref?.();
  }
}


const OFFLINE_STORE_DIR = process.env.CHAT_OFFLINE_STORE_DIR
  || path.join(path.dirname(OFFLINE_STORE_PATH), 'mailboxes');
/* Device-sync beacons; see "Device sync beacons" further down. Declared up
   here because the store is swept at load, before that section runs. */
const BEACON_DIR = process.env.CHAT_BEACON_DIR || path.join(path.dirname(OFFLINE_STORE_PATH), 'beacons');
const BEACON_MAX_CHARS = 11000;          /* 8 KB of ciphertext, base64 */
const BEACON_MAX_DEVICES = 8;
const BEACON_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/* What one device of an account leaves for its siblings that are away
   (holdForAbsentSiblings below): sync envelopes only — messages and what
   became of them, never a file — kept for the devices that were not here,
   and gone the moment each has collected its copy. Bounded per account. */
const SIBLING_DIR = process.env.CHAT_SIBLING_DIR || path.join(path.dirname(OFFLINE_STORE_PATH), 'siblings');
const SIBLING_ITEM_MAX_CHARS = 96 * 1024;
const SIBLING_ACCOUNT_MAX_CHARS = 4 * 1024 * 1024;
const SIBLING_ACCOUNT_MAX_ITEMS = 2000;
const SIBLING_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const SIBLING_DELIVERY_BATCH = 40;
/* Across every account on this relay: past it, nothing more is held (the
   device then catches up from a sibling directly), and the cache keeps no
   more than this much in memory however many accounts are busy. */
const SIBLING_GLOBAL_MAX_CHARS = Number(process.env.CHAT_SIBLING_MAX_BYTES || 256 * 1024 * 1024);
const SIBLING_CACHE_MAX_CHARS = 32 * 1024 * 1024;
/* Up here, not beside the functions that use them: the mailboxes load (and
   count what is held) before the rest of this file has run. */
const siblingHeldCache = new Map();
const siblingHeldChars = new Map();
let siblingCachedChars = 0;
let siblingTotalChars = 0;
const beaconCache = new Map();
/* Which devices are still part of an account; see "The device roster"
   further down. A small signed document per account, nothing more. */
const ROSTER_DIR = process.env.CHAT_ROSTER_DIR || path.join(path.dirname(OFFLINE_STORE_PATH), 'rosters');
/* Accounts that moved to identity v4: old fingerprint → { newFp, until, at },
   from a continuation both keys signed (scripts/lib/identity-v4.js). Mail
   addressed to the old fingerprint is held for the new one until `until`
   (ninety days), and the old key no longer opens that mailbox. */
const MOVES_PATH = process.env.CHAT_MOVES_PATH || path.join(path.dirname(OFFLINE_STORE_PATH), 'identity-moves.json');
const ROSTER_MAX_CHARS = 32 * 1024;
const ROSTER_MAX_MEMBERS = 32;
const ROSTER_MAX_REVOKED = 128;
const rosterCache = new Map();

const POLICY_STORE_PATH = process.env.CHAT_POLICY_STORE_PATH || path.join(path.dirname(OFFLINE_STORE_PATH), 'server-policy.json');
const SELF_DESTRUCT_STORE_PATH = process.env.CHAT_SELF_DESTRUCT_STORE_PATH || path.join(path.dirname(OFFLINE_STORE_PATH), 'self-destruct-records.json');

