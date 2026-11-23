/* ---- the bot's settings, for the central panel's Telegram section --------
   Reading shows the token masked, never whole. Writing is a signed request
   on a locked relay (scripts/lib/operator-signature.js): whoever sets the
   token and the chat reads every alert. */
app.get('/Monitor_Server/telegram', authMiddleware, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    settings: telegramSettings.view(),
    sends: alertsByTelegram(),
    via: alertsByTelegram() ? 'telegram' : (Array.from(alertPeers()).some((id) => relayPeers.linkFor(id)?.isOpen()) ? 'relay-link' : 'none'),
    waiting: alertOutbox.length,
    held: alertOutbox.filter((entry) => deliveryFor(entry).hold).length,
    active: alertState.active(),
    chats: Array.from(telegramChatsSeen.values()).reverse(),
    choices: { categories: telegramConfig.CATEGORIES, alertKeys: telegramConfig.ALERT_KEYS, commands: telegramConfig.COMMANDS, topics: telegramConfig.TOPICS, languages: ['fa', 'en'] },
    label: alertLabel(),
  });
});
app.post('/Monitor_Server/telegram', authMiddleware, async (req, res) => {
  const body = req.body || {};
  const hasToken = Object.prototype.hasOwnProperty.call(body, 'token');
  if (hasToken && body.token !== '' && !telegramConfig.validToken(body.token)) { res.status(400).json({ ok: false, reason: 'token' }); return; }
  const before = telegramSettings.get();
  const tokenBefore = telegramToken();
  if (body.reset === true) telegramSettings.reset();
  if (body.settings !== undefined) {
    const changed = telegramSettings.update(body.settings);
    if (!changed.ok) { res.status(400).json({ ok: false, reason: changed.reason }); return; }
  }
  if (hasToken) telegramSettings.setToken(body.token);
  const after = telegramSettings.get();
  monitorLog(`Telegram settings changed${hasToken ? ' (token)' : ''}${req.signedBy ? ` by ${req.signedBy}` : ''}`);
  if (telegramToken() !== tokenBefore) startTelegramReader();
  else if (before.language !== after.language || JSON.stringify(before.commands) !== JSON.stringify(after.commands)) syncTelegramCommands().catch(() => {});
  flushAlerts().catch(() => {});
  res.json({ ok: true, settings: telegramSettings.view() });
});
/* A card of any category drawn as the settings would draw it now, without
   sending it: what the panel shows beside the form. */
app.post('/Monitor_Server/telegram/preview', authMiddleware, async (req, res) => {
  const category = telegramConfig.CATEGORIES.includes(req.body?.category) ? req.body.category : 'warn';
  /* The card as the form being edited would draw it, before it is saved. */
  let options = cardOptions();
  if (req.body?.settings !== undefined) {
    const tried = telegramSettings.tryOn(req.body.settings);
    if (!tried.ok) return res.status(400).json(tried);
    options = cardOptions(tried.settings);
  }
  const T = botText();
  const level = { resolved: 'ok', reminder: 'warn', report: 'info' }[category] || category;
  if (category === 'report') {
    res.json({ ok: true, html: relayReport.renderFleet({ entries: [{ answered: true, provenId: relayIdentity.id, report: relayReport.cleanReport(await ownReport()) }], title: T.fleet.daily, ...options }) });
    return;
  }
  const sample = {
    warn: [T.alertTitles.disk, T.alert.disk({ free: '3.1 GB', total: '48 GB', pct: 6 })],
    critical: [T.alertTitles['turn-down'], T.alert['turn-down']()],
    resolved: [T.resolved(T.alertTitles.disk), T.alert.disk({ free: '3.1 GB', total: '48 GB', pct: 6 })],
    reminder: [`${T.alertTitles.memory}${T.stillOn}`, T.alert.memory({ free: '210 MB', total: '4.0 GB', pct: 5 })],
    start: [T.start.title, T.start.body], test: [T.test.title, T.test.body], security: [T.security.title, T.security.body('/Monitor_Server/gateways', 'operator')],
    update: [T.update.titles.staged, T.update.staged(RELAY_BUILD.version || '0.0.0')], partner: [T.kinds.partner, '—'], peer: [T.kinds.peer, '—'],
  }[category];
  const html = relayReport.renderCard({ ...relayReport.cleanReport(await ownReport({ level, category, title: sample[0], body: sample[1] })), provenId: relayIdentity.id, ...options });
  res.json({ ok: true, html, delivery: deliveryFor({ category, level }) });
});
app.get('/Monitor_Server/telegram/log', authMiddleware, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, sent: telegramSentLog.slice().reverse(), chats: Array.from(telegramChatsSeen.values()).reverse() });
});

