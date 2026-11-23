/* ---- which gateway, and what the family can reach ------------------------- */

const upSinceOf = (id) => (relayPeers.linkFor(id) ? (linkUpSince.get(id) || Date.now()) : 0);
function bestPartnerGateway(operatorId) {
  const entry = partnerState.entries[operatorId];
  if (!entry || !ACTIVE_PARTNER.has(entry.state)) return null;
  const candidates = partnerGatewaysOf(entry).map((gateway) => ({ id: gateway.id, priority: gateway.priority, upSince: upSinceOf(gateway.id) }));
  const chosen = partnerRules.chooseGateway(candidates, { now: Date.now(), stableMs: GATEWAY_STABLE_MS });
  if (chosen) return chosen;
  const retained = retainedPartnerGateways(operatorId).map((gateway) => ({ id: gateway.id, priority: gateway.priority, upSince: upSinceOf(gateway.id) }));
  return partnerRules.chooseGateway(retained, { now: Date.now(), stableMs: GATEWAY_STABLE_MS });
}
/* The way to a partner's family: its own gateway when a link with one has
   stood for the settle time; else, when allowed, through a common partner
   that carries between its partners and names that family as its partner;
   else whatever is up. */
function routeToPartner(operatorId, { viaAllowed = true } = {}) {
  const entry = partnerState.entries[operatorId];
  if (!entry || !ACTIVE_PARTNER.has(entry.state)) return null;
  const now = Date.now();
  const direct = [...partnerGatewaysOf(entry), ...retainedPartnerGateways(operatorId)]
    .map((gateway) => ({ id: gateway.id, priority: gateway.priority, upSince: upSinceOf(gateway.id) }));
  const settledDirect = partnerRules.chooseGateway(direct.filter((candidate) => candidate.upSince && now - candidate.upSince >= GATEWAY_STABLE_MS), { now, stableMs: GATEWAY_STABLE_MS });
  if (settledDirect) return { id: settledDirect, path: 'direct' };
  const via = viaAllowed ? commonPartnerRoutes(operatorId) : [];
  const settledVia = via.find((route) => route.upSince && now - route.upSince >= GATEWAY_STABLE_MS);
  if (settledVia) return { id: settledVia.id, path: `via:${settledVia.operator}` };
  const anyDirect = partnerRules.chooseGateway(direct, { now, stableMs: GATEWAY_STABLE_MS });
  if (anyDirect) return { id: anyDirect, path: 'direct' };
  const anyVia = via.find((route) => route.upSince);
  return anyVia ? { id: anyVia.id, path: `via:${anyVia.operator}` } : null;
}
function commonPartnerRoutes(target) {
  const routes = [];
  const targetList = farListOf(target);
  for (const entry of activePartners()) {
    if (entry.operatorId === target) continue;
    if (!partnerRules.commonPartnerOk({ through: entry.operatorId, target, throughList: heldList(partnerLists, entry.operatorId), targetList })) continue;
    const id = bestPartnerGateway(entry.operatorId);
    if (id) routes.push({ id, operator: entry.operatorId, upSince: upSinceOf(id) });
  }
  return routes.sort((left, right) => (left.upSince || Infinity) - (right.upSince || Infinity));
}

/* What each partner said about its own partners, from its gateways: which
   operators it links with, and whether it carries between them. Each list is
   signed by the relay that said it; `relayedLists` are the ones a common
   partner passed on from a family this relay has no link with. */
const partnerLists = new Map();
const relayedLists = new Map();
/* The newest list time accepted for each family by either way, kept even
   when the list itself expires or the partner goes: nothing older is ever
   taken again. */
const listHighWater = new Map();
/* Families say their lists again every pull interval; one not heard for
   three of them is as good as missing. */
const PARTNER_LIST_MAX_AGE_MS = 3 * PARTNER_PULL_MS;
function heldList(map, operatorId) {
  return partnerRules.freshList(map.get(operatorId), {
    now: Date.now(),
    maxAgeMs: PARTNER_LIST_MAX_AGE_MS,
    directoryBody: partnerState.entries[operatorId]?.directory?.body,
  });
}
function farListOf(operatorId) {
  const direct = heldList(partnerLists, operatorId);
  const relayed = heldList(relayedLists, operatorId);
  if (!direct) return relayed || null;
  if (!relayed) return direct;
  return relayed.updatedAt > direct.updatedAt ? relayed : direct;
}
let partnerListStamp = 0;
function ownPartnerList() {
  partnerListStamp = Math.max(Date.now(), partnerListStamp + 1);
  return partnerRules.signPartnerList({
    operatorId: ownOperatorId(),
    operators: activePartners().map((entry) => entry.operatorId),
    carries: carriesBetween(),
    updatedAt: partnerListStamp,
  }, { id: relayIdentity.id, key: publicRelayIdentity(relayIdentity).publicKey }, relayPrivate);
}
/* A family that carries between its partners passes each partner's list on
   to the partners that list names, and to nobody else: it says nothing
   about one partner to a family that partner did not choose. */
