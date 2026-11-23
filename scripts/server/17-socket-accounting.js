/* ------------------------------------------------------------------
 * Socket accounting
 *
 * Nothing counted sockets, so one machine could hold as many as it could open
 * — measured at 120 of 120 accepted from a single address, and there was no
 * reason it would have stopped there. Each socket costs a file descriptor, a
 * presence entry and a heartbeat, so this is the cheapest denial of service
 * available against this server.
 *
 * A household behind one NAT is several devices and several tabs, so the
 * per-address ceiling is generous; it exists to stop a flood, not to ration
 * ordinary use.
 * ------------------------------------------------------------------ */
const WS_MAX_TOTAL = Number(process.env.CHAT_WS_MAX_TOTAL || CAPACITY.wsMaxTotal);
const WS_MAX_PER_IP = Number(process.env.CHAT_WS_MAX_PER_IP || CAPACITY.wsMaxPerIp);
/* Frame pricing for one socket. The refill is above what a busy client asks
   — the stress suite pushes a sustained ~180 frames per second per peer and
   a file transfer bursts hundreds of chunks inside a second — while a loop
   that replays get-peers or hello at line rate spends the burst and meets
   the answer inside the first moments. Overridable for the test suites,
   which is how every other ceiling here is sized. */
const WS_RATE_BURST = Number(process.env.CHAT_WS_RATE_BURST || 1024);
const WS_RATE_REFILL_PER_MS = Number(process.env.CHAT_WS_RATE_REFILL_PER_SECOND || 256) / 1000;
/* Frames refused in a row before the socket is closed: a client that keeps
   going this far past its budget is not a person's browser catching up. */
const WS_FLOOD_CLOSE_AFTER = Number(process.env.CHAT_WS_FLOOD_CLOSE_AFTER || 5000);
const wsPerAddress = new Map();
let wsTotal = 0;

/* The address a socket is counted under — by the same rule every HTTP
   security decision uses (securityKey: the hop our own nginx vouches for,
   counted from the right). It took the LEFTMOST X-Forwarded-For, which is
   whatever the client wrote, so one machine could rename itself per socket
   and open as many as it liked past the per-address cap. */
function socketAddress(request) {
  return securityKey(request) || 'unknown';
}

function rejectUpgrade(socket, status, reason) {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  } catch (_error) { /* the peer may already be gone */ }
  try { socket.destroy(); } catch (_error) { /* noop */ }
}

function trackSocket(ws, address) {
  wsTotal += 1;
  wsPerAddress.set(address, (wsPerAddress.get(address) || 0) + 1);
  const release = () => {
    if (ws.__poorijaReleased) return;
    ws.__poorijaReleased = true;
    wsTotal = Math.max(0, wsTotal - 1);
    const left = (wsPerAddress.get(address) || 1) - 1;
    if (left <= 0) wsPerAddress.delete(address);
    else wsPerAddress.set(address, left);
  };
  ws.once('close', release);
  ws.once('error', release);
}

/* Turned-away connections, counted.
 *
 * These refusals were invisible: the socket is rejected before any handler
 * runs, nothing is logged, and the browser reports the same "connection
 * failed" it would show for a server that is switched off. An operator had no
 * way to tell "nobody can reach me" from "some people are being turned away".
 *
 * It is not hypothetical. The per-address cap is
 * `clamp(20 + totalMemMb / 256, 20, 400)`, which is 35 on a 4 GB relay, and
 * mobile carriers put thousands of subscribers behind one address — under
 * CGNAT the thirty-sixth person on that network is refused and told nothing.
 * Whether 35 is the right number is a judgement about the deployment, and
 * CHAT_WS_MAX_PER_IP exists to change it; being able to SEE it happen is not a
 * judgement, it is the difference between a diagnosable problem and a mystery. */
const socketRefusals = { total: 0, perIp: 0, capacity: 0, lastAt: null, addresses: new Map() };

