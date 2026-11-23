/* ------------------------------------------------------------------
 * Store-and-forward retention.
 *
 * Two classes, because they cost the server very different things. Text is a
 * few hundred bytes and is kept until it is delivered, however long that
 * takes — losing someone's message because they were away for a fortnight is
 * not a resource decision anybody would defend. Media is megabytes, so it is
 * held for a week and then dropped, leaving behind only a note saying that
 * something arrived and expired, which is what the recipient is told when they
 * next connect.
 *
 * The relay can only tell the two apart because the sender labels the envelope
 * `class: 'text' | 'media'`. That label, the two fingerprints and the
 * timestamps are the whole of what this feature exposes; the body stays sealed
 * under a key wrapped to the recipient.
 * ------------------------------------------------------------------ */
/* ------------------------------------------------------------------
 * Capacity profile
 *
 * The ceilings below used to be fixed numbers, which means the same relay is
 * simultaneously too generous on a 1 GB VPS — where a full set of mailboxes
 * would exhaust the machine before any limit was reached — and far too mean on
 * a 64 GB box, where it refuses work the hardware would not notice.
 *
 * So they are derived from what the machine actually has, and clamped at both
 * ends: a floor so a tiny instance still works, and a ceiling so a huge one
 * does not promise more than the process can hold. Every value stays
 * overridable by environment variable, which is what the tests and the
 * deployment tooling use.
 *
 * The numbers come from what was measured on this codebase rather than from a
 * rule of thumb: a connected peer costs a socket, a presence record and a
 * heartbeat, which is small, and 1600 of them made no measurable difference to
 * delivery latency (1 ms p95, unchanged from 25 peers). Sockets are therefore
 * budgeted generously against RAM. Mailboxes are the opposite — they are real
 * bytes on disk and in the JSON store — so those are budgeted tightly.
 * ------------------------------------------------------------------ */
function capacityProfile() {
  const cpuCount = Math.max(1, os.cpus()?.length || 1);
  const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
  const clamp = (value, low, high) => Math.max(low, Math.min(high, Math.round(value)));

  /* Tier is only used for reporting and for the coarse decisions below; the
     numbers themselves are continuous, so a machine near a boundary does not
     fall off a cliff. */
  const tier = totalMemMb < 1536 ? 'small'
    : totalMemMb < 6144 ? 'medium'
      : totalMemMb < 24576 ? 'large' : 'xlarge';

  return {
    cpuCount,
    totalMemMb,
    tier,
    /* ~1 socket per 0.35 MB of RAM, floor 500, ceiling 50k. At 1 GB that is
       ~2900; at 64 GB the ceiling bites long before the RAM does. */
    wsMaxTotal: clamp(totalMemMb / 0.35, 500, 50000),
    /* A household behind one NAT is a handful of devices and tabs — but a
       mobile carrier puts thousands of subscribers behind one address
       (CGNAT, the rule on Iranian mobile networks), and each running app
       holds two sockets. The cap exists to stop one machine flooding, which
       the total ceiling, the open-file guard and the frame rate do as well;
       it is generous enough not to turn away the people behind a carrier. */
    wsMaxPerIp: clamp(64 + totalMemMb / 16, 64, 2000),
    /* Mailbox bytes per recipient. Disk, not RAM, but the store is read into
       memory to be rewritten, so RAM is the honest constraint. */
    mediaQuotaBytes: clamp(totalMemMb * 0.35, 128, 4096) * 1024 * 1024,
    /* Requests a minute per address. More cores means more capacity to absorb
       a burst without it costing anyone else. */
    rateDefault: clamp(150 * cpuCount, 150, 3000),
    rateWrite: clamp(30 * cpuCount, 30, 600),
    /* Text entries per mailbox. Cheap, so this stays generous everywhere. */
    textMailboxLimit: clamp(totalMemMb * 4, 1000, 100000),
  };
}

