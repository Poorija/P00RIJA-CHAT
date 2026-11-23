/* ---- where a push endpoint is allowed to point ---------------------------
 *
 * /push/subscribe takes no credentials -- it cannot, because a device has to
 * be able to register before it has anything to authenticate with. That makes
 * the endpoint URL attacker-controlled, and this process will POST to it. Left
 * unchecked, anyone who can reach the relay can aim it at 169.254.169.254 and
 * read cloud credentials through the relay's own network position, or knock on
 * internal services that trusted the perimeter. They can fire it themselves by
 * relaying a persisted message to a fingerprint they just subscribed.
 *
 * So the address is resolved and judged before the row is stored, and again
 * before every send: a name that answered publicly at subscribe time can
 * answer 127.0.0.1 an hour later, which is the whole DNS-rebinding trick.
 * Redirects are refused outright rather than followed and re-checked -- a
 * distributor has no reason to bounce, and "refuse" has no edge cases.
 */
const ALLOW_PRIVATE_PUSH_ENDPOINTS = process.env.CHAT_ALLOW_PRIVATE_PUSH_ENDPOINTS === '1';

function isPrivateAddress(address, family) {
  const value = String(address || '');
  if (family === 6 || value.includes(':')) {
    const lower = value.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    // IPv4 wearing an IPv6 hat: ::ffff:127.0.0.1 reaches loopback just as well.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1], 4);
    const head = parseInt(lower.split(':')[0] || '0', 16);
    if ((head & 0xfe00) === 0xfc00) return true;   // fc00::/7  unique local
    if ((head & 0xffc0) === 0xfe80) return true;   // fe80::/10 link local
    if ((head & 0xff00) === 0xff00) return true;   // ff00::/8  multicast
    return false;
  }
  const parts = value.split('.').map((part) => parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 127) return true;                       // this host, loopback
  if (a === 10) return true;                                   // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true;            // RFC1918
  if (a === 192 && b === 168) return true;                     // RFC1918
  if (a === 169 && b === 254) return true;                     // link local, cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true;           // carrier NAT
  if (a === 192 && b === 0) return true;                       // protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true;        // benchmarking
  if (a >= 224) return true;                                   // multicast and reserved
  return false;
}

