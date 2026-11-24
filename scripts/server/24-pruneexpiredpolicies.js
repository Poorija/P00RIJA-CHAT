function pruneExpiredPolicies() {
  const now = Date.now();
  let changed = false;
  for (const [key, policy] of suspendedUsers.entries()) {
    if (policy.expiresAt && policy.expiresAt <= now) {
      suspendedUsers.delete(key);
      changed = true;
    }
  }
  for (const [key, policy] of kickedUsers.entries()) {
    if (!policy.permanent && policy.expiresAt && policy.expiresAt <= now) {
      kickedUsers.delete(key);
      changed = true;
    }
  }
  if (changed) savePolicyStore();
}

function getRestrictionForIdentity(identity) {
  pruneExpiredPolicies();
  /* The allowlist is asked first. "Nobody unless invited" outranks "everybody
     except these", and asking it second would admit an uninvited peer for as
     long as it took to walk the deny lists. */
  if (allowlistEnabled) {
    const fingerprint = sanitizeFingerprint(identity?.fingerprint || '');
    if (!fingerprint || !allowedUsers.has(fingerprint)) {
      return { type: 'not-allowed', key: fingerprint || 'unknown', policy: { permanent: true } };
    }
  }
  for (const [key, policy] of suspendedUsers.entries()) {
    if (identityMatchesPolicy(identity, policy)) {
      return { type: 'suspended', key, policy };
    }
  }
  for (const [key, policy] of kickedUsers.entries()) {
    if (identityMatchesPolicy(identity, policy)) {
      return { type: 'kicked', key, policy };
    }
  }
  return null;
}

function listSuspensions() {
  pruneExpiredPolicies();
  return Array.from(suspendedUsers.entries()).map(([key, policy]) => ({ key, ...policy }));
}

function listActiveKickBans() {
  pruneExpiredPolicies();
  return Array.from(kickedUsers.entries()).map(([key, policy]) => ({ key, ...policy }));
}

function sendPolicyNotice(record, restriction) {
  if (!record?.ws || record.ws.readyState !== WebSocket.OPEN || !restriction) return;
  const now = Date.now();
  const policy = restriction.policy || {};
  let untilText = '';
  if (policy.expiresAt) {
    const d = new Date(policy.expiresAt);
    untilText = ' تا ' + d.toLocaleString('fa-IR') + ' (' + d.toLocaleString('en-US') + ')';
  }
  const suspendedText = `شما موقتاً تعلیق شده اید.${untilText}`;
  const kickedText = policy.permanent
    ? 'دسترسی شما در سیستم محدود شده است، لطفاً برای رفع محدودیت با ادمین سرور و یا پشتیبانی تماس بگیرید.'
    : `اتصال شما از سرور قطع شد و${untilText} امکان اتصال مجدد ندارید.`;
  const isNoticeCooldown = Boolean(policy.lastNoticeAt && now - policy.lastNoticeAt < POLICY_NOTICE_COOLDOWN_MS);
  safeSend(record.ws, {
    type: restriction.type === 'suspended' ? 'server-suspended' : 'server-kicked',
    message: restriction.type === 'suspended' ? suspendedText : kickedText,
    until: restriction.policy.expiresAt || null,
    permanent: Boolean(policy.permanent),
    silent: isNoticeCooldown,
    timestamp: Date.now(),
  });
  if (isNoticeCooldown) return;
  policy.lastNoticeAt = now;
  restriction.policy = policy;
  if (restriction.type === 'suspended' && restriction.key && suspendedUsers.has(restriction.key)) {
    suspendedUsers.set(restriction.key, { ...suspendedUsers.get(restriction.key), ...policy });
    savePolicyStore();
  }
  if (restriction.type === 'kicked' && restriction.key && kickedUsers.has(restriction.key)) {
    kickedUsers.set(restriction.key, { ...kickedUsers.get(restriction.key), ...policy });
    savePolicyStore();
  }
}