const CAPACITY = capacityProfile();
/* Identifies this process in a pool. Behind a load balancer it is the only way
   to tell which instance answered.
   Deliberately NOT the hostname: this appears in a public health response, and
   an internal machine name is free reconnaissance for anyone mapping the
   deployment. A random handle distinguishes instances just as well. */
const INSTANCE_ID = process.env.CHAT_INSTANCE_ID
  || `relay-${crypto.randomBytes(4).toString('hex')}`;
let shuttingDown = false;

const MEDIA_RETENTION_MS = Number(process.env.CHAT_MEDIA_RETENTION_MS || 7 * 24 * 60 * 60 * 1000);
const MEDIA_QUOTA_BYTES = Number(process.env.CHAT_MEDIA_QUOTA_BYTES || CAPACITY.mediaQuotaBytes);
const EXPIRY_LOG_RETENTION_MS = Number(process.env.CHAT_EXPIRY_LOG_RETENTION_MS || 30 * 24 * 60 * 60 * 1000);
/* A session offer to somebody who is not there is worth holding briefly — long
   enough for them to open the app that evening or the next — but a reservation
   nobody claims is just a stranger's key sitting on a server. */
const SESSION_RESERVATION_MS = Number(process.env.CHAT_SESSION_RESERVATION_MS || 72 * 60 * 60 * 1000);
const RETENTION_SWEEP_MS = Number(process.env.CHAT_RETENTION_SWEEP_MS || 15 * 60 * 1000);
/* Text costs almost nothing, but "unlimited" with no ceiling at all is how a
   relay becomes someone's free storage. This is high enough that a real user
   will never reach it. */
const TEXT_MAILBOX_LIMIT = Number(process.env.CHAT_TEXT_MAILBOX_LIMIT || CAPACITY.textMailboxLimit);
/* And the count alone was not a ceiling a byte could not walk past: a "text"
   envelope is only text because the sender labelled it so, and the label
   exempted it from every byte budget on the server. A single socket could
   queue a hundred thousand envelopes of six megabytes each and call all of
   it text. Text now answers to bytes as well as to count, on the same
   derivation the media quota uses. */
const TEXT_QUOTA_BYTES = Number(process.env.CHAT_TEXT_QUOTA_BYTES || CAPACITY.mediaQuotaBytes);
const EXPIRY_LOG_PATH = process.env.CHAT_EXPIRY_LOG_PATH || path.join(path.dirname(OFFLINE_STORE_PATH), 'expiry-log.json');

const TURN_URL = process.env.CHAT_TURN_URL || `turn:${DOMAIN}:11478?transport=udp,turn:${DOMAIN}:11478?transport=tcp,turns:${DOMAIN}:11349?transport=tcp`;
/* No default worth shipping.
 *
 * This fell back to one deployment's own TURN username, so any relay whose
 * .env did not set TURN_USER handed that name out to every client through
 * /turn-config -- a credential half belonging to somebody else, on somebody
 * else's server, offered to everyone who opened the app.
 *
 * Empty is the honest answer for a relay nobody has configured TURN on. The
 * client already refuses a turn: entry that has no username or no credential
 * and says so, which is better than a name that will fail authentication
 * somewhere the failure reads as "calls do not work". */
const TURN_USERNAME = process.env.CHAT_TURN_USERNAME || process.env.TURN_USER || '';
const TURN_CREDENTIAL = process.env.CHAT_TURN_CREDENTIAL || process.env.TURN_PASSWORD || '';
/* The TURN REST secret coturn shares with this relay (--static-auth-secret).
 *
 * With it, /turn-config stops handing every visitor the one static coturn
 * user — which made both production TURN servers an open relay for anybody
 * who could fetch a JSON file — and mints a credential that expires instead:
 * username "<unix expiry>:<random>", credential base64(HMAC-SHA1(secret,
 * username)), the scheme coturn checks natively. Without a secret the old
 * static pair is served, so a relay that has not been migrated keeps working. */
