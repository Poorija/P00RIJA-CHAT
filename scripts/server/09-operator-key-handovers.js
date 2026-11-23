/* ---- operator-key handovers (scripts/lib/relay-directory.js) --------------
   The old key's word for the new one, kept for the apps: one that trusts the
   old key follows it here instead of asking its user whether this is a
   different operator. Only a handover that leads to this relay's own
   operator key is kept, the last five. */
/* Beside the directory: wherever a relay keeps its family, it keeps these. */
const HANDOVER_PATH = process.env.CHAT_HANDOVER_PATH || path.join(path.dirname(DIRECTORY_PATH), 'operator-handovers.json');
const HANDOVER_KEEP = 5;
function readHandovers() {
  try {
    const list = JSON.parse(fs.readFileSync(HANDOVER_PATH, 'utf8'));
    return Array.isArray(list) ? list.filter((handover) => verifyHandover(handover).ok).slice(-HANDOVER_KEEP) : [];
  } catch (_error) {
    return [];
  }
}
app.get('/operator-handover', (req, res) => {
  setNoStoreHeaders(res);
  res.json({ ok: true, handovers: readHandovers() });
});
app.post('/Monitor_Server/operator-handover', authMiddleware, (req, res) => {
  const handover = req.body;
  const verdict = verifyHandover(handover);
  if (!verdict.ok) return res.status(400).json(verdict);
  if (!OPERATOR_KEY) return res.status(400).json({ ok: false, reason: 'no-operator-key' });
  const ownId = operatorIdFor(OPERATOR_KEY);
  const held = readHandovers();
  const leads = handover.to.id === ownId || followHandovers(held, handover.to.id)?.id === ownId;
  if (!leads) return res.status(400).json({ ok: false, reason: 'not-this-operator' });
  const kept = [...held.filter((entry) => entry.sig !== handover.sig), handover].slice(-HANDOVER_KEEP);
  try {
    fs.mkdirSync(path.dirname(HANDOVER_PATH), { recursive: true });
    fs.writeFileSync(`${HANDOVER_PATH}.tmp`, JSON.stringify(kept, null, 2));
    fs.renameSync(`${HANDOVER_PATH}.tmp`, HANDOVER_PATH);
  } catch (error) {
    return res.status(500).json({ ok: false, reason: 'not-saved', detail: error.message });
  }
  monitorLog(`operator handover ${handover.from.id.slice(0, 12)} → ${handover.to.id.slice(0, 12)} kept`);
  return res.json({ ok: true, kept: kept.length });
});

/* ---- partners: other operators' families (scripts/lib/relay-partners.js) ----
 *
 * Families run by different operators link only through their gateways, and
 * only after the admin of the family that was asked approved
 * (docs/RELAY-NETWORK.md, "Linking with other operators"). What this relay
 * knows about partners it shares with its own family over the family links,
 * so a button pressed on any relay's dashboard holds on all of them; nothing
 * from outside the family can change it. A gateway allows the gateways of
 * every partner it asked or approved; a relay that is not a gateway allows
 * no partner relay at all.
 */
const PARTNERS_PATH = process.env.CHAT_PARTNERS_PATH || path.join(defaultDataDir, 'relay-partners.json');
const GATEWAY_STABLE_MS = Math.max(0, Number(process.env.CHAT_GATEWAY_STABLE_MS || 60000));
const GATEWAY_HANDOFF_MS = Math.max(1000, Number(process.env.CHAT_GATEWAY_HANDOFF_MS || 120000));
/* Only for relays on one machine or one private network, such as the test
   suites: otherwise a partner's directory may not send this relay to a
   private, loopback or link-local address. */
