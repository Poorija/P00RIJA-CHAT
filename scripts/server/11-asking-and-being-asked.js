/* ---- asking, and being asked -------------------------------------------- */

function cleanPartnerOrigin(value) {
  try {
    const url = new URL(String(value || '').trim());
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return '';
    return url.origin;
  } catch (_error) { return ''; }
}
/* Another family's directory, read from any of its relays. Believed only
   as far as its own operator's signature goes: it says who that family is,
   not that anybody here trusts it. */
async function fetchFamilyDirectory(origin) {
  const doc = await partnerFetchJson(origin, '/relay-directory');
  if (!doc) return { ok: false, reason: 'no-directory' };
  const verdict = verifyDirectory(doc, { operatorKey: String(doc?.body?.operator?.key || ''), selfId: doc?.body?.relays?.[0]?.id });
  return verdict.ok ? { ok: true, doc } : { ok: false, reason: 'bad-directory' };
}
const ownOperatorId = () => directoryState.doc?.body.operator.id || '';

const joinNonces = new Map();
const joinCounts = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [nonce, until] of joinNonces) if (until <= now) joinNonces.delete(nonce);
  for (const [key, entry] of joinCounts) if (entry.resetAt <= now) joinCounts.delete(key);
}, 60000).unref?.();

app.post('/relay-join', (req, res) => {
  setNoStoreHeaders(res);
  const now = Date.now();
  const key = securityKey(req);
  let count = joinCounts.get(key);
  if (!count || count.resetAt <= now) {
    count = { count: 0, resetAt: now + 3600000 };
    joinCounts.set(key, count);
  }
  count.count += 1;
  if (count.count > JOIN_PER_HOUR) return res.status(429).json({ ok: false, reason: 'rate-limited' });
  if (!OPERATOR_KEY || !directoryState.doc || !ownGatewaySet().length) return res.status(409).json({ ok: false, reason: 'not-accepting' });
  const verdict = partnerRules.verifyJoinRequest(req.body, {
    selfOperatorId: ownOperatorId(),
    now,
    nonceSeen: (nonce) => (joinNonces.get(nonce) || 0) > now,
  });
  if (!verdict.ok) return res.status(400).json({ ok: false, reason: verdict.reason });
  joinNonces.set(req.body.nonce, now + 3600000);
  const operatorId = verdict.operatorId;
  if (operatorId === ownOperatorId()) return res.status(400).json({ ok: false, reason: 'own-family' });
  const requestId = crypto.randomBytes(16).toString('hex');
  const contact = cleanPartnerOrigin(req.body.contact);
  const current = partnerState.entries[operatorId];
  /* A directory this relay already holds for that family is never rolled
     back by a request carrying an older one, and a relay the newer one no
     longer names (revoked, or dropped) cannot ask with the old. */
  let directory = verdict.directory;
  const held = current?.directory?.body;
  if (held) {
    if (current.operatorKey && current.operatorKey !== verdict.operatorKey) return res.status(400).json({ ok: false, reason: 'wrong-operator' });
    if (directory.body.serial <= held.serial) {
      const stillMember = held.relays.some((relay) => relay.id === req.body.from) && !(held.revoked || []).includes(req.body.from);
      if (!stillMember) return res.status(400).json({ ok: false, reason: 'not-a-member' });
      directory = current.directory;
    }
  }
  const about = { operatorKey: verdict.operatorKey, name: verdict.name, directory, contact, requestId };
  if (current?.state === 'rejected' && (current.mutedUntil || 0) > now) {
    changePartner(operatorId, { requestId, contact });
    return res.status(202).json({ ok: true, requestId, state: 'rejected' });
  }
  if (current?.state === 'approved') {
    changePartner(operatorId, about);
    return res.status(202).json({ ok: true, requestId, state: 'approved' });
  }
  /* Both admins asked: both already said yes. */
  if (current?.state === 'requested') {
    changePartner(operatorId, { ...about, state: 'approved' }, 'approved: both asked');
    return res.status(202).json({ ok: true, requestId, state: 'approved' });
  }
  if (current?.state === 'incoming') {
    changePartner(operatorId, about);
    return res.status(202).json({ ok: true, requestId, state: 'incoming' });
  }
  const waiting = Object.values(partnerState.entries).filter((entry) => entry.state === 'incoming').length;
  if (waiting >= JOIN_WAITING_MAX) return res.status(409).json({ ok: false, reason: 'too-many-waiting' });
  changePartner(operatorId, { ...about, state: 'incoming', since: now, mutedUntil: 0 }, 'asks to link');
  const host = contactHost(contact);
  partnerNotice('درخواست اتصال از اپراتوری دیگر', `اپراتور «${verdict.name || operatorId.slice(0, 12)}» (${operatorId.slice(0, 12)}…)${host ? ` از ${host}` : ''}. در پنل مدیریت، «رله‌ها ← اپراتورهای دیگر»، تأیید یا رد کنید.`);
  return res.status(202).json({ ok: true, requestId, state: 'incoming' });
});

