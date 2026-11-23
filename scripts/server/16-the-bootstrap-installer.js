/* ---- the bootstrap installer ------------------------------------------------
 *
 * A dedicated port (CHAT_BOOTSTRAP_PORT, default 11222) that answers exactly
 * two things: the installer script, and — with the bootstrap token from the
 * server's config — the clean bundle the script pulls. Nothing else, no
 * session, no cookies: the point is one bash line from a fresh machine. */

const BOOTSTRAP_PORT = process.env.CHAT_BOOTSTRAP_PORT === '0' ? 0 : Number(process.env.CHAT_BOOTSTRAP_PORT || 11222);
/* The script a fresh machine runs: `curl …/install | bash -s -- <origin>
 * <token> [dir] [domain]`. Plain sh, so it runs under whatever shell it is
 * piped into, and one block, so a download cut short runs nothing.
 *
 * It writes .env itself. It used to copy a template from the bundle under a
 * name the tree has never had (docker-compose.env.example), found nothing and
 * stopped with "no .env template found in the bundle" on every machine. And a
 * template copied as it is would have been worse than nothing: its dashboard
 * password is printed in the repository for anyone to read, its domain and
 * address are documentation examples. Here every secret is new and random,
 * the domain is asked for (Enter takes the machine's public address, on a
 * self-signed certificate), and a .env already there is kept untouched, so
 * running it again never changes a secret live calls depend on. */
