/* ------------------------------------------------------------------
 * Ceilings
 *
 * 50mb applied to every route, authenticated or not, so an anonymous caller
 * could make the process buffer and parse fifty megabytes of JSON as often as
 * it liked. Nothing this server accepts over HTTP is remotely that large —
 * the big payloads travel over the WebSocket, which has its own accounting.
 * The self-destruct record endpoint is the only one that carries real
 * ciphertext, and it gets its own, larger, ceiling.
 * ------------------------------------------------------------------ */
const JSON_BODY_LIMIT = process.env.CHAT_JSON_BODY_LIMIT || '256kb';
const JSON_BODY_LIMIT_RECORDS = process.env.CHAT_JSON_RECORD_LIMIT || '8mb';
app.use('/self-destruct/records', express.json({ limit: JSON_BODY_LIMIT_RECORDS }));
/* A join request from another operator's relay: a directory and a signature,
   never anywhere near the general limit. */
app.use('/relay-join', express.json({ limit: '64kb' }));
app.use(express.json({ limit: JSON_BODY_LIMIT }));

/* ------------------------------------------------------------------
 * Signed dangerous actions (scripts/lib/operator-signature.js)
 *
 * The dashboard actions that can do harm may carry a signature from the
 * admin's own computer: the operator key, or an admin key the operator listed
 * in the family directory. A relay with CHAT_REQUIRE_OPERATOR_SIGNATURE=1
 * takes them only signed, so a dashboard password that leaks no longer
 * reaches them from the web; reading is never refused for want of one. Both
 * settings live in .env, which takes SSH to change, never in the dashboard.
 * A request without the password goes on to its route, which answers 401 as
 * it always has and says nothing about the lock.
 * ------------------------------------------------------------------ */
const REQUIRE_OPERATOR_SIGNATURE = process.env.CHAT_REQUIRE_OPERATOR_SIGNATURE === '1';
const CENTRAL_CONTROL = process.env.CHAT_CENTRAL_CONTROL !== '0';
const signedNonces = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [nonce, until] of signedNonces) if (until <= now) signedNonces.delete(nonce);
}, 60000).unref?.();
app.use((req, res, next) => {
  if (req.method !== 'POST' || !signatureRules.isDangerous(req.path)) return next();
  if (!isValidMonitorAuth(req)) return next();
  const header = req.get('x-operator-signature');
  if (!header) {
    if (REQUIRE_OPERATOR_SIGNATURE) return res.status(403).json({ ok: false, reason: 'operator-signature-required' });
    return next();
  }
  if (!CENTRAL_CONTROL) return res.status(403).json({ ok: false, reason: 'central-control-off' });
  const verdict = signatureRules.verifyRequest(header, {
    method: req.method,
    path: req.path,
    body: req.body,
    relay: relayIdentity.id,
    now: Date.now(),
    keys: signatureRules.signingKeys(directoryState.doc?.body, OPERATOR_KEY),
    nonceSeen: (nonce) => (signedNonces.get(nonce) || 0) > Date.now(),
  });
  if (!verdict.ok) return res.status(403).json({ ok: false, reason: 'bad-operator-signature', detail: verdict.reason });
  signedNonces.set(verdict.nonce, Date.now() + 10 * 60 * 1000);
  req.signedBy = verdict.name;
  monitorLog(`Signed by ${verdict.name}: ${req.path}`);
  queueReport({ level: 'security', title: botText().security.title, body: botText().security.body(req.path, verdict.name) });
  flushAlerts().catch(() => {});
  return next();
});

