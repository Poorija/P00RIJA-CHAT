/* ---- disk and cleanup ---------------------------------------------------------
 *
 * What the machine's disks hold because of this stack, and one button for
 * each thing that is safe to drop: old tagged images of ourselves, dangling
 * layers, the dashboard's temp transfers, and backups past the retention. */

/* The images some container, running or stopped, is made from. images/json
   has a Containers count, but the engine leaves it at -1 unless asked to
   work it out, so "in use" read from it was never true and an image a
   container runs could be offered for removal. */
async function imagesInUse() {
  const containers = await dockerEngineJson('GET', '/v1.44/containers/json?all=1');
  return new Set((containers.data || []).map((container) => String(container.ImageID || '')).filter(Boolean));
}

/* Proves the whole way to the operator's phone: from a relay without
   Telegram, over the link to the one with it, and on. */
app.post('/Monitor_Server/alert-test', authMiddleware, async (req, res) => {
  /* A test proves the way the cards take, so it obeys the bot's own switch:
     a relay whose bot is off sends nothing, and says so, instead of a test
     that arrives while every other card is dropped. */
  if (!telegramSettings.get().enabled) return res.json({ ok: false, via: 'none', reason: 'bot-off' });
  const via = alertsByTelegram() ? 'telegram' : (Array.from(alertPeers()).some((id) => relayPeers.linkFor(id)?.isOpen()) ? 'relay-link' : 'none');
  queueReport({ level: 'test', title: botText().test.title, body: botText().test.body, force: true });
  await flushAlerts();
  res.json({ ok: via !== 'none', via, waiting: alertOutbox.length });
});

app.post('/Monitor_Server/ops-disk', authMiddleware, async (req, res) => {
  if (!dockerAvailable()) return res.json({ ok: false, reason: 'docker-socket-not-mounted' });
  /* system/df walks every layer on disk and can outlast an nginx proxy
     window; images/json answers the same question about images in one fast
     call, which is what this card actually shows. */
  const [imagesRaw, used] = await Promise.all([dockerEngineJson('GET', '/v1.44/images/json'), imagesInUse()]);
  const images = (imagesRaw.data || []).map((image) => ({
    /* Id survives the remap — the cleanup lists hand it to the engine by
       exact ref, and a remapped row without it deletes nothing. */
    id: String(image.Id || ''),
    tags: (image.RepoTags || []).filter(Boolean),
    size: image.Size,
    inUse: used.has(String(image.Id || '')),
  }));
  /* Our own old tags — every p00rija-chat tag that is not this round's —
     plus anything the engine calls dangling. These are the bytes nobody will
     ever miss. */
  const APP_IMAGE_TAG = process.env.APP_VERSION || '';
  const staleSelf = images.filter((image) => image.tags.some((tag) => tag.startsWith('p00rija-chat:') && (!APP_IMAGE_TAG || !tag.endsWith(APP_IMAGE_TAG))) && !image.inUse);
  const dangling = images.filter((image) => !image.tags.length && !image.inUse);
  const stat = await fsp.statfs(defaultDataDir).catch(() => null);
  res.json({
    ok: true,
    disk: stat ? { free: Number(stat.bavail) * 4096, total: Number(stat.blocks) * 4096 } : null,
    docker: {
      imagesBytes: images.reduce((sum, image) => sum + (image.size || 0), 0),
    },
    cleanup: {
      staleSelfImages: staleSelf.map((image) => ({ ref: image.tags[0] || '', tags: image.tags, size: image.Size || image.size || 0 })),
      staleSelfBytes: staleSelf.reduce((sum, image) => sum + image.size, 0),
      /* Docker names the field Id (capital) — reading .id here handed the
         dashboard empty refs, which is exactly why ticked layers "deleted"
         nothing: the server was asked to remove two blank strings. */
      danglingImages: dangling.map((image) => ({ ref: String(image.Id || image.id || ''), size: image.Size || image.size || 0 })),
      danglingCount: dangling.length,
      danglingBytes: dangling.reduce((sum, image) => sum + image.size, 0),
    },
  });
});