const PARTNER_ALLOW_PRIVATE = process.env.CHAT_PARTNER_ALLOW_PRIVATE === '1';
const partnerOrigin = (origin) => partnerRules.safePartnerOrigin(origin, { allowPrivate: PARTNER_ALLOW_PRIVATE });
function dialOrigins(origins) {
  const safe = (origins || []).map(partnerOrigin).filter(Boolean);
  for (const origin of safe) partnerHosts.add(new URL(origin).hostname.replace(/^\[|\]$/g, '').toLowerCase());
  return safe.join('|');
}
const PARTNER_PULL_MS = Math.max(1000, Number(process.env.CHAT_PARTNER_PULL_MS || 300000));
const JOIN_POLL_MS = Math.max(1000, Number(process.env.CHAT_JOIN_POLL_MS || 60000));
const JOIN_PER_HOUR = Math.max(1, Number(process.env.CHAT_JOIN_PER_HOUR || 10));
const JOIN_WAITING_MAX = Math.max(1, Number(process.env.CHAT_JOIN_WAITING_MAX || 20));
const JOIN_MUTE_MS = 30 * 24 * 60 * 60 * 1000;
const PARTNER_NOTICES_PER_HOUR = 10;
/* Gateway changes of one partner reach Telegram at most once an hour. */
const GATEWAY_NOTICE_GAP_MS = 3600000;
const gatewayNoticeAt = new Map();
/* What a partner's gateway may send. Everything else it sends (this
   family's directory, its partner list, alerts, front-door streams) is not
   a partner's to send. */
const PARTNER_FRAME_KINDS = new Set(['transit', 'transit-result', 'partner-directory', 'partner-keys', 'partner-gateways', 'partner-list', 'partner-list-relay']);

const partnerState = { entries: {}, override: null, carryBetween: null };
/* The partner gateways this relay allowed, so it can take back exactly those. */
const partnerAllowed = new Set();
/* Which partner each relay id belongs to, rebuilt on every change. */
let partnerIndex = new Map();
/* Keys of partner relays, from their gateways; kept only when the key hashes
   to an id that partner's directory names. */
const partnerKeys = new Map();
/* When the link to a relay came up, for choosing a gateway that has stood. */
const linkUpSince = new Map();
const partnerNoticeTimes = [];

const familyIds = () => new Set((directoryState.doc?.body.relays || []).map((relay) => relay.id));
function isFamilyPeer(id) {
  return Boolean(id) && id !== relayIdentity.id && familyIds().has(id);
}
const ownGatewaySet = () => (directoryState.doc ? partnerRules.gatewaySet(directoryState.doc.body, partnerState.override?.gateways ? partnerState.override : null) : []);
function selfIsGateway() {
  return ownGatewaySet().some((gateway) => gateway.id === relayIdentity.id);
}
const ACTIVE_PARTNER = new Set(['requested', 'approved']);
const activePartners = () => Object.values(partnerState.entries)
  .filter((entry) => ACTIVE_PARTNER.has(entry.state) && entry.directory?.body)
  .sort((left, right) => (left.since || 0) - (right.since || 0) || (left.operatorId < right.operatorId ? -1 : 1));

/* Earlier partners first, and never an id of this family or a peer the
   admin named by hand: a partner's directory that names one of those, or
   one an earlier partner owns, is not believed for it. */
function rebuildPartnerIndex() {
  const index = new Map();
  const ours = familyIds();
  for (const entry of activePartners()) {
    for (const relay of entry.directory.body.relays) {
      if (ours.has(relay.id) || directoryState.manualIds.has(relay.id) || index.has(relay.id)) continue;
      index.set(relay.id, entry.operatorId);
    }
  }
  partnerIndex = index;
}
function partnerOperatorOf(id) {
  return partnerIndex.get(id) || '';
}
function partnerGatewaysOf(entry) {
  if (!entry?.directory?.body) return [];
  return partnerRules.gatewaySet(entry.directory.body, entry.gatewayNotice?.gateways ? entry.gatewayNotice : null)
    .filter((gateway) => partnerIndex.get(gateway.id) === entry.operatorId);
}
function isPartnerGateway(id) {
  const entry = partnerState.entries[partnerOperatorOf(id)];
  return Boolean(entry) && ACTIVE_PARTNER.has(entry.state) && partnerGatewaysOf(entry).some((gateway) => gateway.id === id);
}

