/* ---- guest mail ---------------------------------------------------------------
 *
 * Mail moves between relays as what it already is to the relay link: a
 * transit envelope, sealed to the receiving relay's key, delivered there by
 * the same code as any other (deliverRelayMessage). Marked `fwd` with the
 * number of relays it has been forwarded by, so the receiving relay never
 * sends it back where it came from, and nothing is forwarded more than twice
 * — a ring of relays each named as the next one's home cannot spin it. */
const GUEST_FORWARD_HOPS = 2;
const GUEST_RETENTION_MS = Number(process.env.CHAT_GUEST_RETENTION_MS || 3 * 24 * 60 * 60 * 1000);
const GUEST_SWEEP_MS = Number(process.env.CHAT_GUEST_SWEEP_MS || 10 * 60 * 1000);
const guestForwardInFlight = new Set();
const guestHeldBoxes = new Set();
/* Mail for someone who is a guest here, and not also living here. */
const guestHeldFor = (fingerprint) => guestBook.isGuest(fingerprint) && !identityLivesHere(fingerprint);
function dropMailItem(fingerprint, relayId) {
  const items = offlineBoxes.get(fingerprint) || [];
  const kept = items.filter((item) => item.relayId !== relayId);
  if (kept.length === items.length) return;
  if (kept.length) offlineBoxes.set(fingerprint, kept); else offlineBoxes.delete(fingerprint);
  saveOfflineBox(fingerprint);
}
/* Items to another relay of the family over its link; with `remove`, each
   leaves this mailbox once the far relay has queued it. Nothing goes without
   a link: the sweep tries again while the items are kept. */
function forwardMail(toRelay, fingerprint, items, { remove = false } = {}) {
  const link = relayPeers.linkFor(toRelay);
  if (!link || !link.peerKey || !items.length) return false;
  for (const item of items) {
    if (remove && guestForwardInFlight.has(item.relayId)) continue;
    let envelope;
    try {
      envelope = sealTransit(toRelay, link.peerKey, { type: 'relay', toFingerprint: fingerprint, payload: item.payload, persist: true, fwd: (Number(item.hops) || 0) + 1 });
    } catch (_error) { continue; }
    const ref = crypto.randomUUID();
    if (remove) guestForwardInFlight.add(item.relayId);
    rememberTransitWait(ref, {
      clientId: 'relay:guest-mail', tag: '', toRelay, via: link.peerId, expiresAt: Date.now() + TRANSIT_WAIT_MS,
      reply: (answer) => {
        guestForwardInFlight.delete(item.relayId);
        if (remove && answer?.type === 'queued') dropMailItem(fingerprint, item.relayId);
      },
    });
    if (!link.send({ kind: 'transit', ref, envelope })) {
      forgetTransitWait(ref);
      guestForwardInFlight.delete(item.relayId);
    }
  }
  return true;
}
/* What waits here for someone whose stay has ended, home — except anything
   that came from home in the first place. */
function forwardLeftovers(fingerprint, home) {
  if (!home || identityLivesHere(fingerprint) || guestBook.isGuest(fingerprint)) return;
  const items = (offlineBoxes.get(fingerprint) || []).filter((item) => item.via !== home && (Number(item.hops) || 0) < GUEST_FORWARD_HOPS);
  if (items.length) forwardMail(home, fingerprint, items, { remove: true });
}
/* Just queued here: for someone whose stay has ended, it goes on to their
   home for as long as the forwarding lasts. */