app.post('/Monitor_Server/ops-cleanup', authMiddleware, async (req, res) => {
  if (!dockerAvailable()) return res.json({ ok: false, reason: 'docker-socket-not-mounted' });
  const what = String(req.body?.what || '');
  /* Selective mode: the dashboard sends the exact refs the operator ticked —
     image tags ("p00rija-chat:v2.99") or image ids ("sha256:…" truncated is
     not accepted; the disk listing hands out the full ref it wants gone). */
  const chosen = Array.isArray(req.body?.refs) ? req.body.refs.map(String).filter((ref) => /^[\w.:\/@-]+$/.test(ref) && ref.length < 200) : [];
  if (what === 'selected' && chosen.length) {
    let freedBytes = 0;
    const gone = [];
    const used = await imagesInUse();
    for (const ref of chosen) {
      const inspect = await dockerEngineJson('GET', `/v1.44/images/${encodeURIComponent(ref)}/json`);
      if (!inspect.ok) continue;
      /* An image inspection has no container count at all: what runs from
         it is read from the containers. */
      if (used.has(String(inspect.data?.Id || ''))) continue;
      freedBytes += Number(inspect.data?.Size || 0);
      const removed = await dockerEngineRequest('DELETE', `/v1.44/images/${encodeURIComponent(ref)}?force=1&noprune=0`, null, { timeoutMs: 120000 });
      if (!removed.unreachable && removed.status < 300) gone.push(ref);
    }
    monitorLog(`Selective cleanup removed ${gone.length} image ref(s), ${Math.round(freedBytes / 1048576)} MB`);
    return res.json({ ok: true, what, removed: gone, freedBytes });
  }
  const APP_IMAGE_TAG = process.env.APP_VERSION || '';
  const dfRaw = await dockerEngineJson('GET', '/v1.44/images/json');
  const df = { data: { Images: dfRaw.data || [] } };
  let freed = 0;
  if (what === 'stale-images') {
    const used = await imagesInUse();
    for (const image of df.data.Images) {
      const tags = (image.RepoTags || []).filter(Boolean);
      if (!tags.length || used.has(String(image.Id || ''))) continue;
      if (!tags.some((tag) => tag.startsWith('p00rija-chat:') && (!APP_IMAGE_TAG || !tag.endsWith(APP_IMAGE_TAG)))) continue;
      for (const tag of tags) await dockerEngineJson('DELETE', `/v1.44/images/${encodeURIComponent(tag)}`);
      freed += image.Size || 0;
    }
  }
  if (what === 'dangling') {
    /* dangling=true: untagged layers nothing uses. The filter said
       { false: false } — the engine reads the key, not the value, so that
       was dangling=false, which prunes EVERY image no container uses: the
       base images the next build needs (slow or impossible to fetch again
       from a filtered network) and whatever else the machine keeps. */
    const prune = await dockerEngineRequest('POST', '/v1.44/images/prune?filters=' + encodeURIComponent(JSON.stringify({ dangling: { true: true } })), null, { timeoutMs: 300000 });
    freed += Number(opsParseJson(prune.body)?.SizeReclaimed || 0);
  }
  if (what === 'temps') {
    const job = await runOpsJob(['sh', '-c', 'rm -f /relaydata/.monitor-* /job/data/.monitor-* 2>/dev/null; true']);
    if (job.ok) freed += 0;
  }
  monitorLog(`Cleanup (${what}) freed ${Math.round(freed / 1024 / 1024)} MB`);
  res.json({ ok: true, what, freedBytes: freed });
});

/* ---- Docker Hub version check --------------------------------------------------
 *
 * "Check and update" before this said only whether the pull succeeded; the
 * operator asked for the sentence a person actually needs: my digest is X,
 * Hub says Y, newer — update now? The Hub's tag API carries the remote
 * digest and its push time, so the comparison is exact, not a guess. For a
 * server that cannot reach the Hub directly, OPS_HUB_MIRROR points the one
 * wget at a mirror that can. */