/* Express advertises itself in a header on every response, which tells an
   attacker which CVE list to read first. */
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'interest-cohort=(), browsing-topics=()');
  /* Only over TLS: sending HSTS from a plain-http LAN deployment would pin
     browsers to https for a host that does not speak it. */
  if (req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

/* ------------------------------------------------------------------
 * Rate limiting
 *
 * A fixed-window counter per address. Deliberately dependency-free and
 * in-memory: this is a single-process relay, and the point is to blunt a
 * flood from one source, not to be a WAF. Behind a proxy it relies on
 * `trust proxy` being set, which it is.
 *
 * The buckets are separate because the traffic is: a browser polls health
 * often and legitimately, while eight login attempts a minute from one
 * address is already someone guessing.
 * ------------------------------------------------------------------ */
const RATE_LIMIT_WINDOW_MS = Number(process.env.CHAT_RATE_WINDOW_MS || 60_000);
const RATE_LIMITS = {
  default: Number(process.env.CHAT_RATE_DEFAULT || CAPACITY.rateDefault),
  /* Login is not scaled with the hardware: ten guesses a minute is the right
     answer on any machine, and a faster server should not make guessing
     faster. */
  login: Number(process.env.CHAT_RATE_LOGIN || 10),
  write: Number(process.env.CHAT_RATE_WRITE || CAPACITY.rateWrite),
  /* Each preview is an outbound fetch of up to two pages on someone's behalf;
     a person typing links does a handful a minute. */
  preview: Number(process.env.CHAT_RATE_PREVIEW || 20),
  /* A Telegram pack is one description and up to 240 files, asked for one
     after another by a person importing it. */
  telegram: Number(process.env.CHAT_RATE_TELEGRAM || 300),
};
const rateBuckets = new Map();

function rateKey(req) {
  /* Never requestIp(): a bucket an attacker can rename is not a bucket. */
  return securityKey(req);
}

function rateLimit(bucketName) {
  const ceiling = RATE_LIMITS[bucketName] ?? RATE_LIMITS.default;
  return (req, res, next) => {
    /* A CORS preflight is not a request for anything: it carries no
       credentials, performs no work, and the browser sends it on its own
       before the call the caller actually made. Counting it charged every
       cross-origin client twice and halved its real allowance.
       Worse, these middlewares run BEFORE the CORS handler below, so a
       preflight rejected here goes back without Access-Control-Allow-Origin
       and the browser cannot read the 429 at all — the desktop monitor showed
       "Failed to fetch" with nothing to explain it, which is how this was
       found. */
    if (req.method === 'OPTIONS') return next();
    const key = `${bucketName}:${rateKey(req)}`;
    const now = Date.now();
    let entry = rateBuckets.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
      rateBuckets.set(key, entry);
    }
    entry.count += 1;
    const remaining = Math.max(0, ceiling - entry.count);
    res.setHeader('X-RateLimit-Limit', String(ceiling));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));
    if (entry.count > ceiling) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ ok: false, reason: 'rate-limited' });
    }
    return next();
  };
}

/* Unbounded growth here would be its own denial of service. */
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateBuckets) {
    if (entry.resetAt <= now) rateBuckets.delete(key);
  }
}, RATE_LIMIT_WINDOW_MS).unref?.();

app.use('/admin/login', rateLimit('login'));
app.use('/admin', rateLimit('write'));
app.use('/push', rateLimit('write'));
app.use('/self-destruct', rateLimit('write'));
/* Each proof costs a key agreement; a flood of them is a flood of work. */
app.use('/relay-prove', rateLimit('write'));
app.use('/relay-mirrors', rateLimit('write'));
app.use('/link-preview', rateLimit('preview'));
app.use('/telegram-stickers', rateLimit('telegram'));
app.use(rateLimit('default'));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const sameOrigin = !origin;
  const isPrivateIp = (origin) => {
    if (!origin || origin === 'null') return true;
    try {
      const url = new URL(origin);
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0' || hostname.endsWith('.localhost')) return true;
      const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      if (match) {
        const [first, second] = [Number(match[1]), Number(match[2])];
        return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
      }
      return false;
    } catch (e) { return false; }
  };
  const allowedLocal = isPrivateIp(origin);
  const allowedTauri = /^https?:\/\/tauri\.localhost(?::\d+)?$/i.test(origin || '') || /^tauri:\/\//i.test(origin || '');
  /* Every relay of the signed family is allowed too: an app opened from one
     of them may be a guest on another (guest mode). */
  const allowedConfigured = origin && (ALLOWED_ORIGINS.includes(origin) || familyOrigins().includes(origin));
  if (sameOrigin || allowedLocal || allowedTauri || allowedConfigured) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, X-P00RIJA-Fingerprint, X-P00RIJA-Peer-Id, X-P00RIJA-Client-Id, X-P00RIJA-Username');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

function normalizeTurnUrls(value = '') {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[,\n\r]+/);
  return raw
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
}

const TURN_URLS = normalizeTurnUrls(TURN_URL);

function forwardedProtocol(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (forwarded) return forwarded;
  return req.protocol === 'https' ? 'https' : 'http';
}