function disconnectRestrictedPeer(record, restriction) {
  sendPolicyNotice(record, restriction);
  setTimeout(() => {
    try {
      if (record.ws?.readyState === WebSocket.OPEN) {
        record.ws.close(
          restriction?.type === 'suspended' ? 4403 : 4401,
          restriction?.type || 'restricted'
        );
      }
    } catch (_error) {}
  }, 750);
  setTimeout(() => {
    try {
      if (record.ws && record.ws.readyState !== WebSocket.CLOSED) {
        record.ws.terminate();
      }
    } catch (_error) {}
    presence.delete(record.clientId);
    broadcastPeers();
  }, 1500);
}

async function sendPushNotification(toFingerprint, kind = 'chat', hint = null) {
  const fingerprint = sanitizeFingerprint(toFingerprint);
  const key = pushIndexKey(fingerprint);
  const now = Date.now();
  /* An expired record is not delivered to and not kept: the moment the user's
     own window runs out, the row goes. */
  const stored = pushSubscriptions.get(key) || [];
  const live = stored.filter((item) => !item.expiresAt || Date.parse(item.expiresAt) > now);
  if (live.length !== stored.length) {
    if (live.length) pushSubscriptions.set(key, live);
    else pushSubscriptions.delete(key);
    savePushSubscriptions();
  }
  /* A device that is a guest on another relay of the family, on its own
     signed word, is woken there; woken here it would be pointed at mail it
     cannot fetch from where it is (guest mode). */
  const awayAsGuests = new Set(guestBook.remoteFor(fingerprint).map((entry) => entry.deviceId));
  const subscriptions = awayAsGuests.size ? live.filter((item) => !item.deviceId || !awayAsGuests.has(item.deviceId)) : live;
  if (!subscriptions.length && live.length) {
    console.log(`[Push] ${key.slice(0, 12)}: every device is a guest elsewhere; woken there, not here.`);
    return;
  }
  /* Nothing to notify. This used to return in silence, which is how a device
     that had quietly fallen off push came to look exactly like one that had
     just been told: the relay queued the message, delivered it on the next
     connection, and never once said that nobody was woken for it. Say so.
     The index key rather than the fingerprint, because the whole point of
     hashing it is that this file does not hold a list of who talks to whom. */
  if (!subscriptions.length) {
    console.warn(`[Push] No subscription for ${key.slice(0, 12)}; ${kind} was delivered but nobody was woken for it.`);
    return;
  }

  /* Three fixed lines, chosen by what happened — never by who or what was
     said. A call is worth telling apart from a message: one you might answer,
     the other you read later. */
  /* Voice and video are worth telling apart — one you might step outside to
     take. The mode travels with call signalling already; nothing about who or
     what was said is added here. */
  /* Built per row rather than once: each device says which language it reads
     when it subscribes, and one person's phone should not be handed another
     person's language because they share a fingerprint across devices. */
  const payloadFor = (subscription) => JSON.stringify({
    title: 'P00RIJA Chat',
    body: pushBodyFor(kind, subscription.lang),
    /* The service worker adds "N unread" when several arrive behind one row,
       and it has no way to read the app's language setting from where it runs.
       The row already records which language this device asked for, so the
       answer travels with the body it belongs to. */
    lang: normalizePushLang(subscription.lang),
    /* Calls and messages stack separately, so a missed call is not swallowed
       by the message it arrives beside. */
    tag: pushTagFor(kind),
    url: './index.html#chat',
    /* Opaque to this relay: what the sender encrypted for a device that asked
       for its notifications to say more. Present only then. */
    ...(hint ? { hint } : {}),
    data: {
      kind,
      timestamp: Date.now(),
    },
  });

  /* A UnifiedPush endpoint takes a plain POST. There is no vendor service in
     front of it and nothing to encrypt to: the distributor app on the phone
     receives the bytes and raises the notification. The body is the same
     contentless payload the browser path sends, so the distributor learns
     exactly what a push service learns, which is that something arrived. */
  const sendUnifiedPush = async (subscription) => {
    /* Checked again rather than trusted from subscribe time: a name that
       answered publicly an hour ago can answer 127.0.0.1 now, and that gap is
       the whole of DNS rebinding. */
    if (!await pushEndpointIsReachable(subscription.endpoint)) {
      const error = new Error('endpoint no longer resolves to a public address');
      error.statusCode = 410;
      throw error;
    }
    const response = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payloadFor(subscription),
      /* Refused rather than followed and re-checked. A distributor has no
         reason to redirect, and a 302 into the private range is the easiest
         way around a check that only looks at the first URL. */
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`UnifiedPush endpoint tried to redirect (${response.status}); refused`);
    }
    if (!response.ok) {
      const error = new Error(`UnifiedPush endpoint answered ${response.status}`);
      /* 404 and 410 mean the same here as they do for a vendor service: that
         endpoint is gone, and keeping it only produces failures forever. */
      error.statusCode = response.status;
      throw error;
    }
  };

  const remaining = [];
  let pruned = false;
  await Promise.all(subscriptions.map(async (subscription) => {
    try {
      if (subscription.type === 'unifiedpush') await sendUnifiedPush(subscription);
      else await webpush.sendNotification(subscription, payloadFor(subscription), pushSendOptions(kind));
      remaining.push(subscription);
    } catch (error) {
      if ([404, 410].includes(error?.statusCode)) {
        /* The vendor says this endpoint is gone for good. Dropping it silently
           left the person with a switch reading "on" and a phone that would
           never ring again, with nothing anywhere recording the moment it
           stopped. */
        console.warn(`[Push] ${error.statusCode} from the vendor for ${key.slice(0, 12)}; dropping a dead endpoint. That device gets nothing until it subscribes again.`);
        pruned = true;
      } else {
        console.error('Failed to send web push:', error?.statusCode || error?.message || error);
        remaining.push(subscription);
      }
    }
  }));

  /* Rows left out because their device is a guest elsewhere are kept: it is
     woken here again the moment its stay ends. */
  const kept = [...live.filter((item) => !subscriptions.includes(item)), ...remaining];
  if (kept.length) {
    pushSubscriptions.set(key, kept);
  } else {
    pushSubscriptions.delete(key);
  }
  /* WRITE IT DOWN. Dropping a dead endpoint only from memory meant the next
     restart read it back off disk and the relay went on pushing to an
     endpoint the vendor had already told it was gone — forever, because the
     answer never changed and the lesson was never kept. Every other prune in
     this file persists; these two did not. */
  if (pruned || !kept.length) savePushSubscriptions();
}