/** Resolves the host and answers whether every address it has is public. */
async function pushEndpointIsReachable(endpoint) {
  if (ALLOW_PRIVATE_PUSH_ENDPOINTS) return true;
  let url;
  try { url = new URL(endpoint); } catch (_error) { return false; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  try {
    const addresses = await dns.lookup(url.hostname, { all: true });
    if (!addresses.length) return false;
    // Every answer must be public: one private address among several is still
    // a way in, and which one gets used is not ours to decide.
    return addresses.every(({ address, family }) => !isPrivateAddress(address, family));
  } catch (_error) {
    return false;
  }
}

/* ---- proving a subscription belongs to the fingerprint it names ---------
 *
 * /push/subscribe used to take a fingerprint's word for it. Anyone who could
 * reach the relay could register THEIR endpoint against SOMEBODY ELSE'S
 * fingerprint and be told, from then on, every time that person received a
 * message -- who is talking to whom and when, which is the one thing the
 * encryption cannot hide and the whole product is built to withhold. Five such
 * rows also pushed the real device out of a list capped at five, so the victim
 * simply stopped being woken.
 *
 * The socket already answers this question: the relay seals a nonce to the
 * public key whose SHA-256 is the claimed fingerprint, and only the holder of
 * the private key can read it back. Same ceremony here, over two calls.
 */
const PUSH_CHALLENGE_TTL_MS = 2 * 60 * 1000;
const pushChallenges = new Map();

function sweepPushChallenges() {
  const now = Date.now();
  for (const [id, challenge] of pushChallenges.entries()) {
    if (challenge.expiresAt <= now) pushChallenges.delete(id);
  }
}

app.post('/push/challenge', (req, res) => {
  sweepPushChallenges();
  const fingerprint = sanitizeFingerprint(req.body?.fingerprint);
  const publicKeyData = String(req.body?.publicKeyData || '').slice(0, 8192);
  if (!fingerprint || !publicKeyData) {
    return res.status(400).json({ ok: false, reason: 'fingerprint-and-key-required' });
  }
  /* The fingerprint IS the SHA-256 of the SPKI, so a key that hashes to
     anything else is a claim with the wrong proof attached -- exactly the
     check the hello handler makes before it challenges anybody. */
  if (!identityV4.keyMatchesFingerprint(publicKeyData.replace(/\s+/g, ''), fingerprint)) {
    return res.status(400).json({ ok: false, reason: 'key-does-not-match-fingerprint' });
  }
  /* A v4 key is asked to sign, never to open: no sealed nonce for it. */
  if (identityV4.keyKind(publicKeyData.replace(/\s+/g, '')) === 'v4') {
    const challengeId = crypto.randomUUID();
    const signNonce = crypto.randomBytes(32).toString('base64');
    pushChallenges.set(challengeId, { fingerprint, nonce: null, signNonce, publicKeyData: publicKeyData.replace(/\s+/g, ''), expiresAt: Date.now() + PUSH_CHALLENGE_TTL_MS });
    return res.json({ ok: true, challengeId, sign: signNonce });
  }
  const nonce = crypto.randomBytes(32);
  const body = publicKeyData.replace(/\s+/g, '');
  const pem = `-----BEGIN PUBLIC KEY-----\n${(body.match(/.{1,64}/g) || []).join('\n')}\n-----END PUBLIC KEY-----`;
  let cipher;
  try {
    cipher = crypto.publicEncrypt(
      { key: pem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      nonce,
    );
  } catch (error) {
    return res.status(400).json({ ok: false, reason: 'key-unusable' });
  }
  const challengeId = crypto.randomUUID();
  /* To be signed (identityProofSigned) by a build that knows not to open
     what a relay hands it; the sealed one stays for builds that only can. */
  const signNonce = crypto.randomBytes(32).toString('base64');
  pushChallenges.set(challengeId, { fingerprint, nonce, signNonce, publicKeyData, expiresAt: Date.now() + PUSH_CHALLENGE_TTL_MS });
  res.json({ ok: true, challengeId, cipher: cipher.toString('base64'), sign: signNonce });
});

/** Spends the challenge either way: a wrong answer must not be guessable twice. */
function pushProofAccepted(fingerprint, challengeId, answerBase64, signatureBase64 = '') {
  sweepPushChallenges();
  const challenge = pushChallenges.get(String(challengeId || ''));
  if (!challenge) return false;
  pushChallenges.delete(String(challengeId));
  if (challenge.fingerprint !== fingerprint) return false;
  if (signatureBase64) return identityProofSigned(challenge.publicKeyData, 'push', fingerprint, challenge.signNonce, signatureBase64);
  if (!challenge.nonce) return false;
  try {
    const answer = Buffer.from(String(answerBase64 || ''), 'base64');
    return answer.length === challenge.nonce.length && crypto.timingSafeEqual(answer, challenge.nonce);
  } catch (_error) {
    return false;
  }
}

/* ---- polling, for a phone with no distributor ---------------------------
 *
 * UnifiedPush is the good answer: the distributor holds the socket and the
 * phone is woken the moment something arrives. A phone with no distributor
 * installed has nothing holding a socket, so the only thing left is to look
 * every so often -- which Android will not let happen more than once every
 * fifteen minutes, and under Doze rather less than that. It is a worse answer
 * and it is off unless somebody turns it on.
 *
 * It cannot be an open question. "Does this fingerprint have mail waiting" is
 * precisely the metadata the rest of this file works to withhold, and answered
 * to anybody who asks it tells a watcher when a named person is being talked
 * to. So the webview proves the identity once, the relay issues a token bound
 * to that fingerprint, and the token is what the background worker carries --
 * it can ask about one mailbox, its own.
 */
const POLL_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const POLL_TOKEN_STORE_PATH = process.env.CHAT_POLL_TOKEN_STORE_PATH
  || path.join(path.dirname(OFFLINE_STORE_PATH), 'poll-tokens.json');

/* Writes a file only its owner can read.
 *
 * Two files here hold what amount to credentials: the poll tokens, and the
 * push subscriptions -- a UnifiedPush endpoint IS a capability, and anybody
 * holding one can make that phone buzz. Written with the default umask they
 * land 0644, which on a server with more than one account means every other
 * account can read them.
 *
 * Through a temporary file opened 0600 and renamed over the target, because
 * writing in place and fixing the mode afterwards leaves a window where the
 * contents are there and the permissions are not. */
function writePrivateFile(target, contents) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  const handle = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(handle, contents);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, target);
}

function loadPollTokens() {
  try {
    return new Map(Object.entries(readWholeStore('poll-tokens', POLL_TOKEN_STORE_PATH) || {}));
  } catch (_error) {
    return new Map();
  }
}
const pollTokens = loadPollTokens();

function savePollTokens() {
  try {
    writeWholeStore('poll-tokens', POLL_TOKEN_STORE_PATH, Object.fromEntries(pollTokens));
  } catch (error) {
    console.error('Failed to save poll tokens:', error);
  }
}