function noteRefusal(address, kind) {
  socketRefusals.total += 1;
  socketRefusals[kind] += 1;
  socketRefusals.lastAt = new Date().toISOString();
  socketRefusals.addresses.set(address, (socketRefusals.addresses.get(address) || 0) + 1);
  /* Bounded: one entry per address that has ever been refused would itself be
     a way to grow the process without limit. */
  if (socketRefusals.addresses.size > 200) {
    const oldest = socketRefusals.addresses.keys().next().value;
    socketRefusals.addresses.delete(oldest);
  }
}

/* Open files, against the process's own limit (Linux reports both in /proc).
   A socket is a file; so is every mailbox write and every HTTP request,
   health checks included. With the limit reached, new connections hung
   without an answer, the health endpoint went dark with them, and a mailbox
   write could fail. So sockets stop being accepted while a reserve is left
   for everything else. */
const fileGuard = { open: 0, limit: 0, checkedAt: 0 };
function readFileLimit() {
  try {
    const line = fs.readFileSync('/proc/self/limits', 'utf8').split('\n').find((row) => row.startsWith('Max open files'));
    const soft = Number(String(line || '').trim().split(/\s{2,}/)[1]);
    return Number.isFinite(soft) && soft > 0 ? soft : 0;
  } catch (_error) {
    return 0;
  }
}
function refreshFileGuard() {
  try {
    fileGuard.open = fs.readdirSync('/proc/self/fd').length;
    fileGuard.limit = fileGuard.limit || readFileLimit();
  } catch (_error) {
    fileGuard.open = 0;
  }
  fileGuard.checkedAt = Date.now();
}
setInterval(refreshFileGuard, 2000).unref?.();
refreshFileGuard();
/* Memory, against the container's own limit (cgroup) or the machine's. Past
   three quarters of it, or with the machine itself nearly out, new sockets
   wait: the relay was killed outright by the kernel at 7,000 sockets, taking
   everybody with it, and a crowd reconnecting at once would do it again. */
function memoryLimitBytes() {
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const value = Number(fs.readFileSync(file, 'utf8').trim());
      if (Number.isFinite(value) && value > 0 && value < os.totalmem()) return value;
    } catch (_error) { /* not this cgroup version */ }
  }
  return os.totalmem();
}
/* Read again every minute: the dashboard can change a container's memory
   ceiling while it runs (ops-memory-set), and the guard has to follow. */
let MEMORY_LIMIT_BYTES = memoryLimitBytes();
setInterval(() => { MEMORY_LIMIT_BYTES = memoryLimitBytes(); }, 60000).unref?.();
function memoryNearlyExhausted() {
  const rss = process.memoryUsage.rss ? process.memoryUsage.rss() : process.memoryUsage().rss;
  if (rss > MEMORY_LIMIT_BYTES * 0.75) return true;
  return os.freemem() < 96 * 1024 * 1024 && rss > 256 * 1024 * 1024;
}
function filesNearlyExhausted() {
  if (!fileGuard.limit) return false;
  /* Between readings, each socket accepted since counts too (see
     socketBudgetRefused); a fresh reading at most twice a second. */
  if (Date.now() - fileGuard.checkedAt > 500) refreshFileGuard();
  const reserve = Math.max(64, Math.floor(fileGuard.limit * 0.1));
  return fileGuard.open >= fileGuard.limit - reserve;
}
/* ---- alerts to the operator (scripts/lib/relay-alerts.js) -------------------
 *
 * Telegram, from the relay that has the bot's token and a chat to send to;
 * every other relay hands its messages over its transit link to one that does.
 */
const alertChatId = () => telegramSettings.get().chatId;
const ALERT_LABEL_DEFAULT = String(process.env.CHAT_ALERT_LABEL || '').trim() || (() => {
  try { return new URL(process.env.CHAT_PUBLIC_RELAY_ORIGIN || '').hostname || os.hostname(); } catch (_error) { return os.hostname(); }
})();
/* The name this server goes by on its cards: the panel's, else .env's, else
   its domain's. */