function hostWithPort(host = '', port = '') {
  if (!host) return `localhost:${port}`;
  if (!port) return host;
  if (host.startsWith('[')) {
    return host.replace(/\](?::\d+)?$/, `]:${port}`);
  }
  return host.replace(/:\d+$/, '') + `:${port}`;
}

/* The origin clients reach this relay at, as the last real request named it.
   A transit answer has no request to read it from, and a client that just
   discovered a contact lives here needs an origin to file the route under. */
/* The Host header is the requester's to write, so a learned origin is only
   kept when it names this deployment: its DOMAIN, or one of the origins it is
   configured to serve. Anything else would let a stranger's request decide
   the origin this relay hands to the clients of a linked relay. */
let learnedPublicOrigin = '';
function rememberPublicOrigin(origin) {
  const value = String(origin || '');
  if (!/^https?:\/\/[^/\s]+$/i.test(value)) return;
  let hostname = '';
  try { hostname = new URL(value).hostname.toLowerCase(); } catch (_error) { return; }
  const allowed = hostname === String(DOMAIN || '').toLowerCase()
    || ALLOWED_ORIGINS.some((entry) => entry.toLowerCase() === value.toLowerCase());
  if (!allowed) return;
  learnedPublicOrigin = value;
}
function publicOriginForPeers() {
  return PUBLIC_RELAY_ORIGIN || learnedPublicOrigin || '';
}

function publicRelayUrls(req) {
  const host = req.get('host') || `${req.hostname}:${PORT}`;
  const protocol = forwardedProtocol(req);
  const wsProtocol = protocol === 'https' ? 'wss' : 'ws';
  const hasForwardedProxy = Boolean(req.headers['x-forwarded-proto'] || req.headers['x-forwarded-host']);
  const hostPort = host.match(/:(\d+)$/)?.[1] || '';
  const directSignalPort = !hasForwardedProxy && (!hostPort || hostPort === String(PORT));
  const relayOrigin = PUBLIC_RELAY_ORIGIN || `${protocol}://${host}`;
  const presenceHost = directSignalPort ? hostWithPort(host, PRESENCE_PORT) : host;
  const presenceUrl = PUBLIC_PRESENCE_URL || `${wsProtocol}://${presenceHost}/chat-signal`;
  return { relayOrigin, presenceUrl };
}

const authMiddleware = (req, res, next) => {
  setNoStoreHeaders(res);
  if (isValidMonitorAuth(req)) {
    return next();
  }

  res.status(401).json({ ok: false, reason: 'Invalid credentials' });
};

const configuredVapid = {
  publicKey: process.env.VAPID_PUBLIC_KEY || '',
  privateKey: process.env.VAPID_PRIVATE_KEY || '',
};
/* A VAPID pair identifies this server to the browser vendors' push services.
   Generating one per process meant every restart silently invalidated every
   subscription anyone had made — the endpoint stays valid, the signature no
   longer matches it, and the user is left with a switch that says "on" and a
   device that never rings again. Env wins; otherwise a pair is generated ONCE
   and kept beside the other server state.
   The salt below is what keeps chat fingerprints out of the file at rest: the
   subscription store is indexed by a hash of the fingerprint, so lifting the
   file does not hand anyone a list of who talks to whom. */
const VAPID_STORE_PATH = process.env.CHAT_VAPID_STORE_PATH || path.join(defaultDataDir, 'vapid.json');
function loadOrCreateVapid() {
  if (configuredVapid.publicKey && configuredVapid.privateKey) {
    return { ...configuredVapid, source: 'env', salt: process.env.CHAT_PUSH_SALT || '' };
  }
  try {
    if (fs.existsSync(VAPID_STORE_PATH)) {
      const saved = JSON.parse(fs.readFileSync(VAPID_STORE_PATH, 'utf8'));
      if (saved?.publicKey && saved?.privateKey) return { ...saved, source: 'file' };
    }
  } catch (error) {
    console.warn('Could not read the stored VAPID pair; generating a new one:', error?.message || error);
  }
  const generated = webpush.generateVAPIDKeys();
  const record = { ...generated, salt: crypto.randomBytes(32).toString('hex'), createdAt: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(VAPID_STORE_PATH), { recursive: true });
    fs.writeFileSync(VAPID_STORE_PATH, JSON.stringify(record, null, 2), { mode: 0o600 });
  } catch (error) {
    console.warn('Could not persist the VAPID pair; it will change on restart:', error?.message || error);
  }
  return { ...record, source: 'generated' };
}
const vapidKeys = loadOrCreateVapid();
const PUSH_INDEX_SALT = vapidKeys.salt || process.env.CHAT_PUSH_SALT || 'poorija-push-index';
const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:admin@poorija.local';