const TURN_SECRET = process.env.CHAT_TURN_SECRET || process.env.TURN_SECRET || '';
/* Long enough to outlast any call or transfer started near the end of it,
   short enough that a leaked credential is worth little. The client refetches
   well before expiry. */
const TURN_CREDENTIAL_TTL_SECONDS = Math.max(600, Number(process.env.CHAT_TURN_TTL_SECONDS || 12 * 3600));
const PRESENCE_TTL_MS = Number(process.env.CHAT_PRESENCE_TTL_MS || 90000);
/* Two different questions, and answering the second with the first is what
   makes a backgrounded phone look reachable when it is not.
     - is the SOCKET alive?  lastSeenAt, refreshed by the TCP pong, which the
       browser's network stack answers from inside the OS even while the
       page's JavaScript is frozen. Right for connection cleanup.
     - is the APP awake?     lastActiveAt, refreshed only by a frame the page
       itself sent. The client heartbeats every 10s, so a frozen tab stops
       within one interval. This is the one that decides whether a message can
       be delivered live or has to wake the device.
   Two and a half missed heartbeats: long enough that a slow network is not
   mistaken for a frozen app, short enough that the person who backgrounded
   their phone still gets the next message as a notification. */
const APP_AWAKE_TTL_MS = Number(process.env.CHAT_APP_AWAKE_TTL_MS || 25000);
/* A fingerprint arrived as a claim and nothing else, so hello now has to prove
   possession of the identity key behind it before mail is handed over. This
   switch is the escape hatch for a deployment that cannot answer challenges. */
const IDENTITY_PROOF_REQUIRED = process.env.CHAT_IDENTITY_PROOF_REQUIRED !== '0';
const PUBLIC_RELAY_ORIGIN = process.env.CHAT_PUBLIC_RELAY_ORIGIN || '';
const PUBLIC_PRESENCE_URL = process.env.CHAT_PUBLIC_PRESENCE_URL || '';

const CONFIG_PATH = path.join(path.dirname(OFFLINE_STORE_PATH), 'server-config.json');
let MONITOR_PASSWORD = process.env.MONITOR_PASSWORD || '';
const ALLOW_INSECURE_DEFAULTS = process.env.ALLOW_INSECURE_DEFAULTS === '1';
/* Other addresses that reach this same relay — a second domain, a CDN in
   front of it — for a client whose way to the main domain is blocked. The
   client never takes one on trust: it asks the mirror to prove it holds this
   relay's key (POST /relay-prove) before it switches. Listed as origins,
   separated by commas or spaces. A page served from a mirror is a page of
   this deployment, so mirrors are allowed origins too. */
const MIRROR_ORIGINS = Array.from(new Set(String(process.env.CHAT_MIRROR_ORIGINS || '')
  .split(/[\s,]+/)
  .map((entry) => {
    try {
      const url = new URL(entry.trim());
      return (url.protocol === 'https:' || url.protocol === 'http:') ? url.origin : '';
    } catch (_error) { return ''; }
  })
  .filter(Boolean))).slice(0, 8);
const ALLOWED_ORIGINS = (process.env.CHAT_ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)
  .concat(MIRROR_ORIGINS);

/* The monitor password is never written to disk in a form that can be read
 * back. It used to be: server-config.json held the dashboard's rotated
 * password AND a copy of the .env one, both in plain text, so anything that
 * could read the data directory — a backup, a shared volume, a support
 * bundle — held the key to the relay's control panel.
 *
 * Now the file holds a scrypt hash of the rotated password and a SHA-256 of
 * the .env value it was saved against (the stamp only has to answer "did the
 * .env change since?", which an equality test on digests answers). In memory
 * the plain password is kept only when it came from the environment; a
 * rotated one is verified against its hash. */