function forwardIfGuestLeft(fingerprint) {
  const forward = guestBook.forwarding(fingerprint);
  if (forward) forwardLeftovers(fingerprint, forward.relay);
  /* Moved home elsewhere: everything follows for thirty days. */
  if (guestBook.movedTo(fingerprint)) forwardMovedMail(fingerprint);
}
function guestSweep() {
  for (const ended of guestBook.sweep().ended) onGuestStayEnded(ended.fp, ended.home);
  retryPendingMoves();
  for (const { fp, relay } of guestBook.forwardingAll()) {
    if ((offlineBoxes.get(fp) || []).length) forwardLeftovers(fp, relay);
  }
  /* A guest's mail is kept for less time than a resident's. */
  if (!guestSweep.scanned) {
    guestSweep.scanned = true;
    for (const [fp, items] of offlineBoxes) if (items.some((item) => item.guestHeld)) guestHeldBoxes.add(fp);
  }
  const cutoff = Date.now() - GUEST_RETENTION_MS;
  for (const fp of Array.from(guestHeldBoxes)) {
    const items = offlineBoxes.get(fp) || [];
    const kept = items.filter((item) => !(item.guestHeld && Date.parse(item.queuedAt || 0) < cutoff));
    if (!kept.some((item) => item.guestHeld)) guestHeldBoxes.delete(fp);
    if (kept.length === items.length) continue;
    if (kept.length) offlineBoxes.set(fp, kept); else offlineBoxes.delete(fp);
    saveOfflineBox(fp);
  }
  pruneGuestCopies();
  guestSweep.rounds = (guestSweep.rounds || 0) + 1;
  if (guestSweep.rounds % 6 === 1) rosterCopyStore.sweep();
}
setInterval(() => { try { guestSweep(); } catch (error) { console.warn('[Guests] sweep failed:', error.message); } }, GUEST_SWEEP_MS).unref?.();

/* Guest mode at a glance, for the operator: who stays here as a guest, who of
   this relay's people is a guest elsewhere, and what is held for them. Counts
   only — no fingerprints. */
app.post('/Monitor_Server/guests', authMiddleware, (_req, res) => {
  const ids = (map) => Array.from(map.values()).reduce((sum, set) => sum + set.size, 0);
  res.json({
    ok: true,
    ...guestBook.stats(),
    guestSockets: liveGuestSockets(),
    takesGuests: Boolean(directoryState.doc?.body?.relays?.find((relay) => relay.id === relayIdentity.id)?.guests),
    siblings: Array.from(guestSiblings.values()).reduce((sum, held) => sum + held.size, 0),
    remoteCopied: ids(remoteGuestCopied),
    siblingCopied: ids(guestSiblingCopied),
  });
});

app.post('/Monitor_Server/identities', authMiddleware, (req, res) => {
  const rows = Array.from(knownIdentities).map((fp) => ({
    fingerprint: fp.slice(0, 16),
    connected: Array.from(presence.values()).some((record) => sanitizeFingerprint(identitySnapshot(record)?.fingerprint || '') === fp),
    mailbox: (offlineBoxes.get(fp) || []).length,
  }));
  res.json({ ok: true, total: rows.length, identities: rows.sort((a, b) => b.mailbox - a.mailbox).slice(0, 100) });
});