async function sendAdminPushNotification(toFingerprint, body, kind = 'admin-policy') {
  const fingerprint = sanitizeFingerprint(toFingerprint);
  const key = pushIndexKey(fingerprint);
  const now = Date.now();
  const stored = pushSubscriptions.get(key) || [];
  const subscriptions = stored.filter((item) => !item.expiresAt || Date.parse(item.expiresAt) > now);
  /* Nothing to notify. This used to return in silence, which is how a device
     that had quietly fallen off push came to look exactly like one that had
     just been told: the relay queued the message, delivered it on the next
     connection, and never once said that nobody was woken for it. Say so.
     The index key rather than the fingerprint, because the whole point of
     hashing it is that this file does not hold a list of who talks to whom. */
  if (!subscriptions.length) {
    console.warn(`[Push] No subscription for ${key.slice(0, 12)}; ${kind} was delivered but nobody was woken for it.`);
    return;
  }

  const payload = JSON.stringify({
    title: 'P00RIJA Chat',
    body,
    tag: `poorija-${kind}`,
    url: './index.html#chat',
    data: { kind, timestamp: Date.now() },
  });

  const remaining = [];
  let pruned = false;
  await Promise.all(subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification(subscription, payload, pushSendOptions(kind));
      remaining.push(subscription);
    } catch (error) {
      if ([404, 410].includes(error?.statusCode)) {
        pruned = true;
      } else {
        console.error('Failed to send admin web push:', error?.statusCode || error?.message || error);
        remaining.push(subscription);
      }
    }
  }));

  if (remaining.length) {
    pushSubscriptions.set(key, remaining);
  } else {
    pushSubscriptions.delete(key);
  }
  /* See sendPushNotification: a prune that is not written down is undone by
     the next restart. */
  if (pruned || !remaining.length) savePushSubscriptions();
}

const presence = new Map();

/* Can a message reach this person's eyes right now? Not "is there a socket" —
   an iOS web app in the background holds its socket open and reads nothing. */
