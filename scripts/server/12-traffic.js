/* ---- traffic ---------------------------------------------------------------- */

app.post('/Monitor_Server/traffic', authMiddleware, (req, res) => {
  const clients = Array.from(clientTraffic.entries())
    .map(([clientId, row]) => ({
      clientId: clientId.slice(0, 8),
      label: row.label ? row.label.slice(0, 24) : '',
      msgsIn: row.msgsIn, msgsOut: row.msgsOut,
      bytesIn: row.bytesIn, bytesOut: row.bytesOut,
      lastAt: new Date(row.lastAt).toISOString(),
    }))
    .sort((a, b) => (b.bytesIn + b.bytesOut) - (a.bytesIn + a.bytesOut))
    .slice(0, 25);
  const relays = Array.from(transitTraffic.entries())
    .map(([relayId, row]) => ({ relayId: relayId.slice(0, 16), carried: row.carried, bytes: row.bytes, lastAt: new Date(row.lastAt).toISOString() }))
    .sort((a, b) => b.bytes - a.bytes);
  res.json({
    ok: true,
    totals: {
      msgsIn: totalMessagesReceived, msgsOut: totalMessagesSent,
      bytesIn: totalBytesReceived, bytesOut: totalBytesSent, relays: totalRelays,
    },
    clients, relays,
  });
});

/* ---- events, hourly rollups, cross-relay activity, live calls ---------- */

/* The dashboard's report feed. Not a log file — a short memory of what the
   operator would want to see in order, kept in-process and lost with the
   relay, which is exactly the honest lifetime for it. */
const monitorEvents = [];
const MONITOR_EVENTS_MAX = 200;
function noteEvent(kind, text) {
  monitorEvents.push({ at: new Date().toISOString(), kind: String(kind).slice(0, 24), text: String(text).slice(0, 200) });
  if (monitorEvents.length > MONITOR_EVENTS_MAX) monitorEvents.shift();
}
function monitorLog(text) {
  console.log(`[Monitor] ${text}`);
  noteEvent('monitor', text);
}

/* One row per hour: the counters at the top of the hour, so the reports tab
   can draw yesterday without anybody having configured anything. */
const hourlyTraffic = [];
const HOURLY_MAX = 48;
setInterval(() => {
  hourlyTraffic.push({
    at: new Date().toISOString(),
    msgsIn: totalMessagesReceived, msgsOut: totalMessagesSent,
    bytesIn: totalBytesReceived, bytesOut: totalBytesSent,
    peers: presence.size,
  });
  if (hourlyTraffic.length > HOURLY_MAX) hourlyTraffic.shift();
}, 60 * 60 * 1000).unref();

/* Who has been talking THROUGH another relay lately. The envelope is sealed
   and stays sealed — this records only that the sender crossed the link, and
   the dashboard shows it as a badge that ages out. */
const transitActivity = new Map(); // clientId -> lastAt
function noteTransitActivity(clientId) {
  if (!clientId) return;
  transitActivity.set(clientId, Date.now());
  if (transitActivity.size > 1000) transitActivity.delete(transitActivity.keys().next().value);
}
function transitActivityMinutesAgo(clientId) {
  const at = transitActivity.get(clientId);
  if (!at) return null;
  return Math.round((Date.now() - at) / 60000);
}

/* Live calls on THIS relay, from the signaling it already sees: an invite
   opens a row, a cancel or a miss closes it, and ten quiet minutes close it
   for sure — a monitor that shows a dead call as live is worse than none. */
const activeCalls = new Map(); // clientId -> { since, peer, group }
const CALL_TTL_MS = 10 * 60 * 1000;
function noteCallFrame(fromClientId, payloadType, peerLabel) {
  if (!fromClientId) return;
  const isGroup = payloadType.startsWith('gcall');
  if (payloadType === 'call-invite' || payloadType === 'gcall-invite') {
    activeCalls.set(fromClientId, { since: Date.now(), peer: String(peerLabel || '').slice(0, 40), group: isGroup });
  } else if (payloadType === 'call-cancel' || payloadType === 'call-missed' || payloadType === 'gcall-leave') {
    activeCalls.delete(fromClientId);
  }
  if (activeCalls.size > 200) activeCalls.delete(activeCalls.keys().next().value);
}
setInterval(() => {
  const now = Date.now();
  for (const [clientId, call] of activeCalls) {
    if (now - call.since > CALL_TTL_MS) activeCalls.delete(clientId);
  }
}, 60 * 1000).unref();