let MONITOR_PASSWORD_HASH = '';
function scryptHashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function scryptVerify(password, encoded) {
  const parts = String(encoded || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[2], 'base64');
    const expected = Buffer.from(parts[3], 'base64');
    const actual = crypto.scryptSync(String(password ?? ''), salt, expected.length, { N: Number(parts[1]) || 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(actual, expected);
  } catch (_error) {
    return false;
  }
}
function envPasswordStamp(value) {
  return value ? crypto.createHash('sha256').update(`poorija-monitor-env|${value}`).digest('hex') : '';
}
/* A scrypt check costs tens of milliseconds, and HTTP Basic clients send the
   password on every request. The last few successes are remembered by a keyed
   digest for ten minutes, never the password itself. */
const monitorVerifyCache = new Map();
const monitorVerifyKey = crypto.randomBytes(32);
function monitorPasswordMatches(candidate) {
  if (MONITOR_PASSWORD) return secretsMatch(candidate, MONITOR_PASSWORD);
  if (!MONITOR_PASSWORD_HASH) return false;
  const digest = crypto.createHmac('sha256', monitorVerifyKey).update(`${MONITOR_PASSWORD_HASH}|${String(candidate ?? '')}`).digest('hex');
  const remembered = monitorVerifyCache.get(digest);
  if (remembered && Date.now() - remembered < 10 * 60 * 1000) return true;
  const ok = scryptVerify(candidate, MONITOR_PASSWORD_HASH);
  if (ok) {
    monitorVerifyCache.set(digest, Date.now());
    if (monitorVerifyCache.size > 16) monitorVerifyCache.delete(monitorVerifyCache.keys().next().value);
  }
  return ok;
}

function loadServerConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      /* Whose password is newer: the one the dashboard changed to, or the one
         in the environment? The saved rotation wins by default; the env wins
         when it differs from the stamp taken at the save — a changed .env is
         a deliberate override. */
      const env = process.env.MONITOR_PASSWORD || '';
      let migrated = false;
      if (config.monitorPasswordHash) {
        MONITOR_PASSWORD_HASH = String(config.monitorPasswordHash);
        MONITOR_PASSWORD = '';
      } else if (config.monitorPassword) {
        /* A file from before the hash: adopt it, then rewrite it hashed. */
        MONITOR_PASSWORD = String(config.monitorPassword);
        migrated = true;
      }
      const savedStamp = typeof config.monitorPasswordEnvStamp === 'string'
        ? config.monitorPasswordEnvStamp
        : (typeof config.monitorPasswordEnvAtSave === 'string' ? envPasswordStamp(config.monitorPasswordEnvAtSave) : null);
      if (env && envPasswordStamp(env) !== savedStamp) {
        MONITOR_PASSWORD = env;
        MONITOR_PASSWORD_HASH = '';
        migrated = Boolean(config.monitorPassword || config.monitorPasswordEnvAtSave);
      }
      if (migrated || typeof config.monitorPasswordEnvAtSave === 'string') {
        /* Rewritten at once so no plain copy survives the first boot. */
        setTimeout(() => saveServerConfig(), 0);
      }
    }
  } catch (error) {
    console.error('Failed to load server config:', error);
  }
}

function saveServerConfig() {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    const env = process.env.MONITOR_PASSWORD || '';
    /* A password that is the environment's own needs no hash on disk: the
       environment already holds it, and the stamp says it was in force. */
    const fromEnv = Boolean(MONITOR_PASSWORD) && MONITOR_PASSWORD === env;
    if (MONITOR_PASSWORD && !fromEnv) MONITOR_PASSWORD_HASH = scryptHashPassword(MONITOR_PASSWORD);
    writeJsonAtomic(CONFIG_PATH, {
      ...(fromEnv ? {} : { monitorPasswordHash: MONITOR_PASSWORD_HASH }),
      monitorPasswordEnvStamp: envPasswordStamp(env),
    });
  } catch (error) {
    console.error('Failed to save server config:', error);
  }
}

loadServerConfig();