const alertLabel = () => telegramSettings.get().label || ALERT_LABEL_DEFAULT;
/* coturn's relay ports, as config/docker-compose.yaml hands them to it. */
const TURN_PORT_MIN = Number(process.env.CHAT_TURN_PORT_MIN || 40000);
const TURN_PORT_MAX = Number(process.env.CHAT_TURN_PORT_MAX || 40500);
const COTURN_CONTAINER = process.env.COTURN_CONTAINER || 'P00RIJA-Chat_Coturn';
const alertState = createAlertState({ label: ALERT_LABEL_DEFAULT, remindMs: () => telegramSettings.get().remindHours * 3600000 });
/* The relays alerts may go to and come from, by id. Named outright, never
   "whoever is linked": an alert says how full this machine is and what it is
   called, and a transit link can be with another operator's relay, who has
   no business reading that — or writing into this operator's Telegram. */
const ALERT_PEERS_NAMED = new Set(String(process.env.CHAT_ALERT_PEERS || '').split(',').map((id) => id.trim().toLowerCase()).filter((id) => /^[a-f0-9]{64}$/.test(id)));
/* None named: the relay's family (its operator's directory), so a new member
   of the family needs no line of its own in anybody's .env. */
const alertPeers = () => (ALERT_PEERS_NAMED.size ? ALERT_PEERS_NAMED : new Set(directoryMembers()));
/* Waiting for Telegram, or for the link to the relay that has it: { id,
   text, fromPeer, sentAt }. Over a link one is in flight at a time and stays
   first until the far relay acknowledges it, so a link that drops mid-send
   loses nothing and the order holds. */
const alertOutbox = [];
const ALERT_OUTBOX_LIMIT = 50;
/* What a peer may take of the outbox: its alerts can never push this relay's
   own out. */
const ALERT_PEER_SHARE = 20;
const alertPeerDownSince = new Map();
const alertsFromPeers = new Map();
const alertIdsSeen = new Set();
let alertNetworkBefore = null;
let alertsChecking = false;
let alertsFlushing = false;
const alertsByTelegram = () => Boolean(telegramToken() && alertChatId());

/* Which of the operator's categories (scripts/lib/telegram-settings.js) a
   card of each level falls in, when it does not say. */
const CATEGORY_OF_LEVEL = { warn: 'warn', critical: 'critical', ok: 'resolved', start: 'start', test: 'test', security: 'security', partner: 'partner', peer: 'peer', update: 'update', info: 'report' };

/* An event for the operator: { level, title, body }. The card is drawn when
   it is sent, with the server's state of that moment. fromPeer and report
   are for a card another relay of the family sent over its link. `force`
   is the panel's test, which goes whatever the categories and quiet hours. */
function queueReport({ level = 'info', title = '', body = '', category = '', force = false }, fromPeer = '', report = null) {
  if (fromPeer && alertOutbox.filter((entry) => entry.fromPeer).length >= ALERT_PEER_SHARE) return;
  const kind = telegramConfig.CATEGORIES.includes(category) ? category : (report?.category || CATEGORY_OF_LEVEL[level] || 'peer');
  alertOutbox.push({ id: crypto.randomBytes(8).toString('hex'), level, category: kind, force: Boolean(force), title: String(title), body: String(body), report, fromPeer, at: Date.now(), sentAt: 0 });
  /* Full: the oldest of a peer's go first, then the oldest of this relay's. */
  while (alertOutbox.length > ALERT_OUTBOX_LIMIT) {
    const peerIndex = alertOutbox.findIndex((entry) => entry.fromPeer);
    alertOutbox.splice(peerIndex >= 0 ? peerIndex : 0, 1);
  }
  console.log(`[Alerts] ${fromPeer ? `[${fromPeer.slice(0, 12)}] ` : ''}${title || report?.title || ''}${body || report?.body ? `: ${body || report?.body}` : ''}`);
}
/* A plain line, from a relay before 2.98.81 or anywhere else that has only text. */
const queueAlert = (text, fromPeer = '') => queueReport({ level: fromPeer ? 'peer' : 'info', body: String(text) }, fromPeer);

