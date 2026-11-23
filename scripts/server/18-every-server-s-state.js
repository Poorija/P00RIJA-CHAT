/* ---- every server's state, for /status and the daily summary ------------- */

const STATUS_WAIT_MS = Math.max(1000, Number(process.env.CHAT_STATUS_WAIT_MS || 6000));
const statusWaits = new Map();
function receiveStatusRequest(payload, link) {
  if (!isFamilyPeer(link.peerId) && !alertPeers().has(link.peerId)) return;
  const id = /^[a-f0-9]{16}$/.test(String(payload.id || '')) ? payload.id : '';
  if (!id) return;
  ownReport({ level: 'info' }).then((report) => { try { link.send({ kind: 'status-report', id, report }); } catch (_error) { /* the link went */ } }).catch(() => {});
}
function receiveStatusReport(payload, link) {
  const wait = statusWaits.get(String(payload.id || ''));
  if (!wait || !wait.asked.has(link.peerId)) return;
  wait.entries.set(link.peerId, relayReport.cleanReport(payload.report || {}));
  if (wait.entries.size >= wait.asked.size) wait.done();
}
/* This relay and every member of its family, in the directory's order: each
   that answered with its state, each that did not by name. */
async function fleetStatus() {
  const members = directoryMembers();
  const asked = new Set(members.filter((id) => relayPeers.linkFor(id)?.isOpen?.()));
  const id = crypto.randomBytes(8).toString('hex');
  const entries = new Map();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, STATUS_WAIT_MS);
    timer.unref?.();
    statusWaits.set(id, { asked, entries, done: () => { clearTimeout(timer); resolve(); } });
    for (const member of asked) {
      try { relayPeers.linkFor(member).send({ kind: 'status-request', id }); } catch (_error) { /* the link went */ }
    }
    if (!asked.size) { clearTimeout(timer); resolve(); }
  });
  statusWaits.delete(id);
  const own = { answered: true, provenId: relayIdentity.id, report: relayReport.cleanReport(await ownReport()) };
  const order = (directoryState.doc?.body?.relays || []).map((relay) => relay.id);
  const others = members.map((member) => {
    const report = entries.get(member);
    if (report && !report.identity.label) report.identity.label = directoryIdentity(member).label;
    return report ? { answered: true, provenId: member, report } : { answered: false, provenId: member, report: relayReport.cleanReport({ identity: directoryIdentity(member) }) };
  });
  return [own, ...others].sort((a, b) => {
    const ia = order.indexOf(a.provenId); const ib = order.indexOf(b.provenId);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });
}

/* ---- the bot's commands, on the relay that has it ------------------------
   Only the operator's own chat is answered — and in it only the people the
   panel named, when it named any — and only when no webhook is set for the
   bot and nothing else is reading its updates. A chat the bot is not set
   for is remembered, not answered, so the panel can offer it. */