/* A relay started with no monitor password at all — the ready-made Docker
   install leaves it unset — makes a random one rather than run with none (no
   login would ever work) or with a default everyone knows. Only its hash is
   kept; the password itself is shown once, on stdout and in a file only the
   relay's user can read, for the installer to hand to whoever is setting the
   server up. A change from the dashboard removes that file. */
const INITIAL_PASSWORD_PATH = path.join(path.dirname(CONFIG_PATH), 'initial-monitor-password');
function ensureFirstPassword() {
  if (MONITOR_PASSWORD || MONITOR_PASSWORD_HASH) return;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let password = '';
  for (let i = 0; i < 20; i += 1) password += alphabet[crypto.randomInt(alphabet.length)];
  MONITOR_PASSWORD = password;
  saveServerConfig();
  try {
    fs.writeFileSync(INITIAL_PASSWORD_PATH, `${password}\n`, { mode: 0o600 });
    fs.chmodSync(INITIAL_PASSWORD_PATH, 0o600);
  } catch (error) {
    console.error('Failed to write the first monitor password file:', error.message);
  }
  const user = process.env.MONITOR_USER || 'admin';
  console.log([
    '',
    '================================================================',
    `  Monitor user: ${user}`,
    `  Monitor password (first start): ${password}`,
    '  Shown once. Change it in the dashboard: /Monitor_Server',
    '================================================================',
    '',
  ].join('\n'));
}
ensureFirstPassword();

/* Everything this relay keeps on disk is either a secret or somebody's queued
   ciphertext, and none of it should be world-readable. New files are created
   0600 by writeJsonAtomic, but a relay upgraded in place still has the 0644
   files an older build wrote — including server-config.json, which holds the
   monitor password in the clear. One pass at startup brings them into line.
   Failures are ignored on purpose: a filesystem without Unix modes (a bind
   mount from Windows, some container overlays) is not a reason to refuse to
   start. */
function hardenStateFilePermissions(directory, depth = 0) {
  if (depth > 2) return;
  let entries = [];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_error) { return; }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    try {
      if (entry.isDirectory()) {
        fs.chmodSync(full, 0o700);
        hardenStateFilePermissions(full, depth + 1);
      } else if (entry.isFile()) {
        fs.chmodSync(full, 0o600);
      }
    } catch (_error) { /* no modes here, or not ours to change */ }
  }
}
try {
  fs.mkdirSync(path.dirname(OFFLINE_STORE_PATH), { recursive: true });
  fs.chmodSync(path.dirname(OFFLINE_STORE_PATH), 0o700);
  hardenStateFilePermissions(path.dirname(OFFLINE_STORE_PATH));
} catch (_error) { /* see above */ }

/* The monitor is the control panel for this server: it reads the mailbox
 * counters, changes retention, disconnects clients and rotates its own
 * password. Starting it behind a compiled-in "admin123456" whenever the
 * environment forgot to set one is a door that opens by default on a service
 * whose whole job is to be reachable from the internet — and a warning printed
 * to a log nobody reads is not a lock.
 *
 * ALLOW_INSECURE_DEFAULTS was already declared for exactly this and then never
 * consulted, so the fallback applied unconditionally. It is consulted now:
 * without a real password this refuses to start, and the escape hatch has to be
 * asked for out loud.
 */
if (!MONITOR_PASSWORD_HASH && (!MONITOR_PASSWORD || MONITOR_PASSWORD.length < 12)) {
  if (ALLOW_INSECURE_DEFAULTS) {
    console.warn('WARNING: MONITOR_PASSWORD is short or unset and ALLOW_INSECURE_DEFAULTS=1.');
    console.warn('WARNING: falling back to "admin123456". Do not do this on a reachable host.');
    if (!MONITOR_PASSWORD) MONITOR_PASSWORD = 'admin123456';
  } else {
    console.error('MONITOR_PASSWORD is missing or shorter than 12 characters.');
    console.error('The monitor controls this relay, so it will not start without one.');
    console.error('Set MONITOR_PASSWORD in .env, or set ALLOW_INSECURE_DEFAULTS=1 to accept the risk.');
    process.exit(1);
  }
}