function savePartners() {
  try {
    const temporary = `${PARTNERS_PATH}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(partnerState), { mode: 0o600 });
    fs.renameSync(temporary, PARTNERS_PATH);
  } catch (error) {
    console.warn('[Partners] could not keep the partners:', error.message);
  }
}

/* Gateways allow every active partner's gateways and take back what no
   longer qualifies; a relay that is not a gateway takes back everything. */
function applyPartners() {
  rebuildPartnerIndex();
  for (const map of [partnerLists, relayedLists]) {
    for (const operatorId of Array.from(map.keys())) {
      if (!ACTIVE_PARTNER.has(partnerState.entries[operatorId]?.state)) map.delete(operatorId);
    }
  }
  const want = new Map();
  const gatewayNow = selfIsGateway();
  if (wasGateway && !gatewayNow) {
    handoffUntil = Date.now() + GATEWAY_HANDOFF_MS;
    setTimeout(() => applyPartners(), GATEWAY_HANDOFF_MS + 100).unref?.();
  }
  if (gatewayNow) handoffUntil = 0;
  wasGateway = gatewayNow;
  if (gatewayNow) {
    for (const entry of activePartners()) {
      for (const gateway of [...partnerGatewaysOf(entry), ...retainedPartnerGateways(entry.operatorId)]) want.set(gateway.id, dialOrigins(gateway.origins));
    }
  }
  const ours = familyIds();
  for (const id of Array.from(partnerAllowed)) {
    if (want.has(id)) continue;
    const operatorId = partnerOperatorOf(id);
    if (!gatewayNow && Date.now() < handoffUntil && operatorId && ACTIVE_PARTNER.has(partnerState.entries[operatorId]?.state) && !familyGatewayReaches(operatorId)) continue;
    partnerAllowed.delete(id);
    if (directoryState.manualIds.has(id) || ours.has(id)) continue;
    relayPeers.disallowPeer(id);
  }
  for (const [id, origins] of want) {
    if (ours.has(id)) continue;
    relayPeers.allowPeer(id, origins);
    partnerAllowed.add(id);
  }
  shareReach();
}

function sharePartners(entries) {
  const frame = { kind: 'partners', entries, override: partnerState.override, carryBetween: partnerState.carryBetween };
  for (const id of directoryMembers()) {
    const link = relayPeers.linkFor(id);
    if (link?.isOpen?.()) {
      try { link.send(frame); } catch (_error) { /* the link went */ }
    }
  }
}

/* Every change, whoever makes it: stamped, kept, applied, and told to the
   family. The stamp is always later than the one it replaces, so the change
   wins everywhere even on a clock a little behind. */
function changePartner(operatorId, patch, note = '') {
  const current = partnerState.entries[operatorId] || null;
  const entry = {
    ...(current || {}),
    ...patch,
    operatorId,
    updatedAt: Math.max(Date.now(), (current?.updatedAt || 0) + 1),
    updatedBy: relayIdentity.id,
  };
  partnerState.entries = partnerRules.mergePartners(partnerState.entries, [entry]).held;
  savePartners();
  applyPartners();
  sharePartners([entry]);
  announcePartnerList();
  if (note) monitorLog(`Partner ${entry.name || operatorId.slice(0, 12)} (${operatorId.slice(0, 12)}): ${note}`);
  return entry;
}

function receivePartners(payload, link) {
  if (!isFamilyPeer(link?.peerId)) return;
  const incoming = (Array.isArray(payload.entries) ? payload.entries : []).filter((entry) => partnerRules.partnerEntryConsistent(entry));
  const merged = partnerRules.mergePartners(partnerState.entries, incoming);
  const override = wellFormedOverride(payload.override) && laterSetting(payload.override, partnerState.override) ? payload.override : null;
  const carry = wellFormedCarry(payload.carryBetween) && laterSetting(payload.carryBetween, partnerState.carryBetween) ? payload.carryBetween : null;
  if (!merged.changed.length && !override && !carry) return;
  partnerState.entries = merged.held;
  if (override) partnerState.override = override;
  if (carry) partnerState.carryBetween = carry;
  savePartners();
  applyPartners();
  if (override) announceGateways();
  if (merged.changed.length || carry) announcePartnerList();
}

/* A family setting (the gateways the admin chose): the later change wins,
   the relay that made it breaks a tie, as for partner entries. */
function laterSetting(incoming, held) {
  return !held || incoming.updatedAt > held.updatedAt
    || (incoming.updatedAt === held.updatedAt && String(incoming.updatedBy) > String(held.updatedBy));
}
const wellFormedOverride = (override) => partnerRules.validOverride(override);

/* The family's gateways as this relay says them, signed with its own key: a
   partner believes it from any relay of the family's signed directory. */
function currentGatewayNotice() {
  return partnerRules.signGatewayNotice({
    operatorId: ownOperatorId(),
    gateways: ownGatewaySet().map((gateway) => ({ id: gateway.id, priority: gateway.priority })),
    updatedAt: partnerState.override?.updatedAt || 0,
  }, { id: relayIdentity.id, key: publicRelayIdentity(relayIdentity).publicKey }, relayPrivate);
}
/* Told by every relay holding a link with a partner's gateway, which during
   a change is the old gateway as much as the new one. */
function announceGateways() {
  if (!directoryState.doc || !partnerState.override) return;
  sendToPartnerGateways({ kind: 'partner-gateways', notice: currentGatewayNotice() });
}

/* A partner's gateways changed: the ones it dropped stay usable until one of
   its new gateways has a link with us, or the handoff time runs out, so the
   two families are never left without a way to each other. */
const partnerRetained = new Map();
function notePartnerGatewayChange(operatorId, beforeIds) {
  const entry = partnerState.entries[operatorId];
  const now = new Set(partnerGatewaysOf(entry).map((gateway) => gateway.id));
  const dropped = beforeIds.filter((id) => !now.has(id));
  const added = Array.from(now).some((id) => !beforeIds.includes(id));
  if (!dropped.length && !added) return;
  if (dropped.length) {
    const retained = partnerRules.retainGateways(partnerRetained.get(operatorId) || null, dropped, { now: Date.now(), handoffMs: GATEWAY_HANDOFF_MS });
    partnerRetained.set(operatorId, retained);
    setTimeout(() => applyPartners(), Math.max(0, retained.until - Date.now()) + 100).unref?.();
  }
  applyPartners();
  const last = gatewayNoticeAt.get(operatorId) || 0;
  if (Date.now() - last >= GATEWAY_NOTICE_GAP_MS) {
    gatewayNoticeAt.set(operatorId, Date.now());
    partnerNotice('Gatewayهای یک شریک عوض شد', `اپراتور «${entry?.name || operatorId.slice(0, 12)}» (${operatorId.slice(0, 12)}…) Gatewayهای خود را تغییر داد؛ اتصال خودکار با Gatewayهای تازه هماهنگ شد.`);
  }
}
function retainedPartnerGateways(operatorId) {
  const held = partnerRetained.get(operatorId);
  if (!held) return [];
  const entry = partnerState.entries[operatorId];
  const current = partnerGatewaysOf(entry);
  if (Date.now() > held.until || current.some((gateway) => relayPeers.linkFor(gateway.id))) {
    partnerRetained.delete(operatorId);
    return [];
  }
  const relays = new Map((entry?.directory?.body?.relays || []).map((relay) => [relay.id, relay]));
  return Array.from(held.ids)
    .filter((id) => relays.has(id) && partnerIndex.get(id) === operatorId && !directoryState.manualIds.has(id))
    .map((id) => ({ id, priority: 99, origins: (relays.get(id).origins || []).map(String) }));
}

/* This relay stopped being a gateway: it keeps its partner links until a
   gateway of the family has one with that partner, or the handoff time runs
   out. */
let wasGateway = false;
let handoffUntil = 0;
function familyGatewayReaches(operatorId) {
  for (const [gatewayId, relays] of reachFrom) {
    if (gatewayId === relayIdentity.id || !ownGatewaySet().some((gateway) => gateway.id === gatewayId)) continue;
    for (const info of relays.values()) if (info.operatorId === operatorId) return true;
  }
  return false;
}

function partnerNotice(title, body) {
  const now = Date.now();
  while (partnerNoticeTimes.length && now - partnerNoticeTimes[0] > 3600000) partnerNoticeTimes.shift();
  if (partnerNoticeTimes.length >= PARTNER_NOTICES_PER_HOUR) return;
  partnerNoticeTimes.push(now);
  queueReport({ level: 'partner', title, body });
  flushAlerts().catch(() => {});
}
/* The host people know a relay by, never a bare address: an IP goes to
   nobody's Telegram. */
function contactHost(contact) {
  try {
    const host = new URL(String(contact || '')).hostname;
    if (!host || /^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) return '';
    return host;
  } catch (_error) { return ''; }
}

function sendToPartnerGateways(frame, operatorId = '') {
  for (const id of partnerAllowed) {
    if (operatorId && partnerOperatorOf(id) !== operatorId) continue;
    const link = relayPeers.linkFor(id);
    if (link?.isOpen?.()) {
      try { link.send(frame); } catch (_error) { /* the link went */ }
    }
  }
}
function ownKnownKeys() {
  const keys = { [relayIdentity.id]: publicRelayIdentity(relayIdentity).publicKey };
  for (const entry of relayPeers.peerEntries()) {
    if (entry.key && isFamilyPeer(entry.id)) keys[entry.id] = entry.key;
  }
  return keys;
}

function partnersLinkUp(link) {
  const id = link?.peerId;
  if (!id) return;
  if (!linkUpSince.has(id)) linkUpSince.set(id, Date.now());
  if (isFamilyPeer(id)) {
    if (Object.keys(partnerState.entries).length || partnerState.override || partnerState.carryBetween) {
      try { link.send({ kind: 'partners', entries: Object.values(partnerState.entries), override: partnerState.override, carryBetween: partnerState.carryBetween }); } catch (_error) { /* the link went */ }
    }
    if (selfIsGateway()) shareReach();
    return;
  }
  if (!partnerAllowed.has(id)) return;
  const operatorId = partnerOperatorOf(id);
  const entry = partnerState.entries[operatorId];
  if (!entry) return;
  try {
    if (directoryState.doc) link.send({ kind: 'partner-directory', doc: directoryState.doc });
    link.send({ kind: 'partner-keys', keys: ownKnownKeys() });
    if (partnerState.override && directoryState.doc) link.send({ kind: 'partner-gateways', notice: currentGatewayNotice() });
    link.send({ kind: 'partner-list', list: ownPartnerList() });
    relayListsTo(link, operatorId);
  } catch (_error) { /* the link went */ }
  if (partnerRetained.has(operatorId)) applyPartners();
  shareReach();
  /* A link with their gateway stands only if they allow ours: the proof
     that they said yes. */
  if (entry.state === 'requested') {
    changePartner(operatorId, { state: 'approved' }, 'linked');
    partnerNotice('اتصال با یک شریک برقرار شد', `اپراتور «${entry.name || operatorId.slice(0, 12)}» (${operatorId.slice(0, 12)}…).`);
  }
}
function partnersLinkDown(link) {
  const id = link?.peerId;
  if (!id || relayPeers.linkFor(id)) return;
  linkUpSince.delete(id);
  reachFrom.delete(id);
  if (partnerAllowed.has(id)) shareReach();
}