/* The name this relay goes by, in full, and how it is right now. */
/* A name people know the relay by, never a bare address: an IP goes to
   nobody's Telegram. */
function publicHost() {
  let host = String(process.env.DOMAIN || '').trim();
  if (!host) {
    try { host = new URL(String(process.env.CHAT_ALLOWED_ORIGINS || '').split(',')[0].trim()).hostname; } catch (_error) { host = ''; }
  }
  return host && !net.isIP(host.replace(/^\[|\]$/g, '')) && host !== 'localhost' ? host : '';
}
function directoryIdentity(id) {
  const entry = directoryState.doc?.body?.relays?.find((relay) => relay.id === id) || {};
  const gateway = (typeof ownGatewaySet === 'function' ? ownGatewaySet() : []).find((candidate) => candidate.id === id);
  return { label: String(entry.name || ''), region: entry.region || '', cluster: entry.cluster || '', gateway: gateway ? gateway.priority : Number(entry.gateway) || 0, relayId: id };
}
function selfIdentity() {
  return { ...directoryIdentity(relayIdentity.id), label: alertLabel(), host: publicHost(), version: RELAY_BUILD?.version || '', build: RELAY_BUILD?.buildTag || '' };
}
function liveUserCount() {
  const now = Date.now();
  let count = 0;
  for (const record of presence.values()) {
    if (record.ws?.readyState === WebSocket.OPEN && now - (record.lastSeenAt || 0) <= PRESENCE_TTL_MS && hasUsableIdentity(record) && !getRestrictionForIdentity(record)) count += 1;
  }
  return count;
}
async function liveSnapshot() {
  const stat = await fsp.statfs(defaultDataDir).catch(() => null);
  const memory = readMeminfo();
  const status = relayPeers.status();
  let turnRunning = null;
  if (TURN_URLS.length && dockerAvailable()) {
    const state = await dockerEngineJson('GET', `/v1.44/containers/${encodeURIComponent(COTURN_CONTAINER)}/json`);
    if (state.ok) turnRunning = Boolean(state.data?.State?.Running);
  }
  const boxes = typeof offlineBoxes === 'undefined' ? null : offlineBoxes;
  return {
    users: liveUserCount(),
    queued: boxes ? Array.from(boxes.values()).reduce((sum, box) => sum + box.length, 0) : null,
    mailboxes: boxes ? boxes.size : null,
    cpu: Math.min(100, (os.loadavg()[0] / Math.max(1, os.cpus().length)) * 100),
    memory: memory ? { used: memory.total - memory.available, total: memory.total } : null,
    relay: { rss: process.memoryUsage.rss(), limit: MEMORY_LIMIT_BYTES < os.totalmem() ? MEMORY_LIMIT_BYTES : 0 },
    disk: stat ? { used: (Number(stat.blocks) - Number(stat.bavail)) * Number(stat.bsize), total: Number(stat.blocks) * Number(stat.bsize) } : null,
    links: { up: status.up, allowed: status.allowed, hybrid: status.hybrid },
    turn: TURN_URLS.length ? { running: turnRunning, used: turnPortsInUse(TURN_PORT_MIN, TURN_PORT_MAX), size: TURN_PORT_MAX - TURN_PORT_MIN + 1 } : null,
    uptime: process.uptime(),
    hostUptime: os.uptime(),
  };
}
const activeProblems = () => alertState.active().map(({ level, text }) => ({ level, text }));
async function ownReport(entry = {}) {
  return { level: entry.level || 'info', category: entry.category || '', title: entry.title || '', body: entry.body || '', at: entry.at || Date.now(), identity: selfIdentity(), snapshot: await liveSnapshot(), problems: activeProblems() };
}
/* The card for one queued event: a peer's from the fields it sent, with the
   id its link proved; this relay's own with its state as it is sent. */
