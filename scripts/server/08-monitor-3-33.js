/* ============================================================ monitor 3.33
 *
 * The dashboard outgrew "watch": it runs the server now — queues, traffic,
 * relay links, backups, images, updates. Everything below is behind
 * authMiddleware like every /admin action, and answers JSON. */

/* ---- queues ---------------------------------------------------------------- */

/* The queue view the dashboard draws: per mailbox, counts and sizes and
   ages, never payload bytes. Fingerprints are shortened the way every other
   surface here shortens them. */
app.post('/Monitor_Server/queues', authMiddleware, (req, res) => {
  const rows = [];
  for (const [fingerprint, items] of offlineBoxes) {
    if (!Array.isArray(items) || !items.length) continue;
    let bytes = 0;
    let oldest = Infinity;
    let newest = 0;
    for (const item of items) {
      /* The payload is a parsed object, so its wire size is the JSON length —
         .length on an object is undefined and every mailbox would read 0 B. */
      bytes += Buffer.byteLength(JSON.stringify(item?.payload ?? null));
      const at = Number(item?.queuedAt) || 0;
      if (at < oldest) oldest = at;
      if (at > newest) newest = at;
    }
    rows.push({
      fingerprint: fingerprint.slice(0, 12),
      count: items.length,
      bytes,
      oldestAt: Number.isFinite(oldest) ? new Date(oldest).toISOString() : '',
      newestAt: newest ? new Date(newest).toISOString() : '',
    });
  }
  rows.sort((a, b) => b.bytes - a.bytes);
  let heldForConnected = 0;
  for (const record of presence.values()) {
    if (record.sentMail) heldForConnected += record.sentMail.size;
  }
  res.json({
    ok: true,
    monitor: MONITOR_VERSION,
    mailboxes: rows,
    totals: { queued: rows.reduce((sum, row) => sum + row.count, 0), bytes: rows.reduce((sum, row) => sum + row.bytes, 0) },
    heldForConnected,
    transitWaiting: transitWaiting.size,
  });
});

/* One mailbox's items, metadata only: id, sender, type, age. The payload —
   somebody's message, sealed or not — is never handed to the dashboard. */
app.post('/Monitor_Server/queue-mailbox', authMiddleware, (req, res) => {
  const prefix = String(req.body?.fingerprint || '').trim().toLowerCase();
  if (!/^[a-f0-9]{4,64}$/.test(prefix)) {
    return res.status(400).json({ ok: false, reason: 'bad-fingerprint' });
  }
  let fingerprint = '';
  for (const key of offlineBoxes.keys()) {
    if (String(key).toLowerCase().startsWith(prefix)) { fingerprint = key; break; }
  }
  if (!fingerprint) return res.status(404).json({ ok: false, reason: 'no-such-mailbox' });
  const items = offlineBoxes.get(fingerprint) || [];
  res.json({
    ok: true,
    fingerprint: fingerprint.slice(0, 12),
    items: items.map((item, index) => ({
      index,
      id: String(item?.relayId || '').slice(0, 8),
      from: String(item?.fromFingerprint || '').slice(0, 12),
      type: item?.payload?.type ? String(item.payload.type).slice(0, 24) : 'relay',
      size: Buffer.byteLength(JSON.stringify(item?.payload ?? null)),
      queuedAt: item?.queuedAt ? new Date(item.queuedAt).toISOString() : '',
    })),
  });
});

/* Dropping mail is the operator's call, which is why it is here and why it
   is exact: one item by index, or the whole mailbox when index is absent.
   The store is saved the same way delivery saves it. */