const app = express();
const server = http.createServer(app);
const presenceServer = http.createServer();
/* Socket-level failures (reset peers, TLS handshakes that die mid-frame)
   surface as 'error' events on the server object, and an unhandled one takes
   the process down — the per-socket handlers below never see them. */
server.on('error', (error) => console.error('[HTTP] Signal server error:', error));
presenceServer.on('error', (error) => console.error('[HTTP] Presence server error:', error));

/* How many reverse proxies actually stand in front of this process.
 *
 * `trust proxy: true` trusted the WHOLE X-Forwarded-For chain, which means it
 * trusted whatever the client wrote there: req.ip became the leftmost entry,
 * and the leftmost entry is the attacker's to choose. Every defence keyed on
 * it — the three-strike monitor lockout, every rate-limit bucket — was
 * therefore one header away from being switched off. Proved with twelve
 * /admin/login guesses that never once tripped the lockout because each
 * carried a different X-Forwarded-For.
 *
 * A COUNT instead of `true` makes Express walk in from the right and stop
 * after the hops we actually deploy, so the value it lands on is the one our
 * own nginx wrote. Set CHAT_TRUSTED_PROXIES to the real number if a CDN or a
 * second load balancer is added; 0 means this process is directly exposed. */
const TRUSTED_PROXY_HOPS = Math.max(0, Number(process.env.CHAT_TRUSTED_PROXIES ?? 1) || 0);
app.set('trust proxy', TRUSTED_PROXY_HOPS);

/* The address a security decision is allowed to use.
 *
 * requestIp() below stays as it is and stays where it is: the monitor shows
 * operators who is connected, and for THAT a CDN header is better information
 * than a proxy's address. But it consults cf-connecting-ip, true-client-ip,
 * x-real-ip and x-client-ip — four headers nginx neither sets nor strips — so
 * it must never decide whether somebody is rate-limited or locked out.
 *
 * This one consults nothing a client can write. Express has already applied
 * the hop count above; if the chain is shorter than the hop count (a request
 * that did not come through our proxy at all) req.ip falls back to the socket,
 * which is exactly right. */
function securityKey(req) {
  const direct = normalizeIpValue(req?.socket?.remoteAddress || '');
  /* No proxy in front: the socket is the only honest answer and every header
     is noise. Operators who expose this process directly set
     CHAT_TRUSTED_PROXIES=0 and nothing below can be talked into anything. */
  if (TRUSTED_PROXY_HOPS === 0) return String(direct || 'unknown');
  /* A request that reached this process from a public address did not come
     through our own reverse proxy, whatever its headers claim. */
  if (direct && isPublicIp(direct)) return String(direct);

  /* Behind the proxy, count from the RIGHT and never from the left.
   *
   * nginx writes `X-Forwarded-For: <whatever the client sent>, <the address
   * nginx saw>` — so the rightmost entry is the only one our own
   * infrastructure vouches for, and everything to its left is the client's to
   * invent. req.ip is not used here: Express walks in from the socket, which
   * lands on an attacker-supplied entry the moment the real chain is shorter
   * than expected, and that is precisely the bypass this replaces. */
  const chain = String(req?.headers?.['x-forwarded-for'] || '')
    .split(',').map((part) => normalizeIpValue(part.trim())).filter(Boolean);
  if (chain.length < TRUSTED_PROXY_HOPS) return String(direct || 'unknown');
  return String(chain[chain.length - TRUSTED_PROXY_HOPS] || direct || 'unknown');
}

app.use('/vendor', express.static(path.join(__dirname, 'vendor')));
app.use('/vendor', express.static(path.join(__dirname, '..', 'vendor')));
app.use('/fonts', express.static(path.join(__dirname, '..', 'fonts')));
app.use('/assets', express.static(path.join(__dirname, '..', 'assets')));
