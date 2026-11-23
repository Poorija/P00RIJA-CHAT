/* ------------------------------------------------------------------
 * Load-balancer probes
 *
 * /ready is the one a balancer should poll: it answers 503 once this instance
 * is full or is shutting down, which is how a pool stops sending new peers to
 * a node that cannot take them instead of failing their connections. /live
 * only says the process is running, which is what a supervisor wants — a full
 * instance must not be restarted, it is working perfectly.
 * ------------------------------------------------------------------ */
app.get('/ready', (_req, res) => {
  const saturation = WS_MAX_TOTAL > 0 ? wsTotal / WS_MAX_TOTAL : 0;
  const ready = !shuttingDown && saturation < 0.95;
  res.status(ready ? 200 : 503).json({
    ready,
    instance: INSTANCE_ID,
    draining: shuttingDown,
    sockets: wsTotal,
    max: WS_MAX_TOTAL,
    saturation: Number(saturation.toFixed(3)),
  });
});

app.get('/live', (_req, res) => {
  res.json({ live: true, instance: INSTANCE_ID, uptimeSeconds: Math.round(process.uptime()) });
});

/* Who this relay is. Public on purpose: it is a name, the same way a TLS
   certificate is, and a client that cannot read it cannot pin it. Nothing
   private is in the bundle -- publicRelayIdentity builds it from the public
   half alone. */
app.get('/relay-identity', (req, res) => {
  if (sendRestrictionResponse(req, res)) return;
  res.json({ ok: true, ...publicRelayIdentity(relayIdentity) });
});

/* ---- key transparency (roadmap 1.4) ---------------------------------------
   Public on purpose, like the relay's identity: a fingerprint is not a
   secret, and the log holds public keys only. docs/design/1.4-key-transparency.md. */
app.use('/kt', (req, res, next) => {
  if (!KEY_LOG_SERVED) return res.status(404).json({ ok: false, reason: 'no-key-log' });
  return next();
});
app.get('/kt/head', (req, res) => {
  if (sendRestrictionResponse(req, res)) return;
  res.json({ ok: true, head: keyLog.currentHead() });
});
app.get('/kt/proof', (req, res) => {
  if (sendRestrictionResponse(req, res)) return;
  const fp = String(req.query.fp || '');
  if (!isFingerprintKey(fp)) return res.status(400).json({ ok: false, reason: 'bad-fingerprint' });
  res.json({ ok: true, ...keyLog.proofFor(fp) });
});
app.get('/kt/consistency', (req, res) => {
  if (sendRestrictionResponse(req, res)) return;
  const from = Number(req.query.from);
  const to = Number(req.query.to);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || from > to || to > keyLog.size) {
    return res.status(400).json({ ok: false, reason: 'bad-sizes' });
  }
  res.json({ ok: true, from, to, proof: keyLog.consistency(from, to) });
});
/* What this relay holds of the others' logs: their newest signed head each,
   and the evidence for any that signed two that are not one log. */
app.get('/kt/heads', (req, res) => {
  if (sendRestrictionResponse(req, res)) return;
  res.json({ ok: true, self: keyLog.currentHead(), peers: peerKeyHeads.all() });
});

/* A proven v4 account's keys go into the log once. Only v4: an RSA identity
   has no agreement key to bind, and goes away with the legacy window. */
function logProvenKey(record) {
  if (!KEY_LOG_SERVED) return;
  try {
    if (identityV4.keyKind(record.publicKeyData) !== 'v4') return;
    const ak = record.agreeKey && record.agreeKeySig
      && identityV4.verifyAgreeKey({ fp: record.fingerprint, sk: record.publicKeyData, ak: record.agreeKey, akSig: record.agreeKeySig })
      ? { ak: record.agreeKey, akSig: record.agreeKeySig } : { ak: '', akSig: '' };
    if (keyLog.logKey({ fp: record.fingerprint, sk: record.publicKeyData, ...ak }) !== null) announceKeyHead();
  } catch (error) {
    console.warn('[KT] a proven key could not be logged:', error.message);
  }
}
/* The head goes to every linked relay when it changes, at most once a
   minute (the head itself is re-signed no more often). */