const OPS_HUB_MIRROR = process.env.OPS_HUB_MIRROR || 'https://hub.docker.com';
async function hubTagInfo(repository, tag) {
  const path = repository.includes('/') ? repository : `library/${repository}`;
  const job = await (async () => {
    const name = `poorija-hub-${Date.now()}`;
    const created = await dockerEngineJson('POST', `/v1.44/containers/create?name=${name}`, {
      Image: OPS_JOB_IMAGE,
      Cmd: ['wget', '-q', '-O', '-', `${OPS_HUB_MIRROR}/v2/repositories/${path}/tags/${tag}`],
      HostConfig: { AutoRemove: false, NetworkMode: 'default' },
    });
    if (!created.ok) return { ok: false, reason: `create-${created.status}` };
    const containerId = created.data.Id;
    await dockerEngineJson('POST', `/v1.44/containers/${containerId}/start`, null);
    const deadline = Date.now() + 30000;
    let exit = null;
    while (Date.now() < deadline) {
      const state = await dockerEngineJson('GET', `/v1.44/containers/${containerId}/json`);
      if (state.ok && state.data?.State?.Status !== 'running') { exit = Number(state.data?.State?.ExitCode ?? -1); break; }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const logs = await dockerEngineRequest('GET', `/v1.44/containers/${containerId}/logs?stdout=1&stderr=1&tail=10`);
    await dockerEngineJson('DELETE', `/v1.44/containers/${containerId}?force=1&v=1`);
    if (exit !== 0) return { ok: false, reason: 'hub-unreachable' };
    /* The logs API streams framed: 8 header bytes, then that many payload
       bytes, repeat. Strip the frames instead of the NULs, or the JSON the
       Hub answered arrives with binary length bytes woven through it. */
    let stripped = '';
    const raw = logs.raw || Buffer.from(String(logs.body || ''), 'utf8');
    let offset = 0;
    while (offset + 8 <= raw.length) {
      const size = raw.readUInt32BE(offset + 4);
      if (offset + 8 + size > raw.length) break;
      stripped += raw.subarray(offset + 8, offset + 8 + size).toString('utf8');
      offset += 8 + size;
    }
    if (!stripped) stripped = String(logs.body || '');
    return { ok: true, body: stripped };
  })();
  if (!job.ok) return { ok: false, reason: job.reason };
  const parsed = opsParseJson(job.body);
  if (!parsed) return { ok: false, reason: 'hub-bad-answer' };
  return {
    ok: true,
    digest: String(parsed.digest || ''),
    lastPushed: parsed.last_updated ? new Date(parsed.last_updated).toISOString() : '',
    fullSize: Number(parsed.full_size || 0),
  };
}

app.post('/Monitor_Server/ops-image-check', authMiddleware, async (req, res) => {
  const reference = String(req.body?.reference || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.\/:-]*:[A-Za-z0-9_.-]+$/.test(reference)) {
    return res.status(400).json({ ok: false, reason: 'bad-reference' });
  }
  if (!dockerAvailable()) return res.json({ ok: false, reason: 'docker-socket-not-mounted' });
  const [name, tag] = reference.split(':');
  const local = await dockerEngineJson('GET', `/v1.44/images/${encodeURIComponent(reference)}/json`);
  const localDigest = String(local.data?.RepoDigests?.[0] || '').split('@')[1] || String(local.data?.Id || '');
  const hub = await hubTagInfo(name, tag);
  res.json({
    ok: true,
    reference,
    local: { id: String(local.data?.Id || '').slice(7, 19), digest: localDigest.slice(7, 30), created: Number.isFinite(Number(local.data?.Created)) && Number(local.data.Created) > 0 ? new Date(Number(local.data.Created) * 1000).toISOString() : '' },
    hub: hub.ok ? { digest: String(hub.digest || '').slice(7, 30), lastPushed: hub.lastPushed, size: hub.fullSize } : null,
    hubError: hub.ok ? '' : (hub.reason || ''),
    updateAvailable: Boolean(hub.ok && hub.digest && localDigest && !hub.digest.includes(localDigest.slice(7, 30)) && !localDigest.includes(hub.digest.slice(7, 30))),
  });
});

/* ---- machine half: docker, archives, backups --------------------------------
 *
 * All of it goes through the docker engine API over a socket the deployment
 * may mount (OPS_DOCKER_SOCKET). No child process and no shell leave this
 * file: the engine takes JSON, and the one place bytes are packed or
 * unpacked is a short-lived container with a fixed argument list. A
 * deployment that does not mount the socket simply sees these actions
 * answer "unavailable" — the rest of the dashboard carries on. */

const OPS_DOCKER_SOCKET = process.env.OPS_DOCKER_SOCKET || '/var/run/docker.sock';
/* The install directory as THE DOCKER HOST sees it — bind mounts in the job
   containers below are resolved by the host engine, not inside this
   container, so this is the host path even though the relay only ever
   passes it on as text. */
const INSTALL_HOST_DIR = process.env.OPS_INSTALL_DIR || '';
/* The relay's own base image, which every machine running it already holds:
   a job never waits on a registry. */
const OPS_JOB_IMAGE = process.env.OPS_JOB_IMAGE || 'node:26.12.1-alpine';
const OPS_BACKUP_HOST_DIR = process.env.OPS_BACKUP_DIR || (INSTALL_HOST_DIR ? `${INSTALL_HOST_DIR}/backups` : '');
/* Where this relay's own /data lives on the host — the compose file mounts
   data/chat-signal there. A file a job hands to this process (a backup on
   its way to the browser, the clean bundle) is written into it as
   /relaydata. It went to /job/data instead, which is the install's data/,
   one level up: the relay then streamed a file that was not there, and every
   backup download and every bundle — the bootstrap installer's included —
   came out empty. */
const OPS_DATA_HOST_DIR = process.env.OPS_DATA_DIR || (INSTALL_HOST_DIR ? `${INSTALL_HOST_DIR}/data/chat-signal` : '');
/* How many of the dashboard's own backups stay: the newest two, as with the
   deployment snapshots. */
const OPS_BACKUPS_KEPT = Math.max(1, Number(process.env.OPS_BACKUPS_KEPT || 2));
const dockerAvailable = () => fs.existsSync(OPS_DOCKER_SOCKET);

function dockerEngineRequest(method, urlPath, body, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const request = http.request({
      socketPath: OPS_DOCKER_SOCKET,
      path: urlPath,
      method,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks);
        /* raw stays bytes: stream-framed answers (container logs) must be
           de-framed before they are ever read as text. */
        resolve({ status: response.statusCode, body: raw.toString('utf8'), raw, stream: response });
      });
    });
    request.on('timeout', () => request.destroy(new Error('docker api timeout')));
    request.on('error', () => resolve({ status: 0, body: '', unreachable: true }));
    if (body) request.write(body);
    request.end();
  });
}