/* The reports tab: everything above in one answer. */
app.post('/Monitor_Server/reports', authMiddleware, (req, res) => {
  const calls = [];
  for (const [clientId, call] of activeCalls) {
    const record = Array.from(presence.values()).find((peer) => peer.clientId === clientId);
    calls.push({
      username: record?.username || clientId.slice(0, 8),
      peer: call.peer,
      group: call.group,
      since: new Date(call.since).toISOString(),
    });
  }
  res.json({
    ok: true,
    events: monitorEvents.slice(-80).reverse(),
    hourly: hourlyTraffic.slice(),
    activeCalls: calls,
    transitActive: Array.from(transitActivity.entries())
      .map(([clientId, at]) => ({ clientId: clientId.slice(0, 8), minutesAgo: Math.round((Date.now() - at) / 60000) }))
      .sort((a, b) => a.minutesAgo - b.minutesAgo)
      .slice(0, 20),
  });
});

/* The purge's own log — what the retention decided and when, straight from
   the file it already keeps, newest first, never more than a screen. */
app.post('/Monitor_Server/expiry-log', authMiddleware, (req, res) => {
  try {
    const raw = readWholeStore('expiry-log', EXPIRY_LOG_PATH) || [];
    const entries = Array.isArray(raw) ? raw : (Array.isArray(raw.entries) ? raw.entries : []);
    res.json({ ok: true, entries: entries.slice(-100).reverse() });
  } catch (_error) {
    res.json({ ok: true, entries: [] });
  }
});

/* ---- the announce centre ----------------------------------------------------
 *
 * The old broadcast reached whoever was holding a socket; everyone else
 * learned nothing until they came back. This reaches every identity the
 * relay has ever served: a queued mailbox entry (so it is waiting on the
 * next connection), a live frame to anyone connected now, and a push
 * notification to every device that subscribed one — online or not.
 *
 * Attachments ride the entry the way chat media never can (server-origin,
 * already in the clear to the server, capped small), and the app renders
 * them from the system note it already knows how to draw. */

const ANNOUNCE_MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
/* An announce with an attachment to the full registry is a disk bomb: 20k
   identities × 2MB each. Text-only announces are cheap; attachments are
   capped to a targeted list. */
const ANNOUNCE_ATTACHMENT_MAX_RECIPIENTS = 100;
/* ---- the identity registry ---------------------------------------------------
 *
 * The first announce answered "reached 0 identities" on a quiet relay, and
 * The first announce answered "reached 0 identities" on a quiet relay, and
 * it was honest: it counted mailboxes (empty) plus sockets (none). A relay
 * that can only name who is HERE right now cannot send to everyone, which
 * is the whole point of the announce centre. So every fingerprint the relay
 * ever meets — connected, mailed-to, allowlisted, announced-at — is kept in
 * a small persistent file and reloaded at boot. */
const KNOWN_IDENTITIES_PATH = process.env.CHAT_KNOWN_IDENTITIES_PATH || path.join(defaultDataDir, 'known-identities.json');
const knownIdentities = new Set();
function loadKnownIdentities() {
  try {
    const raw = readWholeStore('known-identities', KNOWN_IDENTITIES_PATH);
    for (const fp of Array.isArray(raw?.fingerprints) ? raw.fingerprints : []) {
      if (/^[a-f0-9]{64}$/.test(String(fp))) knownIdentities.add(fp);
    }
    console.log(`[Monitor] ${knownIdentities.size} known identit${knownIdentities.size === 1 ? 'y' : 'ies'} loaded`);
  } catch (_error) { /* first run */ }
}
function saveKnownIdentities() {
  try {
    const cutoff = Date.now() - PROVEN_IDENTITY_TTL_MS;
    const proven = {};
    for (const [fp, at] of provenIdentities) if (at > cutoff) proven[fp] = at;
    writeWholeStore('known-identities', KNOWN_IDENTITIES_PATH, { fingerprints: Array.from(knownIdentities), proven });
  } catch (error) { console.warn('[Monitor] identity registry not saved:', error.message); }
}
/* Fingerprints that PROVED themselves on this relay, and when they last did.
 *
 * knownIdentities is everything the relay ever met, mail addressed to a
 * stranger included, so it cannot answer "does this person live here?". This
 * can: only a socket that answered the identity challenge is written into it.
 * It is what a linked relay is told when a client asks where to deliver — yes
 * or no for the one fingerprint asked, and nothing else. Entries age out after
 * ninety days of absence, so a person who moved relays stops being claimed. */