app.post('/Monitor_Server/announce', authMiddleware, async (req, res) => {
  const message = String(req.body?.message || '').trim().slice(0, 2000);
  const title = String(req.body?.title || '').trim().slice(0, 120) || 'پیام از سرور';
  if (!message && !req.body?.attachment) return res.status(400).json({ ok: false, reason: 'empty' });
  const attachmentRaw = req.body?.attachment || null;
  let attachment = null;
  if (attachmentRaw) {
    const dataUrl = String(attachmentRaw.dataUrl || '');
    if (!/^data:[\w./+-]+;base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) return res.status(400).json({ ok: false, reason: 'bad-data-url' });
    if (Buffer.byteLength(dataUrl) > ANNOUNCE_MAX_ATTACHMENT_BYTES) return res.status(400).json({ ok: false, reason: 'attachment-too-large' });
    attachment = {
      kind: ['image', 'sticker', 'file', 'audio'].includes(attachmentRaw.kind) ? attachmentRaw.kind : 'file',
      name: String(attachmentRaw.name || 'attachment').slice(0, 120),
      mimeType: String(attachmentRaw.mimeType || 'application/octet-stream').slice(0, 100),
      dataUrl,
    };
  }
  /* Everyone this relay has ever served: the persistent registry first (the
     whole point of it), plus connected now and mailbox holders — and every
     one of them is remembered from this moment on. A personal message names
     its targets and goes to exactly those. */
  const fingerprints = new Set();
  const targets = Array.isArray(req.body?.targets)
    ? req.body.targets.map((fp) => sanitizeFingerprint(String(fp || ''))).filter(Boolean)
    : [];
  if (targets.length) {
    for (const fp of targets) fingerprints.add(fp);
  } else {
    for (const fp of knownIdentities) fingerprints.add(fp);
    for (const key of offlineBoxes.keys()) fingerprints.add(key);
    for (const record of presence.values()) {
      const fp = sanitizeFingerprint(identitySnapshot(record)?.fingerprint || '');
      if (fp) fingerprints.add(fp);
    }
  }
  if (attachment && !targets.length && fingerprints.size > ANNOUNCE_ATTACHMENT_MAX_RECIPIENTS) {
    return res.status(400).json({ ok: false, reason: `attachment-broadcast-capped-at-${ANNOUNCE_ATTACHMENT_MAX_RECIPIENTS}`, hint: 'send attachments to named targets only' });
}
for (const fp of fingerprints) noteKnownIdentity(fp);
  let queued = 0;
  let live = 0;
  /* One id per announcement: the frame goes out live AND sits in the
     mailbox, and whichever arrives second must be recognised as the same
     announcement, not rendered (and rung) twice. */
  const announceId = crypto.randomUUID();
  /* The stamp the recipient checks against the relay identity it pinned:
   the relay's signing material cannot make signatures a browser verifies
   (its key is ECDH), so the stamp plus "no peer can send in the relay's
   name" (the fromFingerprint below is written by THIS server, and transit
   refuses the type) is what makes a server note unfakeable. */
  const payload = { type: 'system-note', announceId, message: message || attachment.name, title, attachment, relayId: relayIdentity.id };
  for (const fingerprint of fingerprints) {
    const items = offlineBoxes.get(fingerprint) || [];
    items.push({
      type: 'relay',
      relayId: crypto.randomUUID(),
      fromClientId: 'server-announce',
      fromFingerprint: 'monitor',
      payload,
      queuedAt: new Date().toISOString(),
    });
/* The mailbox flood gate: without a cap on mailbox count, one hostile
   socket fabricates a fresh fingerprint per frame and fills the disk. */
const MAILBOX_MAX_BOXES = 10000;
function mailboxCountOk() { return offlineBoxes.size < MAILBOX_MAX_BOXES; }

    if (!mailboxCountOk()) { reply({ type: 'error', reason: 'mailbox-full' }); return; }
    offlineBoxes.set(fingerprint, items);
    queued += 1;
    /* ONE delivery, ONE notification. The relay frame is the message — live
       now, from the mailbox after a reconnect — and the push wakes only the
       devices that are not already looking at the app. The first cut sent a
       broadcast frame AND a relay frame AND pushed to everybody, which is
       how one announcement learned to ring three times. */
    const target = findOpenPresenceByFingerprint(fingerprint);
    const awake = target ? isAppAwake(target) : false;
    if (target?.ws && target.ws.readyState === WebSocket.OPEN) {
      safeSend(target.ws, { type: 'relay', fromClientId: 'server-announce', fromFingerprint: 'monitor', relayId: crypto.randomUUID(), payload });
      live += 1;
    }
    if (!awake) {
      sendAdminPushNotification(fingerprint, (title ? title + ': ' : '') + String(message || attachment.name || '').slice(0, 160), 'admin-announce').catch(() => {});
    }
    /* Diagnostics the operator can check when a device rings twice: what
       was sent, to whom, and whether they were awake at the time. */
    monitorLog(`Announce → ${fingerprint.slice(0, 12)} (${awake ? 'awake, no push' : 'push sent'})`);
  }
  await saveOfflineBoxes();
  monitorLog(`Announcement to ${queued} identit${queued === 1 ? 'y' : 'ies'} (${live} live, push attempted)`);
  res.json({ ok: true, reached: queued, live });
});

/* ---- container memory -------------------------------------------------------
 *
 * What the machine really has, what each container is allowed, and the knob
 * itself: the engine's update endpoint changes a live container's memory
 * ceiling without a restart, and the restart button beside it is for when
 * the workload should be given a clean start on the new number. */