let keyHeadAnnounced = '';
let keyHeadTimer = null;
function announceKeyHead() {
  if (keyHeadTimer) return;
  keyHeadTimer = setTimeout(() => {
    keyHeadTimer = null;
    const head = keyLog.currentHead();
    const mark = `${head.size}:${head.root}`;
    if (mark === keyHeadAnnounced) return;
    keyHeadAnnounced = mark;
    for (const id of relayPeers.allowedPeers()) { const link = relayPeers.linkFor(id); if (link) offerKeyHeadTo(link); }
  }, 61 * 1000);
  keyHeadTimer.unref?.();
}
function offerKeyHeadTo(link) {
  if (!KEY_LOG_SERVED) return;
  try { link?.send?.({ kind: 'kt-head', head: keyLog.currentHead() }); } catch (_error) { /* link gone */ }
}
/* Consistency proofs asked of a peer over the link, by size pair. */
const keyConsistencyWaits = new Map();
function askKeyConsistency(link, from, to) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomBytes(8).toString('hex');
    const timer = setTimeout(() => { keyConsistencyWaits.delete(id); reject(new Error('timeout')); }, 15000);
    timer.unref?.();
    keyConsistencyWaits.set(id, { resolve, timer, peerId: link.peerId });
    link.send({ kind: 'kt-consistency', id, from, to });
  });
}
function answerKeyConsistency(payload, link) {
  const from = Number(payload?.from);
  const to = Number(payload?.to);
  const id = String(payload?.id || '').slice(0, 32);
  if (!id || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || from > to || to > keyLog.size) return;
  try { link.send({ kind: 'kt-consistency-answer', id, proof: keyLog.consistency(from, to) }); } catch (_error) { /* link gone */ }
}
function settleKeyConsistency(payload, link) {
  const wait = keyConsistencyWaits.get(String(payload?.id || ''));
  if (!wait || wait.peerId !== link?.peerId) return;
  keyConsistencyWaits.delete(String(payload.id));
  clearTimeout(wait.timer);
  wait.resolve(Array.isArray(payload.proof) ? payload.proof.slice(0, 128).map(String) : []);
}
async function receiveKeyHead(payload, link) {
  const head = payload?.head;
  const key = link?.peerKey;
  if (!head || !key || head.relayId !== link.peerId) return;
  const verdict = await peerKeyHeads.note(head, key, (from, to) => askKeyConsistency(link, from, to));
  if (verdict === 'forked') {
    console.error(`[KT] relay ${formatRelayId(head.relayId)} signed two heads that are not one log; the evidence is kept (/kt/heads).`);
    try {
      queueReport({ level: 'security', category: 'security', title: 'Key transparency: a relay showed two logs', body: `Relay ${formatRelayId(head.relayId)} signed two tree heads that are not one log. Both are kept as evidence at /kt/heads.` });
    } catch (_error) { /* no alert channel */ }
  }
}

/* One credential for one client, for this relay's own coturn. Shared by the
   HTTP endpoint and by the transit question a client on another relay asks
   when a call or transfer needs a TURN both sides can reach. */
function turnCredentialsForClient() {
  if (!TURN_URLS.length) return { enabled: false, urls: [] };
  if (TURN_SECRET) {
    const expiresAt = Math.floor(Date.now() / 1000) + TURN_CREDENTIAL_TTL_SECONDS;
    const username = `${expiresAt}:${crypto.randomBytes(6).toString('hex')}`;
    const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
    return {
      enabled: true, urls: TURN_URLS, username, credential,
      ttl: TURN_CREDENTIAL_TTL_SECONDS, expiresAt: expiresAt * 1000,
    };
  }
  return { enabled: true, urls: TURN_URLS, username: TURN_USERNAME, credential: TURN_CREDENTIAL };
}

