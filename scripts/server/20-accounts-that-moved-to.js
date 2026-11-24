/* ---- accounts that moved to identity v4 -------------------------------- */
let identityMoves = null;
function loadIdentityMoves() {
  if (identityMoves) return identityMoves;
  identityMoves = new Map();
  try {
    const stored = readWholeStore('identity-moves', MOVES_PATH);
    for (const [oldFp, move] of Object.entries(stored || {})) {
      if (isFingerprintKey(oldFp) && move && isFingerprintKey(move.newFp) && Number.isSafeInteger(move.until)) identityMoves.set(oldFp, move);
    }
  } catch (_error) { /* none yet */ }
  return identityMoves;
}
function saveIdentityMoves() {
  try { writeWholeStore('identity-moves', MOVES_PATH, Object.fromEntries(loadIdentityMoves())); } catch (error) { console.warn('[Identity] moves could not be written:', error.message); }
}
/* Where mail for `fingerprint` goes now: the account it moved to while the
   window is open, itself otherwise. One step only — a moved account that
   moves again is followed from the newest statement it gives. */
function movedFingerprint(fingerprint) {
  const move = loadIdentityMoves().get(fingerprint);
  if (!move) return fingerprint;
  if (move.until <= Date.now()) {
    identityMoves.delete(fingerprint);
    saveIdentityMoves();
    return fingerprint;
  }
  return move.newFp;
}
/* A socket that proved a v4 key, offering the continuation from its old RSA
   key: checked (both signatures, both keys naming their fingerprints), then
   the old mailbox is folded into the new one and the alias recorded. */
function acceptIdentityContinuation(record) {
  const signed = record.continuation;
  record.continuation = null;
  if (!signed || identityV4.keyKind(record.publicKeyData) !== 'v4') return false;
  const verdict = identityV4.verifyContinuation(signed);
  if (!verdict.ok) {
    console.warn(`[Identity] continuation for ${record.fingerprint} refused: ${verdict.reason}`);
    return false;
  }
  const { oldFp, newFp, at } = signed.statement;
  if (newFp !== record.fingerprint || !isFingerprintKey(oldFp)) return false;
  const until = identityV4.legacyUntil(signed.statement);
  if (until <= Date.now()) return false;
  const moves = loadIdentityMoves();
  const existing = moves.get(oldFp);
  /* The first move holds; a later statement from the old key pointing the
     old account somewhere else is not taken (both keys would have to agree
     again, and the new one already did once). */
  if (existing && existing.newFp !== newFp) {
    console.warn(`[Identity] a second continuation for ${oldFp} to another account was refused`);
    return false;
  }
  moves.set(oldFp, { newFp, at, until });
  saveIdentityMoves();
  try {
    if (keyLog.logMove({ oldFp, newFp, statement: JSON.stringify(signed.statement) }) !== null) announceKeyHead();
  } catch (error) { console.warn('[KT] the move could not be logged:', error.message); }
  const waiting = offlineBoxes.get(oldFp) || [];
  if (waiting.length) {
    const target = offlineBoxes.get(newFp) || [];
    offlineBoxes.set(newFp, target.concat(waiting));
    offlineBoxes.delete(oldFp);
    saveOfflineBox(newFp);
    saveOfflineBox(oldFp);
  }
  console.log(`[Identity] ${oldFp} moved to ${newFp} until ${new Date(until).toISOString()}`);
  return true;
}

