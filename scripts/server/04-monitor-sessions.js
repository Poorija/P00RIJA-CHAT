/* ------------------------------------------------------------------
 * Monitor sessions
 *
 * The old scheme made the token `base64("admin:" + password)`, which is not a
 * session at all — it is the password in a thin disguise. Anyone who reached
 * the cookie (a proxy log, a backup, a stolen laptop) read the password
 * straight out of it, and because the same value was ALSO returned in the
 * login response body, page JavaScript could read what HttpOnly was supposed
 * to protect. It could additionally be passed as ?auth=..., which puts a
 * credential into access logs, browser history and Referer headers.
 *
 * A session is now a random 32-byte handle that means nothing on its own and
 * is only good while the server remembers it.
 * ------------------------------------------------------------------ */
const MONITOR_SESSION_TTL_MS = Number(process.env.MONITOR_SESSION_TTL_MS || 12 * 60 * 60 * 1000);
const monitorSessions = new Map();

function issueMonitorSession(req) {
  const token = crypto.randomBytes(32).toString('base64url');
  monitorSessions.set(token, {
    createdAt: Date.now(),
    expiresAt: Date.now() + MONITOR_SESSION_TTL_MS,
    ip: monitorLoginKey(req),
  });
  return token;
}

function monitorSessionValid(token) {
  if (!token) return false;
  const session = monitorSessions.get(token);
  if (!session) return false;
  if (session.expiresAt <= Date.now()) {
    monitorSessions.delete(token);
    return false;
  }
  /* Sliding: an operator mid-work never hits a wall mid-tab-switch. A fixed
     12h expiry logged people out at arbitrary moments because the clock
     started at login and never moved; now every valid request re-arms it. */
  session.expiresAt = Date.now() + MONITOR_SESSION_TTL_MS;
  return true;
}

function revokeMonitorSession(token) {
  if (token) monitorSessions.delete(token);
}

/* Every session dies when the password changes: a rotated password that leaves
   old sessions logged in has not really been rotated. */
function revokeAllMonitorSessions() {
  monitorSessions.clear();
}

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of monitorSessions) {
    if (session.expiresAt <= now) monitorSessions.delete(token);
  }
}, 10 * 60 * 1000).unref?.();

/* String === on a secret returns at the first differing byte, which is a
   timing signal. Compare digests so the work is the same either way, whatever
   the lengths are. */
function secretsMatch(candidate, expected) {
  const a = crypto.createHash('sha256').update(String(candidate ?? '')).digest();
  const b = crypto.createHash('sha256').update(String(expected ?? '')).digest();
  return crypto.timingSafeEqual(a, b);
}

function monitorCookieFlags(req) {
  /* Secure would make the cookie unusable over a plain-http LAN deployment,
     which is a supported way to run this, so it is set when the request that
     is establishing the session actually arrived over TLS. */
  const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  return `Path=/; Max-Age=${Math.floor(MONITOR_SESSION_TTL_MS / 1000)}; SameSite=Strict; HttpOnly${secure ? '; Secure' : ''}`;
}

function clearMonitorAuthCookie(res) {
  res.setHeader('Set-Cookie', [
    'monitor_token_v2=; Path=/; Max-Age=0; SameSite=Strict; HttpOnly',
    'monitor_token_v2=; Path=/Monitor_Server; Max-Age=0; SameSite=Strict; HttpOnly',
  ]);
}

/* No query-string credentials. A password in a URL is a password in the
   access log, in the browser's history, and in the Referer header of the next
   outbound request the page makes. */
function monitorTokenFromRequest(req) {
  const cookie = readCookie(req, 'monitor_token_v2');
  if (cookie) return cookie;
  const header = String(req.headers.authorization || '');
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return '';
}

function getMonitorAuth(req) {
  return monitorTokenFromRequest(req);
}