function isAppAwake(record) {
  if (!record || record.away) return false;
  return Date.now() - (record.lastActiveAt || 0) <= APP_AWAKE_TTL_MS;
}

function snapshotPeers() {
  const now = Date.now();
  return Array.from(presence.values())
    .filter((client) => client.peerId)
    /* Proven identities only, as in the broadcast table: this answer replaces
       the client's copy of that table, so anybody listed here but never in
       the broadcast would stay "online" there with no removal ever coming. */
    .filter((client) => !IDENTITY_PROOF_REQUIRED || client.identityVerified)
    .filter((client) => client.ws?.readyState === WebSocket.OPEN)
    .filter((client) => now - (client.lastSeenAt || 0) <= PRESENCE_TTL_MS)
    .filter((client) => !getRestrictionForIdentity(client))
    .map((client) => ({
      clientId: client.clientId,
      username: client.username || client.peerId || client.fingerprint || '',
      peerId: client.peerId,
      publicKeyData: client.publicKeyData || '',
      fingerprint: client.fingerprint || '',
      /* Whatever they wrote about what they are doing. Short, free text, and
         no more sensitive than the display name beside it — but it has to
         travel with the presence record or the other side never sees it. */
      mood: client.mood || '',
      prekeyId: client.prekeyId || '',
      prekeyPublic: client.prekeyPublic || '',
      prekeyExpiresAt: client.prekeyExpiresAt || '',
      prekeySig: client.prekeySig || '',
      prekeyPq: client.prekeyPq || '',
      prekeyPqSig: client.prekeyPqSig || '',
      /* Identity v4: the X25519 agreement key and the signing key's signature
         over it. Forwarded only; a client keeps it only once the signature
         checks against the signing key it pinned. */
      agreeKey: client.agreeKey || '',
      agreeKeySig: client.agreeKeySig || '',
      caps: Array.isArray(client.caps) ? client.caps : [],
      /* Which install this socket is. The client reads it to tell its own
         sibling devices apart (the devices panel, the device-sync beacon), and
         it was never sent: every sibling arrived with an empty device id, so
         two devices of one account looked like one. A random per-install
         string, no more identifying than the peer id beside it. */
      deviceId: client.deviceId || '',
      /* Registered but frozen is not online. Saying otherwise tells the person
         writing that their message has been seen when it has not even been
         read off the wire. */
      status: isAppAwake(client) ? 'online' : 'away',
      updatedAt: client.updatedAt,
    }));
}


let broadcastTimer = null;
/* What every delta-capable client was last told, one serialized record per
   socket — so a change sends that change, not the whole room again. */
