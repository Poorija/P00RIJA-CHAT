app.post('/admin/broadcast', authMiddleware, (req, res) => {
  const { message, fileData, fileName, kind, targetClientId, targetFingerprint } = req.body;
  if (!message && !fileData) return res.status(400).json({ ok: false, reason: 'Content required' });
  
  console.log(`[Admin] Broadcasting ${kind || 'message'}: ${message || fileName}`);
  const payload = JSON.stringify({
    type: 'system-broadcast',
    message,
    fileData,
    fileName,
    kind: kind || 'text',
    timestamp: Date.now()
  });

  let sentCount = 0;
  const targetFingerprintClean = sanitizeFingerprint(targetFingerprint);
  for (const client of presence.values()) {
    if (targetClientId && client.clientId !== targetClientId) continue;
    if (targetFingerprintClean && client.fingerprint !== targetFingerprintClean) continue;
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload);
      sentCount++;
    }
  }
  res.json({ ok: true, sentTo: sentCount });
});

app.post('/admin/change-password', authMiddleware, (req, res) => {
  const { oldPassword, newPassword, currentPassword } = req.body || {};
  /* The Monitor dashboard called this field `currentPassword` while this
     endpoint read `oldPassword`, so every password change made from the
     Monitor itself was refused with "old password incorrect" — whatever was
     typed. Both names answer now: the endpoint heals an already-deployed
     dashboard, and the dashboard sends the canonical one. */
  const suppliedOld = oldPassword ?? currentPassword;

  /* The old password is required, not merely checked when supplied. The guard
     used to read `if (oldPassword && ...)`, so omitting the field skipped the
     comparison altogether — a stolen session cookie was enough to take the
     account over without ever learning the password. */
  if (!monitorPasswordMatches(suppliedOld)) {
    return res.status(403).json({ ok: false, reason: 'Old password incorrect' });
  }

  /* Twelve, matching what the installer insists on. Six let the wizard's own
     rule be undone from the dashboard a minute after setup. */
  if (!newPassword || String(newPassword).length < 12) {
    return res.status(400).json({ ok: false, reason: 'Password must be at least 12 characters' });
  }
  if (/[\s$]/.test(String(newPassword))) {
    return res.status(400).json({ ok: false, reason: 'Password must not contain spaces or $' });
  }

  MONITOR_PASSWORD = String(newPassword);
  saveServerConfig();
  /* The password shown at first start is no longer the password — and its file is gone before the answer says so: it
     was removed in a callback nobody waited for, so for a moment (and for ever if the removal failed, which nothing
     reported) the plain first password sat on disk beside a "changed" response. */
  try { fs.rmSync(INITIAL_PASSWORD_PATH, { force: true }); } catch (error) { console.error('[Admin] Could not remove the first-password file:', error.message); }
  /* Only the hash stays; the plain value lived long enough to be hashed. */
  if (MONITOR_PASSWORD !== (process.env.MONITOR_PASSWORD || '')) MONITOR_PASSWORD = '';
  monitorVerifyCache.clear();
  /* Every existing session dies with the old password. A rotation that leaves
     the previous sessions signed in has not rotated anything. */
  revokeAllMonitorSessions();
  clearMonitorAuthCookie(res);
  console.log('[Admin] Monitor password changed; all sessions revoked.');
  res.json({ ok: true, reauth: true });
});

app.post('/admin/clear-offline', authMiddleware, (req, res) => {
  const count = offlineBoxes.size;
  offlineBoxes.clear();
  saveOfflineBoxes();
  console.log(`[Admin] Cleared ${count} offline message boxes.`);
  res.json({ ok: true, cleared: count });
});

app.post('/admin/optimize-ram', authMiddleware, (req, res) => {
  const before = process.memoryUsage().heapUsed;
  if (global.gc) {
    global.gc();
  }
  const after = process.memoryUsage().heapUsed;
  console.log(`[Admin] RAM Optimization triggered. Heap: ${Math.round(before/1024/1024)}MB -> ${Math.round(after/1024/1024)}MB`);
  res.json({ ok: true, gcTriggered: Boolean(global.gc), saved: Math.round((before - after)/1024/1024) });
});

app.post('/admin/clear-memory', authMiddleware, (req, res) => {
  // Clear dead presence records and trigger GC if available
  const now = Date.now();
  let cleared = 0;
  for (const [clientId, record] of presence.entries()) {
    const isExpired = now - (record.lastSeenAt || 0) > PRESENCE_TTL_MS;
    const isClosed = !record.ws || record.ws.readyState !== 1; // 1 is WebSocket.OPEN

    if (isExpired || isClosed) {
      console.log(`[Admin] Cleaning up ${clientId} (expired: ${isExpired}, closed: ${isClosed})`);
      try {
        if (record.ws) record.ws.terminate();
      } catch (_e) {}
      presence.delete(clientId);
      cleared++;
    }
  }

  // Also clear any disconnected PeerServer clients if accessible
  // (peerServer doesn't expose a simple clear, but usually cleans itself)

  if (global.gc) {
    global.gc();
  }

  res.json({ ok: true, clearedPresence: cleared, gcTriggered: Boolean(global.gc) });
});