const BOOTSTRAP_INSTALLER = [
  '#!/bin/sh',
  '# P00RIJA Chat — clean-server installer.',
  '# Pulls the program (and nothing of the server it came from) and stands',
  '# the stack up on THIS machine with a fresh, empty identity and fresh secrets.',
  'set -eu',
  '{',
  'SRC=${1:?usage: install <origin> <bootstrap-token> [dir] [domain]}',
  'TOKEN=${2:?bootstrap token required}',
  'DIR=${3:-$HOME/p00rija-chat}',
  'DOMAIN=${4:-}',
  'command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 || { echo "Docker with its compose plugin is needed first: https://docs.docker.com/engine/install/" >&2; exit 1; }',
  'random_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d " \\n"; }',
  /* grep tests each LINE, so "1.2.3.4<newline>MONITOR_PASSWORD=x" passed and
     wrote a line of its own into .env. case looks at the whole value: any
     character outside the set, a newline included, fails before grep runs. */
  'is_ip() { case "$1" in ""|*[!0-9.]*) return 1 ;; esac; printf "%s" "$1" | grep -Eq "^([0-9]{1,3}\\.){3}[0-9]{1,3}$"; }',
  'is_name() { case "$1" in ""|*[!A-Za-z0-9.-]*) return 1 ;; esac; [ ${#1} -le 253 ]; }',
  'echo "==> fetching the clean bundle from $SRC"',
  'mkdir -p "$DIR"',
  'curl -fsSL -H "X-Bootstrap-Token: $TOKEN" "$SRC/bundle" -o "$DIR/bundle.tar.gz"',
  'tar -xzf "$DIR/bundle.tar.gz" -C "$DIR"',
  'rm -f "$DIR/bundle.tar.gz"',
  'cd "$DIR"',
  'mkdir -p certs data/chat-signal',
  'PASSWORD_SHOWN=""',
  'if [ -s .env ]; then',
  '  echo "==> keeping the .env already here"',
  'else',
  '  echo "==> writing .env"',
  '  PUBLIC_IP=$(curl -fsS4 --max-time 8 https://api.ipify.org 2>/dev/null || curl -fsS4 --max-time 8 https://ifconfig.me 2>/dev/null || true)',
  '  is_ip "$PUBLIC_IP" || { echo "could not find this machine\'s public IPv4 address" >&2; exit 1; }',
  /* /dev/tty exists without a terminal behind it (over ssh, under cron);
     opening it then fails, and under set -e the prompt would end the run. */
  '  if [ -z "$DOMAIN" ] && ( : < /dev/tty ) 2>/dev/null; then',
  '    printf "Domain of this server (Enter for its address, %s): " "$PUBLIC_IP" > /dev/tty',
  '    read -r DOMAIN < /dev/tty || DOMAIN=""',
  '  fi',
  '  DOMAIN=${DOMAIN:-$PUBLIC_IP}',
  '  is_name "$DOMAIN" || { echo "not a domain or address: $DOMAIN" >&2; exit 1; }',
  '  if is_ip "$DOMAIN"; then ORIGINS="https://$DOMAIN:1122,http://$DOMAIN:1122"; else ORIGINS="https://$DOMAIN:1122,https://$DOMAIN"; fi',
  '  MONITOR_PASSWORD=$(random_hex 12)',
  '  ( umask 077',
  '    printf "%s\\n" "# P00RIJA Chat, written by the clean-server installer. Keep it private."',
  '    printf "DOMAIN=%s\\n" "$DOMAIN"',
  '    printf "EXTERNAL_IP=%s\\n" "$PUBLIC_IP"',
  '    printf "APP_PORT=1122\\n"',
  '    printf "CHAT_ALLOWED_ORIGINS=%s\\n" "$ORIGINS"',
  '    printf "MONITOR_PASSWORD=%s\\n" "$MONITOR_PASSWORD"',
  '    printf "TURN_USER=p00rija-%s\\n" "$(random_hex 4)"',
  '    printf "TURN_PASSWORD=%s\\n" "$(random_hex 16)"',
  '    printf "TURN_SECRET=%s\\n" "$(random_hex 32)"',
  '    printf "VAPID_SUBJECT=mailto:admin@%s\\n" "$DOMAIN"',
  '    printf "CERT_MODE=\\nCERTBOT_EMAIL=\\n"',
  '  ) > .env',
  '  chmod 600 .env',
  '  PASSWORD_SHOWN=$MONITOR_PASSWORD',
  'fi',
  'echo "==> starting the stack (docker compose; the first build takes a while)"',
  'APP_VERSION=$(sed -n "s/.*\\"version\\": *\\"\\([^\\"]*\\)\\".*/\\1/p" package.json | head -1)',
  'APP_VERSION=$APP_VERSION OPS_INSTALL_DIR=$PWD OPS_BACKUP_DIR=$PWD/backups docker compose -p config -f config/docker-compose.yaml --env-file .env up -d --build',
  'DOMAIN_NOW=$(sed -n "s/^DOMAIN=//p" .env | tail -1)',
  'echo "==> done."',
  'echo "    App:        https://$DOMAIN_NOW:1122/"',
  'echo "    Dashboard:  https://$DOMAIN_NOW:1122/Monitor_Server"',
  'if [ -n "$PASSWORD_SHOWN" ]; then',
  '  echo "    Password:   $PASSWORD_SHOWN"',
  '  echo "    It is in .env as MONITOR_PASSWORD; change it in the dashboard."',
  'fi',
  'is_ip "$DOMAIN_NOW" && echo "    The certificate is self-signed, so the browser asks you to accept it once." || true',
  'exit 0',
  '}',
  '',
].join('\n');
function bootstrapToken() {
  if (process.env.CHAT_BOOTSTRAP_TOKEN) return process.env.CHAT_BOOTSTRAP_TOKEN;
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).bootstrapToken || ''; } catch (_error) { return ''; }
}
function rotateBootstrapToken() {
  const token = crypto.randomBytes(24).toString('hex');
  let config = {};
  try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}; } catch (_error) { config = {}; }
  config.bootstrapToken = token;
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 }); } catch (error) {
    console.warn('[Monitor] bootstrap token not saved:', error.message);
  }
  return token;
}
app.post('/Monitor_Server/bootstrap-token', authMiddleware, (req, res) => {
  const token = bootstrapToken() || rotateBootstrapToken();
  res.json({ ok: true, token });
});