/* All the asker learns: waiting, approved or rejected. */
app.get('/relay-join/:requestId', (req, res) => {
  setNoStoreHeaders(res);
  const requestId = String(req.params.requestId || '');
  const entry = /^[a-f0-9]{32}$/.test(requestId) ? Object.values(partnerState.entries).find((candidate) => candidate.requestId === requestId) : null;
  if (!entry) return res.status(404).json({ ok: false });
  const state = entry.state === 'incoming' ? 'waiting' : (entry.state === 'approved' ? 'approved' : 'rejected');
  res.json({ ok: true, state });
});

function partnerSummary() {
  return Object.values(partnerState.entries).map((entry) => {
    const owned = (entry.directory?.body?.relays || []).filter((relay) => partnerIndex.get(relay.id) === entry.operatorId);
    return {
      operatorId: entry.operatorId,
      name: String(entry.name || ''),
      state: entry.state,
      contact: entry.contact || '',
      serial: entry.directory?.body?.serial || 0,
      relays: owned.length,
      relayIds: owned.map((relay) => relay.id.slice(0, 16)),
      gateways: partnerGatewaysOf(entry).map((gateway) => ({
        id: gateway.id.slice(0, 16),
        name: String(owned.find((relay) => relay.id === gateway.id)?.name || ''),
        priority: gateway.priority,
        linked: Boolean(relayPeers.linkFor(gateway.id)),
      })),
      carrying: carryingFor(entry.operatorId).slice(0, 16),
      path: pathFor(entry.operatorId),
      since: entry.since || 0,
      updatedAt: entry.updatedAt || 0,
    };
  });
}
/* The next relay traffic for that partner leaves by: one of their gateways
   on a gateway, one of ours elsewhere. */
function pathFor(operatorId) {
  if (!selfIsGateway()) return '';
  const route = routeToPartner(operatorId);
  if (!route) return '';
  return route.path === 'direct' ? 'direct' : `via:${route.path.slice(4, 20)}`;
}
function carryingFor(operatorId) {
  if (selfIsGateway()) return routeToPartner(operatorId)?.id || '';
  const reporters = new Set();
  for (const info of reachView().values()) if (info.operatorId === operatorId) for (const id of info.gateways) reporters.add(id);
  return bestOwnGateway(reporters) || '';
}

app.post('/Monitor_Server/partners', authMiddleware, (req, res) => {
  const body = directoryState.doc?.body;
  res.json({
    ok: true,
    self: {
      operatorId: body?.operator.id || '',
      name: String(body?.operator.name || ''),
      gateway: selfIsGateway(),
      chosenInDashboard: Array.isArray(partnerState.override?.gateways),
      carryBetween: carriesBetween(),
      gateways: ownGatewaySet().map((gateway) => ({
        id: gateway.id.slice(0, 16),
        name: String(body?.relays.find((relay) => relay.id === gateway.id)?.name || ''),
        priority: gateway.priority,
      })),
    },
    partners: partnerSummary(),
  });
});

app.post('/Monitor_Server/partners/lookup', authMiddleware, async (req, res) => {
  const origin = partnerOrigin(req.body?.origin);
  if (!origin) return res.status(400).json({ ok: false, reason: 'bad-origin' });
  try {
    const found = await fetchFamilyDirectory(origin);
    if (!found.ok) return res.status(400).json(found);
    const body = found.doc.body;
    if (body.operator.id === ownOperatorId()) return res.status(400).json({ ok: false, reason: 'own-family' });
    res.json({
      ok: true,
      operator: { id: body.operator.id, name: String(body.operator.name || '') },
      serial: body.serial,
      relays: body.relays.length,
      gateways: partnerRules.gatewaySet(body, null).map((gateway) => ({
        id: gateway.id,
        name: String(body.relays.find((relay) => relay.id === gateway.id)?.name || ''),
        priority: gateway.priority,
        origins: gateway.origins,
      })),
      state: partnerState.entries[body.operator.id]?.state || '',
    });
  } catch (error) {
    res.status(502).json({ ok: false, reason: 'unreachable', detail: String(error?.message || error).slice(0, 120) });
  }
});