app.get('/turn-config', (req, res) => {
  if (sendRestrictionResponse(req, res)) return;
  /* A minted credential is per request; caching one would hand the next
     visitor somebody else's. */
  setNoStoreHeaders(res);
  res.json(turnCredentialsForClient());
});

/* The relays this one is linked with right now, and the key to seal to each.
 *
 * What a client needs to find a contact whose home relay it does not know:
 * it can ask each of these, sealed, whether that fingerprint lives there. An
 * operator's links are not a secret — /chat-health already counts them — and
 * a relay that is not linked is not listed, so nothing here invites a client
 * to send through a carrier that would refuse it. */
/* The other addresses of this relay (CHAT_MIRROR_ORIGINS). Unsigned on
   purpose: a list naming a wrong address costs a client one failed proof,
   because every mirror is checked against this relay's key before use. */
/* A link preview for a client that cannot fetch one itself — the web app and
   the phone apps (scripts/lib/link-preview.js has the checks). The client says
   before the switch is on that the relay sees the link; nothing about the
   request is logged or kept here. CHAT_LINK_PREVIEWS=0 turns it off, and the
   number in flight at once is capped so it cannot tie up the relay. */
const LINK_PREVIEWS_ENABLED = process.env.CHAT_LINK_PREVIEWS !== '0';
const LINK_PREVIEW_MAX_IN_FLIGHT = Number(process.env.CHAT_LINK_PREVIEW_MAX_IN_FLIGHT || 8);
let linkPreviewsInFlight = 0;
app.post('/link-preview', async (req, res) => {
  if (sendRestrictionResponse(req, res)) return;
  setNoStoreHeaders(res);
  if (!LINK_PREVIEWS_ENABLED) return res.status(404).json({ ok: false, reason: 'disabled' });
  if (linkPreviewsInFlight >= LINK_PREVIEW_MAX_IN_FLIGHT) return res.status(503).json({ ok: false, reason: 'busy' });
  const url = String(req.body?.url || '').slice(0, 2048);
  if (!url) return res.status(400).json({ ok: false, reason: 'url-required' });
  linkPreviewsInFlight += 1;
  try {
    const preview = await linkPreview(url);
    return res.json({ ok: true, preview });
  } catch (error) {
    return res.status(422).json({ ok: false, reason: String(error?.message || 'refused').slice(0, 120) });
  } finally {
    linkPreviewsInFlight -= 1;
  }
});

/* The Telegram bot's settings, which the central panel changes while the
   relay runs (scripts/lib/telegram-settings.js): .env gives the defaults,
   what the panel changed is kept beside the data, and so is a token set from
   the panel, owner-only, in a file of its own. */
const telegramSettings = telegramConfig.createTelegramSettings({
  file: process.env.CHAT_TELEGRAM_SETTINGS_PATH || path.join(path.dirname(OFFLINE_STORE_PATH), 'telegram-settings.json'),
  tokenFile: process.env.CHAT_TELEGRAM_TOKEN_PATH || path.join(path.dirname(OFFLINE_STORE_PATH), 'telegram-token'),
  env: process.env,
});
const telegramToken = () => telegramSettings.token();
/* Everything the bot says, in the language the operator chose. */
const botText = () => textFor(telegramSettings.get().language);

/* A Telegram sticker pack from its share link (scripts/lib/telegram-stickers.js
   has the checks). The bot's token lets this relay ask Telegram itself;
   without one, TELEGRAM_STICKERS_UPSTREAM names a relay that can, and the
   question is passed to it — the relay inside a network that cannot reach
   Telegram asks the one outside. Neither set: the endpoint says so, and the
   app explains. Nothing about who asked is logged or kept. */