app.post('/Monitor_Server/ops-memory', authMiddleware, async (req, res) => {
  if (!dockerAvailable()) return res.json({ ok: false, reason: 'docker-socket-not-mounted' });
  const info = await dockerEngineJson('GET', '/v1.44/info');
  const containers = await dockerEngineJson('GET', '/v1.44/containers/json?all=1');
  const rows = [];
  for (const container of containers.data || []) {
    const name = String((container.Names || [])[0] || '').replace(/^\//, '');
    if (!/Poorija-Cryptography/.test(name)) continue;
    const detail = await dockerEngineJson('GET', `/v1.44/containers/${container.Id}/json`);
    const stats = await dockerEngineRequest('GET', `/v1.44/containers/${container.Id}/stats?stream=false`, null, { timeoutMs: 20000 });
    const statData = opsParseJson(stats.body);
    const limitBytes = Number(detail.data?.HostConfig?.Memory || 0);
    const usageBytes = Number(statData?.memory_stats?.usage || 0);
    const cpuDelta = Number(statData?.cpu_stats?.cpu_usage?.total_usage || 0) - Number(statData?.precpu_stats?.cpu_usage?.total_usage || 0);
    const sysDelta = Number(statData?.cpu_stats?.system_cpu_usage || 0) - Number(statData?.precpu_stats?.system_cpu_usage || 0);
    const onlineCpus = Number(statData?.cpu_stats?.online_cpus || 1) || 1;
    const cpuPct = sysDelta > 0 ? Math.round((cpuDelta / sysDelta) * onlineCpus * 100) : 0;
    rows.push({
      id: container.Id.slice(0, 12),
      name,
      limitMb: Math.round(limitBytes / 1024 / 1024) || null,
      usageMb: Math.round(usageBytes / 1024 / 1024) || 0,
      cpuPct: Math.min(999, cpuPct),
      cpuCapped: Number(detail.data?.HostConfig?.CpuQuota || 0) > 0,
      unlimited: !limitBytes,
    });
  }
  res.json({
    ok: true,
    host: {
      totalMb: Math.round(Number(info.data?.MemTotal || 0) / 1024 / 1024),
      cpus: info.data?.NCPU || 0,
      engine: info.data?.ServerVersion || '',
    },
    containers: rows,
  });
});

app.post('/Monitor_Server/ops-memory-set', authMiddleware, async (req, res) => {
  if (!dockerAvailable()) return res.json({ ok: false, reason: 'docker-socket-not-mounted' });
  const name = String(req.body?.container || '').trim();
  /* mb = 0 is a deliberate "back to unlimited": the engine's zero means no
     ceiling, which is how the stack started life and how every container
     except the ones an operator has touched still runs. cpu = a percentage
     of ONE core (50 = half a core, 200 = two cores), 0 = uncapped. */
  const rawMb = Math.round(Number(req.body?.mb ?? -1));
  const unlimited = rawMb === 0;
  const megabytes = unlimited ? 0 : Math.max(64, Math.min(16384, rawMb));
  const cpuPercent = Math.max(0, Math.min(800, Math.round(Number(req.body?.cpu ?? 0) || 0)));
  if (!/^P00RIJA-Chat_[\w-]+$/.test(name) || rawMb < 0 || (!unlimited && !megabytes)) {
    return res.status(400).json({ ok: false, reason: 'bad-request' });
  }
  const containers = await dockerEngineJson('GET', '/v1.44/containers/json?all=1');
  const target = (containers.data || []).find((container) => ((container.Names || [])[0] || '').replace(/^\//, '') === name);
  if (!target) return res.status(404).json({ ok: false, reason: 'no-such-container' });
  /* MemorySwap at twice the ceiling is the standard pairing: the heap may
     breathe past RSS a little, but never past a wall anyone can point at.
     CpuQuota is µs of CPU per 100ms period — 100000 = one whole core. */
  const update = await dockerEngineJson('POST', `/v1.44/containers/${target.Id}/update`, {
    Memory: megabytes * 1024 * 1024,
    MemorySwap: unlimited ? 0 : megabytes * 2 * 1024 * 1024,
    CpuPeriod: cpuPercent ? 100000 : undefined,
    CpuQuota: cpuPercent ? cpuPercent * 1000 : -1,
  });
  monitorLog(`Resources of ${name}: mem ${unlimited ? 'unlimited' : megabytes + ' MB'}, cpu ${cpuPercent ? cpuPercent + '%' : 'uncapped'} (${update.ok ? 'applied live' : 'failed'})`);
  res.json({
    ok: update.ok,
    container: name,
    mb: megabytes,
    unlimited,
    cpu: cpuPercent,
    note: update.ok ? 'applied to the running container; restart it if you want a clean start on the new number' : String(update.data?.message || '').slice(0, 200),
  });
});