function relayListsTo(link, operatorId) {
  if (!carriesBetween()) return;
  for (const from of partnerLists.keys()) {
    const held = heldList(partnerLists, from);
    if (from === operatorId || !held?.doc || !held.operators.has(operatorId)) continue;
    try { link.send({ kind: 'partner-list-relay', list: held.doc }); } catch (_error) { /* the link went */ }
  }
}
const carriesBetween = () => Boolean(partnerState.carryBetween?.on);
function wellFormedCarry(setting) {
  return Boolean(setting) && typeof setting.on === 'boolean' && Number.isFinite(setting.updatedAt)
    && setting.updatedAt <= Date.now() + 5 * 60 * 1000 && typeof setting.updatedBy === 'string';
}
let partnerListTimer = null;
function announcePartnerList() {
  if (partnerListTimer) return;
  partnerListTimer = setTimeout(() => {
    partnerListTimer = null;
    if (!directoryState.doc) return;
    sendToPartnerGateways({ kind: 'partner-list', list: ownPartnerList() });
    for (const id of partnerAllowed) {
      const link = relayPeers.linkFor(id);
      if (link?.isOpen?.()) relayListsTo(link, partnerOperatorOf(id));
    }
  }, 200);
  partnerListTimer.unref?.();
}

/* Among this family's gateways that said they reach a relay. */
function bestOwnGateway(reporters) {
  const candidates = ownGatewaySet()
    .filter((gateway) => gateway.id !== relayIdentity.id && reporters.has(gateway.id))
    .map((gateway) => ({ id: gateway.id, priority: gateway.priority, upSince: upSinceOf(gateway.id) }));
  return partnerRules.chooseGateway(candidates, { now: Date.now(), stableMs: GATEWAY_STABLE_MS });
}

/* What a gateway reaches: the relays of every partner whose gateways it has
   a link to, with a key that hashes to the id. Its members hear it as
   `reach` frames; a member believes them only from a gateway of its own. */
const reachFrom = new Map();
function localReach() {
  const reach = new Map();
  if (!selfIsGateway()) return reach;
  for (const entry of activePartners()) {
    if (!routeToPartner(entry.operatorId)) continue;
    for (const relay of entry.directory.body.relays) {
      if (partnerIndex.get(relay.id) !== entry.operatorId) continue;
      /* Without a key the app cannot seal to it, but this family can still
         route what is sealed elsewhere. */
      const key = relayPeers.linkFor(relay.id)?.peerKey || partnerKeys.get(relay.id) || '';
      reach.set(relay.id, { key, origin: partnerOrigin(relay.origins?.[0]), operatorId: entry.operatorId, operatorName: String(entry.name || '') });
    }
  }
  return reach;
}
function reachView() {
  const view = new Map();
  const add = (gatewayId, relayId, info) => {
    const current = view.get(relayId) || { ...info, gateways: new Set() };
    current.gateways.add(gatewayId);
    view.set(relayId, current);
  };
  const gateways = new Set(ownGatewaySet().map((gateway) => gateway.id));
  for (const [gatewayId, relays] of reachFrom) {
    if (!gateways.has(gatewayId) || !relayPeers.linkFor(gatewayId)) continue;
    for (const [relayId, info] of relays) add(gatewayId, relayId, info);
  }
  for (const [relayId, info] of localReach()) add(relayIdentity.id, relayId, info);
  return view;
}
let reachTimer = null;
function shareReach() {
  if (reachTimer) return;
  reachTimer = setTimeout(() => {
    reachTimer = null;
    const relays = Array.from(localReach(), ([id, info]) => ({ id, ...info }));
    for (const id of directoryMembers()) {
      const link = relayPeers.linkFor(id);
      if (link?.isOpen?.()) {
        try { link.send({ kind: 'reach', relays }); } catch (_error) { /* the link went */ }
      }
    }
  }, 200);
  reachTimer.unref?.();
}
/* Which members of the family each member has a link to, as each says over
   its own link. A path between two servers can close while each still
   reaches the rest (a route filtered between two providers); with this a
   relay reaches a member it has no link to through one that has. */