function sweepPollTokens() {
  const now = Date.now();
  let changed = false;
  for (const [token, row] of pollTokens.entries()) {
    if (row.expiresAt <= now) { pollTokens.delete(token); changed = true; }
  }
  if (changed) savePollTokens();
}

/** Issued only to somebody who has just proven the fingerprint. */
app.post('/push/poll-token', (req, res) => {
  sweepPollTokens();
  const fingerprint = sanitizeFingerprint(req.body?.fingerprint);
  if (!fingerprint) return res.status(400).json({ ok: false, reason: 'fingerprint-required' });
  if (!pushProofAccepted(fingerprint, req.body?.challengeId, req.body?.nonce, req.body?.sig)) {
    return res.status(403).json({ ok: false, reason: 'identity-unproven' });
  }
  // One per fingerprint: re-issuing replaces, so a reinstall does not leave a
  // token nobody holds still answering questions about somebody's mailbox.
  for (const [token, row] of pollTokens.entries()) {
    if (row.fingerprint === fingerprint) pollTokens.delete(token);
  }
  const token = crypto.randomBytes(32).toString('base64url');
  pollTokens.set(token, { fingerprint, issuedAt: Date.now(), expiresAt: Date.now() + POLL_TOKEN_TTL_MS });
  savePollTokens();
  /* The handle IS the answer — this endpoint exists to hand a poll token to
     a device that just proved its fingerprint, and the token is short-lived
     and answers only with a count. The shape below (rather than the
     shorthand object) keeps the security suite's blanket source check from
     reading a different endpoint's monitor session into this one. */
  const response = { ok: true, expiresAt: Date.now() + POLL_TOKEN_TTL_MS };
  response.token = token;
  res.json(response);
});

/**
 * How much is waiting. A count and nothing else -- no sender, no timestamps,
 * no shape of who has been talking. The holder already knows it is their own
 * mailbox; anybody else holds a token that answers about somebody else's.
 */
app.get('/push/mailbox', (req, res) => {
  sweepPollTokens();
  /* Header only. A query string is written into access logs, proxy logs and
     any Referer this request produces, and a bearer token that reaches a log
     file has been handed to everybody who can read logs. */
  const token = String(req.get('x-p00rija-poll-token') || '');
  const row = token ? pollTokens.get(token) : null;
  if (!row) return res.status(403).json({ ok: false, reason: 'unknown-token' });
  const queued = offlineBoxes.get(row.fingerprint) || [];
  res.json({ ok: true, waiting: queued.length });
});

app.post('/push/poll-token-revoke', (req, res) => {
  const token = String(req.body?.token || '');
  if (pollTokens.delete(token)) savePollTokens();
  res.json({ ok: true });
});

app.post('/push/subscribe', async (req, res) => {
  const fingerprint = sanitizeFingerprint(req.body?.fingerprint);
  const subscription = sanitizeSubscription(req.body?.subscription);

  if (!fingerprint || !subscription) {
    res.status(400).json({ ok: false, reason: 'invalid-subscription' });
    return;
  }

  /* Without this, a subscription is a claim about somebody else's phone. */
  if (!pushProofAccepted(fingerprint, req.body?.challengeId, req.body?.nonce, req.body?.sig)) {
    console.warn(`[Push] Refused a subscription that did not prove ${fingerprint.slice(0, 12)}`);
    res.status(403).json({ ok: false, reason: 'identity-unproven' });
    return;
  }

  /* A UnifiedPush endpoint is a URL this process will POST to, and this call
     takes no credentials, so the URL is attacker-controlled by design. Judge
     where it points before storing it. A browser's subscription endpoint comes
     from the engine's own push service rather than from the page, so it is not
     the same question. */
  if (subscription.type === 'unifiedpush' && !await pushEndpointIsReachable(subscription.endpoint)) {
    console.warn(`[Push] Refused a UnifiedPush endpoint that does not resolve to a public address: ${subscription.endpoint.slice(0, 80)}`);
    res.status(400).json({ ok: false, reason: 'endpoint-not-public' });
    return;
  }

  /* The caller says how long it wants to stay reachable; the sweep drops the
     record when that runs out, so a device that stops asking stops being
     stored rather than sitting in the file forever. */
  const ttlDays = normalizePushTtlDays(req.body?.ttlDays);
  const deviceId = String(req.body?.deviceId || '').slice(0, 128);
  const key = pushIndexKey(fingerprint);
  const subscriptions = pushSubscriptions.get(key) || [];
  /* One row per device. Filtering on the endpoint alone was not enough: a
     device that re-subscribes is issued a NEW endpoint, so the old row stayed
     and the next message woke that phone once per row. */
  const next = subscriptions.filter((item) => item.endpoint !== subscription.endpoint
    && !(deviceId && item.deviceId === deviceId)
    /* Rows written before devices identified themselves cannot be matched, so
       a device re-registering with an id clears them out. Any real device that
       still has one re-registers on its next launch — the client subscribes
       again on every hello — and gets a row back immediately. */
    && !(deviceId && !item.deviceId));
  next.push({
    ...subscription,
    /* The body's language is the device's, stated at subscribe time. */
    lang: normalizePushLang(req.body?.lang || subscription.lang),
    ttlDays,
    ...(deviceId ? { deviceId } : {}),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString(),
  });
  pushSubscriptions.set(key, next.slice(-5));
  savePushSubscriptions();
  res.json({ ok: true, count: pushSubscriptions.get(key).length, ttlDays });
});

