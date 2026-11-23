/* A phone that is frozen sends nothing, so nothing announces that it has gone quiet: awake lapses with the clock
   (APP_AWAKE_TTL_MS). This looks every few seconds and broadcasts only when somebody's state actually flipped. */
setInterval(() => {
  let flipped = false;
  for (const record of presence.values()) {
    const awake = isAppAwake(record);
    if (record.broadcastAwake !== awake) {
      /* the first look only records the state: it was announced with the record itself */
      if (record.broadcastAwake !== undefined) flipped = true;
      record.broadcastAwake = awake;
    }
  }
  if (flipped) broadcastPeers();
}, 5000).unref?.();

setInterval(() => {
  let changed = false;
  const now = Date.now();
  for (const [clientId, record] of presence.entries()) {
    if (record.ws.readyState !== WebSocket.OPEN) {
      console.log(`[Presence] Cleaning up non-open connection for ${clientId}`);
      presence.delete(clientId);
      changed = true;
    } else if (now - (record.lastSeenAt || 0) > PRESENCE_TTL_MS) {
      console.log(`[Presence] Connection timeout for ${clientId} (${record.username}). Last seen: ${now - record.lastSeenAt}ms ago`);
      presence.delete(clientId);
      try {
        record.ws.terminate();
      } catch (_error) {
        // The socket may already be closed.
      }
      changed = true;
    }
  }
  if (changed) broadcastPeers();
}, 30000).unref?.();

setInterval(() => {
  pruneSelfDestructRecords();
}, 6 * 60 * 60 * 1000).unref?.();

/* Whatever the monitor last decided about relay links, on top of the env's
   seed. Called last, at boot, once everything it touches exists. */
loadRuntimeTransitPeers();
startRelayDirectory();
startPartners();

startFrontDoor();

listenOn(server, PORT, '0.0.0.0', () => {
  const where = LISTEN_HOSTS.length ? LISTEN_HOSTS.join(', ') : '0.0.0.0';
  console.log(`Poorija chat signal server listening on port ${PORT} (${where})`);
  console.log(`Monitoring Dashboard available at /Monitor_Server (v${MONITOR_VERSION})`);
});

listenOn(presenceServer, PRESENCE_PORT, HOST, () => {
  console.log(`Poorija chat presence socket listening on port ${PRESENCE_PORT}`);
});

/* ------------------------------------------------------------------
 * Graceful shutdown
 *
 * Without this, a redeploy or a rolling restart kills the process mid-write:
 * the offline mailbox file is read, modified and rewritten in one go, so a
 * SIGTERM landing between the read and the write loses whatever was queued.
 * Peers also just lose their socket with no reason given and reconnect in a
 * thundering herd.
 *
 * The sequence matters. Stop reporting ready first, so a load balancer takes
 * this instance out of the pool while it can still serve what it already has.
 * Then tell the connected peers to reconnect — with a jittered delay, so five
 * thousand of them do not all come back in the same second. Only then close.
 * ------------------------------------------------------------------ */
const SHUTDOWN_GRACE_MS = Number(process.env.CHAT_SHUTDOWN_GRACE_MS || 8000);

function beginShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Shutdown] ${signal} received — draining ${presence.size} peer(s).`);
  /* A guest admitted in the last two seconds is in the book's pending write. */
  try { guestBook.save(); } catch (_error) { /* nothing to lose but the book */ }

  server.close();
  presenceServer.close();

  let told = 0;
  for (const record of presence.values()) {
    if (record.ws?.readyState !== WebSocket.OPEN) continue;
    try {
      record.ws.send(JSON.stringify({
        type: 'server-draining',
        instance: INSTANCE_ID,
        /* The client is asked to come back after its own random delay rather
           than immediately: a synchronised reconnect from every peer at once
           is a self-inflicted denial of service on the instance that replaces
           this one. */
        reconnectAfterMs: 500 + Math.floor(Math.random() * 4000),
      }));
      told += 1;
    } catch (_error) { /* the socket is going away anyway */ }
  }
  console.log(`[Shutdown] told ${told} peer(s) to reconnect.`);

  /* Flush anything still owed to disk before the process goes. */
  try {
    if (typeof saveOfflineBoxes === 'function') saveOfflineBoxes();
  } catch (error) {
    console.error('[Shutdown] could not flush the offline store:', error.message);
  }

  /* The linked relays learn it now, not when their own handshake timeouts
     say so. A peer left to notice for itself spends up to a minute believing
     the link is up — carrying envelopes into it, and re-dialling only after
     the silence outlives them. */
  try {
    relayPeers.close();
  } catch (error) {
    console.error('[Shutdown] could not close the transit links:', error.message);
  }

  const closeAll = setTimeout(() => {
    for (const record of presence.values()) {
      try { record.ws?.close(1001, 'server-restarting'); } catch (_error) { /* noop */ }
    }
    /* The WAL folded back into the database, so the file on its own is the
       whole state (what a backup of the data directory then carries). */
    try { stateDbHandle?.close(); } catch (_error) { /* closing anyway */ }
    console.log('[Shutdown] done.');
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);
  /* Deliberately NOT unref'd. Unreffing it means the process is free to exit
     the moment nothing else holds the loop open — which is exactly the abrupt
     death this whole function exists to avoid. */
  void closeAll;
}

process.on('SIGTERM', () => beginShutdown('SIGTERM'));
process.on('SIGINT', () => beginShutdown('SIGINT'));

/* A crash that takes the mailboxes with it is worse than a crash. */
process.on('uncaughtException', (error) => {
  console.error('[Fatal] uncaught exception:', error);
  try {
    if (typeof saveOfflineBoxes === 'function') saveOfflineBoxes();
  } catch (_error) { /* nothing more to try */ }
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Fatal] unhandled rejection:', reason);
});