let presenceSnapshot = new Map();
function lightPeerRecord(r) {
  /* Whitelist, not blacklist: the spread (...) was copying `ws` (a WebSocket
     with a circular timer reference), `sentMail` (a Set), and friends — and
     JSON.stringify crashed the process on the circular reference. Only the
     fields the peers table actually carries are listed here.
     Never the address. Every record went to every connected client with the
     person's real public IP in it — anybody on the relay could collect the
     addresses of everybody online. The app never used it; the monitor reads
     addresses from its own, authenticated, endpoint.
     Nor the clocks (connected, last seen, last active, away): the app reads
     none of them — it keeps "last seen" itself — and they changed every
     minute for everybody, so with thousands online the table was resent to
     everyone, all the time, and that alone saturated the relay. */
  return {
    clientId: r.clientId,
    username: r.username,
    peerId: r.peerId,
    deviceId: r.deviceId,
    fingerprint: r.fingerprint,
    mood: r.mood,
    /* The one clock that is a state rather than a tick: awake or away. It changes when a phone is frozen or
       comes back, a few times a day for a person, not every minute — and without it a delta never said so:
       the table the app lives on (the first whole one and every delta after it) is built from this record,
       so a frozen phone read as online and "the message was seen" was said of one that had not been read off
       the wire. awayTick() below is what notices the heartbeat lapsing, which no message announces. */
    status: isAppAwake(r) ? 'online' : 'away',
  };
}
function broadcastPeers(minDelayMs = 0) {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    /* Stripped: the periodic presence table says who is here, not what they
       look like. Avatars travel on profile-card; re-serializing 2MB photos
       per peer per tick is a GC death spiral at scale. */
    const current = new Map();
    /* Only a proven identity is announced. The table carried every socket
       from its hello on, before any proof — so anybody holding a person's
       public key (which is public) could make them appear online, under a
       peer id of the claimant's choosing, to everyone on the relay. */
    for (const record of presence.values()) {
      if (IDENTITY_PROOF_REQUIRED && !record.identityVerified) continue;
      current.set(record.clientId, JSON.stringify(lightPeerRecord(record)));
    }
    const upsert = [];
    for (const [clientId, json] of current) if (presenceSnapshot.get(clientId) !== json) upsert.push(json);
    const remove = [];
    for (const clientId of presenceSnapshot.keys()) if (!current.has(clientId)) remove.push(clientId);
    presenceSnapshot = current;
    /* The whole table went to every client on every change: N records to N
       sockets, which at 2,700 clients was 2.5 GB per tick and the ceiling of
       the relay. A client that says it reads deltas (caps 'pd1') gets the
       table once and then only what changed; an older build still gets the
       whole table, as before. */
    const delta = upsert.length || remove.length
      ? `{"type":"peers-delta","upsert":[${upsert.join(',')}],"remove":${JSON.stringify(remove)}}`
      : '';
    let full = '';
    let fullSent = 0;
    let owed = false;
    let waiting = false;
    /* The broadcast used the raw send, which is the one path in the file with
       no buffered-amount guard — so a client that opened a socket and read
       nothing accumulated the whole peer table, avatars included, in memory
       on the relay for as long as the socket stayed open. The guard costs a
       readyState and a number; the same serialisation is still paid once.
       Presence is replaceable — only its latest state matters — so a client
       still behind on what it was sent is not sent more: it is marked to get
       one fresh table once it has caught up. And whole tables (a megabyte or
       two each with thousands online) go out a bounded number per tick, so a
       crowd connecting at once is served over a few ticks instead of piling
       gigabytes into memory: that is what killed the relay at 7,000 sockets. */
    for (const client of presence.values()) {
      if (!client.ws || client.ws.readyState !== WebSocket.OPEN) continue;
      const readsDeltas = Array.isArray(client.caps) && client.caps.includes('pd1');
      /* An older build reads whole tables only: any change owes it one. */
      if (delta && !readsDeltas) client.peersSynced = false;
      if (client.ws.bufferedAmount > PRESENCE_BUFFER_LIMIT) {
        /* A change it missed owes it the whole table once it catches up. */
        if (delta) client.peersSynced = false;
        if (!client.peersSynced) waiting = true;
        continue;
      }
      if (client.peersSynced) {
        if (delta) safeSendText(client.ws, delta, false);
        continue;
      }
      if (fullSent >= PRESENCE_FULL_PER_TICK) { owed = true; continue; }
      full = full || `{"type":"peers","peers":[${[...current.values()].join(',')}]}`;
      safeSendText(client.ws, full, false);
      fullSent += 1;
      client.peersSynced = true;
    }
    /* Somebody is still owed a table: come round again — at the next tick
       when the per-tick cap held it back, after a second when its socket is
       still behind. Nobody owed anything, no further tick: an idle room
       costs nothing. */
    if (owed) broadcastPeers();
    else if (waiting) broadcastPeers(1000);
  }, Math.max(minDelayMs, presenceTickMs()));
}
const PRESENCE_BUFFER_LIMIT = 256 * 1024;
/* get-peers: a burst of three answered at once, then one per ten seconds. */
const PEERS_ASK_BURST = 3;
const PEERS_ASK_EVERY_MS = 10000;
/* How long until this socket may have the next table with keys: 0 for now. */
function peersAskWait(record) {
  const now = Date.now();
  if (record.peersAskTokens === undefined) {
    record.peersAskTokens = PEERS_ASK_BURST;
    record.peersAskRefillAt = now;
  }
  const earned = Math.floor((now - record.peersAskRefillAt) / PEERS_ASK_EVERY_MS);
  if (earned > 0) {
    record.peersAskTokens = Math.min(PEERS_ASK_BURST, record.peersAskTokens + earned);
    record.peersAskRefillAt += earned * PEERS_ASK_EVERY_MS;
  }
  if (record.peersAskTokens >= PEERS_ASK_BURST) record.peersAskRefillAt = now;
  if (record.peersAskTokens >= 1) return 0;
  return Math.max(1, PEERS_ASK_EVERY_MS - (now - record.peersAskRefillAt));
}
const PRESENCE_FULL_PER_TICK = Number(process.env.CHAT_PRESENCE_FULL_PER_TICK || 50);
/* Changes are gathered for longer as the room grows: each tick is one frame
   to every socket, so a crowd reconnecting at once (after a restart, say)
   would otherwise cost tens of thousands of sends a second. A tenth of a
   second while the room is small, up to a second at several thousand. */