app.post('/Monitor_Server/partners/request', authMiddleware, async (req, res) => {
  if (!OPERATOR_KEY || !directoryState.doc) return res.status(409).json({ ok: false, reason: 'no-family' });
  if (!ownGatewaySet().length) return res.status(409).json({ ok: false, reason: 'no-gateway' });
  const origin = partnerOrigin(req.body?.origin);
  const operatorId = String(req.body?.operatorId || '').toLowerCase();
  if (!origin) return res.status(400).json({ ok: false, reason: 'bad-origin' });
  if (!/^[a-f0-9]{64}$/.test(operatorId)) return res.status(400).json({ ok: false, reason: 'bad-request' });
  try {
    const found = await fetchFamilyDirectory(origin);
    if (!found.ok) return res.status(400).json(found);
    /* The admin confirmed this operator; a different one answering now is
       not who they agreed to. */
    if (found.doc.body.operator.id !== operatorId) return res.status(409).json({ ok: false, reason: 'operator-changed' });
    const request = partnerRules.signJoinRequest({
      directory: directoryState.doc,
      from: relayIdentity.id,
      key: publicRelayIdentity(relayIdentity).publicKey,
      to: operatorId,
      at: Date.now(),
      nonce: crypto.randomBytes(16).toString('hex'),
      contact: publicOriginForPeers(),
    }, relayPrivate);
    const sent = await partnerRequest(origin, '/relay-join', { method: 'POST', body: request });
    if (!sent) return res.status(502).json({ ok: false, reason: 'unreachable' });
    const answer = sent.json || {};
    if (sent.status !== 202) return res.status(502).json({ ok: false, reason: answer.reason || `answered-${sent.status}` });
    const state = answer.state === 'approved' ? 'approved' : (answer.state === 'rejected' ? 'rejected' : 'requested');
    const body = found.doc.body;
    const current = partnerState.entries[operatorId];
    changePartner(operatorId, {
      operatorKey: body.operator.key,
      name: String(body.operator.name || ''),
      state,
      directory: found.doc,
      contact: origin,
      requestId: String(answer.requestId || ''),
      requestedBy: relayIdentity.id,
      since: current?.since || Date.now(),
    }, `asked to link (${state})`);
    res.json({ ok: true, state, requestId: answer.requestId || '' });
  } catch (error) {
    res.status(502).json({ ok: false, reason: 'unreachable', detail: String(error?.message || error).slice(0, 120) });
  }
});

app.get('/relay-gateways', (req, res) => {
  setNoStoreHeaders(res);
  if (!directoryState.doc) return res.status(404).json({ ok: false, reason: 'no-directory' });
  res.json(currentGatewayNotice());
});

app.post('/Monitor_Server/partners/carry', authMiddleware, (req, res) => {
  if (typeof req.body?.on !== 'boolean') return res.status(400).json({ ok: false, reason: 'bad-request' });
  partnerState.carryBetween = {
    on: req.body.on,
    updatedAt: Math.max(Date.now(), (partnerState.carryBetween?.updatedAt || 0) + 1),
    updatedBy: relayIdentity.id,
  };
  savePartners();
  sharePartners([]);
  announcePartnerList();
  monitorLog(`Carrying between partners turned ${req.body.on ? 'on' : 'off'}`);
  res.json({ ok: true, on: carriesBetween() });
});

app.post('/Monitor_Server/gateways', authMiddleware, (req, res) => {
  if (!OPERATOR_KEY || !directoryState.doc) return res.status(409).json({ ok: false, reason: 'no-family' });
  const members = familyIds();
  let gateways = null;
  if (!req.body?.reset) {
    const list = Array.isArray(req.body?.gateways) ? req.body.gateways : null;
    if (!list || list.length > 64) return res.status(400).json({ ok: false, reason: 'bad-gateways' });
    const seen = new Set();
    gateways = [];
    for (const item of list) {
      const id = String(item?.id || '').toLowerCase();
      const priority = Number(item?.priority);
      if (!members.has(id) || seen.has(id) || !Number.isInteger(priority) || priority < 1 || priority > 99) return res.status(400).json({ ok: false, reason: 'bad-gateways' });
      seen.add(id);
      gateways.push({ id, priority });
    }
  }
  partnerState.override = {
    gateways,
    updatedAt: Math.max(Date.now(), (partnerState.override?.updatedAt || 0) + 1),
    updatedBy: relayIdentity.id,
  };
  savePartners();
  applyPartners();
  sharePartners([]);
  announceGateways();
  monitorLog(gateways ? `Gateways set from the dashboard: ${gateways.map((gateway) => `${gateway.id.slice(0, 12)}:${gateway.priority}`).join(', ') || 'none'}` : 'Gateways back to the deploy settings');
  res.json({ ok: true, gateways: ownGatewaySet().map((gateway) => ({ id: gateway.id.slice(0, 16), priority: gateway.priority })) });
});