function deliverRelayMessage(message, { clientId = '', fromFingerprint = '', reply = () => {}, viaRelay = '', viaHops = 0 } = {}) {
totalRelays++;
  /* An account that moved to identity v4 is written to under its new
     fingerprint, whichever one the sender still has. */
  const toFingerprint = movedFingerprint(String(message.toFingerprint || '').slice(0, 128));
  /* Queued mail is keyed by this value and lands in a file named after it,
     so a mailbox key that is not a fingerprint is refused before it can
     reach the store. Live delivery below answers to the socket tables and
     never to a filename, so it does not need the same gate. */
  if (message.persist && toFingerprint && !isFingerprintKey(toFingerprint)) {
    reply({ type: 'error', reason: 'invalid-target', toClientId: message.toClientId || '', toFingerprint, tag: String(message.tag || '').slice(0, 96) });
    return;
  }
  /* Echoed back on every reply so the sender can line a refusal or a
     queue confirmation up with the message it was sent for. */
  const tag = String(message.tag || '').slice(0, 96);
  const target = openPresenceRecord(message.toClientId) || findOpenPresenceByFingerprint(toFingerprint);
  /* One account may be online from several sockets at once, and a frame
     addressed to the identity belongs on all of them: the phone in a pocket
     and the desktop on a desk both get it. The set is the target as it was
     always resolved — so a single-device delivery is byte-for-byte what it
     has always been — plus every other verified live socket of the same
     fingerprint, drawn from the index findOpenPresenceByFingerprint reads. */
  const allTargets = [];
  if (target) allTargets.push(target);
  if (toFingerprint) {
    for (const candidate of verifiedByFingerprint.get(toFingerprint) || []) {
      if (candidate.ws?.readyState !== WebSocket.OPEN) continue;
      if (allTargets.includes(candidate)) continue;
      allTargets.push(candidate);
    }
  }

  const payloadType = String(message.payload?.type || 'unknown');
  const isReceiptEnvelope = message.payload?.eph === 2;
  /* Sealed sender (js/chat/51-envelope-privacy.js): the sender's name is in an
     encrypted box, and this relay neither files the item under the sender nor
     hands the sender's name to the recipient's socket. */
  const sealedSender = payloadType === 'offline-chat' && message.payload?.ss === 1;
  /* Call signaling the relay already sees; the live-calls report keys on it. */
  if (payloadType.startsWith('call') || payloadType.startsWith('gcall')) {
    noteCallFrame(clientId || message.fromClientId, payloadType, message.toClientId || toFingerprint);
  }

  const targetRestriction = target
    ? getRestrictionForIdentity(target)
    : (toFingerprint ? getRestrictionForIdentity({ fingerprint: toFingerprint }) : null);
  if (targetRestriction) {
    console.warn(`[Relay] Blocked delivery to restricted target ${toFingerprint || message.toClientId}`);
    reply({ type: 'error', reason: 'target-restricted', toClientId: message.toClientId || '', toFingerprint, tag });
    return;
  }

  if (!target) {
    /* Whatever the client asked for, an ephemeral signal is not stored and
       does not ring anyone. Old builds mark everything persist. */
    /* Judged by what the envelope carries, not by the word on the outside.
       Every sealed envelope arrives as 'offline-chat', so reading only the
       outer name let a delivery receipt or a typing flag be stored like a
       message and ring a phone like one. The client marks the inner name;
       this is the server half, so an out-of-date client cannot fill a
       mailbox with them either. */
    const innerType = String(message.payload?.inner || '');
    /* A sealed envelope keeps its inner type in the box and states only the
       one bit the relay needs: whether to keep it at all. */
    /* A receipt is the one ephemeral thing that is kept, for two days and
       without waking anybody (eph 2): the sender was
       away, or a link was down, and the tick would never have come. */
    if (!isReceiptEnvelope && (EPHEMERAL_PAYLOADS.has(payloadType) || EPHEMERAL_PAYLOADS.has(innerType) || message.payload?.eph === 1)) {
      reply({ type: 'error', reason: 'target-offline', toClientId: message.toClientId || '', tag });
      return;
    }
    if (message.persist && toFingerprint) {
      console.log(`[Relay] Target offline, queuing ${payloadType} for ${toFingerprint}`);
      const queued = offlineBoxes.get(toFingerprint) || [];
      const offlineItem = {
        type: 'relay',
        relayId: crypto.randomUUID(),
        /* A sealed-sender envelope is filed without a sender: who wrote it
           is inside the box, and the mailbox on disk does not learn it. */
        fromClientId: sealedSender ? '' : clientId,
        fromFingerprint: sealedSender ? '' : fromFingerprint,
        payload: message.payload || null,
        queuedAt: new Date().toISOString(),
        /* Guest mode: which family relay forwarded it here, and whether it is
           held for a guest (kept for less time). */
        ...(isReceiptEnvelope ? { receipt: 1 } : {}),
        ...(viaRelay ? { via: viaRelay, hops: viaHops } : {}),
        ...(guestHeldFor(toFingerprint) ? { guestHeld: true } : {}),
      };
      queued.push(offlineItem);
      if (guestHeldFor(toFingerprint)) guestHeldBoxes.add(toFingerprint);
      /* One of this relay's people is a guest elsewhere on their own signed
         word: a copy goes to them there. */
      copyToRemoteGuests(toFingerprint, [offlineItem]);
      copyToGuestSiblings(toFingerprint, [offlineItem]);
      /* The old cap was a flat 200 items per mailbox, which a single
         chunked file would blow through on its own — evicting other
         people's messages to make room for pieces of itself. Retention is
         now decided by class: text is kept, media ages out, and the quota
         is measured in bytes rather than in items. */
      offlineBoxes.set(toFingerprint, queued);
      /* The sweep can touch anybody's queue, so it says what it changed and
         those get written; this delivery only changed one mailbox. */
      noteKnownIdentity(toFingerprint);
      saveOfflineBox(toFingerprint);
      /* The sweep writes whatever it changes, including this box if the
         quota just pushed something out of it. Scoped to the recipient:
         queueing for one person cannot push anything out of anyone else's
         mailbox, so weighing the whole server was pure cost. */
      sweepRetention(toFingerprint);
      /* The sweep may have emptied the box entirely, so the count reads
         what is left rather than assuming the queue survived it. */
      const remaining = offlineBoxes.get(toFingerprint);
      /* `known` tells the sender whether this recipient has ever proven their
         key here. False means the message may be waiting at a relay its
         recipient never visits, and the client goes looking for the right one
         instead of showing a reassuring tick. */
      reply({ type: 'queued', toFingerprint, count: remaining ? remaining.length : 0, tag, known: identityLivesHere(toFingerprint) || guestBook.isGuest(toFingerprint) });
      /* Someone whose guest stay here ended: it goes on to their home. */
      forwardIfGuestLeft(toFingerprint);
      /* Written to here by one of this relay's own clients for somebody who does
         not live here: find where they do (14-guest-mail.js). Mail that came by
         another relay is not chased, so two relays cannot hand it to each other. */
      if (!viaRelay) chaseStrangerMail(toFingerprint);
      /* A real chat message travels as a sealed 'offline-chat' envelope, so
         the type the relay can see is the envelope's, not the message's —
         gating on the inner names meant no queued message ever rang a
         device. The envelope says whether it is worth waking someone for;
         everything else falls back to the list of plain types. */
      const wakes = isReceiptEnvelope ? false : payloadType === 'offline-chat'
        ? message.payload?.notify !== false
        : PUSHABLE_PAYLOADS.has(payloadType);
      if (wakes) {
        /* A sealed envelope hides what it is, so a group call to a sleeping
           phone used to ring as "chat update". The sender marks the outside
           of the envelope with the call verb and, for a group, the word
           "group" - never its name, the caller, or anything said. The rule
           itself lives in scripts/lib/push-wording.js so it can be read and
           tested without starting a server. */
        const kind = pushKindFor(payloadType, message.payload || {});
        sendPushNotification(toFingerprint, kind, sanitizeNoticeHint(message.payload?.hint)).catch((error) => console.error(error));
      }
      return;
    }
    console.warn(`[Relay] Target not found for ${payloadType} to ${message.toClientId || toFingerprint}`);
    reply({ type: 'error', reason: 'target-offline', toClientId: message.toClientId || '', tag });
    return;
  }

  /* Store-and-forward is not only for offline targets. A "connected"
     client can be a locked app whose webview is suspended: the socket
     accepts the frame and nothing reads it, and a message forwarded only
     live into that socket was lost — no queue entry, no error, and a
     sender stuck watching an hourglass. Persistent envelopes are now
     queued for connected recipients too. The client de-duplicates by
     message id and acks the redelivered copy, so a healthy live path
     costs one extra frame per message and an unhealthy one costs nothing
     at all. */
  /* The id of the mailbox copy this delivery also queued, so a connected
     recipient can acknowledge the copy out of the box the moment it has the
     live frame in hand — without it the box held every message for an
     account whose devices never disconnect, and re-delivered all of them on
     the one reconnect that finally drained it. */
  let liveRelayId = '';
  if (message.persist && toFingerprint) {
    const queuedLive = offlineBoxes.get(toFingerprint) || [];
    const queuedItem = {
      type: 'relay',
      relayId: crypto.randomUUID(),
      fromClientId: sealedSender ? '' : clientId,
      fromFingerprint: sealedSender ? '' : fromFingerprint,
      payload: message.payload || null,
      queuedAt: new Date().toISOString(),
      ...(viaRelay ? { via: viaRelay, hops: viaHops } : {}),
      ...(guestHeldFor(toFingerprint) ? { guestHeld: true } : {}),
    };
    if (queuedItem.guestHeld) guestHeldBoxes.add(toFingerprint);
    copyToRemoteGuests(toFingerprint, [queuedItem]);
    if (guestBook.movedTo(toFingerprint)) forwardMovedMail(toFingerprint);
    copyToGuestSiblings(toFingerprint, [queuedItem]);
    queuedLive.push(queuedItem);
    liveRelayId = queuedItem.relayId;
    offlineBoxes.set(toFingerprint, queuedLive);
    saveOfflineBox(toFingerprint);
    sweepRetention(toFingerprint);
    const remainingLive = offlineBoxes.get(toFingerprint);
    reply({ type: 'queued', toFingerprint, count: remainingLive ? remainingLive.length : 0, tag, known: true });
  }

  /* The socket is registered, so this message takes the live path. That
     is not the same as the person seeing it: an iOS web app in the
     background keeps its socket and reads nothing off it, and until now
     that case got the live frame and no notification — the sender saw
     them as online and the phone stayed silent, which is the one
     combination that loses a message without anybody being told.
     A push is sent as well when the app is not awake. The live frame
     still goes out because it costs nothing and the client de-duplicates
     by message id, so if the app IS awake and the heartbeat merely
     lapsed, the worst case is one notification for a message already on
     screen — which the service worker suppresses anyway when a window is
     in front of the user. */
  if (!isAppAwake(target) && toFingerprint) {
    const wakes = payloadType === 'offline-chat'
      ? message.payload?.notify !== false
      : PUSHABLE_PAYLOADS.has(payloadType);
    if (wakes) {
      const kind = pushKindFor(payloadType, message.payload || {});
      sendPushNotification(toFingerprint, kind, sanitizeNoticeHint(message.payload?.hint)).catch((error) => console.error(error));
    }
  }
  for (const recipient of allTargets) {
    safeSend(recipient.ws, {
      type: 'relay',
      relayId: liveRelayId || undefined,
      fromClientId: sealedSender ? '' : clientId,
      fromFingerprint: sealedSender ? '' : fromFingerprint,
      payload: message.payload || null,
    });
  }
}