const TELEGRAM_STICKERS_UPSTREAM = String(process.env.TELEGRAM_STICKERS_UPSTREAM || '').trim();
const telegramStickersAvailable = () => Boolean(telegramToken() || TELEGRAM_STICKERS_UPSTREAM);
const TELEGRAM_MAX_IN_FLIGHT = Number(process.env.CHAT_TELEGRAM_MAX_IN_FLIGHT || 12);
let telegramInFlight = 0;
function telegramFailure(res, error) {
  const reason = String(error?.message || 'refused').slice(0, 60);
  const status = { 'bad-name': 400, 'bad-file': 400, 'pack-not-found': 404, 'pack-empty': 404, 'unknown-file': 409, 'token-refused': 503 }[reason] || 502;
  return res.status(status).json({ ok: false, reason });
}
async function telegramGate(req, res, work) {
  if (sendRestrictionResponse(req, res)) return;
  setNoStoreHeaders(res);
  if (!telegramStickersAvailable()) return res.status(404).json({ ok: false, reason: 'not-configured' });
  if (telegramInFlight >= TELEGRAM_MAX_IN_FLIGHT) return res.status(503).json({ ok: false, reason: 'busy' });
  telegramInFlight += 1;
  try {
    return await work();
  } catch (error) {
    return telegramFailure(res, error);
  } finally {
    telegramInFlight -= 1;
  }
}
app.get('/telegram-stickers/set', (req, res) => telegramGate(req, res, async () => {
  const name = String(req.query.name || '');
  if (!telegramStickers.PACK_NAME.test(name)) throw new Error('bad-name');
  if (telegramToken()) return res.json({ ok: true, pack: await telegramStickers.stickerPack(telegramToken(), name) });
  const answer = await telegramStickers.fromUpstream(TELEGRAM_STICKERS_UPSTREAM, `/telegram-stickers/set?name=${encodeURIComponent(name)}`, telegramStickers.MAX_JSON_BYTES);
  return res.status(answer.status || 502).type('application/json').send(answer.body);
}));
app.get('/telegram-stickers/file', (req, res) => telegramGate(req, res, async () => {
  const id = String(req.query.id || '');
  if (!telegramStickers.FILE_ID.test(id)) throw new Error('bad-file');
  if (telegramToken()) {
    const file = await telegramStickers.stickerFile(telegramToken(), id);
    return res.status(200).type(file.type).send(file.body);
  }
  const answer = await telegramStickers.fromUpstream(TELEGRAM_STICKERS_UPSTREAM, `/telegram-stickers/file?id=${encodeURIComponent(id)}`, telegramStickers.MAX_FILE_BYTES);
  return res.status(answer.status || 502).type(answer.type || 'application/octet-stream').send(answer.body);
}));

/* The relays this one answers for at addresses of its own (CHAT_FRONTS), so a
   client that cannot reach its relay directly can find the door. Public on
   purpose: a client still proves the door leads to the relay it pinned (the
   mirror proof) before sending anything through it. */
app.get('/relay-fronts', (req, res) => {
  if (sendRestrictionResponse(req, res)) return;
  setNoStoreHeaders(res);
  res.json({ ok: true, fronts: frontDoor ? frontDoor.listing() : [] });
});

app.get('/relay-mirrors', (req, res) => {
  if (sendRestrictionResponse(req, res)) return;
  setNoStoreHeaders(res);
  res.json({ ok: true, relayId: relayIdentity.id, origins: MIRROR_ORIGINS });
});

/* Proof that whoever answers at this address holds this relay's private key.
 *
 * The client seals a fresh nonce to the relay key it pinned (the same sealing
 * transit uses) and posts it here; only the holder of the private key can
 * open it and hand the nonce back. That is what lets a client trust a mirror
 * — a different hostname, a CDN, a new certificate — as the relay it already
 * knows, without the relay needing a signing key.
 *
 * The envelope must say it is a proof and carry nothing but a nonce, so this
 * can never be used to open an intercepted transit envelope: anything else is
 * refused without saying what was inside. */