async function cardFor(entry) {
  if (entry.fromPeer) {
    const fields = entry.report || { level: 'peer', body: entry.body, at: entry.at, identity: directoryIdentity(entry.fromPeer) };
    const cleaned = relayReport.cleanReport(fields);
    if (!cleaned.identity.label) cleaned.identity.label = directoryIdentity(entry.fromPeer).label;
    return relayReport.renderCard({ ...cleaned, provenId: entry.fromPeer, ...cardOptions() });
  }
  return relayReport.renderCard({ ...relayReport.cleanReport(await ownReport(entry)), provenId: relayIdentity.id, ...cardOptions() });
}
/* How the operator wants a card drawn: language, time zone, footer, and how
   much of the server and its state to show. */
function cardOptions(current = telegramSettings.get()) {
  const design = current.templates;
  return {
    lang: current.language, timezone: current.timezone, footer: design.footer, showIdentity: design.showIdentity, showSnapshot: design.showSnapshot,
    style: design.style, separator: design.separator, direction: design.direction, icons: design.icons, quote: design.quote, custom: design.custom,
  };
}

/* What the operator's settings make of one card: not sent (the bot off, or
   its category off), held for the end of quiet hours, sent without a sound,
   or sent. A critical card sounds through a mute, and through quiet hours
   when the operator lets it. */
function deliveryFor(entry, at = Date.now()) {
  const current = telegramSettings.get();
  /* This relay's own test from the panel proves the way, whatever the
     categories say. Only that: force is never set for what a peer sent, and
     a peer naming its card a test gets no further than any other card. */
  if (entry.force && !entry.fromPeer) return { send: true, silent: false };
  if (!current.enabled) return { send: false, why: 'bot-off' };
  const flags = current.categories[entry.category] || { on: true, silent: false };
  if (!flags.on) return { send: false, why: 'category-off' };
  const critical = entry.level === 'critical';
  if (telegramSettings.quietNow(at) && !(critical && current.quiet.criticalPasses)) {
    return current.quiet.mode === 'hold' ? { send: false, hold: true, why: 'quiet-hours' } : { send: true, silent: true };
  }
  if (telegramSettings.muted(at) && !critical) return { send: true, silent: true };
  return { send: true, silent: Boolean(flags.silent) && !critical };
}

/* What the bot sent lately, and what it did not and why, for the panel. */
const telegramSentLog = [];
function noteTelegram(entry) {
  telegramSentLog.push({ at: Date.now(), ...entry });
  while (telegramSentLog.length > 60) telegramSentLog.shift();
}
let telegramLastSentAt = 0;
/* One card to the operator's chat: in its category's forum topic, silent
   when the settings say so, with the buttons on an alert, and no sooner after
   the last than the operator's gap. */