/* The socket another relay arrives on.
 *
 * 24 MB rather than the 12 MB a client frame gets: a transit envelope wraps
 * one of those and the wrapping is base64, which costs a third, and the frame
 * around it costs a little more. A ceiling below what the inner path allows
 * would drop the largest legitimate messages and nothing would say why.
 *
 * Nothing is accepted at all while transit is off, and the handshake decides
 * the rest — see relay-peers.js. */
const relayLinkServer = new WebSocketServer({ noServer: true, maxPayload: 24 * 1024 * 1024 });
relayLinkServer.on('error', (error) => console.error('[Transit] link server error:', error));
/* A link socket is a socket. It counts against the same ceilings every other
   socket counts against, from the moment the upgrade completes — the
   handshake proves nothing for up to ten seconds, and unauthenticated
   handshakes are exactly what a ceiling is for. */
relayLinkServer.on('connection', (ws, request) => {
  trackSocket(ws, socketAddress(request));
  relayPeers.accept(ws);
});
function handleRelayLinkUpgrade(request, socket, head) {
  if (!relayPeers.enabled()) { socket.destroy(); return; }
  if (socketBudgetRefused(request, socket)) return;
  relayLinkServer.handleUpgrade(request, socket, head, (ws) => {
    relayLinkServer.emit('connection', ws, request);
  });
}