function presenceTickMs() {
  return Math.max(100, Math.min(1000, Math.round(presence.size / 4)));
}

let totalMessagesReceived = 0;
let totalMessagesSent = 0;
let totalBytesReceived = 0;
let totalBytesSent = 0;
let totalRelays = 0;

/* The monitor's own version. The relay's build tag says which app round the
   messenger is on; this says which dashboard round the server is on — they
   move on different schedules and the dashboard must be able to say which
   of the two an operator is actually looking at. */
const MONITOR_VERSION = '3.34';

/* Fine-grained traffic, for the dashboard's traffic tab: the same events the
   totals count, kept per client and per relay link. The maps are capped so
   a hostile rotation of ids cannot grow them without bound — the same
   discipline the rest of the bookkeeping here holds itself to. */
const clientTraffic = new Map();   // clientId -> { msgsIn, msgsOut, bytesIn, bytesOut, lastAt, label }
const transitTraffic = new Map();  // relayId -> { carried, bytes, lastAt }
const TRAFFIC_ROWS_MAX = 500;
function noteClientTraffic(clientId, direction, bytes, label) {
  if (!clientId) return;
  let row = clientTraffic.get(clientId);
  if (!row) {
    if (clientTraffic.size >= TRAFFIC_ROWS_MAX) clientTraffic.delete(clientTraffic.keys().next().value);
    row = { msgsIn: 0, msgsOut: 0, bytesIn: 0, bytesOut: 0, lastAt: Date.now(), label: label || '' };
    clientTraffic.set(clientId, row);
  }
  row.lastAt = Date.now();
  if (label) row.label = label;
  if (direction === 'in') { row.msgsIn++; row.bytesIn += bytes; }
  else { row.msgsOut++; row.bytesOut += bytes; }
}
function noteTransitTraffic(relayId, bytes) {
  if (!relayId) return;
  /* Never a throw from bookkeeping: a non-number here means a caller
     miscounted, and the right answer is zero, not a dead relay. */
  bytes = Number.isFinite(Number(bytes)) ? Number(bytes) : 0;
  let row = transitTraffic.get(relayId);
  if (!row) {
    if (transitTraffic.size >= 64) transitTraffic.delete(transitTraffic.keys().next().value);
    row = { carried: 0, bytes: 0, lastAt: Date.now() };
    transitTraffic.set(relayId, row);
  }
  row.carried++;
  row.bytes += bytes;
  row.lastAt = Date.now();
}

/* A client that stops reading its socket leaves every frame sent to it
   buffered inside this process — an unread mailbox handover is the easiest
   way to balloon memory without sending anything yourself. No legitimate
   reader falls this far behind, so past this point the socket is dropped. */
const SEND_BUFFER_LIMIT_BYTES = 16 * 1024 * 1024;

function safeSend(ws, message) {
  safeSendText(ws, JSON.stringify(message));
}

/* The same protection for a payload that was stringified once for many
   sockets — a broadcast pays for the serialisation, not the safety.
   Broadcast frames are not counted as messages sent: the counter answers
   "how much mail moved", and one presence change fanned out to a room of N
   is one change, not N messages — the numbers the stress suite holds the
   relay to are about forwarding, and would otherwise count presence. */