const PROVEN_IDENTITY_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const provenIdentities = new Map();
function loadProvenIdentities() {
  try {
    const raw = readWholeStore('known-identities', KNOWN_IDENTITIES_PATH);
    const cutoff = Date.now() - PROVEN_IDENTITY_TTL_MS;
    for (const [fp, at] of Object.entries(raw?.proven || {})) {
      if (/^[a-f0-9]{64}$/.test(fp) && Number(at) > cutoff) provenIdentities.set(fp, Number(at));
    }
  } catch (_error) { /* first run */ }
}
function noteProvenIdentity(fingerprint) {
  const fp = sanitizeFingerprint(String(fingerprint || ''));
  if (!/^[a-f0-9]{64}$/.test(fp)) return;
  const previous = provenIdentities.get(fp) || 0;
  provenIdentities.set(fp, Date.now());
  if (provenIdentities.size > 20000) provenIdentities.delete(provenIdentities.keys().next().value);
  /* A daily refresh is plenty for a ninety-day window; writing on every
     reconnect would be a disk write per page load. */
  if (Date.now() - previous > 24 * 60 * 60 * 1000) noteKnownIdentity(fp, { force: true });
}
function identityLivesHere(fingerprint) {
  const at = provenIdentities.get(String(fingerprint || ''));
  return Boolean(at && Date.now() - at < PROVEN_IDENTITY_TTL_MS);
}

function noteKnownIdentity(fingerprint, { force = false } = {}) {
  const fp = sanitizeFingerprint(String(fingerprint || ''));
  if (!fp || fp.length < 32) return;
  if (knownIdentities.has(fp) && !force) return;
  knownIdentities.add(fp);
  /* Cap the registry so it cannot grow without bound on a hostile relay. */
  if (knownIdentities.size > 20000) knownIdentities.delete(knownIdentities.keys().next().value);
  /* Debounced, not per-hello: a sync write of the full registry inside
     the WS receive path froze the event loop per new fingerprint. */
  if (noteKnownIdentity._timer) clearTimeout(noteKnownIdentity._timer);
  noteKnownIdentity._timer = setTimeout(() => {
    noteKnownIdentity._timer = null;
    saveKnownIdentities();
  }, 2000);
  if (noteKnownIdentity._timer && typeof noteKnownIdentity._timer.unref === 'function') noteKnownIdentity._timer.unref();
}
loadKnownIdentities();
loadProvenIdentities();

/* ---- guest mode (scripts/lib/relay-guests.js) ---------------------------------
 *
 * Someone whose home relay is another relay of this family, and unreachable
 * from where they are, may stay here for a while as a guest: their mail
 * reaches them here, but they are never a resident — this relay never claims
 * them in a route answer, and never writes them down as living here. Only a
 * relay whose own entry in the signed family list says `guests: true` takes
 * guests at all, and never more than a share of its sockets. */
const GUEST_SHARE = (() => {
  const raw = process.env.CHAT_GUEST_SHARE;
  const value = raw === undefined || raw === '' ? 0.3 : Number(raw);
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.3;
})();
const GUEST_TTL_MS = Number(process.env.CHAT_GUEST_TTL_MS || 24 * 60 * 60 * 1000);
const GUEST_FORWARD_MS = Number(process.env.CHAT_GUEST_FORWARD_MS || 7 * 24 * 60 * 60 * 1000);
const guestBook = guestRules.createGuestBook({
  file: process.env.CHAT_GUEST_BOOK_PATH || path.join(path.dirname(OFFLINE_STORE_PATH), 'guests.json'),
  ttlMs: GUEST_TTL_MS,
  forwardMs: GUEST_FORWARD_MS,
  saveDelayMs: 2000,
});
/* A device without an id (an old build) is told apart by its socket. */
const guestDeviceOf = (record) => String(record.deviceId || record.clientId || '').slice(0, 128);
function liveGuestSockets() {
  let count = 0;
  for (const record of presence.values()) if (record.guest && record.ws?.readyState === WebSocket.OPEN) count += 1;
  return count;
}
/* Whether someone is connected here as a resident: a guest's socket is up,
   but that is not somebody living here. */