// Manual upgrade handler to resolve path conflicts between wsServer and PeerJS
server.on('upgrade', (request, socket, head) => {
  /* A malformed request line here is an exception in an event handler, which
     is a process-level event with a flushing exit attached. The HTTP parser
     rarely allows one through, but "rarely" is not "never", and the answer to
     a bad URL is a closed socket rather than a dead relay. */
  let url;
  try {
    url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  } catch (_error) {
    rejectUpgrade(socket, 400, 'Bad Request');
    return;
  }
  const { pathname } = url;

  if (pathname === '/chat-signal') {
    handlePresenceUpgrade(request, socket, head);
    return;
  }
  if (pathname === '/relay-link') {
    handleRelayLinkUpgrade(request, socket, head);
    return;
  }
  if (pathname === '/peerjs/peerjs' || pathname.startsWith('/peerjs/peerjs/')) {
    const restriction = getRestrictionForIdentity(upgradeRequestIdentity(request, url));
    if (restriction) {
      rejectRestrictedUpgrade(socket, restriction);
      return;
    }
    if (socketBudgetRefused(request, socket)) return;
    for (const listener of peerUpgradeListeners) {
      listener.call(server, request, socket, head);
    }
    return;
  }
  socket.destroy();
});

presenceServer.on('upgrade', (request, socket, head) => {
  let url;
  try {
    url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  } catch (_error) {
    rejectUpgrade(socket, 400, 'Bad Request');
    return;
  }
  if (url.pathname !== '/chat-signal') {
    socket.destroy();
    return;
  }
  handlePresenceUpgrade(request, socket, head);
});

  const offlineBoxes = loadOfflineBoxes();
/* Retention has to run on a clock as well as on use: a mailbox nobody writes
   to and nobody collects would otherwise keep week-old media forever. */
setInterval(() => {
  try {
    sweepRetention();
  } catch (error) {
    console.error('[Retention] sweep failed:', error);
  }
}, RETENTION_SWEEP_MS).unref?.();
  const pushSubscriptions = loadPushSubscriptions();
  const selfDestructRecords = loadSelfDestructRecords();
  const policyStore = loadPolicyStore();
  const suspendedUsers = new Map(Object.entries(policyStore.suspendedUsers || {}));
  const kickedUsers = new Map(Object.entries(policyStore.kickedUsers || {}));
/* Admission by invitation rather than by exception.
 *
 * The key is the identity fingerprint, which is derived from the public key.
 * Generating a new key therefore produces a new fingerprint and a stranger
 * again -- which is the point: rotating a key must not be a way around the
 * door, and on a deny list it always is. */
const allowedUsers = new Map(Object.entries(policyStore.allowedUsers || {}));
/* Off means the relay is open, which is what it has always been and what an
   existing install keeps after an upgrade. Turning it on is a decision. */
let allowlistEnabled = Boolean(policyStore.allowlistEnabled);