function socketBudgetRefused(request, socket) {
  const address = socketAddress(request);
  if (filesNearlyExhausted() || memoryNearlyExhausted()) {
    noteRefusal(address, 'capacity');
    rejectUpgrade(socket, 503, 'Service Unavailable');
    return true;
  }
  if (wsTotal >= WS_MAX_TOTAL) {
    noteRefusal(address, 'capacity');
    rejectUpgrade(socket, 503, 'Service Unavailable');
    return true;
  }
  if ((wsPerAddress.get(address) || 0) >= WS_MAX_PER_IP) {
    noteRefusal(address, 'perIp');
    rejectUpgrade(socket, 429, 'Too Many Requests');
    return true;
  }
  /* Counted the moment it is let in: a burst of sockets between two readings
     of /proc would otherwise all pass the guard on the same old number. The
     next reading corrects for any that have closed. */
  fileGuard.open += 1;
  return false;
}

function handlePresenceUpgrade(request, socket, head) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const restriction = getRestrictionForIdentity(upgradeRequestIdentity(request, url));
  if (restriction) {
    rejectRestrictedUpgrade(socket, restriction);
    return;
  }
  if (socketBudgetRefused(request, socket)) return;
  const address = socketAddress(request);
  wsServer.handleUpgrade(request, socket, head, (ws) => {
    trackSocket(ws, address);
    wsServer.emit('connection', ws, request);
  });
}

/* Delivering one envelope to one recipient on this relay.
 *
 * Lifted out of the socket handler unchanged so that a message arriving over
 * a transit link takes exactly this path and not a second one written to
 * resemble it. Retention, the push wording, the ephemeral and pushable lists,
 * the store-and-forward for a connected-but-asleep app: all of it is decided
 * here once, and a transit envelope gets the same decisions because it is the
 * same code.
 *
 * `reply` is how the sender is answered — a socket send for a local client, a
 * frame back down the link for a carried one. `fromFingerprint` is whoever
 * wrote it, which for a carried envelope the inner payload carries anyway:
 * this relay is the RECIPIENT'S relay, and it already knows everything about
 * its own users. What transit withholds is the carrying relay learning the
 * pair, not this one. */
/* ---- carrying somebody else's envelope ------------------------------- */
/* What a client hands over when its contact lives on another relay, and what
   comes back. This relay is the CARRIER here: it cannot open the envelope, so
   it cannot know who the message is for — which is the whole arrangement.
 *
 * It keeps one thing, in memory, for as long as it takes to answer: which
 * socket asked. Not the envelope, not the recipient's relay against the
 * sender, nothing on disk. A relay that stores nothing has nothing to hand
 * over, which is a security property and a legal one at the same time. */
/* Sixty seconds. Thirty was shorter than a slow international link can take
   to drain a burst of file chunks, and an envelope still sitting in the link's
   buffer was reported lost to a sender who then sent it again. A link that is
   really gone answers its waits at once (failTransitWaitsFor), so the longer
   wait only ever applies to a link that is up and slow. */
const TRANSIT_WAIT_MS = 60000;
/* How long an envelope may wait for a link that is mid-redial. */
const TRANSIT_PARK_MS = 10000;
/* Above this much unsent on a link, new envelopes are refused as busy. Well
   under the hard ceiling in relay-peers.js, so the refusal is a pacing signal
   and never the link being torn down. */
const TRANSIT_LINK_SOFT_LIMIT_BYTES = Number(process.env.CHAT_TRANSIT_LINK_SOFT_LIMIT_BYTES || 16 * 1024 * 1024);
/* How many envelopes one client may have in the air at once. Each carried
   envelope parks a closure holding the asking socket for the full minute,
   and nothing capped them: a single client could park the closure for every
   frame it could send, and each park keeps a socket and a reply path alive
   whether the far relay ever answers or not. Well above what a person's
   in-flight messages ever need; far below what a loop needs to hurt. */