function decodeMonitorAuth(authToUse) {
  if (!authToUse) return null;
  const parts = authToUse.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Basic') return null;
  try {
    const decoded = Buffer.from(parts[1], 'base64').toString();
    const separator = decoded.indexOf(':');
    if (separator < 0) return null;
    return {
      user: decoded.slice(0, separator),
      pass: decoded.slice(separator + 1),
      token: parts[1],
    };
  } catch (_error) {
    return null;
  }
}

function isValidMonitorAuth(req) {
  const token = monitorTokenFromRequest(req);
  if (monitorSessionValid(token)) return true;
  /* HTTP Basic stays supported for scripted access, but the password is
     compared in constant time rather than with ===. */
  const header = String(req.headers.authorization || '');
  if (header.startsWith('Basic ')) {
    const decoded = decodeMonitorAuth(header);
    return Boolean(decoded && decoded.user === 'admin' && monitorPasswordMatches(decoded.pass));
  }
  return false;
}

function monitorLoginKey(req) {
  /* The three-strike ladder hangs off this. See securityKey(). */
  return securityKey(req);
}

function getMonitorLockState(req) {
  const key = monitorLoginKey(req);
  const state = monitorLoginFailures.get(key);
  if (!state) return { locked: false, remainingMs: 0, attempts: 0 };
  if (state.lockUntil && Date.now() < state.lockUntil) {
    return { locked: true, remainingMs: state.lockUntil - Date.now(), attempts: state.attempts || 0 };
  }
  if (state.lockUntil && Date.now() >= state.lockUntil) {
    monitorLoginFailures.delete(key);
  }
  return { locked: false, remainingMs: 0, attempts: state?.attempts || 0 };
}

function recordMonitorLoginFailure(req) {
  const key = monitorLoginKey(req);
  const current = monitorLoginFailures.get(key) || { attempts: 0, lockUntil: 0 };
  const attempts = current.attempts + 1;
  const lockUntil = attempts >= MONITOR_LOCK_MAX_ATTEMPTS ? Date.now() + MONITOR_LOCK_MS : 0;
  monitorLoginFailures.set(key, { attempts, lockUntil });
  return { attempts, lockUntil, locked: Boolean(lockUntil) };
}

function requestIdentity(req) {
  const decodeHeader = (val) => {
    if (!val) return '';
    const raw = Array.isArray(val) ? val[0] : String(val);
    const normalized = raw.replace(/\s+/g, '');
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) && normalized.length % 4 === 0) {
      try {
        return Buffer.from(normalized, 'base64').toString('utf8');
      } catch (_error) {}
    }
    // Fallback for older formats or plain strings.
    try { return decodeURIComponent(raw); } catch (e2) { return raw; }
  };
  return {
    fingerprint: sanitizeFingerprint(decodeHeader(req.headers['x-p00rija-fingerprint'] || req.query?.fingerprint)),
    peerId: String(decodeHeader(req.headers['x-p00rija-peer-id'] || req.query?.peerId || '')).slice(0, 160),
    clientId: String(decodeHeader(req.headers['x-p00rija-client-id'] || req.query?.clientId || '')).slice(0, 80),
    username: String(decodeHeader(req.headers['x-p00rija-username'] || '')).slice(0, 80),
    ip: requestIp(req),
  };
}

function sendRestrictionResponse(req, res) {
  const restriction = getRestrictionForIdentity(requestIdentity(req));
  if (!restriction) return false;
  const policy = restriction.policy || {};
  let untilText = '';
  if (policy.expiresAt) {
    const d = new Date(policy.expiresAt);
    untilText = ' تا ' + d.toLocaleString('fa-IR') + ' (' + d.toLocaleString('en-US') + ')';
  }
  const suspendedText = `شما موقتاً تعلیق شده اید.${untilText}`;
  const kickedText = policy.permanent
    ? 'دسترسی شما در سیستم محدود شده است، لطفاً برای رفع محدودیت با ادمین سرور و یا پشتیبانی تماس بگیرید.'
    : `اتصال شما با این سرور${untilText} محدود شده است، لطفاً با ادمین تماس بگیرید.`;
  res.status(403).json({
    ok: false,
    restricted: true,
    restrictionType: restriction.type,
    permanent: Boolean(restriction.policy?.permanent),
    until: restriction.policy?.expiresAt || null,
    message: restriction.type === 'kicked' ? kickedText : suspendedText,
  });
  return true;
}