const FAMILY_LINKS_MS = Math.max(1000, Number(process.env.CHAT_FAMILY_LINKS_MS || 60000));
const familyLinksFrom = new Map();
let familyLinksTimer = null;
function shareFamilyLinks() {
  if (familyLinksTimer) return;
  familyLinksTimer = setTimeout(() => {
    familyLinksTimer = null;
    const members = directoryMembers();
    const ids = members.filter((id) => relayPeers.linkFor(id)?.isOpen?.());
    for (const id of ids) {
      try { relayPeers.linkFor(id).send({ kind: 'family-links', ids, telegram: alertsByTelegram() }); } catch (_error) { /* the link went */ }
    }
  }, 200);
  familyLinksTimer.unref?.();
}
setInterval(shareFamilyLinks, FAMILY_LINKS_MS).unref?.();
function receiveFamilyLinks(payload, link) {
  const id = link?.peerId;
  if (!isFamilyPeer(id)) return;
  const family = familyIds();
  const ids = (Array.isArray(payload.ids) ? payload.ids : []).slice(0, 2048).map(String).filter((other) => family.has(other));
  familyLinksFrom.set(id, { ids: new Set(ids), at: Date.now(), telegram: payload.telegram === true });
  /* A relay that has just said it has the bot may be the one alerts were waiting for. */
  if (payload.telegram === true && alertOutbox.length && !alertsByTelegram()) flushAlerts().catch(() => {});
}
/* The member to go through: one heard from lately that has a link to the
   one wanted, of the same cluster when there is one. */
function familyDetour(toRelay) {
  const fresh = Date.now() - 3 * FAMILY_LINKS_MS;
  const clusterOf = (id) => directoryState.doc?.body?.relays?.find((relay) => relay.id === id)?.cluster || '';
  const wanted = clusterOf(toRelay);
  const through = Array.from(familyLinksFrom)
    .filter(([id, view]) => view.at >= fresh && view.ids.has(toRelay) && relayPeers.linkFor(id))
    .map(([id]) => id)
    .sort((a, b) => Number(Boolean(wanted) && clusterOf(b) === wanted) - Number(Boolean(wanted) && clusterOf(a) === wanted) || a.localeCompare(b));
  return through.length ? relayPeers.linkFor(through[0]) : null;
}

function receiveReach(payload, link) {
  const id = link?.peerId;
  if (!isFamilyPeer(id) || !ownGatewaySet().some((gateway) => gateway.id === id)) return;
  const ours = familyIds();
  const relays = new Map();
  for (const relay of (Array.isArray(payload.relays) ? payload.relays : []).slice(0, 2048)) {
    const relayId = String(relay?.id || '');
    if (!/^[a-f0-9]{64}$/.test(relayId) || ours.has(relayId) || (relay.key && relayIdFor(String(relay.key)) !== relayId)) continue;
    relays.set(relayId, {
      key: String(relay.key || ''),
      origin: cleanPartnerOrigin(relay.origin),
      operatorId: /^[a-f0-9]{64}$/.test(String(relay.operatorId || '')) ? relay.operatorId : '',
      operatorName: String(relay.operatorName || '').slice(0, 80),
    });
  }
  reachFrom.set(id, relays);
  if (handoffUntil) applyPartners();
}

/* A frame not sealed to this relay. Carried on only as the rules in
   relay-partners.js allow; everything else gets the one answer every refusal
   already gets, so the sender learns nothing about why. */
function forwardTransitFrame(payload, link, facts) {
  const answer = (reply) => { try { link.send({ kind: 'transit-result', ref: payload.ref, answer: reply }); } catch (_error) { /* the link went */ } };
  const peer = link?.peerId;
  const from = isFamilyPeer(peer) ? 'family' : (isPartnerGateway(peer) ? 'partner' : 'other');
  const targetOperator = partnerOperatorOf(facts.toRelay);
  const target = familyIds().has(facts.toRelay)
    ? { family: 'self' }
    : (targetOperator ? { family: 'partner', operator: targetOperator } : { family: 'none' });
  const hop = payload.hop === undefined ? 0 : payload.hop;
  const verdict = partnerRules.forwardRule({
    from,
    fromOperator: from === 'partner' ? partnerOperatorOf(peer) : '',
    selfGateway: selfIsGateway(),
    target,
    hop,
    carryBetween: carriesBetween(),
    partnerNames: (operatorId) => heldList(partnerLists, operatorId)?.operators || new Set(),
  });
  if (verdict.action === 'reject') return answer({ type: 'error', reason: 'transit-rejected' });
  const clientId = `relay:${peer}`;
  if ((transitWaitingByClient.get(clientId)?.size || 0) >= TRANSIT_WAIT_PER_CLIENT) return answer({ type: 'error', reason: 'transit-busy' });
  /* What a partner hands on goes to the relay it is for over that family's
     own gateways, never through yet another family. */
  carryToward(payload.envelope, facts, { clientId, tag: undefined, reply: answer, hop: hop + 1, viaAllowed: from === 'family' });
}