const TRANSIT_WAIT_PER_CLIENT = Number(process.env.CHAT_TRANSIT_WAIT_PER_CLIENT || 256);
const transitWaiting = new Map();
const transitWaitingByClient = new Map();
function rememberTransitWait(ref, entry) {
  transitWaiting.set(ref, entry);
  const held = transitWaitingByClient.get(entry.clientId) || new Set();
  held.add(ref);
  transitWaitingByClient.set(entry.clientId, held);
}
function forgetTransitWait(ref) {
  const entry = transitWaiting.get(ref);
  if (!entry) return;
  transitWaiting.delete(ref);
  const held = transitWaitingByClient.get(entry.clientId);
  if (!held) return;
  held.delete(ref);
  if (!held.size) transitWaitingByClient.delete(entry.clientId);
}
setInterval(() => {
  const now = Date.now();
  for (const [ref, waiting] of transitWaiting) {
    if (waiting.expiresAt > now) continue;
    forgetTransitWait(ref);
    /* A wait that runs out is an answer, not a silence. The sender held a
       frame back for the whole of TRANSIT_WAIT_MS believing a carrier was
       carrying it; leaving that belief standing is how a link that died
       mid-carry turns into messages nobody admits to losing. The reply is
       the same shape a missing link already gets, so the client needs no
       new case to understand it. */
    try {
      waiting.reply({ type: 'error', reason: 'transit-unavailable', toRelay: waiting.toRelay, tag: waiting.tag });
    } catch (_error) { /* the socket that asked is gone; nothing to tell */ }
  }
}, 15000).unref?.();

function carryTransitEnvelope(envelope, { clientId, tag, reply }) {
  const facts = transitFacts(envelope);
  if (!facts.toRelay) {
    reply({ type: 'error', reason: 'transit-no-relay', tag });
    return;
  }
  if (facts.toRelay === relayIdentity.id) {
    /* Addressed to this relay, which means the sender worked out the route
       wrongly. Saying so is better than opening it here and quietly making
       the transit layer meaningless for that message. */
    reply({ type: 'error', reason: 'transit-loop', tag });
    return;
  }
  /* The per-client ceiling is checked before anything is parked, so a client
     that is already over it is told now rather than after a ten-second park. */
  if ((transitWaitingByClient.get(clientId)?.size || 0) >= TRANSIT_WAIT_PER_CLIENT) {
    reply({ type: 'error', reason: 'transit-busy', toRelay: facts.toRelay, tag });
    return;
  }
  carryToward(envelope, facts, { clientId, tag, reply });
}

/* The next link toward a relay: a link to it, or, for a relay of a partner's
   family, the best of the gateways on the way. A relay of this family is
   reached over its own link, or, when there is none, through one member
   that has one (only for the first hop, so a frame never wanders). */
function nextLinkToward(toRelay, { viaAllowed = true, detour = false } = {}) {
  const direct = relayPeers.linkFor(toRelay);
  if (direct) return direct;
  if (familyIds().has(toRelay)) return detour ? familyDetour(toRelay) : null;
  const operatorId = partnerOperatorOf(toRelay);
  if (operatorId && selfIsGateway()) {
    const route = routeToPartner(operatorId, { viaAllowed });
    if (route) return relayPeers.linkFor(route.id);
  }
  const info = reachView().get(toRelay);
  if (info) {
    const id = bestOwnGateway(info.gateways);
    if (id) return relayPeers.linkFor(id);
  }
  return null;
}