const telegramChatsSeen = new Map();
function noteTelegramChat(chat, from) {
  if (!chat || chat.id === undefined) return;
  const id = String(chat.id);
  telegramChatsSeen.delete(id);
  telegramChatsSeen.set(id, {
    id, type: String(chat.type || '').slice(0, 20), at: Date.now(),
    title: String(chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || '').replace(/[\u0000-\u001f<>]/g, '').slice(0, 60),
    username: String(chat.username || from?.username || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 32),
  });
  while (telegramChatsSeen.size > 10) telegramChatsSeen.delete(telegramChatsSeen.keys().next().value);
}
function telegramMayAsk(chat, from) {
  const current = telegramSettings.get();
  if (!chat || String(chat.id) !== current.chatId) return false;
  return !current.admins.length || current.admins.includes(String(from?.id ?? ''));
}
/* The commands the operator left on, described in the bot's language. */
function telegramCommandList() {
  const current = telegramSettings.get();
  const words = textFor(current.language).commands;
  return telegramConfig.COMMANDS.filter((command) => current.commands[command]).map((command) => ({ command, description: words[command] }));
}
async function syncTelegramCommands(token = telegramToken()) {
  if (!token) return;
  await telegramCall(token, 'setMyCommands', { commands: telegramCommandList() });
}
/* An answer in the chat and topic it was asked in. */
const replyTelegram = (message, html, extra = {}) => sendTelegram(telegramToken(), message.chat.id, html, {
  html: true, extra: { ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}), ...extra },
});
/* "30m", "2h", "1d" or nothing (an hour), up to seven days. */
function muteLength(text) {
  const match = /^(\d{1,4})([mhd]?)$/i.exec(String(text || '1h').trim());
  if (!match) return 0;
  const ms = Number(match[1]) * ({ m: 60000, h: 3600000, d: 86400000 }[(match[2] || 'h').toLowerCase()]);
  return ms > 0 && ms <= 7 * 86400000 ? ms : 0;
}
function localTime(at) {
  const current = telegramSettings.get();
  try {
    return new Intl.DateTimeFormat(current.language === 'fa' ? 'fa-IR' : 'en-GB', { timeZone: current.timezone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(at));
  } catch (_error) {
    return new Date(at).toISOString().slice(0, 16).replace('T', ' ');
  }
}
async function telegramAnswer(command, argument, message) {
  const current = telegramSettings.get();
  const T = textFor(current.language);
  const options = { lang: current.language, timezone: current.timezone };
  const allowed = (name) => current.commands[name];
  if (command === 'status' && allowed('status')) return replyTelegram(message, relayReport.renderFleet({ entries: await fleetStatus(), ...options }));
  if (command === 'servers' && allowed('servers')) return replyTelegram(message, relayReport.renderServers({ entries: await fleetStatus(), ...options }));
  if (command === 'alerts' && allowed('alerts')) {
    const lines = [];
    for (const entry of await fleetStatus()) {
      for (const problem of entry.report.problems || []) {
        lines.push(`${problem.level === 'critical' ? '🔴' : '🟡'} <b>${relayReport.escapeHtml(entry.report.identity.label || entry.provenId.slice(0, 12))}</b>: ${relayReport.escapeHtml(problem.text)}`);
      }
    }
    return replyTelegram(message, lines.length ? [`<b>🚦 ${T.replies.problems}</b>`, ...lines].join('\n').slice(0, 4000) : T.replies.noProblems);
  }
  if (command === 'updates' && allowed('updates')) {
    const staged = relayUpdates.status().staged?.version || '';
    const lines = (await fleetStatus()).map((entry) => `${entry.answered ? '🟢' : '⛔️'} <b>${relayReport.escapeHtml(entry.report.identity.label || entry.provenId.slice(0, 12))}</b>: <code>${relayReport.escapeHtml(entry.report.identity.version || T.replies.none)}</code>`);
    if (staged) lines.push('', `⬆️ ${T.replies.staged}: <code>${relayReport.escapeHtml(staged)}</code>`);
    return replyTelegram(message, [`<b>🏷 ${T.replies.updatesTitle}</b>`, ...lines].join('\n').slice(0, 4000));
  }
  if (command === 'version' && allowed('version')) return replyTelegram(message, T.replies.versionOf(relayReport.escapeHtml(alertLabel()), relayReport.escapeHtml(RELAY_BUILD.version || '—'), relayReport.escapeHtml(RELAY_BUILD.buildTag || '')));
  if (command === 'mute' && allowed('mute')) {
    const ms = muteLength(argument);
    if (!ms) return replyTelegram(message, T.replies.badMute);
    telegramSettings.mute(Date.now(), ms);
    return replyTelegram(message, T.replies.muted(localTime(Date.now() + ms)));
  }
  if (command === 'unmute' && allowed('unmute')) {
    telegramSettings.unmute();
    return replyTelegram(message, T.replies.unmuted);
  }
  if ((command === 'help' && allowed('help')) || command === 'start') {
    return replyTelegram(message, relayReport.renderHelp({ label: alertLabel(), lang: current.language, commands: telegramCommandList().map((entry) => entry.command) }));
  }
  return null;
}
async function answerTelegram(update) {
  /* A button under an alert: the same as its command. */
  if (update?.callback_query) {
    const query = update.callback_query;
    const message = query.message;
    const permitted = telegramMayAsk(message?.chat, query.from);
    await telegramCall(telegramToken(), 'answerCallbackQuery', { callback_query_id: query.id });
    if (!permitted) return;
    const data = String(query.data || '');
    if (data === 'status') await telegramAnswer('status', '', message);
    else if (/^mute:\d{1,6}$/.test(data)) await telegramAnswer('mute', `${Math.round(Number(data.slice(5)) / 60)}m`, message);
    return;
  }
  const message = update?.message;
  if (!message?.chat) return;
  if (String(message.chat.id) !== telegramSettings.get().chatId) { noteTelegramChat(message.chat, message.from); return; }
  if (!telegramMayAsk(message.chat, message.from)) return;
  const [first, ...rest] = String(message.text || '').trim().split(/\s+/);
  if (!first.startsWith('/')) return;
  await telegramAnswer(first.slice(1).replace(/@.*$/, '').toLowerCase(), rest.join(' '), message);
}
/* One reader of the bot's updates at a time: a new token from the panel
   starts a new one, and the old one stops at its next turn. */
let telegramReader = 0;
async function readTelegramCommands(turn) {
  const token = telegramToken();
  const hook = await telegramCall(token, 'getWebhookInfo', {});
  if (hook.json?.result?.url) { console.warn('[Telegram] the bot has a webhook; its commands are left to it'); return; }
  await syncTelegramCommands(token);
  /* What was sent while the relay was down is not answered now. */
  let offset = 0;
  const last = await telegramCall(token, 'getUpdates', { offset: -1, timeout: 0 });
  if (Array.isArray(last.json?.result) && last.json.result.length) offset = last.json.result[last.json.result.length - 1].update_id + 1;
  let conflicts = 0;
  while (turn === telegramReader) {
    const answer = await telegramCall(token, 'getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 40000);
    if (turn !== telegramReader) return;
    /* Another reader: the one before this, finishing its last turn, or
       something else entirely, which keeps the commands. */
    if (answer.status === 409) {
      conflicts += 1;
      if (conflicts > 3) { console.warn('[Telegram] something else reads this bot’s updates; its commands stay with it'); return; }
      await new Promise((resolve) => setTimeout(resolve, 30000));
      continue;
    }
    conflicts = 0;
    if (!answer.json?.ok || !Array.isArray(answer.json.result)) { await new Promise((resolve) => setTimeout(resolve, 15000)); continue; }
    for (const update of answer.json.result) {
      offset = Math.max(offset, Number(update.update_id) + 1);
      await answerTelegram(update).catch((error) => console.warn('[Telegram] a command failed:', error?.message || error));
    }
  }
}
function startTelegramReader(delayMs = 0) {
  telegramReader += 1;
  const turn = telegramReader;
  if (!telegramToken() || process.env.CHAT_TELEGRAM_COMMANDS === '0' || process.env.CHAT_ALERTS === '0') return;
  setTimeout(() => readTelegramCommands(turn).catch((error) => console.warn('[Telegram] commands stopped:', error?.message || error)), delayMs).unref?.();
}
startTelegramReader(3000);

/* Once a day, at the time the operator chose (CHAT_STATUS_REPORT_AT in .env,
   "09:00" unless set, "off" for none) in their time zone, every server's
   state. The day it went out is kept, so a restart after that hour does not
   send it twice. */
const STATUS_REPORT_FILE = process.env.CHAT_STATUS_REPORT_PATH || path.join(path.dirname(OFFLINE_STORE_PATH), 'status-report-day.txt');
let statusReportBusy = false;
async function maybeSendStatusReport() {
  const current = telegramSettings.get();
  if (statusReportBusy || !current.report.on || !alertsByTelegram()) return;
  const { day, time } = telegramSettings.clock();
  if (time < current.report.at) return;
  let sentDay = '';
  try { sentDay = fs.readFileSync(STATUS_REPORT_FILE, 'utf8').trim(); } catch (_error) { /* never sent */ }
  if (sentDay === day) return;
  const decision = deliveryFor({ category: 'report', level: 'info' });
  if (decision.hold) return;
  statusReportBusy = true;
  try {
    const title = textFor(current.language).fleet.daily;
    if (!decision.send) {
      noteTelegram({ category: 'report', level: 'info', title, ok: false, skipped: decision.why });
      fs.writeFileSync(STATUS_REPORT_FILE, `${day}\n`);
      return;
    }
    const html = relayReport.renderFleet({ entries: await fleetStatus(), title, lang: current.language, timezone: current.timezone });
    if (await sendCard(html, { category: 'report', level: 'info', title, silent: decision.silent })) fs.writeFileSync(STATUS_REPORT_FILE, `${day}\n`);
  } finally {
    statusReportBusy = false;
  }
}
if (process.env.CHAT_ALERTS !== '0') {
  setInterval(() => { maybeSendStatusReport().catch(() => {}); }, Math.max(1000, Number(process.env.CHAT_STATUS_REPORT_CHECK_MS || 30000))).unref?.();
}

async function alertReadings(limits) {
  const reading = {};
  const stat = await fsp.statfs(defaultDataDir).catch(() => null);
  if (stat) reading.disk = { free: Number(stat.bavail) * Number(stat.bsize), total: Number(stat.blocks) * Number(stat.bsize) };
  reading.memory = readMeminfo();
  /* Only a real container ceiling: without one the machine's memory, above,
     is the measure. */
  if (MEMORY_LIMIT_BYTES < os.totalmem()) reading.relay = { rss: process.memoryUsage.rss(), limit: MEMORY_LIMIT_BYTES };
  reading.files = { open: fileGuard.open, limit: fileGuard.limit };
  if (TURN_URLS.length) {
    let running = null;
    if (dockerAvailable()) {
      const state = await dockerEngineJson('GET', `/v1.44/containers/${encodeURIComponent(COTURN_CONTAINER)}/json`);
      if (state.ok) running = Boolean(state.data?.State?.Running);
    }
    reading.turn = { used: turnPortsInUse(TURN_PORT_MIN, TURN_PORT_MAX), size: TURN_PORT_MAX - TURN_PORT_MIN + 1, running };
  }
  const bytes = networkBytes();
  const now = Date.now();
  if (bytes !== null) {
    if (alertNetworkBefore && now > alertNetworkBefore.at) {
      reading.network = { mbps: ((bytes - alertNetworkBefore.bytes) * 8) / ((now - alertNetworkBefore.at) / 1000) / 1e6 };
    }
    alertNetworkBefore = { bytes, at: now };
  }
  reading.peersDown = [];
  for (const id of relayPeers.allowedPeers()) {
    if (relayPeers.linkFor(id)) { alertPeerDownSince.delete(id); continue; }
    if (!alertPeerDownSince.has(id)) alertPeerDownSince.set(id, now);
    const forMs = now - alertPeerDownSince.get(id);
    if (forMs >= limits.peerDownMs) {
      const nameOf = (relayId) => directoryState.doc?.body?.relays?.find((relay) => relay.id === relayId)?.name || '';
      const through = familyIds().has(id) ? familyDetour(id) : null;
      reading.peersDown.push({ id, forMs, name: nameOf(id), via: through ? (nameOf(through.peerId) || through.peerId.slice(0, 12)) : '' });
    }
  }
  return reading;
}
let alertsAnnounced = false;
async function checkAlerts() {
  /* A relay with nowhere to send them (a development machine, a test) keeps
     quiet. */
  if (alertsChecking || !(alertsByTelegram() || alertPeers().size)) return;
  alertsChecking = true;
  const current = telegramSettings.get();
  const T = textFor(current.language);
  /* A start is announced: after a crash and a restart, that is how the
     operator hears of it. */
  if (!alertsAnnounced) {
    alertsAnnounced = true;
    queueReport({ level: 'start', title: T.start.title, body: T.start.body });
  }
  try {
    const limits = limitsFrom(current.thresholds);
    alertState.update(evaluateAlerts(await alertReadings(limits), limits, current.language, current.alertKeys)).forEach((message) => {
      const name = T.alertTitles[message.key.split(':')[0]] || T.alertTitles.default;
      queueReport({
        level: message.level,
        category: message.level === 'ok' ? 'resolved' : message.reminder ? 'reminder' : message.level,
        title: message.level === 'ok' ? T.resolved(name) : `${name}${message.reminder ? T.stillOn : ''}`,
        body: message.text,
      });
    });
    await flushAlerts();
  } catch (error) {
    console.warn('[Alerts] the check failed:', error?.message || error);
  } finally {
    alertsChecking = false;
  }
}
/* Each check sets the next, so a new interval from the panel holds from the
   check after it. */
function scheduleAlertCheck(first = false) {
  const every = telegramSettings.get().checkSeconds * 1000;
  setTimeout(() => { checkAlerts().finally(() => scheduleAlertCheck()); }, first ? Math.min(15000, every) : every).unref?.();
}
if (process.env.CHAT_ALERTS !== '0') scheduleAlertCheck(true);

/* Each step of a server update, to the operator (scripts/lib/relay-updates.js
   tells; this says it in their language). A failure is critical. */
function reportUpdateEvent(event) {
  const T = botText();
  const version = String(event?.version || '');
  const say = {
    staged: () => T.update.staged(version), notifying: () => T.update.notifying(version, event.seconds), applying: () => T.update.applying(version),
    done: () => T.update.done(version),
    failed: () => (event.reason === 'revert-failed' ? T.update.revertFailed(version, String(event.detail || '').slice(0, 160)) : T.update.failed(version, String(event.reason || '').slice(0, 160))),
    /* Put back by the apply step's watch: the server is fine, the version is not. */
    reverted: () => T.update.reverted(version, String(event.reason || '').slice(0, 160)),
    /* The canary put it back: this server waits for the operator. */
    held: () => T.update.held(version),
  }[event?.kind];
  if (!say || !version) return;
  const level = { failed: 'critical', reverted: 'warn', held: 'warn' }[event.kind] || 'update';
  queueReport({ level, category: 'update', title: T.update.titles[event.kind], body: say() });
  flushAlerts().catch(() => {});
}