/* ---------------------------------------------------------------------------
 * What the relay knows and the monitor could not see.
 *
 * /healthz reported usage without ever reporting a ceiling — "412 peers" and
 * "1 204 queued" with nothing to compare them against — and it reported
 * nothing at all about the one thing an operator most needs to know: the relay
 * DISCARDS messages. Media ages out after a week, a mailbox over its quota
 * drops its oldest media, and a text tail past the limit is trimmed. Every one
 * of those is written to expiryLog, and none of it reached a screen. A message
 * that never arrived looked identical to one that was never sent.
 *
 * COST. This walks every mailbox, and /healthz is polled every few seconds, so
 * doing it per request would make the monitor the heaviest client on the
 * relay. Two things keep it cheap:
 *   - the result is cached for ten seconds, which is below any refresh
 *     interval the monitor offers, so a faster poll costs nothing extra;
 *   - only media envelopes are measured with envelopeBytes (a JSON.stringify
 *     each), because only media is subject to the byte quota. Text is counted,
 *     not weighed. On a queue of any size that is the difference between a few
 *     hundred stringifications and all of them.
 * ------------------------------------------------------------------------- */
const RELAY_INSIGHT_TTL_MS = 10_000;
const RELAY_INSIGHT_TOP = 8;

/* Only the mailbox walk is cached, because only the mailbox walk is expensive.
 *
 * Caching the whole block was wrong in a way that showed up immediately: a
 * monitor refreshing every two seconds got a live `peers` count next to a
 * `sockets` figure up to ten seconds old, so one screen disagreed with itself
 * — during a load test it read 75 peers and 25 sockets, and the 25 was this
 * cache, not the relay. Sockets, throttling and push counts are all reads of
 * small maps; they cost nothing and are now always current. */
let mailboxCache = { at: 0, value: null };

function mailboxSummary() {
  const now = Date.now();
  if (mailboxCache.value && now - mailboxCache.at < RELAY_INSIGHT_TTL_MS) {
    return mailboxCache.value;
  }

  let envelopes = 0;
  let textEnvelopes = 0;
  let mediaEnvelopes = 0;
  let mediaBytes = 0;
  let oldestQueuedAt = 0;
  const perBox = [];

  for (const [fingerprint, items] of offlineBoxes.entries()) {
    let boxMedia = 0;
    let boxMediaCount = 0;
    let boxOldest = 0;
    for (const item of items) {
      envelopes += 1;
      const queued = queuedAtMs(item);
      if (queued && (!boxOldest || queued < boxOldest)) boxOldest = queued;
      if (envelopeClass(item) === 'media') {
        mediaEnvelopes += 1;
        boxMediaCount += 1;
        boxMedia += envelopeBytes(item);
      } else {
        textEnvelopes += 1;
      }
    }
    mediaBytes += boxMedia;
    if (boxOldest && (!oldestQueuedAt || boxOldest < oldestQueuedAt)) oldestQueuedAt = boxOldest;
    perBox.push({
      /* Truncated on purpose. A fingerprint identifies a person, and the
         monitor is a screen somebody may be looking at over your shoulder;
         eight characters is enough to match against a peer row. */
      fingerprint: String(fingerprint || '').slice(0, 8),
      envelopes: items.length,
      media: boxMediaCount,
      mediaBytes: boxMedia,
      quotaPercent: MEDIA_QUOTA_BYTES > 0 ? Math.round((boxMedia / MEDIA_QUOTA_BYTES) * 100) : 0,
      oldestQueuedAt: boxOldest ? new Date(boxOldest).toISOString() : null,
    });
  }
  perBox.sort((a, b) => b.mediaBytes - a.mediaBytes || b.envelopes - a.envelopes);

  const value = {
    count: offlineBoxes.size,
    envelopes,
    textEnvelopes,
    mediaEnvelopes,
    mediaBytes,
    quotaPercent: MEDIA_QUOTA_BYTES > 0 ? Math.round((mediaBytes / MEDIA_QUOTA_BYTES) * 100) : 0,
    oldestQueuedAt: oldestQueuedAt ? new Date(oldestQueuedAt).toISOString() : null,
    fullest: perBox.slice(0, RELAY_INSIGHT_TOP),
    walkedAt: new Date(now).toISOString(),
  };
  mailboxCache = { at: now, value };
  return value;
}