app.get('/Monitor_Server', (req, res) => {
  setNoStoreHeaders(res);
  const authToUse = getMonitorAuth(req);
  const authenticated = isValidMonitorAuth(req);


  const host = req.get('host') || 'localhost';

  if (!authenticated) {
    clearMonitorAuthCookie(res);
    return res.send(monitorLoginHtml());
  }

  /* This used to re-check the caller here with
     `decodeMonitorAuth(getMonitorAuth(req))`, and that check could never pass.
     getMonitorAuth returns the opaque session handle introduced when sessions
     stopped being the password in disguise; decodeMonitorAuth still expected
     the old "Basic <base64 user:pass>" string, so it returned null for a cookie
     login AND for HTTP Basic, and every authenticated request to the dashboard
     came back 401 "Invalid credentials". /healthz accepted the very same
     credentials, which is what made it look like a password problem.

     isValidMonitorAuth above is the check — it understands both a live session
     and Basic — and it has already run into `authenticated`. Asking a second
     time with a decoder that no longer matches the token format was not
     defence in depth, it was the reason the dashboard was unreachable. */
  if (!authenticated) {
    return res.status(401).send('Invalid credentials');
  }

  /* The 3.34 dashboard, drawn by scripts/lib/monitor-dashboard.js. The old
     single-scroll sheet still hangs below this line and stays reachable at
     ?classic=1 for the remainder of this release — it is deleted once an
     operator has confirmed the new one on a real deployment. */
  if (!req.query.classic) {
    return res.send(monitorDashboardHtml({
      version: RELAY_BUILD?.version || '',
      buildTag: RELAY_BUILD?.buildTag || '',
      monitorVersion: MONITOR_VERSION,
      port: PORT,
      presencePort: PRESENCE_PORT,
      bootstrapPort: BOOTSTRAP_PORT,
    }));
  }

  res.send(monitorClassicHtml({ PORT, PRESENCE_PORT, host }));
});

/* A test-only stand-in for how full this relay is, so the suites can show the
   apps a busy relay; ignored unless test hooks are on. */
const TEST_SATURATION = (() => {
  if (process.env.CHAT_TEST_HOOKS !== '1') return null;
  const value = Number(process.env.CHAT_TEST_SATURATION);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
})();

/* A block of bytes to time, for an app choosing the fastest relay of its family
   (js/chat/63-relay-choice.js). Public, uncached, says nothing, and limited to a
   few a minute per address so it cannot be used to make this relay send much. */
const RELAY_SPEED_DEFAULT = 262144;
const RELAY_SPEED_MAX = 524288;
const RELAY_SPEED_PER_MINUTE = 6;
const relaySpeedAsks = new Map();
const relaySpeedBlock = crypto.randomBytes(RELAY_SPEED_MAX);
app.get('/relay-speed', (req, res) => {
  const ip = requestIp(req) || 'unknown';
  const now = Date.now();
  const seen = relaySpeedAsks.get(ip);
  if (!seen || now - seen.since > 60000) relaySpeedAsks.set(ip, { since: now, count: 1 });
  else seen.count += 1;
  if (relaySpeedAsks.size > 20000) relaySpeedAsks.delete(relaySpeedAsks.keys().next().value);
  if ((relaySpeedAsks.get(ip)?.count || 0) > RELAY_SPEED_PER_MINUTE) {
    res.status(429).json({ ok: false, reason: 'slow-down' });
    return;
  }
  const asked = Math.floor(Number(req.query?.bytes) || RELAY_SPEED_DEFAULT);
  const bytes = Math.max(1, Math.min(RELAY_SPEED_MAX, asked));
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', String(bytes));
  res.end(relaySpeedBlock.subarray(0, bytes));
});

app.get('/chat-health', (req, res) => {
  if (sendRestrictionResponse(req, res)) return;
  const publicUrls = publicRelayUrls(req);
  rememberPublicOrigin(publicUrls.relayOrigin);
  res.json({
    ok: true,
    service: 'poorija-chat-signal',
    peers: presence.size,
    turnEnabled: TURN_URLS.length > 0,
    /* Whether POST /link-preview answers, so a client offers the switch only
       against a relay that will do the fetch. */
    linkPreviews: LINK_PREVIEWS_ENABLED,
    /* Whether this relay can fetch a Telegram sticker pack from a link,
       itself or through the relay it hands the question to. */
    telegramStickers: telegramStickersAvailable(),
    /* So a client learns the relay's name in the probe it already makes. */
    relayId: relayIdentity.id,
    /* Which kinds of account identity this relay can prove: an app only
       moves an account to v4 against a relay that says 'v4' here. */
    identity: ['v3', 'v4'],
    /* Whether this relay's group-call SFU answers (roadmap 3.2): an app uses
       it for a large call, and stays on the mesh otherwise. */
    sfu: sfuUp,
    /* Which tree this relay was built from, so a deploy can check it. */
    version: RELAY_BUILD.version,
    buildTag: RELAY_BUILD.buildTag,
    /* The monitor's own round, which moves on its own schedule — stated here
       so a deployment can tell which dashboard answered without logging in. */
    monitor: MONITOR_VERSION,
    /* How many other relays this one can actually hand traffic to right now,
       which is the only honest measure of transit being up. */
    transit: relayPeers.status(),
    /* Whether dangerous dashboard actions here need an operator signature. */
    locked: REQUIRE_OPERATOR_SIGNATURE,
    peerOrigin: publicUrls.relayOrigin,
    presenceUrl: publicUrls.presenceUrl,
    /* What this instance sized itself to, and how full it is. A load balancer
       reads `saturation` to decide where to send the next peer; an operator
       reads `tier` to understand why the ceilings are what they are. Nothing
       secret is here — the numbers describe capacity, not configuration. */
    capacity: {
      tier: CAPACITY.tier,
      cpus: CAPACITY.cpuCount,
      memoryMb: CAPACITY.totalMemMb,
      sockets: { inUse: wsTotal, max: WS_MAX_TOTAL, maxPerAddress: WS_MAX_PER_IP },
      /* What the apps' choice of relay reads (js/chat/63-relay-choice.js). */
      saturation: TEST_SATURATION !== null ? TEST_SATURATION : (WS_MAX_TOTAL > 0 ? Number((wsTotal / WS_MAX_TOTAL).toFixed(3)) : 0),
    },
    instance: INSTANCE_ID,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