app.post('/Monitor_Server/queue-drop', authMiddleware, async (req, res) => {
  const prefix = String(req.body?.fingerprint || '').trim().toLowerCase();
  const index = Number.isInteger(req.body?.index) ? Number(req.body.index) : null;
  if (!/^[a-f0-9]{4,64}$/.test(prefix)) {
    return res.status(400).json({ ok: false, reason: 'bad-fingerprint' });
  }
  let fingerprint = '';
  for (const key of offlineBoxes.keys()) {
    if (String(key).toLowerCase().startsWith(prefix)) { fingerprint = key; break; }
  }
  if (!fingerprint) return res.status(404).json({ ok: false, reason: 'no-such-mailbox' });
  const items = offlineBoxes.get(fingerprint) || [];
  if (index !== null) {
    if (index < 0 || index >= items.length) return res.status(400).json({ ok: false, reason: 'bad-index' });
    const [dropped] = items.splice(index, 1);
    if (!items.length) offlineBoxes.delete(fingerprint);
    monitorLog(`Dropped one mail item for ${fingerprint.slice(0, 12)}`);
  } else {
    offlineBoxes.delete(fingerprint);
    monitorLog(`Dropped the whole mailbox of ${fingerprint.slice(0, 12)} (${items.length} items)`);
  }
  await saveOfflineBoxes();
  res.json({ ok: true, remaining: offlineBoxes.get(fingerprint)?.length || 0 });
});

/* Nudge delivery: every connected holder of held mail is pumped right away.
   An offline mailbox is left alone — nudging it cannot deliver what has no
   one to receive it, and pretending otherwise would be a lie on a button. */
app.post('/Monitor_Server/queue-flush', authMiddleware, (req, res) => {
  let pumped = 0;
  for (const record of presence.values()) {
    if (!record.sentMail?.size) continue;
    pumped += record.sentMail.size;
    if (typeof pumpHeldMail === 'function') pumpHeldMail(record);
    if (typeof deliverHeldMail === 'function') deliverHeldMail(record);
  }
  res.json({ ok: true, pumped });
});

/* ---- relay links ------------------------------------------------------------ */

/* Runtime peer management, persisted beside the rest of the relay's state so
   a restart keeps the set the operator last chose. The env's peers are the
   seed; the file is the truth after the first change. */