/* Invalidated rather than waited out, so a monitor watching someone's queue
   drain does not keep showing the old figure for another ten seconds. */
function forgetMailboxSummary() {
  mailboxCache = { at: 0, value: null };
}

function relayInsight() {
  const now = Date.now();
  const boxes = mailboxSummary();

  const dayAgo = now - 86400000;
  const byReason = {};
  let expiredLast24h = 0;
  for (const entry of expiryLog) {
    byReason[entry.reason] = (byReason[entry.reason] || 0) + 1;
    const at = Date.parse(entry.expiredAt || '');
    if (Number.isFinite(at) && at >= dayAgo) expiredLast24h += 1;
  }

  let pushEndpoints = 0;
  let pushExpiringSoon = 0;
  const weekAhead = now + 7 * 86400000;
  for (const items of pushSubscriptions.values()) {
    for (const item of items) {
      pushEndpoints += 1;
      const at = Date.parse(item?.expiresAt || '');
      if (Number.isFinite(at) && at <= weekAhead) pushExpiringSoon += 1;
    }
  }

  /* Who is currently being throttled, and who is close to it. A stress test
     that produces a wall of 429s is indistinguishable from a broken relay
     without this. */
  const throttled = [];
  let activeBuckets = 0;
  for (const [key, entry] of rateBuckets) {
    if (entry.resetAt <= now) continue;
    activeBuckets += 1;
    const bucket = key.slice(0, key.indexOf(':'));
    const ceiling = RATE_LIMITS[bucket] ?? RATE_LIMITS.default;
    if (entry.count >= ceiling * 0.8) {
      throttled.push({
        bucket,
        client: key.slice(key.indexOf(':') + 1),
        count: entry.count,
        ceiling,
        over: entry.count > ceiling,
        resetsInMs: Math.max(0, entry.resetAt - now),
      });
    }
  }
  throttled.sort((a, b) => b.count - a.count);

  const sockets = [];
  let socketTotal = 0;
  for (const [address, count] of wsPerAddress) {
    socketTotal += count;
    sockets.push({ address, count });
  }
  sockets.sort((a, b) => b.count - a.count);

  let selfDestruct = { records: 0, opened: 0 };
  try {
    const records = Array.from(selfDestructRecords.values());
    selfDestruct = {
      records: records.length,
      opened: records.reduce((sum, record) => sum + Number(record?.opens || 0), 0),
    };
  } catch (error) { /* the store may not be loaded yet */ }

  return {
    instanceId: INSTANCE_ID,
    /* Every number above has a ceiling somewhere in this file. Sending them
       together is what turns a reading into a judgement. */
    limits: {
      tier: CAPACITY.tier,
      cpuCount: CAPACITY.cpuCount,
      totalMemMb: CAPACITY.totalMemMb,
      /* The values actually enforced, not the ones the hardware profile
         suggested. CHAT_WS_MAX_TOTAL and CHAT_WS_MAX_PER_IP override the
         profile, and reporting the profile instead meant the monitor printed a
         ceiling nobody was being held to — a per-address cap of 276 while the
         relay was letting 20 000 through. A limit displayed wrongly is worse
         than one not displayed at all: it gets believed. */
      wsMaxTotal: WS_MAX_TOTAL,
      wsMaxPerIp: WS_MAX_PER_IP,
      textMailboxLimit: TEXT_MAILBOX_LIMIT,
      mediaQuotaBytes: MEDIA_QUOTA_BYTES,
      mediaRetentionMs: MEDIA_RETENTION_MS,
      rateWindowMs: RATE_LIMIT_WINDOW_MS,
      rateLimits: { ...RATE_LIMITS },
    },
    mailboxes: boxes,
    /* The headline this whole block exists for. */
    discarded: {
      total: expiryLog.length,
      last24h: expiredLast24h,
      byReason,
      recent: expiryLog.slice(-20).reverse().map((entry) => ({
        to: String(entry.fingerprint || '').slice(0, 8),
        from: String(entry.from || '').slice(0, 8),
        class: entry.class,
        reason: entry.reason,
        queuedAt: entry.queuedAt,
        expiredAt: entry.expiredAt,
      })),
    },
    push: {
      subscribers: pushSubscriptions.size,
      endpoints: pushEndpoints,
      expiringSoon: pushExpiringSoon,
    },
    throttle: {
      activeBuckets,
      windowMs: RATE_LIMIT_WINDOW_MS,
      nearOrOverLimit: throttled.slice(0, RELAY_INSIGHT_TOP),
    },
    sockets: {
      total: socketTotal,
      addresses: wsPerAddress.size,
      busiest: sockets.slice(0, RELAY_INSIGHT_TOP),
      refused: {
        total: socketRefusals.total,
        perIp: socketRefusals.perIp,
        capacity: socketRefusals.capacity,
        lastAt: socketRefusals.lastAt,
        addresses: Array.from(socketRefusals.addresses.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, RELAY_INSIGHT_TOP)
          .map(([address, count]) => ({ address, count })),
      },
    },
    selfDestruct,
    computedAt: new Date(now).toISOString(),
  };
}