async function sendCard(html, { category = 'report', level = 'info', title = '', silent = false, buttons = false } = {}) {
  const current = telegramSettings.get();
  const wait = current.minGapSeconds * 1000 - (Date.now() - telegramLastSentAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  const extra = {};
  if (silent) extra.disable_notification = true;
  const topic = telegramSettings.topicFor(category);
  if (topic) extra.message_thread_id = Number(topic);
  if (buttons && current.buttons) {
    const words = textFor(current.language).buttons;
    extra.reply_markup = { inline_keyboard: [[{ text: words.mute, callback_data: 'mute:3600' }, { text: words.status, callback_data: 'status' }]] };
  }
  const ok = await sendTelegram(telegramToken(), current.chatId, html, { html: true, extra });
  telegramLastSentAt = Date.now();
  noteTelegram({ category, level, title: String(title).slice(0, 120), ok, silent: Boolean(silent) });
  return ok;
}

/* The link to hand alerts to: a named or family relay that said it has the
   bot, else the first linked one. */
function alertLink() {
  const linked = Array.from(alertPeers()).map((id) => relayPeers.linkFor(id)).filter((candidate) => candidate?.isOpen());
  return linked.find((link) => familyLinksFrom.get(link.peerId)?.telegram) || linked[0] || null;
}

/* Oldest first, stopping at the first that cannot go yet: order is kept, and
   nothing is lost to a Telegram or a link that is down for a while. */
async function flushAlerts() {
  if (alertsFlushing) return;
  alertsFlushing = true;
  try {
    while (alertOutbox.length) {
      if (alertsByTelegram()) {
        /* The first that may go now: one held for the end of quiet hours
           stays where it is, and the next is looked at. */
        let entry = null;
        let decision = null;
        for (const candidate of alertOutbox) {
          const verdict = deliveryFor(candidate);
          if (verdict.hold) continue;
          entry = candidate;
          decision = verdict;
          break;
        }
        if (!entry) return;
        const title = entry.report?.title || entry.title || '';
        if (decision.send && !await sendCard(await cardFor(entry), { category: entry.category, level: entry.level, title, silent: decision.silent, buttons: ['warn', 'critical'].includes(entry.level) })) return;
        if (!decision.send) noteTelegram({ category: entry.category, level: entry.level, title: String(title).slice(0, 120), ok: false, skipped: decision.why });
        const at = alertOutbox.indexOf(entry);
        if (at >= 0) alertOutbox.splice(at, 1);
        continue;
      }
      const entry = alertOutbox[0];
      /* The bot is off on this relay: nothing of its own leaves it. */
      if (!telegramSettings.get().enabled && !entry.force) {
        alertOutbox.shift();
        continue;
      }
      /* Sent and not yet acknowledged: wait a minute before sending it again. */
      if (entry.sentAt && Date.now() - entry.sentAt < 60000) return;
      const link = alertLink();
      if (!link) return;
      const report = await ownReport(entry);
      link.send({ kind: 'alert', id: entry.id, text: [report.title, report.body].filter(Boolean).join(': '), report });
      entry.sentAt = Date.now();
      return;
    }
  } finally {
    alertsFlushing = false;
  }
}
/* From a linked relay named in CHAT_ALERT_PEERS (or of the family), authenticated by the link:
   sent on only from a relay that can, never passed along again (no loops),
   at most thirty an hour per link, and drawn here from its fields with the
   id the link proved — what a relay says of itself on its own could claim
   to be any relay. Acknowledged even when already seen: the sender resends
   until it hears back. */
function receiveRelayAlert(payload, link) {
  if (!alertPeers().has(link.peerId) || !alertsByTelegram()) return;
  const id = /^[a-f0-9]{16}$/.test(String(payload.id || '')) ? payload.id : '';
  if (id) link.send({ kind: 'alert-ack', id });
  if (id && alertIdsSeen.has(id)) return;
  if (id) {
    alertIdsSeen.add(id);
    if (alertIdsSeen.size > 500) alertIdsSeen.delete(alertIdsSeen.values().next().value);
  }
  const now = Date.now();
  const tally = alertsFromPeers.get(link.peerId) || { since: now, count: 0 };
  if (now - tally.since > 3600000) { tally.since = now; tally.count = 0; }
  tally.count += 1;
  alertsFromPeers.set(link.peerId, tally);
  if (tally.count > 30) return;
  if (payload.report && typeof payload.report === 'object') {
    const report = relayReport.cleanReport(payload.report);
    queueReport({ level: report.level, title: report.title, body: report.body, category: report.category }, link.peerId, report);
  } else {
    const text = String(payload.text || '').replace(/[\u0000-\u001f\u2028\u2029]+/g, ' ').trim().slice(0, 1500);
    if (!text) return;
    queueAlert(text, link.peerId);
  }
  flushAlerts().catch(() => {});
}
/* The far relay has it: the next one may go. */
function receiveRelayAlertAck(payload, link) {
  const entry = alertOutbox[0];
  if (!entry || entry.id !== payload.id || !alertPeers().has(link.peerId)) return;
  alertOutbox.shift();
  flushAlerts().catch(() => {});
}