if (BOOTSTRAP_PORT > 0) {
  const bootstrapServer = http.createServer((req, res) => {
    const asked = String(req.url || '');
    res.setHeader('Cache-Control', 'no-store');
    if (asked.startsWith('/install')) {
      res.writeHead(200, { 'Content-Type': 'text/x-shellscript; charset=utf-8' });
      res.end(BOOTSTRAP_INSTALLER);
      return;
    }
    if (asked.startsWith('/bundle')) {
      const token = bootstrapToken();
      if (!token) { res.writeHead(503).end('bootstrap token not configured on the server'); return; }
      if (!secretsMatch(req.headers['x-bootstrap-token'] || '', token)) { res.writeHead(401).end('bad bootstrap token'); return; }
      if (!INSTALL_HOST_DIR) { res.writeHead(503).end('ops paths not configured on the server'); return; }
      /* Used once, as the panel says. It never changed, so a token copied
         into one machine's shell history went on fetching the bundle from
         this server for as long as it ran. The panel's next "show install"
         hands out the new one. */
      rotateBootstrapToken();
      opsBundleTo(res, 'poorija-clean-bundle.tar.gz');
      return;
    }
    res.writeHead(404).end('not found');
  });
  /* An optional helper must never take the relay down with it. A port already
     held — a second relay on the same host, the standalone distribution next
     to a full stack — used to surface as an uncaught EADDRINUSE and a dead
     relay. Now the installer is simply not offered on that host. */
  bootstrapServer.on('error', (error) => {
    console.warn(`[Bootstrap] installer not started on ${BOOTSTRAP_PORT}: ${error.code || error.message}`);
  });
  /* Behind nginx at /bootstrap/ (https) when CHAT_LISTEN_HOSTS keeps this
     port off the internet; a plain-http installer piped into a shell is a
     way to hand someone else's script to a new server. */
  listenOn(bootstrapServer, BOOTSTRAP_PORT, '0.0.0.0', () => {
    console.log(`Bootstrap installer available on port ${BOOTSTRAP_PORT}`);
  });
}

/* ---- updates: a signed package, passed along the family, applied at the right time
 *
 * scripts/lib/relay-updates.js decides; this is where it meets the relay: its
 * family (the signed directory), the people on it (presence), the notice they
 * get, and the step that applies a package. That step runs on the host, as
 * the install's owner, the way a deploy does: a privileged helper (the
 * renewer's image, which every server holds) enters the host's namespaces and
 * runs scripts/apply-update.sh, which checks the package's hash again before
 * it touches anything. The helper outlives this process, which the update
 * restarts; how it went is left in result.json for the relay that comes back. */
const { createRelayUpdates } = require('./lib/relay-updates.js');