function carryToward(envelope, facts, { clientId, tag, reply, hop, viaAllowed = true }) {
  const detour = hop === undefined;
  const link = nextLinkToward(facts.toRelay, { viaAllowed, detour });
  if (link) {
    carryOverLink(link, envelope, facts, { clientId, tag, reply, hop });
    return;
  }
  /* The link might be mid-redial (a drop-to-redial cycle is under two
     seconds). Refusing instantly was turning a one-second window into a
     user-visible error, because the client's retries all hit the same
     instant refusal. Park the envelope for up to ten seconds and carry it the
     moment a link stands again; only if the link is truly gone does the
     refusal go out.
     The park used to call `link.send` on the variable that had been null when
     it parked — the revived link was found and then never used — so every
     envelope sent during a redial ended as "transit-failed" with a TypeError
     in the log (Finland, 2026-10-06T17:27:52). The revived link is now the
     one carried on. */
  const parkDeadline = Date.now() + TRANSIT_PARK_MS;
  const parkTimer = setInterval(() => {
    const revived = nextLinkToward(facts.toRelay, { viaAllowed, detour });
    if (revived) {
      clearInterval(parkTimer);
      carryOverLink(revived, envelope, facts, { clientId, tag, reply, hop });
      return;
    }
    if (Date.now() > parkDeadline) {
      clearInterval(parkTimer);
      reply({ type: 'error', reason: 'transit-unavailable', toRelay: facts.toRelay, tag });
    }
  }, 250);
  parkTimer.unref?.();
}

/* Hands one envelope to one live link and parks the asking socket's reply
   until the far relay answers. Every failure here is an answer to the sender,
   never a throw: this runs inside the socket receive handler, and a throw
   from it used to take the whole relay down. */
function carryOverLink(activeLink, envelope, facts, { clientId, tag, reply, hop }) {
  try {
    /* The envelope is a parsed object on this side of the socket; its wire
       size is the JSON. Buffer.byteLength(object) THROWS — and this sits in
       the WS receive path, so one cross-relay message killed the whole relay. */
    const wireBytes = Buffer.byteLength(JSON.stringify(envelope));
    /* A link with a backlog is a slow border, not a dead one. Refusing with a
       retryable "busy" lets the client pace itself; piling more behind the
       backlog only makes every envelope in it later, until their waits run
       out and they are all reported lost together. */
    if (typeof activeLink.bufferedBytes === 'function'
      && activeLink.bufferedBytes() + wireBytes > TRANSIT_LINK_SOFT_LIMIT_BYTES) {
      reply({ type: 'error', reason: 'transit-busy', toRelay: facts.toRelay, tag });
      return;
    }
    noteTransitTraffic(facts.toRelay, wireBytes);
    /* The badge in the users table: this sender's traffic just crossed a relay
       link. What crossed stays sealed — but its SIZE is not private, and the
       presence probes a same-relay user's app fires at cross-relay contacts
       are a few hundred bytes. A kilobyte is a message, not a probe. */
    if (wireBytes >= 1024) noteTransitActivity(clientId);
    /* The carrier's own correlation id, not the client's tag. The tag belongs
       to the client and there is no reason for another relay to see it. */
    const ref = crypto.randomUUID();
    /* `via` is the link it leaves by, which is not the relay it is for when
       it goes through a gateway: that link dropping is what ends the wait. */
    rememberTransitWait(ref, {
      clientId, tag, reply, toRelay: facts.toRelay, via: activeLink.peerId, expiresAt: Date.now() + TRANSIT_WAIT_MS,
    });
    const frame = hop === undefined ? { kind: 'transit', ref, envelope } : { kind: 'transit', ref, envelope, hop };
    if (!activeLink.send(frame)) {
      forgetTransitWait(ref);
      reply({ type: 'error', reason: activeLink.isOpen() ? 'transit-busy' : 'transit-unavailable', toRelay: facts.toRelay, tag });
      return;
    }
    if (wireBytes >= 1024) console.log(`[Transit] carried ${facts.bytes} bytes for ${facts.toRelay.slice(0, 12)}`);
  } catch (transitError) {
    console.warn('[Transit] carry failed:', transitError.message);
    reply({ type: 'error', reason: 'transit-failed', tag });
  }
}

/* A link that goes down takes its unanswered envelopes with it: nothing will
   ever answer them. Saying so at once, rather than when each wait expires,
   is what lets a client re-send over the redialled link within seconds. Only
   when no other link to that relay remains — a duplicate link standing means
   the answers can still come back. */