/* The same list, authenticated by this relay's key. The client seals a nonce
   and a one-off secret to the key it pinned; only the key's holder can read
   the secret, and the answer carries an HMAC under it over the list. Whoever
   sits on the path to the main address cannot slip an address of their own
   into what the client keeps. */
app.post('/relay-mirrors', (req, res) => {
  if (sendRestrictionResponse(req, res)) return;
  setNoStoreHeaders(res);
  let inner;
  try {
    inner = openTransit(relayPrivate, relayIdentity.id, req.body?.envelope);
  } catch (_error) {
    res.status(400).json({ ok: false, reason: 'unreadable' });
    return;
  }
  const nonce = String(inner?.nonce || '');
  const secret = String(inner?.k || '');
  if (inner?.purpose !== 'mirrors' || !/^[a-f0-9]{32,64}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(secret)
    || Object.keys(inner).length !== 3) {
    res.status(400).json({ ok: false, reason: 'not-a-request' });
    return;
  }
  const origins = MIRROR_ORIGINS.slice();
  const mac = crypto.createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(`poorija-mirrors-v1|${relayIdentity.id}|${nonce}|${JSON.stringify(origins)}`)
    .digest('hex');
  res.json({ ok: true, relayId: relayIdentity.id, nonce, origins, mac });
});

app.post('/relay-prove', (req, res) => {
  if (sendRestrictionResponse(req, res)) return;
  setNoStoreHeaders(res);
  let inner;
  try {
    inner = openTransit(relayPrivate, relayIdentity.id, req.body?.envelope);
  } catch (_error) {
    res.status(400).json({ ok: false, reason: 'unreadable' });
    return;
  }
  const nonce = String(inner?.nonce || '');
  if (inner?.purpose !== 'prove' || !/^[a-f0-9]{32,64}$/.test(nonce) || Object.keys(inner).length !== 2) {
    res.status(400).json({ ok: false, reason: 'not-a-proof' });
    return;
  }
  res.json({ ok: true, relayId: relayIdentity.id, nonce });
});

app.get('/transit-peers', (req, res) => {
  if (sendRestrictionResponse(req, res)) return;
  setNoStoreHeaders(res);
  const peers = relayPeers.peerEntries()
    .filter((entry) => entry.linked && entry.key)
    /* The first of a "|"-separated list: clients route by id and key, and an
       operator's alternates for the link are the link's business. */
    .map((entry) => ({ id: entry.id, key: entry.key, origin: String(entry.origin || '').split('|')[0] }));
  /* Then the relays of partner families this relay's gateways reach, so the
     app's route discovery asks them too. */
  const listed = new Set(peers.map((peer) => peer.id));
  for (const [id, info] of reachView()) {
    if (listed.has(id) || id === relayIdentity.id || !info.key) continue;
    peers.push({ id, key: info.key, origin: info.origin, via: 'gateway' });
  }
  res.json({ ok: true, self: relayIdentity.id, peers });
});

app.get('/cert-status', (_req, res) => {
  const certPath = process.env.CHAT_TLS_CERT_PATH || '/etc/certs/cert.pem';
  try {
    const pem = fs.readFileSync(certPath);
    const cert = new crypto.X509Certificate(pem);
    const msLeft = new Date(cert.validTo).getTime() - Date.now();
    res.json({
      ok: msLeft > 0,
      subject: cert.subject,
      issuer: cert.issuer,
      validFrom: cert.validFrom,
      validTo: cert.validTo,
      daysLeft: Math.floor(msLeft / 86400000),
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: String((error && error.message) || error) });
  }
});

app.get('/push/vapid-public-key', (_req, res) => {
  res.json({
    enabled: true,
    publicKey: vapidKeys.publicKey,
  });
});