async function dockerEngineJson(method, urlPath, payload) {
  const response = await dockerEngineRequest(method, urlPath, payload ? JSON.stringify(payload) : null);
  if (response.unreachable) return { ok: false, status: 0, data: null };
  let parsed = null;
  try { parsed = JSON.parse(response.body); } catch (_error) { parsed = null; }
  return { ok: response.status >= 200 && response.status < 300, status: response.status, data: parsed };
}
function opsParseJson(text) {
  try { return JSON.parse(text); } catch (_error) { return null; }
}

/* One short-lived container, fixed argument list, two mounts it may see: the
   install tree and the backups directory. The host paths come from this
   file's settings; the names inside are fixed text. If the job image is not
   on the machine yet — a first run, or a server that never pulled it — it is
   fetched once from the registry and the create is retried. */
async function runOpsJob(command, { timeoutMs = 900000 } = {}) {
  if (!dockerAvailable() || !INSTALL_HOST_DIR) {
    return { ok: false, reason: 'docker-socket-not-mounted' };
  }
  const name = `poorija-ops-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const binds = [`${INSTALL_HOST_DIR}:/job`];
  if (OPS_BACKUP_HOST_DIR) binds.push(`${OPS_BACKUP_HOST_DIR}:/backups`);
  if (OPS_DATA_HOST_DIR) binds.push(`${OPS_DATA_HOST_DIR}:/relaydata`);
  let created = await dockerEngineJson('POST', `/v1.44/containers/create?name=${name}`, {
    Image: OPS_JOB_IMAGE,
    Cmd: command,
    WorkingDir: '/job',
    HostConfig: { AutoRemove: false, Binds: binds, NetworkMode: 'none' },
  });
  if (!created.ok && /no such image/i.test(String(created.data?.message || ''))) {
    const [imageName, imageTag] = OPS_JOB_IMAGE.split(':');
    await dockerEngineRequest('POST',
      `/v1.44/images/create?fromImage=${encodeURIComponent(imageName)}&tag=${encodeURIComponent(imageTag || 'latest')}`,
      null, { timeoutMs: 600000 });
    created = await dockerEngineJson('POST', `/v1.44/containers/create?name=${name}`, {
      Image: OPS_JOB_IMAGE,
      Cmd: command,
      WorkingDir: '/job',
      HostConfig: { AutoRemove: false, Binds: binds, NetworkMode: 'none' },
    });
  }
  if (!created.ok) return { ok: false, reason: `create-${created.status}`, detail: String(created.data?.message || '').slice(0, 300) };
  const containerId = created.data?.Id;
  const started = await dockerEngineJson('POST', `/v1.44/containers/${containerId}/start`, null);
  if (!started.ok) {
    await dockerEngineJson('DELETE', `/v1.44/containers/${containerId}?force=1&v=1`);
    return { ok: false, reason: `start-${started.status}` };
  }
  const deadline = Date.now() + timeoutMs;
  let exitCode = null;
  while (Date.now() < deadline) {
    const state = await dockerEngineJson('GET', `/v1.44/containers/${containerId}/json`);
    if (state.ok && state.data?.State?.Status !== 'running') {
      exitCode = Number(state.data?.State?.ExitCode ?? -1);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const logs = await dockerEngineRequest('GET', `/v1.44/containers/${containerId}/logs?stdout=1&stderr=1&tail=40`);
  await dockerEngineJson('DELETE', `/v1.44/containers/${containerId}?force=1&v=1`);
  if (exitCode === null) return { ok: false, reason: 'job-timeout' };
  let jobLogs = String(logs.body || '').replace(/\u0000/g, '');
  if (logs.raw) {
    let strippedLogs = '';
    const rawLogs = logs.raw;
    let cursor = 0;
    while (cursor + 8 <= rawLogs.length) {
      const size = rawLogs.readUInt32BE(cursor + 4);
      if (cursor + 8 + size > rawLogs.length) break;
      strippedLogs += rawLogs.subarray(cursor + 8, cursor + 8 + size).toString('utf8');
      cursor += 8 + size;
    }
    if (strippedLogs) jobLogs = strippedLogs;
  }
  return { ok: exitCode === 0, logs: jobLogs.slice(-2000) };
}

/* What a backup refuses to carry, and what the clean bundle refuses to
   carry (everything of this machine's own). */
const OPS_BACKUP_EXCLUDE = ['node_modules', '.git', 'backups', 'dist', 'Export', 'GitHub', 'standalone-relay/lib', 'release-logs'];
/* `.env*`, not `.env`. tar matches an exclude against the whole name, so
   `.env` left every copy of it in: `.env.bak-before-family`, the backups a
   change to .env leaves beside it, carry this server's dashboard password,
   TURN secrets and bot token, and went to whoever held a bootstrap token.
   `.env.example` goes too; the installer writes a fresh .env of its own. */
const OPS_BUNDLE_EXCLUDE = [...OPS_BACKUP_EXCLUDE, 'data', '.env*', 'certs', 'server-config.json'];

/* Retention: the newest OPS_BACKUPS_KEPT, plus any named (the one just
   restored, which may be older). Run after every path that makes a backup —
   a restore, an update and a rollback each take a safety snapshot, and only
   a backup made by hand used to be followed by a prune, so those piled up. */
function pruneOpsBackups(keep = []) {
  const spare = keep.filter((name) => /^server-backup_[\w.-]+\.tar\.gz$/.test(name)).map((name) => ` | grep -vxF '/backups/${name}'`).join('');
  return runOpsJob(['sh', '-c', `mkdir -p /backups && ls -1t /backups/server-backup_*.tar.gz 2>/dev/null | tail -n +${OPS_BACKUPS_KEPT + 1}${spare} | xargs -r rm -f`], { timeoutMs: 120000 });
}

/* A pre-restore / pre-update snapshot, always taken the same way. */
async function opsSnapshot() {
  const label = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const cmd = ['tar', 'czf', `/backups/server-backup_${label}.tar.gz`];
  for (const item of OPS_BACKUP_EXCLUDE) cmd.push(`--exclude=./${item}`);
  cmd.push('./');
  const job = await runOpsJob(cmd, { timeoutMs: 900000 });
  return { ok: job.ok, name: `server-backup_${label}.tar.gz` };
}

app.post('/Monitor_Server/ops-status', authMiddleware, async (req, res) => {
  const [images, containers] = await Promise.all([
    dockerEngineJson('GET', '/v1.44/images/json'),
    dockerEngineJson('GET', '/v1.44/containers/json'),
  ]);
  res.json({
    ok: true,
    monitor: MONITOR_VERSION,
    docker: {
      available: dockerAvailable(),
      installConfigured: Boolean(INSTALL_HOST_DIR),
      images: images.ok ? images.data : [],
      containers: containers.ok ? containers.data : [],
    },
  });
});

app.post('/Monitor_Server/ops-images', authMiddleware, async (req, res) => {
  const images = await dockerEngineJson('GET', '/v1.44/images/json');
  if (!images.ok) return res.json({ ok: false, reason: dockerAvailable() ? 'docker-error' : 'docker-socket-not-mounted' });
  const list = (images.data || []).flatMap((image) =>
    (image.RepoTags || []).filter(Boolean).map((tag) => ({
      repository: tag.split(':')[0],
      tag: tag.split(':')[1] || '',
      id: String(image.Id || '').slice(7, 19),
      size: image.Size,
      created: image.Created ? new Date(image.Created * 1000).toISOString() : '',
    })));
  const watched = list.filter((image) => /^(node|docker|coturn\/coturn|nginx|certbot\/certbot)/.test(image.repository));
  res.json({ ok: true, images: list, watched });
});

/* Re-pulling a tag is how "is there a newer base" is answered honestly: the
   registry decides whether the digest moved, the engine fetches it if it
   did, and the reply says which happened. */
app.post('/Monitor_Server/ops-image-update', authMiddleware, async (req, res) => {
  const reference = String(req.body?.reference || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.\/:-]*:[A-Za-z0-9_.-]+$/.test(reference)) {
    return res.status(400).json({ ok: false, reason: 'bad-reference' });
  }
  if (!dockerAvailable()) return res.json({ ok: false, reason: 'docker-socket-not-mounted' });
  const [name, tag] = reference.split(':');
  const before = await dockerEngineJson('GET', `/v1.44/images/${encodeURIComponent(reference)}/json`);
  const pull = await dockerEngineRequest('POST',
    `/v1.44/images/create?fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`,
    null, { timeoutMs: 900000 });
  if (pull.unreachable || pull.status !== 200) {
    return res.json({ ok: false, reason: `pull-${pull.status || 'unreachable'}`, output: pull.body.slice(-800) });
  }
  const after = await dockerEngineJson('GET', `/v1.44/images/${encodeURIComponent(reference)}/json`);
  const changed = Boolean(before.ok && after.ok && before.data?.Id !== after.data?.Id);
  /* An updated base does nothing to the running stack until it is rebuilt —
     saying so here is what makes the answer honest. */
  res.json({ ok: true, reference, changed, note: changed ? 'base updated; restart the stack to run on it' : 'already current', output: pull.body.slice(-400) });
});

app.post('/Monitor_Server/ops-stack-restart', authMiddleware, async (req, res) => {
  if (!dockerAvailable()) return res.json({ ok: false, reason: 'docker-socket-not-mounted' });
  const containers = await dockerEngineJson('GET', '/v1.44/containers/json?all=1');
  if (!containers.ok) return res.json({ ok: false, reason: 'docker-error' });
  const restarted = [];
  for (const container of containers.data || []) {
    if (!/Poorija-Cryptography/.test((container.Names || []).join(' '))) continue;
    const result = await dockerEngineJson('POST', `/v1.44/containers/${container.Id}/restart?t=15`, null);
    restarted.push({ name: (container.Names || [])[0], ok: result.ok });
  }
  monitorLog(`Stack restart: ${restarted.map((entry) => entry.name + (entry.ok ? "+" : "x")).join(", ") || "none"}`);
  res.json({ ok: restarted.length > 0 && restarted.every((entry) => entry.ok), restarted });
});

/* The raw image of the running relay, streamed from the engine. Fixed to
   the image the stack builds — no operator-supplied name anywhere. */
app.post('/Monitor_Server/ops-image-export', authMiddleware, async (req, res) => {
  if (!dockerAvailable()) return res.json({ ok: false, reason: 'docker-socket-not-mounted' });
  const target = 'config-chat-signal:latest';
  const inspect = await dockerEngineJson('GET', `/v1.44/images/${encodeURIComponent(target)}/json`);
  if (!inspect.ok) return res.json({ ok: false, reason: 'no-such-image' });
  const request = http.request({
    socketPath: OPS_DOCKER_SOCKET,
    path: `/v1.44/images/${encodeURIComponent(target)}/get`,
    method: 'GET',
  }, (response) => {
    if (response.statusCode !== 200) {
      res.status(502).json({ ok: false, reason: `docker-${response.statusCode}` });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/x-tar',
      'Content-Disposition': 'attachment; filename="poorija-relay-image.tar"',
      'Cache-Control': 'no-store',
    });
    /* The engine going away part-way ends this download, not the relay: an
       error event with no listener is thrown, and so is a JSON answer after
       the tar's headers have gone out. */
    response.on('error', () => res.destroy());
    response.pipe(res);
  });
  request.on('error', () => {
    if (res.headersSent) res.destroy();
    else res.status(502).json({ ok: false, reason: 'docker-unreachable' });
  });
  request.end();
});

/* Backups are packed by a job container straight into the host's backups
   directory; this process never touches the bytes. Retention keeps the
   newest OPS_BACKUPS_KEPT (two) — a backup directory that grows forever is a
   disk-full outage being scheduled in advance. */
app.post('/Monitor_Server/ops-backup-create', authMiddleware, async (req, res) => {
  if (!INSTALL_HOST_DIR || !OPS_BACKUP_HOST_DIR) return res.json({ ok: false, reason: 'ops-paths-not-configured' });
  const snapshot = await opsSnapshot();
  if (!snapshot.ok) return res.json({ ok: false, reason: 'archive-failed' });
  await pruneOpsBackups();
  monitorLog(`Backup created: ${snapshot.name}`);
  res.json({ ok: true, name: snapshot.name });
});

/* The listing IS the interface: download, restore and delete take the name
   of a row this listing produced, matched exactly. */
app.post('/Monitor_Server/ops-backup-list', authMiddleware, async (req, res) => {
  if (!OPS_BACKUP_HOST_DIR) return res.json({ ok: false, reason: 'ops-paths-not-configured' });
  const job = await runOpsJob(['sh', '-c', 'ls -lh1 /backups 2>/dev/null | grep server-backup_ || true'], { timeoutMs: 60000 });
  if (!job.ok) return res.json({ ok: false, reason: 'list-failed' });
  const rows = String(job.logs || '').replace(/\u0000/g, '').split('\n').map((line) => line.trim())
    .filter((line) => line.includes('server-backup_'))
    .map((line) => {
      /* ls -lh1 columns: perms links owner group SIZE date time NAME */
      const parts = line.split(/\s+/);
      const name = parts[parts.length - 1];
      const size = parts.length >= 5 ? parts[parts.length - 5] : '';
      return { size, name };
    })
    .filter((row) => /^server-backup_[\w.-]+\.tar\.gz$/.test(row.name));
  rows.sort((a, b) => b.name.localeCompare(a.name));
  res.json({ ok: true, backups: rows });
});

app.post('/Monitor_Server/ops-backup-download', authMiddleware, async (req, res) => {
  if (!OPS_BACKUP_HOST_DIR) return res.json({ ok: false, reason: 'ops-paths-not-configured' });
  const name = String(req.body?.name || '');
  if (!/^server-backup_[\w.-]+\.tar\.gz$/.test(name)) return res.status(400).json({ ok: false, reason: 'bad-name' });
  /* The engine cannot reach the host filesystem from here; the bytes travel
     through a job container into this relay's data directory and stream
     from there — one fixed pipeline, one fixed name shape. */
  /* A name of its own per download: two at once shared one file, and the
     second copy overwrote — or the first one's cleanup deleted — the bytes
     the other was still streaming. */
  const transfer = `.monitor-transfer-${crypto.randomBytes(6).toString('hex')}.tar.gz`;
  const copy = await runOpsJob(['sh', '-c', `test -f "/backups/${name}" && cp "/backups/${name}" "/relaydata/${transfer}"`], { timeoutMs: 300000 });
  if (!copy.ok) return res.status(404).json({ ok: false, reason: 'no-such-backup' });
  const local = path.join(defaultDataDir, transfer);
  res.writeHead(200, {
    'Content-Type': 'application/gzip',
    'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'no-store',
  });
  /* A stream error with nobody listening is thrown — it took the whole relay
     down when the file was not there. Now it ends this one download. */
  fs.createReadStream(local)
    .on('error', () => res.destroy())
    .on('close', () => { fs.unlink(local, () => {}); })
    .pipe(res);
});

app.post('/Monitor_Server/ops-backup-delete', authMiddleware, async (req, res) => {
  if (!OPS_BACKUP_HOST_DIR) return res.json({ ok: false, reason: 'ops-paths-not-configured' });
  const name = String(req.body?.name || '');
  if (!/^server-backup_[\w.-]+\.tar\.gz$/.test(name)) return res.status(400).json({ ok: false, reason: 'bad-name' });
  const job = await runOpsJob(['rm', '-f', `/backups/${name}`], { timeoutMs: 60000 });
  res.json({ ok: job.ok });
});

/* Restore overlays the backup onto the tree — deliberately NOT a wipe: what
   the backup does not carry (data, certs, .env) stays standing, and the
   automatic pre-restore snapshot is how "put it back" works. The operator
   restarts the stack when ready. */
app.post('/Monitor_Server/ops-backup-restore', authMiddleware, async (req, res) => {
  if (!OPS_BACKUP_HOST_DIR) return res.json({ ok: false, reason: 'ops-paths-not-configured' });
  const name = String(req.body?.name || '');
  if (!/^server-backup_[\w.-]+\.tar\.gz$/.test(name)) return res.status(400).json({ ok: false, reason: 'bad-name' });
  const safety = await opsSnapshot();
  const job = await runOpsJob(['tar', 'xzf', `/backups/${name}`, '-C', '/job'], { timeoutMs: 900000 });
  await pruneOpsBackups([name]);
  monitorLog(`Restore overlaid: ${name}`);
  res.json({
    ok: job.ok,
    restored: name,
    safetyBackup: safety.ok ? safety.name : '',
    note: 'tree overlaid; restart the stack from the dashboard when ready',
  });
});

/* The clean bundle: the program with none of this machine's state — what
   the bootstrap installer ships to a fresh server. */
async function opsBundleTo(res, filename) {
  const cmd = ['tar', 'czf', '/relaydata/.monitor-bundle.tar.gz'];
  for (const item of OPS_BUNDLE_EXCLUDE) cmd.push(`--exclude=./${item}`);
  cmd.push('./');
  const job = await runOpsJob(cmd, { timeoutMs: 600000 });
  if (!job.ok) { res.writeHead(502).end('bundle failed'); return; }
  res.writeHead(200, {
    'Content-Type': 'application/gzip',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  const local = path.join(defaultDataDir, '.monitor-bundle.tar.gz');
  fs.createReadStream(local)
    .on('error', () => res.destroy())
    .on('close', () => { fs.unlink(local, () => {}); })
    .pipe(res);
}
app.post('/Monitor_Server/ops-bundle', authMiddleware, async (req, res) => {
  if (!INSTALL_HOST_DIR) return res.json({ ok: false, reason: 'ops-paths-not-configured' });
  await opsBundleTo(res, 'poorija-clean-bundle.tar.gz');
});

/* Where this project's own releases are. Never the other app's: the monitor
   can download a release and lay it over the running tree, and a chat server
   given another app's tree is no longer a chat server. Overridable for a fork;
   anything that is not owner/name falls back to the default. */
const UPDATE_REPO = /^[\w.-]+\/[\w.-]+$/.test(String(process.env.CHAT_UPDATE_REPO || '')) ? process.env.CHAT_UPDATE_REPO : 'Poorija/P00RIJA-Chat';

/* GitHub: check the newest published release against the running build.
   Applying downloads that release and overlays it onto the tree; the safety
   snapshot taken first is the rollback. The one fetch in this file is a
   fixed literal of this project's own releases page; the download itself
   happens inside a job container with the network on, against the same
   fixed origin, so no request-shaped string ever reaches a URL here. */
app.post('/Monitor_Server/ops-github-check', authMiddleware, async (req, res) => {
  let release = null;
  let reachable = false;
  try {
    const response = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { 'User-Agent': 'poorija-monitor' },
      signal: AbortSignal.timeout(30000),
    });
    reachable = response.ok;
    if (response.ok) release = await response.json();
  } catch (_error) { reachable = false; }
  res.json({
    ok: reachable && Boolean(release),
    reachable,
    latest: release ? { tag: release.tag_name, published: release.published_at, url: release.html_url } : null,
    running: { version: RELAY_BUILD?.version, buildTag: RELAY_BUILD?.buildTag },
    /* The published tag may or may not carry the leading v; strip both sides
       before asking whether they differ. */
    updateAvailable: Boolean(release?.tag_name && RELAY_BUILD?.version &&
      String(release.tag_name).replace(/^v/, '') !== String(RELAY_BUILD.version).replace(/^v/, '')),
  });
});

app.post('/Monitor_Server/ops-github-apply', authMiddleware, async (req, res) => {
  if (!INSTALL_HOST_DIR) return res.json({ ok: false, reason: 'ops-paths-not-configured' });
  let tag = String(req.body?.tag || '').trim();
  if (!/^v?[0-9][0-9.]*$/.test(tag)) return res.status(400).json({ ok: false, reason: 'bad-tag' });
  if (!tag.startsWith('v')) tag = `v${tag}`;
  const safety = await opsSnapshot();
  /* One job, network on, fixed origin, tag reduced to dotted digits above:
     download the release zip into the data directory, unpack it, overlay
     the tree, and clean up — every path inside is the job's own mount. */
  const download = await (async () => {
    const name = `poorija-ops-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const created = await dockerEngineJson('POST', `/v1.44/containers/create?name=${name}`, {
      Image: OPS_JOB_IMAGE,
      Cmd: ['sh', '-c', `wget -q -O /job/data/.monitor-update.zip "https://github.com/${UPDATE_REPO}/archive/refs/tags/${tag}.zip" && cd /job/data && rm -rf .monitor-unpacked && mkdir .monitor-unpacked && unzip -q .monitor-update.zip -d .monitor-unpacked && inner=$(ls -d .monitor-unpacked/*/ | head -n 1) && tar -cf - -C "$inner" . | tar -xf - -C /job && rm -rf .monitor-unpacked .monitor-update.zip`],
      HostConfig: { AutoRemove: false, Binds: [`${INSTALL_HOST_DIR}:/job`], NetworkMode: 'default' },
    });
    if (!created.ok) return { ok: false, reason: `create-${created.status}` };
    const containerId = created.data?.Id;
    const started = await dockerEngineJson('POST', `/v1.44/containers/${containerId}/start`, null);
    if (!started.ok) {
      await dockerEngineJson('DELETE', `/v1.44/containers/${containerId}?force=1&v=1`);
      return { ok: false, reason: `start-${started.status}` };
    }
    const deadline = Date.now() + 600000;
    let exitCode = null;
    while (Date.now() < deadline) {
      const state = await dockerEngineJson('GET', `/v1.44/containers/${containerId}/json`);
      if (state.ok && state.data?.State?.Status !== 'running') {
        exitCode = Number(state.data?.State?.ExitCode ?? -1);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const logs = await dockerEngineRequest('GET', `/v1.44/containers/${containerId}/logs?stdout=1&stderr=1&tail=40`);
    await dockerEngineJson('DELETE', `/v1.44/containers/${containerId}?force=1&v=1`);
    if (exitCode === null) return { ok: false, reason: 'job-timeout' };
    return { ok: exitCode === 0, logs: logs.body.slice(-2000) };
  })();
  if (!download.ok) return res.json({ ok: false, reason: download.reason || 'download-failed', output: String(download.logs || '').slice(-500) });
  monitorLog(`GitHub ${tag} applied; safety: ${safety.ok ? safety.name : 'none'}`);
  await pruneOpsBackups();
  res.json({ ok: true, tag, safetyBackup: safety.ok ? safety.name : '', note: 'tree updated; restart the stack from the dashboard to run it' });
});