function failTransitWaitsFor(relayId) {
  if (!relayId || relayPeers.linkFor(relayId)) return;
  for (const [ref, waiting] of transitWaiting) {
    if ((waiting.via || waiting.toRelay) !== relayId) continue;
    forgetTransitWait(ref);
    try {
      waiting.reply({ type: 'error', reason: 'transit-unavailable', toRelay: relayId, tag: waiting.tag });
    } catch (_error) { /* the socket that asked is gone */ }
  }
}

/* A frame off a relay link. Two kinds: an envelope to deliver here, and the
   answer to one this relay carried. */
/* At most this many presence questions from one peer relay in one minute.
   Generous for a person opening conversations, useless for a sweep. */
/* Shared by every question a linked relay may ask on behalf of its clients —
   presence, route and TURN. 240 was below what a handful of people with a
   screenful of cross-relay contacts produce, and an exhausted budget showed
   real contacts as offline. */
const PRESENCE_QUERY_PER_MINUTE = Number(process.env.CHAT_TRANSIT_QUERIES_PER_MINUTE || 1200);
const presenceQueryCounts = new WeakMap();
function presenceQueryAllowed(link) {
  const now = Date.now();
  const seen = presenceQueryCounts.get(link);
  if (!seen || now - seen.since > 60000) {
    presenceQueryCounts.set(link, { since: now, count: 1 });
    return true;
  }
  seen.count += 1;
  return seen.count <= PRESENCE_QUERY_PER_MINUTE;
}