webpush.setVapidDetails(vapidSubject, vapidKeys.publicKey, vapidKeys.privateKey);
if (vapidKeys.source === 'generated') {
  console.warn(`VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY were not provided; generated a pair and stored it at ${VAPID_STORE_PATH}.`);
}

/* Push subscriptions are indexed by this, never by the fingerprint itself. */
function pushIndexKey(fingerprint) {
  return crypto.createHmac('sha256', PUSH_INDEX_SALT).update(String(fingerprint || '')).digest('hex');
}
/* What the user is allowed to choose in Settings, and what the server will
   accept — a client asking for ten years does not get ten years. */
const PUSH_TTL_CHOICES = [30, 60, 90, 120, 180];

/* Not everything a client relays is worth keeping, and far less of it is worth
   waking a phone for.
   Typing indicators are the case that made this obvious: they are sent every
   few seconds while someone composes, they were marked persist like everything
   else, and so each one queued a row AND fired a push. Writing one long message
   rang the other person's phone over and over — and when they came back they
   collected a pile of "was typing" envelopes that had stopped being true
   minutes earlier.
   Ephemeral: meaningless once the moment passes. Never stored, never pushed.
   Pushable: something a person would want to be told about. */
const EPHEMERAL_PAYLOADS = new Set([
  'typing', 'receipt', 'ping', 'pong', 'relay-ack', 'call-reaction', 'call-busy',
  /* A call frame that is stored is a call that rings again later, with nothing
     behind it. call-invite stays out of this list on purpose: it is the one that
     is meant to wait for somebody who was away. The group verbs carry the same
     staleness and arrive far more of them — an hour-long group call emitted a
     stored, pushed envelope per reaction per participant, and the offline
     member's mailbox filled with moments that had passed. */
  'call-relay-offer', 'call-relay-answer', 'call-relay-ice', 'call-relay-end',
  'call-ice', 'call-renegotiate', 'call-renegotiate-answer', 'call-accepted', 'call-path-relay',
  'link-relay-offer', 'link-relay-answer', 'link-relay-ice', 'link-relay-end',
  'gcall-here', 'gcall-join', 'gcall-leave', 'gcall-react', 'gcall-state',
  /* A device-sync bundle is a snapshot one machine offers its siblings
     while they are here; it is never stored and never rings anybody. */
  'device-sync',
]);
const PUSHABLE_PAYLOADS = new Set([
  'text', 'rich', 'file-start', 'reaction', 'group', 'space-message', 'space-note',
  'system-note', 'call-invite', 'gcall-invite', 'call-missed', 'call-cancel',
]);
function normalizePushTtlDays(value) {
  const days = Number(value);
  return PUSH_TTL_CHOICES.includes(days) ? days : PUSH_TTL_CHOICES[0];
}

let serverLogs = [];
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
const monitorLoginFailures = new Map();
const MONITOR_LOCK_MAX_ATTEMPTS = 3;
const MONITOR_LOCK_MS = 10 * 60 * 1000;
const POLICY_NOTICE_COOLDOWN_MS = 10 * 60 * 1000;

function addLog(type, args) {
  try {
    const msg = args.map(arg => {
      try {
        return typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
      } catch (e) {
        return '[Unserializable]';
      }
    }).join(' ');
    serverLogs.push({ type, msg, ts: new Date().toISOString() });
    if (serverLogs.length > 200) serverLogs.shift();
  } catch (err) {
    // Fail silently to avoid infinite recursion
  }
}

console.log = (...args) => { originalLog(...args); addLog('info', args); };
console.warn = (...args) => { originalWarn(...args); addLog('warn', args); };
console.error = (...args) => { originalError(...args); addLog('error', args); };

function setNoStoreHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
}

function readCookie(req, name) {
  if (!req.headers.cookie) return '';
  return req.headers.cookie.split(';').reduce((acc, cookie) => {
    const [key, ...value] = cookie.trim().split('=');
    return key === name ? value.join('=') : acc;
  }, '');
}