const TRANSIT_PEERS_STORE = process.env.CHAT_TRANSIT_PEERS_STORE || path.join(defaultDataDir, 'transit-peers.json');
function loadRuntimeTransitPeers() {
  try {
    const raw = JSON.parse(fs.readFileSync(TRANSIT_PEERS_STORE, 'utf8'));
    for (const entry of Array.isArray(raw?.peers) ? raw.peers : []) {
      if (!/^[a-f0-9]{64}$/.test(String(entry?.id || ''))) continue;
      relayPeers.allowPeer(entry.id, String(entry?.origin || ''));
      directoryState.manualIds.add(entry.id);
    }
    if ((raw?.peers || []).length) console.log(`[Monitor] Restored ${raw.peers.length} runtime transit peer(s)`);
  } catch (_error) { /* first run: nothing to restore */ }
}
function saveRuntimeTransitPeers() {
  /* Not the family a directory brought in: copied here, a relay later left
     out of the directory would come back at the next start as "manual". */
  const peers = relayPeers.peerEntries()
    .filter(({ id }) => directoryState.manualIds.has(id) || (!directoryState.addedIds.has(id) && !partnerAllowed.has(id)))
    .map(({ id, origin }) => ({ id, origin }));
  try {
    fs.writeFileSync(TRANSIT_PEERS_STORE, JSON.stringify({ peers, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  } catch (error) { console.warn('[Monitor] transit peers not saved:', error.message); }
}

/* ---- the relay family (scripts/lib/relay-directory.js) ----------------------
 *
 * The relays this relay's operator runs, in a directory the operator signed
 * (docs/RELAY-NETWORK.md, "Relay families"). The
 * relay trusts one operator key, CHAT_OPERATOR_KEY; it links by itself with
 * every relay the newest directory signed by that key names, and drops what
 * a newer one leaves out or revokes. Peers named in CHAT_TRANSIT_PEERS or
 * added from the dashboard stay as they are, unless revoked. A relay without
 * the key behaves as it always has.
 */
const OPERATOR_KEY = String(process.env.CHAT_OPERATOR_KEY || '').trim();
const DIRECTORY_PATH = process.env.CHAT_DIRECTORY_PATH || path.join(defaultDataDir, 'relay-directory.json');
const DIRECTORY_SOURCES = String(process.env.CHAT_DIRECTORY_SOURCES || '').split(',').map((origin) => origin.trim()).filter((origin) => /^https?:\/\//.test(origin));
const DIRECTORY_PULL_MS = Math.max(1000, Number(process.env.CHAT_DIRECTORY_PULL_MS || 300000));
/* The lowest serial this relay will ever take, held or not. The serial guard
   only knows what the relay holds: a new relay, or one whose file was lost,
   would take any directory the operator ever signed, an old one naming a
   relay revoked since. The operator's tool writes the current serial here. */
const DIRECTORY_FLOOR_PATH = `${DIRECTORY_PATH}.serial`;
/* Kept apart from the directory, so losing that file does not lower it. */
const DIRECTORY_MIN_SERIAL = Math.max(
  Math.floor(Number(process.env.CHAT_DIRECTORY_MIN_SERIAL || 0)) || 0,
  (() => { try { return Math.floor(Number(fs.readFileSync(DIRECTORY_FLOOR_PATH, 'utf8').trim())) || 0; } catch (_error) { return 0; } })(),
);
/* addedIds: what the directory brought in, and so may take away again.
   manualIds: what CHAT_TRANSIT_PEERS or the dashboard named. */
const directoryState = { doc: null, addedIds: new Set(), manualIds: new Set(TRANSIT_PEERS.map((peer) => peer.id)) };
const directoryMembers = () => (directoryState.doc?.body.relays || []).map((relay) => relay.id).filter((id) => id !== relayIdentity.id);
/* The web origins every relay of the family is reached at, public and inside. */
function familyOrigins() {
  const out = [];
  for (const relay of directoryState.doc?.body?.relays || []) {
    for (const value of [...(relay.origins || []), ...(relay.inside || [])]) {
      try { const origin = new URL(String(value)).origin; if (!out.includes(origin)) out.push(origin); } catch (_error) { /* not an address */ }
    }
  }
  return out;
}

function applyDirectory(doc) {
  const takersBefore = new Set((directoryState.doc?.body?.relays || []).filter((relay) => relay.guests === true).map((relay) => relay.id));
  const plan = planChanges(doc.body, relayIdentity.id, directoryState.addedIds);
  const revoked = new Set(doc.body.revoked);
  for (const id of plan.drop) {
    if (directoryState.manualIds.has(id) && !revoked.has(id)) continue;
    relayPeers.disallowPeer(id);
    directoryState.addedIds.delete(id);
    directoryState.manualIds.delete(id);
  }
  for (const { id, origins } of plan.allow) {
    relayPeers.allowPeer(id, origins);
    if (!directoryState.manualIds.has(id)) directoryState.addedIds.add(id);
  }
  directoryState.doc = doc;
  /* A relay the list now says takes guests gets the rosters this one holds. */
  for (const relay of doc.body.relays) {
    if (relay.guests === true && !takersBefore.has(relay.id) && relay.id !== relayIdentity.id) sendRosterCopiesTo(relayPeers.linkFor(relay.id));
  }
}

function offerDirectoryTo(link) {
  if (!directoryState.doc || !link?.isOpen?.() || !directoryMembers().includes(link.peerId)) return;
  try { link.send({ kind: 'directory', doc: directoryState.doc }); } catch (_error) { /* the link went */ }
}

/* Every way a directory arrives ends here, and every check happens here. */
function acceptDirectory(doc, source) {
  if (!OPERATOR_KEY) return { ok: false, reason: 'no-operator-key' };
  const held = directoryState.doc?.body;
  const floor = DIRECTORY_MIN_SERIAL > (held?.serial || 0);
  const verdict = verifyDirectory(doc, {
    operatorKey: OPERATOR_KEY,
    selfId: relayIdentity.id,
    heldSerial: floor ? DIRECTORY_MIN_SERIAL - 1 : (held?.serial || 0),
    heldBody: floor ? null : (held || null),
  });
  if (!verdict.ok) {
    /* The same directory heard again is the normal case for pull and push. */
    if (verdict.reason !== 'stale' || source === 'dashboard') {
      console.warn(`[Directory] refused a directory from ${source}: ${verdict.reason}`);
    }
    return verdict;
  }
  applyDirectory(doc);
  partnersOnFamilyDirectory();
  if (source !== 'disk') {
    try {
      fs.writeFileSync(DIRECTORY_PATH, JSON.stringify(doc), { mode: 0o600 });
      fs.writeFileSync(DIRECTORY_FLOOR_PATH, `${doc.body.serial}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn('[Directory] could not keep the directory:', error.message);
    }
    for (const id of directoryMembers()) offerDirectoryTo(relayPeers.linkFor(id));
    monitorLog(`Relay directory ${doc.body.serial} from ${source}: ${doc.body.relays.length} relay(s), ${doc.body.revoked.length} revoked`);
  }
  console.log(`[Directory] serial ${doc.body.serial} (${source}): linked with ${directoryMembers().length} family relay(s)`);
  return { ok: true, serial: doc.body.serial };
}

/* Asked of every family member and every seed address; the newest valid
   answer wins. This is how a relay nobody can reach (one in Iran, seen from
   outside) still hears of a new directory. */
async function pullDirectories() {
  if (!OPERATOR_KEY) return;
  const origins = new Set(DIRECTORY_SOURCES);
  for (const relay of directoryState.doc?.body.relays || []) {
    if (relay.id !== relayIdentity.id) for (const origin of relay.origins || []) origins.add(String(origin));
  }
  await Promise.allSettled(Array.from(origins, async (origin) => {
    const response = await fetch(`${origin.replace(/\/+$/, '')}/relay-directory`, { signal: AbortSignal.timeout(15000) });
    if (response.ok) acceptDirectory(await response.json(), 'pull');
  }));
}

function startRelayDirectory() {
  if (!OPERATOR_KEY) return;
  try {
    acceptDirectory(JSON.parse(fs.readFileSync(DIRECTORY_PATH, 'utf8')), 'disk');
  } catch (_error) { /* none kept yet */ }
  setTimeout(() => pullDirectories().catch(() => {}), Math.min(5000, DIRECTORY_PULL_MS)).unref?.();
  setInterval(() => pullDirectories().catch(() => {}), DIRECTORY_PULL_MS).unref?.();
}

function directorySummary() {
  const body = directoryState.doc?.body;
  if (!body) return null;
  return {
    operator: { id: body.operator.id, name: String(body.operator.name || '') },
    serial: body.serial,
    issuedAt: body.issuedAt || '',
    relays: body.relays.map((relay) => ({
      id: relay.id,
      name: String(relay.name || ''),
      region: String(relay.region || ''),
      gateway: Number(relay.gateway || 0),
      cluster: String(relay.cluster || ''),
      inside: Array.isArray(relay.inside) ? relay.inside.map(String) : [],
      self: relay.id === relayIdentity.id,
      linked: relay.id === relayIdentity.id || Boolean(relayPeers.linkFor(relay.id)),
    })),
    revoked: body.revoked,
  };
}

app.get('/relay-directory', (req, res) => {
  setNoStoreHeaders(res);
  if (!directoryState.doc) return res.status(404).json({ ok: false, reason: 'no-directory' });
  res.json(directoryState.doc);
});

app.post('/Monitor_Server/directory', authMiddleware, (req, res) => {
  const result = acceptDirectory(req.body, 'dashboard');
  res.status(result.ok ? 200 : 400).json(result);
});