function handleTransitFrame(payload, link) {
  if (payload?.kind === 'kt-head') {
    receiveKeyHead(payload, link);
    return;
  }
  if (payload?.kind === 'kt-consistency') {
    answerKeyConsistency(payload, link);
    return;
  }
  if (payload?.kind === 'kt-consistency-answer') {
    settleKeyConsistency(payload, link);
    return;
  }
  if (payload?.kind === 'partners') {
    receivePartners(payload, link);
    return;
  }
  if (payload?.kind === 'partner-directory' || payload?.kind === 'partner-keys' || payload?.kind === 'partner-gateways' || payload?.kind === 'partner-list' || payload?.kind === 'partner-list-relay') {
    receivePartnerFrame(payload, link);
    return;
  }
  if (payload?.kind === 'reach') {
    receiveReach(payload, link);
    return;
  }
  if (payload?.kind === 'family-links') {
    receiveFamilyLinks(payload, link);
    return;
  }
  if (payload?.kind === 'directory') {
    acceptDirectory(payload.doc, 'push');
    return;
  }
  if (payload?.kind === 'roster-copy') {
    receiveRosterCopy(payload, link);
    return;
  }
  if (payload?.kind === 'guest-notice') {
    receiveGuestNotice(payload, link);
    return;
  }
  if (payload?.kind === 'guest-end') {
    receiveGuestEndFrame(payload, link);
    return;
  }
  if (payload?.kind === 'guest-sibling') {
    receiveGuestSibling(payload, link);
    return;
  }
  if (payload?.kind === 'guest-sibling-end') {
    receiveGuestSiblingEnd(payload, link);
    return;
  }
  if (payload?.kind === 'home-move') {
    receiveHomeMove(payload, link);
    return;
  }
  if (payload?.kind === 'home-move-ack') {
    if (guestBook.pendingMoves().some((entry) => entry.fp === payload.fp && entry.home === link?.peerId)) guestBook.clearPendingMove(String(payload.fp));
    return;
  }
  if (payload?.kind === 'alert') {
    receiveRelayAlert(payload, link);
    return;
  }
  if (payload?.kind === 'alert-ack') {
    receiveRelayAlertAck(payload, link);
    return;
  }
  if (payload?.kind === 'status-request') {
    receiveStatusRequest(payload, link);
    return;
  }
  if (payload?.kind === 'status-report') {
    receiveStatusReport(payload, link);
    return;
  }
  if (payload?.kind === 'transit') {
    const outer = transitFacts(payload.envelope);
    if (outer.toRelay && outer.toRelay !== relayIdentity.id) {
      forwardTransitFrame(payload, link, outer);
      return;
    }
    let inner;
    try {
      inner = openTransit(relayPrivate, relayIdentity.id, payload.envelope);
    } catch (error) {
      /* Every refusal looks the same from the other side. Saying WHY an
         envelope did not open tells a carrier something about what was in
         it. */
      link.send({ kind: 'transit-result', ref: payload.ref, answer: { type: 'error', reason: 'transit-rejected' } });
      return;
    }
    /* A question about one of this relay's own clients, rather than something
     * to hand to one.
     *
     * Presence is per relay -- a relay broadcasts its own clients and nobody
     * else's -- so somebody on the far side is shown as offline for ever, which
     * is ignorance dressed up as knowledge. This answers for exactly ONE
     * fingerprint at a time, and only one already known to the asker: a
     * fingerprint is 256 bits, so it cannot be guessed, and holding one means
     * holding that person's card. It is also strictly less than this relay
     * already gives its own clients, who are handed every other client's
     * presence unasked.
     *
     * The rate limit is per link and per minute, so a peer relay cannot turn
     * this into a sweep even for fingerprints it does somehow hold.
     */
    if (inner?.type === 'presence-query' || inner?.type === 'route-query' || inner?.type === 'turn-query') {
      if (!presenceQueryAllowed(link)) {
        link.send({ kind: 'transit-result', ref: payload.ref, answer: { type: 'error', reason: 'transit-busy' } });
        return;
      }
      if (inner.type === 'turn-query') {
        /* A credential for THIS relay's coturn, for somebody on the asking
           relay whose call or transfer needs a TURN both ends can reach. The
           question names nobody; the answer is the same thing /turn-config
           gives any visitor, minted fresh and expiring. */
        link.send({ kind: 'transit-result', ref: payload.ref, answer: { type: 'turn', ...turnCredentialsForClient() } });
        return;
      }
      const asked = String(inner.toFingerprint || '').slice(0, 128);
      const up = Boolean(findOpenPresenceByFingerprint(asked));
      if (inner.type === 'route-query') {
        /* Does this person live here? Yes when they proved their key on this
           relay in the last ninety days. The origin goes with a yes so the
           asking client can file the route; the relay's id and key it
           already had, because it sealed this question to them. */
        /* A guest's socket is up, but they do not live here: they are named
           a guest instead, and the asking client keeps that route in memory
           only, never as the person's address. */
        const home = (residentSocketUp(asked) || identityLivesHere(asked)) && !guestBook.movedTo(asked);
        const guestHere = !home && guestBook.isGuest(asked);
        link.send({
          kind: 'transit-result',
          ref: payload.ref,
          answer: {
            type: 'route', toFingerprint: asked, home, up, origin: home || guestHere ? publicOriginForPeers() : '',
            ...(guestHere ? { guest: true, ...(guestNoticeFor(asked) ? { notice: guestNoticeFor(asked) } : {}) } : {}),
          },
        });
        return;
      }
      link.send({
        kind: 'transit-result',
        ref: payload.ref,
        /* `up` is a socket; `awake` is a person with the app in front of
           them, the same rule the presence table gives this relay's own
           clients (isAppAwake). The far side showed "online" for somebody
           whose phone had been in a pocket for an hour: same relay said
           away, another relay said up. */
        answer: { type: 'presence', toFingerprint: asked, up, awake: up ? isAppAwake(findOpenPresenceByFingerprint(asked)) : false },
      });
      return;
    }
    /* The relay's own voice never arrives by transit. A system-note is either
       a peer's (signed, checked where it is rendered) or THIS relay's (stamped
       with an id only this relay could put there). Anything else is somebody
       on another relay quoting a stamp they do not hold. */
    if (String(inner?.payload?.type || '') === 'system-note') {
      link.send({ kind: 'transit-result', ref: payload.ref, answer: { type: 'error', reason: 'transit-rejected' } });
      return;
    }
    deliverRelayMessage(inner, {
      /* Forwarded by a relay of the family (guest mode), not carried for a
         client: marked so it is never sent back there. */
      viaRelay: Number.isSafeInteger(inner?.fwd) && inner.fwd >= 1 && directoryMembers().includes(link.peerId) ? link.peerId : '',
      viaHops: Number.isSafeInteger(inner?.fwd) ? Math.min(Math.max(inner.fwd, 1), 9) : 0,
      clientId: '',
      /* Deliberately blank. For a local client this field is the fingerprint
         the relay CHALLENGED and the client proved; nothing was proved here,
         so presenting the sender's claim in the same field would be this
         relay vouching for something it did not check. The recipient reads
         the sender out of the sealed payload, where it can verify it. */
      fromFingerprint: '',
      reply: (answer) => link.send({ kind: 'transit-result', ref: payload.ref, answer }),
    });
    return;
  }
  if (payload?.kind === 'transit-result') {
    const waiting = transitWaiting.get(String(payload.ref || ''));
    if (!waiting) return;
    forgetTransitWait(String(payload.ref));
    waiting.reply({ ...transitAnswerForClient(payload.answer), tag: waiting.tag });
  }
}