function safeSendText(ws, payload, countAsMessage = true) {
  if (ws.readyState === WebSocket.OPEN) {
    /* A verified peer whose buffer is full is READING SLOWLY, not refusing
       to read. Killing the socket here was turning every large mailbox dump
       into a connect-kill-reconnect loop (37 queued messages, 16 MB buffer,
       the same cycle forever). The limit stays for genuinely hostile
       sockets; verified peers get a higher ceiling and a warning first. */
    const isVerified = Boolean(ws.__poorijaVerifiedFingerprint);
    const limit = isVerified ? SEND_BUFFER_LIMIT_BYTES * 2 : SEND_BUFFER_LIMIT_BYTES;
    if (ws.bufferedAmount > limit) {
      if (!ws.__poorijaSendOverflow) {
        ws.__poorijaSendOverflow = true;
        console.warn(`[Presence] Send buffer above ${Math.round(limit / 1048576)} MB (${isVerified ? 'verified peer' : 'unverified socket'}) — terminating.`);
      }
      ws.terminate();
      return;
    }
    if (countAsMessage) {
      totalMessagesSent++;
      totalBytesSent += Buffer.byteLength(payload);
      noteClientTraffic(ws.__poorijaClientId, 'out', Buffer.byteLength(payload));
    }
    ws.send(payload);
  }
}

function openPresenceRecord(clientId = '') {
  const record = presence.get(String(clientId || ''));
  return record?.ws?.readyState === WebSocket.OPEN ? record : null;
}

/* A maintained index of who is proven, keyed by fingerprint. The lookup used
   to allocate and sort the whole presence table on every message addressed
   by fingerprint — every transit delivery on the recipient relay paid
   O(peers log peers), so a relay moving real traffic spent most of its CPU
   sorting a list it had just sorted. The index holds every verified record
   for a fingerprint; the most recently active one wins exactly as before,
   decided between at most the two records a reconnect can leave behind. */
const verifiedByFingerprint = new Map();
function indexVerified(record) {
  if (!record?.fingerprint || !record.identityVerified) return;
  const held = verifiedByFingerprint.get(record.fingerprint);
  if (!held) {
    verifiedByFingerprint.set(record.fingerprint, new Set([record]));
    return;
  }
  held.add(record);
}
function unindexVerified(record) {
  const held = record?.fingerprint ? verifiedByFingerprint.get(record.fingerprint) : null;
  if (!held) return;
  held.delete(record);
  if (!held.size) verifiedByFingerprint.delete(record.fingerprint);
}
/* Liveness is re-checked on every read — a record may be in the index and
   gone from the socket table, because the index is a cache of identity, not
   of connection state. */
setInterval(() => {
  for (const [fingerprint, held] of verifiedByFingerprint) {
    for (const record of held) {
      if (!presence.has(record.clientId)) held.delete(record);
    }
    if (!held.size) verifiedByFingerprint.delete(fingerprint);
  }
}, 30000).unref?.();

function findOpenPresenceByFingerprint(fingerprint = '') {
  if (!fingerprint) return null;
  /* Only a socket that proved the identity behind the fingerprint may be
     routed to by it — otherwise mail lands on whoever claimed the name. A
     reconnect leaves two sockets holding the same fingerprint for a moment,
     so the most recently active one wins rather than the first found. */
  const held = verifiedByFingerprint.get(fingerprint);
  if (!held) return null;
  let best = null;
  for (const record of held) {
    if (record.ws?.readyState !== WebSocket.OPEN) continue;
    if (!best || (record.lastSeenAt || 0) > (best.lastSeenAt || 0)) best = record;
  }
  return best;
}

/* Everything hello used to hand over on the strength of a claim: the mailbox
   sweep, the batched delivery and the expiry notices. It moved behind the
   identity proof and now runs one round trip later, unchanged. */
/* How many envelopes may be with a recipient at once, unacknowledged. A whole
   mailbox would be a burst of hundreds of megabytes into a socket that cannot
   refuse it; one at a time would cost a round trip per envelope. */
const MAIL_WINDOW = 50;