function partnerAction(from, to, note, extra = () => ({})) {
  return (req, res) => {
    const operatorId = String(req.body?.operatorId || '').toLowerCase();
    const entry = partnerState.entries[operatorId];
    if (!entry || !from.includes(entry.state)) return res.status(409).json({ ok: false, reason: 'not-possible', state: entry?.state || '' });
    const changed = changePartner(operatorId, { state: to, ...extra(entry) }, note);
    res.json({ ok: true, state: changed.state });
  };
}
app.post('/Monitor_Server/partners/approve', authMiddleware, partnerAction(['incoming', 'rejected'], 'approved', 'approved', (entry) => ({ since: entry.since || Date.now(), mutedUntil: 0 })));
app.post('/Monitor_Server/partners/reject', authMiddleware, partnerAction(['incoming'], 'rejected', 'rejected', () => ({ mutedUntil: Date.now() + JOIN_MUTE_MS })));
app.post('/Monitor_Server/partners/remove', authMiddleware, partnerAction(['incoming', 'requested', 'approved'], 'removed', 'disconnected'));

/* The relay that asked follows the answer; a gateway refreshes what it
   knows of each partner's directory from that partner's gateways. */
async function pollPartnerRequests() {
  for (const entry of Object.values(partnerState.entries)) {
    if (entry.state !== 'requested' || entry.requestedBy !== relayIdentity.id || !entry.requestId || !entry.contact) continue;
    try {
      const answer = (await partnerFetchJson(entry.contact, `/relay-join/${entry.requestId}`)) || {};
      if (answer.state === 'rejected') changePartner(entry.operatorId, { state: 'rejected' }, 'they rejected');
      else if (answer.state === 'approved') changePartner(entry.operatorId, { state: 'approved' }, 'they approved');
    } catch (_error) { /* asked again next time */ }
  }
}
const PARTNER_FETCH_MAX_BYTES = 256 * 1024;
async function partnerFetchJson(origin, route) {
  const answer = await partnerRequest(origin, route);
  return answer && answer.status === 200 ? answer.json : null;
}
/* One request to another family's relay: connected to exactly the address
   that was checked (a name cannot answer the check with one address and the
   connection with another), no redirect followed, and the connection cut
   the moment the answer passes the cap rather than after reading it all.
   Resolves to { status, json } or null. */
async function partnerRequest(origin, route, { method = 'GET', body = null } = {}) {
  const safe = partnerOrigin(origin);
  if (!safe) return null;
  const url = new URL(`${safe}${route}`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let pinned = net.isIP(host) ? { address: host, family: net.isIP(host) } : null;
  if (!pinned) {
    const answers = await dns.lookup(host, { all: true, verbatim: true });
    if (!answers.length || (!PARTNER_ALLOW_PRIVATE && answers.some((answer) => partnerRules.privateHost(answer.address)))) return null;
    pinned = answers[0];
  }
  const payload = body === null ? null : Buffer.from(JSON.stringify(body));
  const answer = await new Promise((resolve) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request({
      protocol: url.protocol,
      hostname: host,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method,
      servername: net.isIP(host) ? undefined : host,
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'identity',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
      },
      lookup: (_hostname, options, callback) => {
        if (options && options.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
        else callback(null, pinned.address, pinned.family);
      },
      timeout: 10000,
    }, (response) => {
      if (Number(response.headers['content-length'] || 0) > PARTNER_FETCH_MAX_BYTES) {
        response.destroy();
        resolve(null);
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > PARTNER_FETCH_MAX_BYTES) {
          request.destroy();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode || 0, raw: Buffer.concat(chunks) }));
      response.on('error', () => resolve(null));
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
    request.end(payload || undefined);
  });
  if (!answer) return null;
  let json = {};
  try { json = JSON.parse(answer.raw.toString('utf8') || '{}'); } catch (_error) { json = {}; }
  return { status: answer.status, json };
}