function updatesRequest(url, { headers = {}, to = null } = {}) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(url); } catch (_error) { resolve({ ok: false, status: 0 }); return; }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') { resolve({ ok: false, status: 0 }); return; }
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(target, {
      method: 'GET', headers,
      rejectUnauthorized: verifyTlsFor({ origin: target.origin, familyMember: true, verifyTls: TRANSIT_VERIFY_TLS }),
      /* Idle, not total: a package of a few hundred megabytes over a slow
         international path takes as long as it takes. */
      timeout: 120000,
    }, (response) => {
      if (response.statusCode !== 200) { response.resume(); resolve({ ok: false, status: response.statusCode }); return; }
      if (to) {
        /* Never into a file that is already there (a link someone put down). */
        const out = fs.createWriteStream(to, { mode: 0o644, flags: 'wx' });
        let size = 0;
        response.on('data', (chunk) => { size += chunk.length; if (size > 3 * 1024 * 1024 * 1024) request.destroy(new Error('too large')); });
        response.on('error', () => resolve({ ok: false, status: 0 }));
        out.on('error', () => resolve({ ok: false, status: 0 }));
        out.on('finish', () => resolve({ ok: true, status: 200 }));
        response.pipe(out);
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => { size += chunk.length; if (size > 65536) request.destroy(new Error('too large')); else chunks.push(chunk); });
      response.on('end', () => {
        try { resolve({ ok: true, status: 200, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (_error) { resolve({ ok: false, status: 200 }); }
      });
      response.on('error', () => resolve({ ok: false, status: 0 }));
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', () => resolve({ ok: false, status: 0 }));
    request.end();
  });
}

const UPDATE_APPLY_SCRIPT = [
  'dir=$1; pkg=$2; out=$3; version=$4; code=0',
  'owner=$(stat -c %U "$dir") || exit 1',
  'home=$(getent passwd "$owner" | cut -d: -f6)',
  'runuser -u "$owner" -- env HOME="$home" PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \\',
  '  bash -c \'cd "$1" && bash scripts/apply-update.sh "$2"\' apply "$dir" "$pkg" > "$out/apply.log.tmp" 2>&1 || code=$?',
  'printf \'{"code":%d,"at":"%s","version":"%s"}\\n\' "$code" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$version" > "$out/result.json"',
  'mv "$out/apply.log.tmp" "$out/apply.log"',
].join('\n');

async function launchUpdateHelper({ file, version }) {
  if (!dockerAvailable() || !INSTALL_HOST_DIR || !OPS_DATA_HOST_DIR) return { ok: false, reason: 'docker-socket-not-mounted' };
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(String(version))) return { ok: false, reason: 'bad-version' };
  const renewer = await dockerEngineJson('GET', '/v1.44/containers/P00RIJA-Chat_CertRenewer/json');
  const image = renewer.data?.Image;
  if (!renewer.ok || !image) return { ok: false, reason: 'no-helper-image' };
  const hostUpdates = `${OPS_DATA_HOST_DIR}/updates`;
  const created = await dockerEngineJson('POST', `/v1.44/containers/create?name=poorija-update-${Date.now()}`, {
    Image: image,
    Entrypoint: ['nsenter'],
    Cmd: ['-t', '1', '-m', '-u', '-i', '-n', '-p', '--', '/bin/sh', '-c', UPDATE_APPLY_SCRIPT, 'apply',
      INSTALL_HOST_DIR, `${hostUpdates}/${path.basename(file)}`, hostUpdates, String(version)],
    HostConfig: { Privileged: true, PidMode: 'host', AutoRemove: true },
  });
  if (!created.ok) return { ok: false, reason: `create-${created.status}`, detail: String(created.data?.message || '').slice(0, 200) };
  const started = await dockerEngineJson('POST', `/v1.44/containers/${created.data.Id}/start`, null);
  return started.ok ? { ok: true } : { ok: false, reason: `start-${started.status}` };
}

const relayUpdates = createRelayUpdates({
  dir: process.env.CHAT_UPDATES_DIR || path.join(defaultDataDir, 'updates'),
  operatorKey: () => OPERATOR_KEY,
  currentVersion: () => RELAY_BUILD.version,
  self: { id: relayIdentity.id, publicKey: publicRelayIdentity(relayIdentity).publicKey, privateKey: relayPrivate },
  peers: () => (directoryState.doc?.body.relays || []).filter((relay) => relay.id !== relayIdentity.id)
    .map((relay) => ({ id: relay.id, origins: [...(relay.inside || []), ...(relay.origins || [])].filter((origin) => /^https?:\/\//.test(origin)) })),
  isMember: (id) => isFamilyPeer(id),
  fetchJson: (url) => updatesRequest(url),
  fetchFile: (url, { headers, to }) => updatesRequest(url, { headers, to }),
  onlineCount: () => presence.size,
  notifyClients: (notice) => {
    for (const record of presence.values()) {
      if (record.ws && record.ws.readyState === WebSocket.OPEN) safeSend(record.ws, { type: 'server-update', ...notice });
    }
  },
  launchApply: launchUpdateHelper,
  noticeMs: Math.max(1000, Number(process.env.CHAT_UPDATE_NOTICE_MS || 120000)),
  log: (line) => monitorLog(line),
  /* Told before the alert queue below exists, at a start that finished an
     update: so said on the next turn. */
  onEvent: (event) => setImmediate(() => reportUpdateEvent(event)),
});

app.get('/p00rija-update/offer', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(relayUpdates.offer());
});
app.get('/p00rija-update/package/:version', (req, res) => {
  const pathname = `/p00rija-update/package/${req.params.version}`;
  const allowed = relayUpdates.authorize(req.headers['x-p00rija-update-auth'], pathname);
  if (!allowed.ok) { res.status(401).json({ ok: false, reason: allowed.reason }); return; }
  const file = relayUpdates.packageFile(req.params.version);
  if (!file) { res.status(404).json({ ok: false, reason: 'not-held' }); return; }
  monitorLog(`update: handing ${req.params.version} to ${allowed.id.slice(0, 12)}`);
  res.set({ 'Content-Type': 'application/x-tar', 'Content-Length': String(fs.statSync(file).size), 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
app.get('/Monitor_Server/updates', authMiddleware, (req, res) => {
  res.json({ ok: true, ...relayUpdates.status(), canApply: Boolean(dockerAvailable() && INSTALL_HOST_DIR && OPS_DATA_HOST_DIR) });
});
app.post('/Monitor_Server/updates/stage', authMiddleware, async (req, res) => {
  const name = String(req.body?.file || '');
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(name)) { res.status(400).json({ ok: false, reason: 'bad-file' }); return; }
  const file = path.join(relayUpdates.incomingDir, name);
  if (!fs.existsSync(file)) { res.status(404).json({ ok: false, reason: 'no-such-file' }); return; }
  const kept = await relayUpdates.stage(file, { from: 'panel', policy: req.body?.policy });
  try { fs.unlinkSync(file); } catch (_error) { /* moved or gone */ }
  res.status(kept.ok ? 200 : 400).json(kept);
});
app.post('/Monitor_Server/updates/policy', authMiddleware, async (req, res) => res.json(await relayUpdates.setPolicy(req.body || {})));
app.post('/Monitor_Server/updates/cancel', authMiddleware, async (req, res) => res.json(await relayUpdates.cancel()));
app.post('/Monitor_Server/updates/check', authMiddleware, async (req, res) => res.json(await relayUpdates.checkPeers()));

setTimeout(() => {
  relayUpdates.sample();
  relayUpdates.tick().catch(() => {});
  setInterval(() => relayUpdates.sample(), 5 * 60 * 1000).unref();
  setInterval(() => { relayUpdates.tick().catch((error) => monitorLog(`update: ${error.message}`)); }, 60 * 1000).unref();
  setInterval(() => { relayUpdates.checkPeers().catch((error) => monitorLog(`update: ${error.message}`)); }, Math.max(60000, Number(process.env.CHAT_UPDATE_PEER_MS || 10 * 60 * 1000))).unref();
}, Math.max(1000, Number(process.env.CHAT_UPDATE_START_MS || 60000))).unref();

app.post('/self-destruct/records', (req, res) => {
  if (sendRestrictionResponse(req, res)) return;
  const payloadId = sanitizeSelfDestructId(req.body?.payloadId);
  const timeLimitMs = clampNonNegativeNumber(req.body?.timeLimitMs, 0, 30 * 24 * 60 * 60 * 1000);
  const maxViews = clampNonNegativeNumber(req.body?.maxViews, 0, 100000);
  const createdAtMs = clampNonNegativeNumber(req.body?.createdAt, Date.now(), Date.now() + 5 * 60 * 1000);
  if (!payloadId) {
    res.status(400).json({ ok: false, reason: 'invalid-payload-id' });
    return;
  }
  const id = crypto.randomUUID();
  const record = {
    id,
    payloadId,
    timeLimitMs,
    maxViews,
    opens: 0,
    createdAt: new Date(createdAtMs || Date.now()).toISOString(),
    firstOpenedAt: null,
    updatedAt: new Date().toISOString(),
  };
  selfDestructRecords.set(id, record);
  pruneSelfDestructRecords();
  saveSelfDestructRecords();
  res.json({ ok: true, ...publicSelfDestructRecord(record) });
});

app.get('/self-destruct/records/:id', (req, res) => {
  if (sendRestrictionResponse(req, res)) return;
  const id = sanitizeSelfDestructId(req.params.id);
  const record = selfDestructRecords.get(id);
  if (!record) {
    res.status(404).json({ ok: false, reason: 'not-found' });
    return;
  }
  res.json({ ok: true, ...publicSelfDestructRecord(record) });
});

app.post('/self-destruct/records/:id/open', (req, res) => {
  if (sendRestrictionResponse(req, res)) return;
  const id = sanitizeSelfDestructId(req.params.id);
  const record = selfDestructRecords.get(id);
  if (!record) {
    res.status(404).json({ ok: false, reason: 'not-found' });
    return;
  }
  const payloadId = sanitizeSelfDestructId(req.body?.payloadId);
  if (record.payloadId && payloadId && record.payloadId !== payloadId) {
    res.status(400).json({ ok: false, reason: 'payload-mismatch' });
    return;
  }
  const status = selfDestructRecordStatus(record);
  if (status.expired) {
    res.status(410).json({ ok: false, reason: 'expired', ...status });
    return;
  }
  if (record.maxViews > 0 && record.opens >= record.maxViews) {
    res.status(410).json({ ok: false, reason: 'view-limit-reached', ...status });
    return;
  }
  if (!record.firstOpenedAt) record.firstOpenedAt = new Date().toISOString();
  record.opens += 1;
  record.updatedAt = new Date().toISOString();
  saveSelfDestructRecords();
  res.json({ ok: true, ...publicSelfDestructRecord(record) });
});

const upgradeListenersBeforePeer = new Set(server.listeners('upgrade'));
// A TCP connection that dies without a close frame -- phone suspends, carrier
// NAT entry expires, Wi-Fi drops mid-packet -- stays "open" on both ends
// forever. Protocol-level ping/pong is the only thing that detects it, and
// detecting it quickly is what frees the peer id so a returning client can
// reclaim its own id instead of being told it is taken.
function attachSocketKeepAlive(wss, label, intervalMs = 15000) {
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
  });
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        console.log(`[${label}] Terminating unresponsive socket.`);
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch (_error) { /* socket already gone */ }
    }
  }, intervalMs);
  timer.unref?.();
  wss.on('close', () => clearInterval(timer));
  return wss;
}

const peerServer = ExpressPeerServer(server, {
  path: '/peerjs',
  proxied: true,
  /* Off, because nothing this project ships ever asks for the list. The
     endpoint answers "who is online" to any website that asks, and a relay
     that answers it hands a stranger the roster for free — the one fact the
     transit layer is built to keep from the operator. */
  allow_discovery: false,
  key: 'peerjs',
  // alive_timeout is driven by application-level HEARTBEAT messages, which a
  // backgrounded browser tab stops sending because its timers are frozen. The
  // 90s default therefore evicted every phone that spent a minute and a half
  // in someone's pocket. Ping/pong above reaps genuinely dead sockets within
  // ~30s, so this window only needs to cover frozen-but-connected clients.
  alive_timeout: 600000,
  expire_timeout: 10000,
  // Peer signalling frames are small; capping them costs nothing and stops a
  // single peer from buffering an unbounded frame in this process.
  createWebSocketServer: (options) => {
    const wss = attachSocketKeepAlive(
      new WebSocketServer({ ...options, maxPayload: 12 * 1024 * 1024 }),
      'PeerJS',
    );
    /* PeerJS sockets are part of the same budget as every other socket. They
       were refused by the per-address ceiling before PeerJS ever saw them,
       but the ones that got through were then invisible to the count — so the
       ceiling read zero however many were held, and an address could stack
       PeerJS sockets without ever touching its own cap. */
    wss.on('connection', (ws, request) => trackSocket(ws, socketAddress(request)));
    return wss;
  },
});
app.use(peerServer);
/* An 'error' event with no listener is a throw, and a throw in this process
   is a flush-and-exit. Every other server in this file says where its errors
   go; the PeerJS mount re-emits socket errors on itself, so it says so too. */
peerServer.on('error', (error) => console.error('[PeerJS] server error:', error?.message || error));
const peerUpgradeListeners = server.listeners('upgrade')
  .filter((listener) => !upgradeListenersBeforePeer.has(listener));
for (const listener of peerUpgradeListeners) {
  server.off('upgrade', listener);
}