/* Sends whatever the window has room for, skipping what this connection has
   already been handed.

   It used to slice the first MAIL_WINDOW off the queue each time, which was
   wrong in both directions. The same envelopes went out again on every
   top-up, so a recipient collecting a file received most of it several times
   over. And the top-up only ran on an ACK that actually removed something --
   the app acknowledges each envelope as it handles it, duplicates included,
   and an ACK for an envelope already gone changed nothing, so it triggered
   nothing. Once the recipient had acknowledged everything it held, neither
   side had a reason to speak next. Delivery stopped dead around MAIL_WINDOW
   envelopes whatever the size of the mailbox, and only a reconnection moved
   it on. A conversation rarely has fifty waiting, so this only ever showed on
   files -- which advanced a few megabytes per reconnect and read as a slow
   network.

   Tracking what this connection has been sent fixes both. The set belongs to
   the connection, not to the mailbox, so a reconnection re-sends anything
   that was in flight when the socket went -- which is what makes an
   unacknowledged envelope safe to drop. */
/* The mailbox dump used to fire up to MAIL_WINDOW messages in one burst
   with no flow control. A client with 37 queued items (some carrying
   attachments) blew the 16 MB send buffer on every reconnect — the relay
   killed the socket for "not reading", the client reconnected, the same
   37 queued items fired again: a connect-overflow-disconnect loop that
   never drained. The pump now checks the wire before every frame and
   backs off when the socket is congested, resuming on the next ACK
   (which is the client saying it finished reading what it got). */
const MAIL_PUMP_BUFFER_SOFT_LIMIT = 1024 * 1024; /* 1 MB */

function pumpHeldMail(record, ws) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const queued = offlineBoxes.get(record.fingerprint) || [];
  if (!queued.length) return;
  if (!record.sentMail) record.sentMail = new Set();

  let inFlight = record.sentMail.size;
  for (const item of queued) {
    if (inFlight >= MAIL_WINDOW) break;
    if (record.sentMail.has(item.relayId)) continue;
    /* Flow control: if the socket is still draining the previous batch,
       stop here. The next ACK triggers another pump, so delivery resumes
       the moment the client catches up — no timer, no polling. */
    if (ws.bufferedAmount > MAIL_PUMP_BUFFER_SOFT_LIMIT) {
      console.log(`[Presence] Mail pump paused for ${record.fingerprint?.slice(0, 12) ?? ''} — socket draining (${Math.round(ws.bufferedAmount / 1024)}KB buffered, ${inFlight} in flight, ${queued.length - inFlight} waiting)`);
      return;
    }
    safeSend(ws, item);
    record.sentMail.add(item.relayId);
    inFlight += 1;
  }
}

function deliverHeldMail(record, ws) {
  /* The old key of an account that moved to v4 opens nothing any more: its
     mail is the new account's (acceptIdentityContinuation). */
  if (movedFingerprint(record.fingerprint) !== record.fingerprint) return;
  // Expire before delivering, so nothing stale is handed over and the
  // notices below reflect what actually happened while they were away.
  // Scoped to this peer: nobody else's mail is about to be handed over
  // here, and walking all of it blocked the relay for 171 ms per connect.
  sweepRetention(record.fingerprint);

  const queued = offlineBoxes.get(record.fingerprint) || [];
  if (queued.length) {
    console.log(`[Presence] Delivering ${queued.length} queued messages to ${record.fingerprint}`);
    /* A fresh start for this socket: whatever a previous one was sent went
       with it, and anything unacknowledged has to come round again. */
    record.sentMail = new Set();
    pumpHeldMail(record, ws);
  }

  /* What a sibling left for this device while it was away. */
  pumpSiblingHeld(record, ws);

  /* Somebody wrote to them and it did not survive the wait. Saying so is
     the difference between a message that was lost and a message the
     recipient never knew existed. */
  const notices = expiryLog.filter((entry) => entry.fingerprint === record.fingerprint && !entry.delivered);
  if (notices.length) {
    console.log(`[Presence] Reporting ${notices.length} expired item(s) to ${record.fingerprint}`);
    safeSend(ws, {
      type: 'expired-notice',
      items: notices.map((entry) => ({
        from: entry.from,
        class: entry.class,
        reason: entry.reason,
        queuedAt: entry.queuedAt,
        expiredAt: entry.expiredAt,
      })),
    });
    notices.forEach((entry) => { entry.delivered = true; });
    saveExpiryLog();
  }
}