async function pullPartnerDirectories() {
  if (!selfIsGateway()) return;
  for (const entry of activePartners()) {
    /* Any relay of theirs may say which gateways they have now: the way to
       hear of a change when none of their old gateways is up. A handful of
       origins, asked at once, each with its own deadline. */
    const everyOrigin = Array.from(new Set(entry.directory.body.relays.flatMap((relay) => (relay.origins || []).slice(0, 2)))).slice(0, 8);
    const notices = await Promise.allSettled(everyOrigin.map((origin) => partnerFetchJson(origin, '/relay-gateways')));
    for (const result of notices) {
      if (result.status === 'fulfilled' && result.value) takeGatewayNotice(entry.operatorId, result.value);
    }
    const gatewayOrigins = Array.from(new Set(partnerGatewaysOf(entry).flatMap((gateway) => gateway.origins))).slice(0, 8);
    const directories = await Promise.allSettled(gatewayOrigins.map((origin) => partnerFetchJson(origin, '/relay-directory')));
    for (const result of directories) {
      if (result.status !== 'fulfilled' || !result.value) continue;
      const doc = result.value;
      const current = partnerState.entries[entry.operatorId];
      const held = current?.directory?.body;
      const verdict = verifyDirectory(doc, { operatorKey: entry.operatorKey, selfId: doc?.body?.relays?.[0]?.id, heldSerial: held?.serial || 0, heldBody: held || null });
      if (!verdict.ok) continue;
      const before = partnerGatewaysOf(current).map((gateway) => gateway.id);
      changePartner(entry.operatorId, { directory: doc }, `directory ${doc.body.serial}`);
      notePartnerGatewayChange(entry.operatorId, before);
    }
  }
}

function startPartners() {
  try {
    const kept = JSON.parse(fs.readFileSync(PARTNERS_PATH, 'utf8'));
    partnerState.entries = partnerRules.prunePartners(partnerRules.mergePartners({}, Object.values(kept?.entries || {})).held);
    if (wellFormedOverride(kept?.override)) partnerState.override = kept.override;
    if (wellFormedCarry(kept?.carryBetween)) partnerState.carryBetween = kept.carryBetween;
  } catch (_error) { /* none kept yet */ }
  applyPartners();
  setInterval(() => pollPartnerRequests().catch(() => {}), JOIN_POLL_MS).unref?.();
  setInterval(() => {
    const before = JSON.stringify(partnerState.entries);
    partnerState.entries = partnerRules.prunePartners(partnerState.entries);
    if (JSON.stringify(partnerState.entries) !== before) savePartners();
  }, 24 * 60 * 60 * 1000).unref?.();
  setInterval(() => {
    pullPartnerDirectories().catch(() => {});
    if (selfIsGateway()) announcePartnerList();
  }, PARTNER_PULL_MS).unref?.();
}

app.post('/Monitor_Server/transit', authMiddleware, (req, res) => {
  res.json({
    ok: true,
    status: relayPeers.status(),
    directory: directorySummary(),
    partners: partnerSummary(),
    peers: relayPeers.peerEntries().map((entry) => ({
      id: entry.id.slice(0, 16),
      /* In full too: removing a link takes the whole id. */
      fullId: entry.id,
      origin: entry.origin,
      linked: entry.linked,
      role: entry.role,
      kind: directoryState.manualIds.has(entry.id) ? 'manual' : (isFamilyPeer(entry.id) ? 'family' : (partnerAllowed.has(entry.id) ? 'partner' : 'manual')),
      traffic: transitTraffic.get(entry.id) || { carried: 0, bytes: 0 },
    })),
  });
});

app.post('/Monitor_Server/transit-add', authMiddleware, (req, res) => {
  const id = String(req.body?.id || '').trim().toLowerCase();
  const origin = String(req.body?.origin || '').trim();
  if (!/^[a-f0-9]{64}$/.test(id)) return res.status(400).json({ ok: false, reason: 'bad-relay-id' });
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad scheme');
    } catch (_error) { return res.status(400).json({ ok: false, reason: 'bad-origin' }); }
  }
  const added = relayPeers.allowPeer(id, origin);
  if (!added) return res.status(400).json({ ok: false, reason: 'peer-refused' });
  directoryState.manualIds.add(id);
  directoryState.addedIds.delete(id);
  saveRuntimeTransitPeers();
  monitorLog(`Transit peer added: ${id.slice(0, 12)}${origin ? ` @ ${origin}` : ' (answer-only)'}`);
  res.json({ ok: true, status: relayPeers.status() });
});

app.post('/Monitor_Server/transit-remove', authMiddleware, (req, res) => {
  const id = String(req.body?.id || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(id)) return res.status(400).json({ ok: false, reason: 'bad-relay-id' });
  const removed = relayPeers.disallowPeer(id);
  if (!removed) return res.status(404).json({ ok: false, reason: 'no-such-peer' });
  saveRuntimeTransitPeers();
  monitorLog(`Transit peer removed: ${id.slice(0, 12)}`);
  res.json({ ok: true, status: relayPeers.status() });
});