/* What a linked relay is allowed to say to one of this relay's clients.
 *
 * The answer to a carried envelope is written by the OTHER relay and arrives
 * on this relay's socket to that client, which means passing it through
 * unchanged hands a peer relay a frame injector: 'server-kicked',
 * 'id-challenge', anything the client acts on. It is rebuilt here from the
 * two shapes a delivery can actually produce, field by field, and everything
 * else becomes a plain refusal. */
function transitAnswerForClient(answer) {
  const type = String(answer?.type || '');
  if (type === 'queued') {
    return {
      type: 'queued',
      toFingerprint: String(answer.toFingerprint || '').slice(0, 128),
      count: Number.isFinite(answer.count) ? answer.count : 0,
      /* Whether the far relay knows this recipient. Passed on only as a
         boolean; absent (older relay) stays absent. */
      ...(typeof answer.known === 'boolean' ? { known: answer.known } : {}),
    };
  }
  if (type === 'presence') {
    return {
      type: 'presence',
      toFingerprint: String(answer.toFingerprint || '').slice(0, 128),
      up: answer.up === true,
      /* Absent from an older relay, and then absent here too. */
      ...(typeof answer.awake === 'boolean' ? { awake: answer.awake && answer.up === true } : {}),
    };
  }
  if (type === 'route') {
    const origin = String(answer.origin || '');
    return {
      type: 'route',
      toFingerprint: String(answer.toFingerprint || '').slice(0, 128),
      home: answer.home === true,
      up: answer.up === true,
      origin: /^https?:\/\/[^/\s]{1,200}$/i.test(origin) ? origin : '',
      ...(answer.guest === true && answer.home !== true ? { guest: true, ...guestNoticeForClient(answer.notice) } : {}),
    };
  }
  if (type === 'turn') {
    /* Only TURN urls, only a handful, only plain strings: the client puts
       these into an RTCPeerConnection, and nothing else may ride along. */
    const urls = (Array.isArray(answer.urls) ? answer.urls : [])
      .map((url) => String(url || ''))
      .filter((url) => /^turns?:[^\s]{1,200}$/i.test(url))
      .slice(0, 6);
    return {
      type: 'turn',
      enabled: answer.enabled === true && urls.length > 0,
      urls,
      username: String(answer.username || '').slice(0, 128),
      credential: String(answer.credential || '').slice(0, 128),
      expiresAt: Number.isFinite(answer.expiresAt) ? answer.expiresAt : 0,
    };
  }
  if (type === 'error') {
    /* The reason is echoed only when it is one this relay would have sent
       itself, so a peer cannot invent a reason a client has a special path
       for. */
    /* transit-unavailable too: through a gateway the relay that has no way
       on is not the client's own, and the app re-sends on exactly that. */
    const known = new Set(['target-offline', 'target-restricted', 'transit-rejected', 'transit-busy', 'transit-unavailable']);
    const reason = String(answer.reason || '');
    return { type: 'error', reason: known.has(reason) ? reason : 'transit-rejected' };
  }
  return { type: 'error', reason: 'transit-rejected' };
}

/* A guest notice another relay passed on, rebuilt field by field: the client
   checks its signature, and nothing else may ride along. */
function guestNoticeForClient(notice) {
  const s = notice?.statement;
  if (!s || typeof s !== 'object' || typeof notice.sig !== 'string' || notice.sig.length > 1100) return {};
  const statement = { v: s.v, type: 'guest-route', fp: String(s.fp || '').slice(0, 64), guest: String(s.guest || '').slice(0, 64), until: Number(s.until) || 0 };
  return { notice: { statement, sig: notice.sig } };
}