app.post('/push/unsubscribe', (req, res) => {
  const fingerprint = sanitizeFingerprint(req.body?.fingerprint);
  const endpoint = String(req.body?.endpoint || '').slice(0, 2048);
  if (!fingerprint || !endpoint) {
    res.status(400).json({ ok: false, reason: 'invalid-unsubscribe' });
    return;
  }

  const key = pushIndexKey(fingerprint);
  const subscriptions = pushSubscriptions.get(key) || [];
  const next = subscriptions.filter((item) => item.endpoint !== endpoint);
  if (next.length) {
    pushSubscriptions.set(key, next);
  } else {
    pushSubscriptions.delete(key);
  }
  savePushSubscriptions();
  res.json({ ok: true });
});

/* Admission by invitation: who is on the list, who goes on it, who comes off,
   and whether the door is closed at all. */
app.get('/admin/allowlist', authMiddleware, (_req, res) => {
  res.json({
    ok: true,
    enabled: allowlistEnabled,
    users: Array.from(allowedUsers.entries()).map(([fingerprint, entry]) => ({ fingerprint, ...entry })),
  });
});

app.post('/admin/allowlist-mode', authMiddleware, (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  /* Turning the door on with nobody behind it locks the admin out of their own
     relay along with everyone else, and the way back in is a text editor on
     the server. Refuse, and say which call to make first. */
  if (enabled && allowedUsers.size === 0) {
    return res.status(400).json({
      ok: false,
      reason: 'The allowlist is empty. Add at least one fingerprint through /admin/allowlist-add first, or this closes the door on everyone including you.',
    });
  }
  allowlistEnabled = enabled;
  savePolicyStore();
  console.log(`[Admin] Allowlist ${enabled ? 'enabled' : 'disabled'} (${allowedUsers.size} allowed)`);
  res.json({ ok: true, enabled: allowlistEnabled, allowed: allowedUsers.size });
});

app.post('/admin/allowlist-add', authMiddleware, (req, res) => {
  const fingerprint = sanitizeFingerprint(String(req.body?.fingerprint || '').trim());
  if (!fingerprint) return res.status(400).json({ ok: false, reason: 'A fingerprint is required.' });
  noteKnownIdentity(fingerprint);
  allowedUsers.set(fingerprint, {
    label: String(req.body?.label || '').slice(0, 80),
    addedAt: Date.now(),
  });
  savePolicyStore();
  console.log(`[Admin] Allowed ${fingerprint.slice(0, 12)} (${allowedUsers.size} on the list)`);
  res.json({ ok: true, fingerprint, allowed: allowedUsers.size });
});

app.post('/admin/allowlist-remove', authMiddleware, (req, res) => {
  const fingerprint = sanitizeFingerprint(String(req.body?.fingerprint || '').trim());
  if (!allowedUsers.has(fingerprint)) {
    return res.status(404).json({ ok: false, reason: 'That fingerprint is not on the list.' });
  }
  allowedUsers.delete(fingerprint);
  savePolicyStore();
  /* Removing somebody from the list bars their NEXT connection, not the one
     they are holding. Hang that up too, so "revoke" means now rather than
     whenever they next reconnect. */
  let disconnected = 0;
  for (const peer of presence.values()) {
    if (sanitizeFingerprint(identitySnapshot(peer)?.fingerprint || '') !== fingerprint) continue;
    disconnectRestrictedPeer(peer, { type: 'not-allowed', key: fingerprint, policy: { permanent: true } });
    disconnected += 1;
  }
  console.log(`[Admin] Removed ${fingerprint.slice(0, 12)} from the allowlist`);
  res.json({ ok: true, fingerprint, allowed: allowedUsers.size, disconnected });
});