/* The certificate is read from disk, so it is cached harder than the rest: a
   file that changes twice a year does not need looking at every ten seconds,
   and a relay whose certificate has lapsed is simply unreachable, which is the
   one failure the monitor cannot report because it cannot connect either. */
let certCache = { at: 0, value: null };
function certSummary() {
  const now = Date.now();
  if (certCache.value && now - certCache.at < 300_000) return certCache.value;
  let value = { ok: false, daysLeft: null, validTo: null, subject: '' };
  try {
    const certPath = process.env.CHAT_TLS_CERT_PATH || '/etc/certs/cert.pem';
    const cert = new crypto.X509Certificate(fs.readFileSync(certPath));
    const msLeft = new Date(cert.validTo).getTime() - now;
    value = {
      ok: msLeft > 0,
      daysLeft: Math.floor(msLeft / 86400000),
      validTo: cert.validTo,
      subject: cert.subject,
    };
  } catch (error) {
    value.error = String((error && error.message) || error);
  }
  certCache = { at: now, value };
  return value;
}

app.get('/healthz', authMiddleware, (_req, res) => {
  pruneExpiredPolicies();
  const mem = process.memoryUsage();
  const cpus = os.cpus();
  
  // Basic CPU load calculation (1-min load avg relative to CPU cores)
  const cpuCount = cpus.length;
  const loadAvg = os.loadavg();
  const cpuLoadPercent = Math.min(100, Math.round((loadAvg[0] / cpuCount) * 100));

  const now = Date.now();
  const livePeers = Array.from(presence.values()).filter((p) =>
    p.ws?.readyState === WebSocket.OPEN
    && now - (p.lastSeenAt || 0) <= PRESENCE_TTL_MS
    && hasUsableIdentity(p)
    && !getRestrictionForIdentity(p)
  );
  const peersDetails = livePeers.map(p => ({
    clientId: p.clientId,
    username: p.username || p.peerId || p.fingerprint || 'بدون نام',
    ip: p.ip,
    connectedAt: p.connectedAt,
    lastSeenAt: p.lastSeenAt,
    peerId: p.peerId,
    fingerprint: p.fingerprint,
    /* Minutes since this sender last crossed a relay link, for the users
       table's cross-relay badge; null means it never did this session. */
    crossRelayMinutes: transitActivityMinutesAgo(p.clientId),
  }));

  // Check storage (fallback for older node versions)
  let storage = null;
  try {
    if (fs.statfsSync) {
      const stats = fs.statfsSync('/data');
      storage = {
        total: Math.round((stats.blocks * stats.bsize) / 1024 / 1024),
        free: Math.round((stats.bfree * stats.bsize) / 1024 / 1024)
      };
    }
  } catch (_e) {}

  res.json({
    ok: true,
    service: 'poorija-chat-signal',
    peers: livePeers.length,
    peersList: peersDetails,
    /* What the system tab draws: the relay's own name, the machine's, the
       processor, and the TURN endpoints actually configured. */
    relayId: relayIdentity.id,
    hostname: os.hostname(),
    cpus: os.cpus().length,
    cpuModel: String(os.cpus()[0]?.model || '').trim().slice(0, 60),
    turnUrls: TURN_URLS.slice(0, 4),
    activeCalls: activeCalls.size,
    /* The relay container's own memory as the kernel prices it: what the
       cgroup allows and what is in use. This — not the node heap — is the
       number the overview card draws, so it matches whatever ceiling the
       machine tab set, 512 MB or unlimited alike. */
    containerMem: (() => {
      try {
        const maxRaw = String(fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8')).trim();
        const current = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8'));
        /* "max" means no ceiling — an unlimited container is a fact worth
           showing, not a reason to fall back to the heap number. */
        if (maxRaw === 'max' && Number.isFinite(current) && current > 0) {
          return { limitMb: 0, usageMb: Math.round(current / 1048576) };
        }
        const max = Number(maxRaw);
        if (Number.isFinite(max) && Number.isFinite(current) && current > 0 && max > 0) {
          return { limitMb: Math.round(max / 1048576), usageMb: Math.round(current / 1048576) };
        }
      } catch (_error) { /* cgroup v1 or no limit exposed */ }
      try {
        const limit = Number(fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8'));
        const usage = Number(fs.readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8'));
        if (Number.isFinite(limit) && Number.isFinite(usage) && usage > 0) {
          return { limitMb: (limit > 0 && limit < 1e15) ? Math.round(limit / 1048576) : 0, usageMb: Math.round(usage / 1048576) };
        }
      } catch (_error) { /* not a cgroup v1 host either */ }
      return null;
    })(),
    queuedMessages: Array.from(offlineBoxes.values()).reduce((sum, box) => sum + box.length, 0),
    pushSubscribers: Array.from(pushSubscriptions.values()).reduce((sum, items) => sum + items.length, 0),
    turnEnabled: TURN_URLS.length > 0,
    traffic: {
      msgsIn: totalMessagesReceived,
      msgsOut: totalMessagesSent,
      bytesIn: totalBytesReceived,
      bytesOut: totalBytesSent,
      relays: totalRelays
    },
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    },
    /* Open files against the process's limit: the ceiling that used to arrive
       unannounced (see filesNearlyExhausted). */
    files: { open: fileGuard.open, limit: fileGuard.limit },
    memoryLimitMb: Math.round(MEMORY_LIMIT_BYTES / 1048576),
    /* What is wrong right now, and whether it reaches the operator. */
    alerts: { active: alertState.active(), telegram: alertsByTelegram(), waiting: alertOutbox.length },
    uptime: Math.round(process.uptime()),
    sysUptime: Math.round(os.uptime()),
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    platform: `${os.platform()} ${os.release()} (${os.arch()})`,
    cpuUsage: process.cpuUsage(),
    cpuLoad: cpuLoadPercent,
    loadAvg: loadAvg,
    totalMem: Math.round(os.totalmem() / 1024 / 1024),
    freeMem: Math.round(os.freemem() / 1024 / 1024),
    activePorts: [PORT, PRESENCE_PORT],
    logs: serverLogs,
    storage: storage,
    suspendedUsers: listSuspensions(),
    kickedUsers: listActiveKickBans(),
    relay: relayInsight(),
    /* The same transit honesty /chat-health reports, for the dashboard's
       overview card without a second request. */
    transit: relayPeers.status(),
    /* The dashboard's overview card reads this to say "3 / 50000 sockets";
       without it the card can only say "— / —". /chat-health has always
       published the same numbers to anybody who asks, so an authenticated
       monitor gaining them gives away nothing it did not already have. */
    capacity: {
      tier: CAPACITY.tier,
      sockets: {
        inUse: Array.from(wsPerAddress.values()).reduce((sum, count) => sum + count, 0),
        max: WS_MAX_TOTAL,
        maxPerAddress: WS_MAX_PER_IP,
      },
    },
    cert: certSummary()
  });
});

app.post('/admin/login', (req, res) => {
  setNoStoreHeaders(res);
  const lock = getMonitorLockState(req);
  if (lock.locked) {
    return res.status(423).json({ ok: false, reason: 'locked', remainingMs: lock.remainingMs });
  }

  const { password, username } = req.body || {};
  /* A username gate in front of the password one: the monitor answers to a
     named operator, not just to whoever holds the secret. Default 'admin'
     keeps every existing bookmark working. */
  const MONITOR_USER = process.env.MONITOR_USER || 'admin';
  const usernameOk = !username || String(username).trim() === MONITOR_USER;
  if (usernameOk && monitorPasswordMatches(password)) {
    monitorLoginFailures.delete(monitorLoginKey(req));
    const token = issueMonitorSession(req);
    res.setHeader('Set-Cookie', `monitor_token_v2=${token}; ${monitorCookieFlags(req)}`);

    /* The token is not in the body by default: the web monitor is served from
       this origin, the browser attaches the HttpOnly cookie by itself, and
       handing page script a copy would undo HttpOnly for no gain.
     *
     * A client that has no cookie jar with this origin must ask for it. The
     * desktop monitor is exactly that: it runs from tauri://localhost, sends
     * `mode: 'cors'` without credentials, and so never receives the cookie at
     * all. It had been written to read `payload.token` from this response,
     * which stopped existing when sessions became opaque handles — so it set
     * no Authorization header, every call came back 401, and the app was
     * unusable against any relay.
     *
     * monitorTokenFromRequest already accepts `Authorization: Bearer <token>`,
     * which is plainly what that support was for. Returning the handle only
     * when it is asked for gives that client its half without weakening the
     * browser's: this response is reached only by someone who just presented
     * the correct password, so a token here tells an attacker nothing they
     * could not have obtained by logging in themselves. */
    const wantsBearer = req.body?.bearer === true || req.body?.mode === 'bearer';
    return res.json({
      ok: true,
      redirect: '/Monitor_Server',
      ...(wantsBearer ? { token, tokenType: 'Bearer' } : {}),
    });
  }

  const failure = recordMonitorLoginFailure(req);
  res.status(failure.locked ? 423 : 401).json({
    ok: false,
    reason: failure.locked ? 'locked' : 'invalid',
    attemptsRemaining: Math.max(0, MONITOR_LOCK_MAX_ATTEMPTS - failure.attempts),
    remainingMs: failure.lockUntil ? failure.lockUntil - Date.now() : 0,
  });
});

app.post('/admin/logout', (req, res) => {
  setNoStoreHeaders(res);
  revokeMonitorSession(monitorTokenFromRequest(req));
  clearMonitorAuthCookie(res);
  res.json({ ok: true });
});

app.post('/admin/kick-peer', authMiddleware, (req, res) => {
  const { clientId } = req.body;
  const permanent = req.body?.permanent !== undefined ? Boolean(req.body.permanent) : true;
  const durationMinutes = permanent ? 0 : sanitizePolicyDurationMinutes(req.body?.durationMinutes, 60);
  const peer = presence.get(clientId);
  if (peer) {
    const snapshot = identitySnapshot(peer);
    const key = identityKey(snapshot);
    const expiresAt = permanent ? null : Date.now() + durationMinutes * 60 * 1000;
    if (key) {
      kickedUsers.set(key, {
        ...snapshot,
        durationMinutes,
        permanent,
        expiresAt,
        createdAt: new Date().toISOString(),
        reason: String(req.body?.reason || 'admin-kick').slice(0, 160),
      });
      savePolicyStore();
    }
    console.log(`[Admin] Kicking peer ${peer.username} (${clientId}) ${permanent ? 'permanently' : `for ${durationMinutes} minutes`}`);
    disconnectRestrictedPeer(peer, {
      type: 'kicked',
      key,
      policy: { expiresAt, permanent },
    });
    return res.json({ ok: true, key, expiresAt, durationMinutes, permanent });
  }
  res.status(404).json({ ok: false, reason: 'Peer not found' });
});

app.post('/admin/suspend-peer', authMiddleware, (req, res) => {
  const { clientId } = req.body;
  const durationMs = sanitizePolicyDurationMs(req.body?.durationMs, req.body?.durationMinutes, 30);
  const durationMinutes = Math.max(1, Math.ceil(durationMs / 60000));
  const peer = presence.get(clientId);
  if (!peer) return res.status(404).json({ ok: false, reason: 'Peer not found' });

  const snapshot = identitySnapshot(peer);
  const key = identityKey(snapshot);
  if (!key) return res.status(400).json({ ok: false, reason: 'Peer has no stable identity yet' });

  const policy = {
    ...snapshot,
    durationMinutes,
    durationMs,
    expiresAt: Date.now() + durationMs,
    createdAt: new Date().toISOString(),
    reason: String(req.body?.reason || 'admin-suspension').slice(0, 160),
  };
  suspendedUsers.set(key, policy);
  savePolicyStore();
  console.log(`[Admin] Suspended peer ${peer.username} (${clientId})`);
  if (policy.fingerprint) {
    sendAdminPushNotification(
      policy.fingerprint,
      'دسترسی شما در سرور به حالت تعلیق درآمده است. برای رفع تعلیق با ادمین سرور تماس بگیرید.',
      'suspended'
    ).catch((error) => console.error(error));
  }
  disconnectRestrictedPeer(peer, { type: 'suspended', key, policy });
  res.json({ ok: true, key, policy, expiresAt: policy.expiresAt, durationMinutes, durationMs });
});

app.post('/admin/resume-peer', authMiddleware, (req, res) => {
  const directKey = String(req.body?.key || '').trim();
  let deletedCount = 0;
  
  if (directKey && suspendedUsers.has(directKey)) {
    const basePolicy = suspendedUsers.get(directKey);
    const identity = {
      fingerprint: basePolicy.fingerprint,
      peerId: basePolicy.peerId,
      username: basePolicy.username,
      ip: basePolicy.ip
    };

    for (const [key, policy] of suspendedUsers.entries()) {
      if (identityMatchesPolicy(identity, policy)) {
        suspendedUsers.delete(key);
        deletedCount++;
      }
    }
  }

  if (deletedCount > 0) {
    savePolicyStore();
    console.log(`[Admin] Resumed user (deleted ${deletedCount} policy entries)`);
    return res.json({ ok: true, deletedCount });
  }
  
  res.status(404).json({ ok: false, reason: 'Suspended user not found' });
});

app.post('/admin/unkick-peer', authMiddleware, (req, res) => {
  const directKey = String(req.body?.key || '').trim();
  let deletedCount = 0;
  
  if (directKey && kickedUsers.has(directKey)) {
    const basePolicy = kickedUsers.get(directKey);
    const identity = {
      fingerprint: basePolicy.fingerprint,
      peerId: basePolicy.peerId,
      username: basePolicy.username,
      ip: basePolicy.ip
    };

    for (const [key, policy] of kickedUsers.entries()) {
      if (identityMatchesPolicy(identity, policy)) {
        kickedUsers.delete(key);
        deletedCount++;
      }
    }
  }

  if (deletedCount > 0) {
    savePolicyStore();
    console.log(`[Admin] Removed kicked user (deleted ${deletedCount} policy entries)`);
    return res.json({ ok: true, deletedCount });
  }
  
  res.status(404).json({ ok: false, reason: 'Kicked user not found' });
});