function residentSocketUp(fingerprint) {
  const best = findOpenPresenceByFingerprint(fingerprint);
  if (!best) return false;
  if (!best.guest) return true;
  return Array.from(verifiedByFingerprint.get(fingerprint) || []).some((record) => !record.guest && record.ws?.readyState === WebSocket.OPEN);
}
function familyRelayName(id) {
  return String(directoryState.doc?.body?.relays?.find((relay) => relay.id === id)?.name || String(id || '').slice(0, 12));
}
/* One word to the operator per outage: the first guest from a home after six
   quiet hours. */
const guestAlertAt = new Map();
function noteGuestAlert(homeId) {
  const last = guestAlertAt.get(homeId) || 0;
  guestAlertAt.set(homeId, Date.now());
  if (Date.now() - last < 6 * 60 * 60 * 1000) return;
  const T = botText();
  queueReport({ level: 'info', category: 'peer', title: T.guests.title, body: T.guests.started(familyRelayName(relayIdentity.id), familyRelayName(homeId)) });
  flushAlerts().catch(() => {});
}
/* New guest identities one address may add in ten minutes: a household or a
   carrier's shared address is many people, an endless stream of fresh keys
   is not. */
const GUEST_NEW_PER_IP = Math.max(1, Number(process.env.CHAT_GUEST_NEW_PER_IP_10M || 20));
/* A guest with no socket here for this long may make room in a full book. */
const GUEST_IDLE_MS = Number(process.env.CHAT_GUEST_IDLE_MS || 10 * 60 * 1000);
const guestNewcomers = new Map();
function guestNewcomerLimited(ip) {
  const now = Date.now();
  const seen = guestNewcomers.get(ip);
  if (!seen || now - seen.since > 10 * 60 * 1000) return false;
  return seen.count >= GUEST_NEW_PER_IP;
}
function noteGuestNewcomer(ip) {
  const now = Date.now();
  const seen = guestNewcomers.get(ip);
  if (!seen || now - seen.since > 10 * 60 * 1000) guestNewcomers.set(ip, { since: now, count: 1 });
  else seen.count += 1;
  if (guestNewcomers.size > 50000) guestNewcomers.delete(guestNewcomers.keys().next().value);
}
function guestSocketLive(fingerprint, deviceId) {
  return Array.from(verifiedByFingerprint.get(fingerprint) || []).some((record) => record.guest && guestDeviceOf(record) === deviceId && record.ws?.readyState === WebSocket.OPEN);
}
/* Said once, then the socket goes: staying on as an ordinary user would make
   this relay claim them as a resident for ninety days. */
function refuseGuest(record, reason) {
  record.identityVerified = false;
  record.guest = false;
  safeSend(record.ws, { type: 'guest-refused', reason });
  console.log(`[Guests] refused ${String(record.fingerprint || '').slice(0, 12)} from ${String(record.guestOf || '').slice(0, 12)}: ${reason}`);
  setTimeout(() => {
    try { if (record.ws?.readyState === WebSocket.OPEN) record.ws.close(4409, 'guest-refused'); } catch (_error) { /* gone */ }
  }, 300).unref?.();
  setTimeout(() => {
    try { if (record.ws && record.ws.readyState !== WebSocket.CLOSED) record.ws.terminate(); } catch (_error) { /* gone */ }
    presence.delete(record.clientId);
    broadcastPeers();
  }, 1500).unref?.();
}
/* A proven identity that asked to be a guest: taken in, or refused. Every
   other reason is weighed first; only when the book being full is the one
   thing in the way do idle guests make room. Every newcomer's attempt counts
   against its address. */