function receivePartnerFrame(payload, link) {
  const id = link?.peerId;
  const operatorId = partnerOperatorOf(id);
  const entry = partnerState.entries[operatorId];
  if (!entry || !partnerAllowed.has(id)) return;
  if (payload.kind === 'partner-directory') {
    const held = entry.directory?.body;
    const verdict = verifyDirectory(payload.doc, { operatorKey: entry.operatorKey, selfId: id, heldSerial: held?.serial || 0, heldBody: held || null });
    if (verdict.ok) {
      const before = partnerGatewaysOf(entry).map((gateway) => gateway.id);
      changePartner(operatorId, { directory: payload.doc }, `directory ${payload.doc.body.serial}`);
      notePartnerGatewayChange(operatorId, before);
    }
    return;
  }
  if (payload.kind === 'partner-gateways') {
    takeGatewayNotice(operatorId, payload.notice);
    return;
  }
  if (payload.kind === 'partner-list') {
    const verdict = partnerRules.verifyPartnerList(payload.list, { directoryBody: entry.directory?.body, heldAt: listHighWater.get(operatorId) || 0, maxAgeMs: PARTNER_LIST_MAX_AGE_MS });
    if (!verdict.ok) return;
    listHighWater.set(operatorId, verdict.list.updatedAt);
    partnerLists.set(operatorId, { ...verdict.list, doc: payload.list, by: payload.list.by, receivedAt: Date.now() });
    /* Passed on at once to the partners it names, if this family carries. */
    if (carriesBetween()) {
      for (const named of verdict.list.operators) {
        if (named !== operatorId && partnerState.entries[named]) sendToPartnerGateways({ kind: 'partner-list-relay', list: payload.list }, named);
      }
    }
    shareReach();
    return;
  }
  if (payload.kind === 'partner-list-relay') {
    const far = String(payload.list?.operatorId || '');
    const farEntry = partnerState.entries[far];
    if (!farEntry || far === operatorId || !ACTIVE_PARTNER.has(farEntry.state)) return;
    const verdict = partnerRules.verifyPartnerList(payload.list, { directoryBody: farEntry.directory?.body, heldAt: listHighWater.get(far) || 0, maxAgeMs: PARTNER_LIST_MAX_AGE_MS });
    if (verdict.ok) {
      listHighWater.set(far, verdict.list.updatedAt);
      relayedLists.set(far, { ...verdict.list, by: payload.list.by, receivedAt: Date.now() });
      shareReach();
    }
  }
  if (payload.kind === 'partner-keys') {
    for (const [relayId, key] of Object.entries(payload.keys || {}).slice(0, 256)) {
      if (partnerOperatorOf(relayId) === operatorId && relayIdFor(String(key || '')) === relayId) partnerKeys.set(relayId, String(key));
    }
    shareReach();
  }
}

function takeGatewayNotice(operatorId, notice) {
  const entry = partnerState.entries[operatorId];
  if (!entry?.directory?.body) return false;
  const verdict = partnerRules.verifyGatewayNotice(notice, { directoryBody: entry.directory.body, heldAt: entry.gatewayNotice?.updatedAt || 0 });
  if (!verdict.ok) return false;
  const before = partnerGatewaysOf(entry).map((gateway) => gateway.id);
  changePartner(operatorId, { gatewayNotice: verdict.set }, 'gateways changed');
  notePartnerGatewayChange(operatorId, before);
  return true;
}

/* Only a partner's gateway is held to the short list; a peer named by hand
   or a member of this family is not a partner, whatever a partner's
   directory claims. */
function partnerFrameRefused(payload, link) {
  const id = link?.peerId;
  if (!id || !partnerAllowed.has(id) || isFamilyPeer(id) || directoryState.manualIds.has(id)) return false;
  return !PARTNER_FRAME_KINDS.has(payload?.kind);
}

/* Our own directory changed: gateways may have changed, and the partners'
   gateways hear the new one. */
function partnersOnFamilyDirectory() {
  applyPartners();
  if (directoryState.doc) sendToPartnerGateways({ kind: 'partner-directory', doc: directoryState.doc });
}