app.post('/Monitor_Server/ops-github-rollback', authMiddleware, async (req, res) => {
  const name = String(req.body?.backup || '').trim();
  if (name && !/^server-backup_[\w.-]+\.tar\.gz$/.test(name)) return res.status(400).json({ ok: false, reason: 'bad-name' });
  /* No name given: the newest backup, which is the pre-update snapshot if
     the update was the last thing that happened. */
  let chosen = name;
  if (!chosen) {
    /* ls prints the path; the name is what follows /backups/. The check
       below took the whole line, never matched, and a rollback with no name
       always answered "no backup". */
    const listJob = await runOpsJob(['sh', '-c', 'ls -1t /backups/server-backup_*.tar.gz 2>/dev/null | head -n 1'], { timeoutMs: 60000 });
    chosen = String(listJob.logs || '').replace(/\u0000/g, '').split('\n').map((line) => line.trim().replace(/^.*\//, '')).find((line) => /^server-backup_[\w.-]+\.tar\.gz$/.test(line)) || '';
  }
  if (!chosen) return res.json({ ok: false, reason: 'no-backup' });
  const safety = await opsSnapshot();
  const job = await runOpsJob(['tar', 'xzf', `/backups/${chosen}`, '-C', '/job'], { timeoutMs: 900000 });
  await pruneOpsBackups([chosen]);
  monitorLog(`Rollback overlaid: ${chosen}`);
  res.json({
    ok: job.ok,
    restored: chosen,
    safetyBackup: safety.ok ? safety.name : '',
    note: 'tree overlaid; restart the stack from the dashboard when ready',
  });
});