function admitGuest(record, view) {
  const known = guestBook.devices(record.fingerprint).includes(guestDeviceOf(record));
  const newcomerLimited = !known && guestNewcomerLimited(record.ip);
  if (!known) noteGuestNewcomer(record.ip);
  const facts = {
    directory: directoryState.doc?.body || null,
    selfId: relayIdentity.id,
    guestOf: record.guestOf,
    guestSockets: liveGuestSockets(),
    wsMax: WS_MAX_TOTAL,
    share: GUEST_SHARE,
    deviceRevoked: guestViewRevokes(view, record.deviceId, provenDeviceKey(record)),
    known,
    newcomerLimited,
  };
  let reason = guestRules.guestRefusal({ ...facts, bookEntries: 0 });
  if (!reason && !known) {
    const room = guestRules.bookRoomFor(WS_MAX_TOTAL, GUEST_SHARE);
    const held = guestBook.liveGuests().length;
    if (room > 0 && held >= room) {
      for (const ended of guestBook.evictStale({ olderThanMs: GUEST_IDLE_MS, connected: guestSocketLive, max: held - room + 1 })) {
        onGuestStayEnded(ended.fp, ended.home);
      }
    }
    reason = guestRules.guestRefusal({ ...facts, bookEntries: guestBook.liveGuests().length });
  }
  if (reason) {
    refuseGuest(record, reason);
    return false;
  }
  record.guest = true;
  const entry = guestBook.admit({ fp: record.fingerprint, deviceId: guestDeviceOf(record), home: record.guestOf });
  console.log(`[Guests] ${record.fingerprint.slice(0, 12)} is a guest from ${record.guestOf.slice(0, 12)}`);
  safeSend(record.ws, { type: 'guest-ok', home: record.guestOf, until: entry.until });
  noteGuestAlert(record.guestOf);
  passGuestNotice(record);
  sendGuestStatus(record);
  announceGuestSibling(record.fingerprint);
  return true;
}
/* The newest signed route statement each guest gave — fp, this relay, until,
   nothing more — handed to whoever asks where they are: a sender believes a
   guest route only on the person's own word that names this relay
   (js/chat/40-route-finder.js). */
const guestNotices = new Map();
function guestNoticeFor(fingerprint) {
  const notice = guestNotices.get(fingerprint);
  if (!notice) return null;
  if (!guestBook.isGuest(fingerprint) || Number(notice.statement?.until) <= Date.now()) { guestNotices.delete(fingerprint); return null; }
  return notice;
}
/* What a guest is told about its home as this relay sees it: up when the
   link to it stands, unknown otherwise — never "down", which this relay
   cannot tell from "unreachable from here". */
function sendGuestStatus(record) {
  safeSend(record.ws, { type: 'guest-status', homeUp: relayPeers.linkFor(record.guestOf) ? true : null });
}
/* The guest's own signed notice, checked here and handed to its home: home
   then treats this relay as where one of its people's devices is. Only a
   notice about this socket, this home, and this relay counts. */
function passGuestNotice(record) {
  /* The smaller statement, for senders asking where this person is. */
  const route = record.guestRoute;
  if (route && route.statement.fp === record.fingerprint && route.statement.guest === relayIdentity.id
    && guestRules.verifyIdentityStatement({ ...route, publicKeyData: record.publicKeyData }, { type: 'guest-route' }).ok) {
    guestNotices.set(record.fingerprint, route);
    if (guestNotices.size > 20000) guestNotices.delete(guestNotices.keys().next().value);
    record.guestRouteSigned = route;
  }
  const notice = record.guestNotice;
  if (!notice) return;
  const verdict = guestRules.verifyIdentityStatement({ ...notice, publicKeyData: record.publicKeyData }, { type: 'guest-at' });
  const s = notice.statement;
  if (!verdict.ok || s.fp !== record.fingerprint || s.deviceId !== guestDeviceOf(record) || s.home !== record.guestOf || s.guest !== relayIdentity.id) {
    console.log(`[Guests] notice from ${String(record.fingerprint).slice(0, 12)} not passed on: ${verdict.reason || 'not about this stay'}`);
    return;
  }
  record.guestNoticeSigned = notice;
  const link = relayPeers.linkFor(record.guestOf);
  if (link) {
    try { link.send({ kind: 'guest-notice', statement: notice.statement, sig: notice.sig, publicKeyData: record.publicKeyData }); } catch (_error) { /* the link went */ }
  }
}
function liveGuestRecordsFrom(homeId) {
  return Array.from(presence.values()).filter((record) => record.guest && record.guestOf === homeId && record.ws?.readyState === WebSocket.OPEN);
}
/* A link to some guests' home came up or went down. */
function guestHomeLinkChanged(link, up) {
  const homeId = link?.peerId;
  if (!homeId) return;
  if (up) retryPendingMoves(homeId);
  for (const record of liveGuestRecordsFrom(homeId)) {
    sendGuestStatus(record);
    if (up && record.guestNoticeSigned) {
      try { link.send({ kind: 'guest-notice', statement: record.guestNoticeSigned.statement, sig: record.guestNoticeSigned.sig, publicKeyData: record.publicKeyData }); } catch (_error) { /* the link went */ }
    }
  }
}

