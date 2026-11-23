/* ------------------------------------------------------------------
 * Retention
 * ------------------------------------------------------------------ */
let expiryLog = loadExpiryLog();

function loadExpiryLog() {
  try {
    const raw = readWholeStore('expiry-log', EXPIRY_LOG_PATH);
    return Array.isArray(raw) ? raw : [];
  } catch (error) {
    console.error('Failed to load the expiry log:', error);
    return [];
  }
}

function saveExpiryLog() {
  try {
    writeWholeStore('expiry-log', EXPIRY_LOG_PATH, expiryLog);
  } catch (error) {
    console.error('Failed to save the expiry log:', error);
  }
}

/* What the sweep needs to know about an envelope, worked out once and kept
   against the envelope itself, so it is dropped when the envelope is and
   reaches neither the store nor the recipient.

   The sweep runs every time mail lands, and it re-derived all three facts for
   every envelope already waiting: sizing one means stringifying it, and the
   sort that orders them calls queuedAtMs twice per comparison. A file arrives
   as one envelope per chunk into one mailbox, so chunk N paid for the N-1
   before it and a transfer cost the square of its own size in JSON and date
   parsing. Measured over a 30 MB file, the last chunks landed several times
   slower than the first; a 200 MB one crawled. Deriving each fact once turns
   that back into a walk of numbers. */
const envelopeFacts = new WeakMap();

function envelopeFactsFor(item) {
  const cached = item && typeof item === 'object' ? envelopeFacts.get(item) : null;
  if (cached) return cached;

  const declared = String(item?.payload?.class || '').toLowerCase();
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
  } catch (error) {
    bytes = 0;
  }
  const parsed = Date.parse(item?.queuedAt || '');

  const facts = {
    kind: declared === 'media' ? 'media' : 'text',
    bytes,
    at: Number.isFinite(parsed) ? parsed : Date.now(),
  };
  if (item && typeof item === 'object') envelopeFacts.set(item, facts);
  return facts;
}

function envelopeClass(item) {
  return envelopeFactsFor(item).kind;
}

function envelopeBytes(item) {
  return envelopeFactsFor(item).bytes;
}

function queuedAtMs(item) {
  return envelopeFactsFor(item).at;
}

/* Records that something arrived and did not survive long enough to be
   collected, so the recipient can be told rather than left wondering. The note
   deliberately carries no message id and nothing from the body — only that
   there was one, from whom, and when. */
function noteExpired(fingerprint, item, reason) {
  expiryLog.push({
    fingerprint,
    from: item?.fromFingerprint || '',
    class: envelopeClass(item),
    reason,
    queuedAt: item?.queuedAt || new Date().toISOString(),
    expiredAt: new Date().toISOString(),
    delivered: false,
  });
}

/* Runs on a timer and on every enqueue. Text is only ever trimmed at the
   ceiling; media goes when it is a week old or when the mailbox is over
   quota, oldest first. */
/* `only` scopes the walk to one recipient's mailbox.
 *
 * Measured on a relay holding 297 mailboxes and 468 MB: one unscoped sweep
 * takes 171 ms, because it JSON.stringifies every media envelope on the server
 * to weigh it against the quota. That ran synchronously on every `hello` and
 * on every queued message, so the cost of one delivery was the size of
 * everyone else's mail — the same quadratic shape this file already fixed once
 * for disk I/O, reintroduced for CPU. At that size the event loop stalls for a
 * sixth of a second every time somebody connects, and it only grows.
 *
 * Queueing a message can only push something out of THAT recipient's mailbox,
 * and a `hello` only needs that peer's queue expired before it is handed over.
 * Neither needs to look at anyone else's. The timer still does the full walk,
 * which is what catches mail belonging to people who never come back. */
function sweepRetention(only = null) {
  const now = Date.now();
  let changed = false;
  /* Which mailboxes the sweep actually touched, so a caller can write those
     rather than all of them. */
  const touched = new Set();

  /* Push subscriptions expire on the window the user chose in Settings. The
     store used to keep them until a vendor said 410, which meant a device that
     was never used again stayed on file indefinitely. */
  let pushChanged = false;
  for (const [key, items] of pushSubscriptions.entries()) {
    const live = items.filter((item) => !item.expiresAt || Date.parse(item.expiresAt) > now);
    if (live.length === items.length) continue;
    pushChanged = true;
    if (live.length) pushSubscriptions.set(key, live);
    else pushSubscriptions.delete(key);
  }
  if (pushChanged) savePushSubscriptions();

  const boxes = only
    ? (offlineBoxes.has(only) ? [[only, offlineBoxes.get(only)]] : [])
    : offlineBoxes.entries();
  for (const [fingerprint, items] of boxes) {
    /* Mail landing is the ordinary case, and ordinarily it evicts nothing:
       the box is inside both caps, everything in it is younger than its
       retention, and no reservation has gone stale. Settle that first, with
       nothing but arithmetic over the cached facts, and leave without copying
       the array or sorting it. A file arriving as thousands of chunks runs
       this path thousands of times. */
    let standingMedia = 0;
    let standingText = 0;
    let standingTextBytes = 0;
    let mustSweep = false;
    for (const item of items) {
      const facts = envelopeFactsFor(item);
      const age = now - facts.at;
      if (facts.kind === 'media') {
        if (age > MEDIA_RETENTION_MS) { mustSweep = true; break; }
        standingMedia += facts.bytes;
        if (standingMedia > MEDIA_QUOTA_BYTES) { mustSweep = true; break; }
      } else {
        standingText += 1;
        standingTextBytes += facts.bytes;
        if (standingTextBytes > TEXT_QUOTA_BYTES) { mustSweep = true; break; }
      }
      if (item?.payload?.type === 'session-offer' && age > SESSION_RESERVATION_MS) {
        mustSweep = true;
        break;
      }
    }
    if (!mustSweep && standingText <= TEXT_MAILBOX_LIMIT) continue;

    const keep = [];
    let mediaBytes = 0;

    // Newest first so the quota drops the oldest media, not the newest.
    const ordered = [...items].sort((a, b) => queuedAtMs(b) - queuedAtMs(a));
    for (const item of ordered) {
      const kind = envelopeClass(item);
      const age = now - queuedAtMs(item);

      if (kind === 'media') {
        if (age > MEDIA_RETENTION_MS) {
          noteExpired(fingerprint, item, 'retention');
          changed = true;
          continue;
        }
        const size = envelopeBytes(item);
        if (mediaBytes + size > MEDIA_QUOTA_BYTES) {
          noteExpired(fingerprint, item, 'quota');
          changed = true;
          continue;
        }
        mediaBytes += size;
      }

      if (item?.payload?.type === 'session-offer'
        && age > SESSION_RESERVATION_MS) {
        // An unclaimed reservation is a stranger's key sitting on a server.
        changed = true;
        continue;
      }

      keep.push(item);
    }

    // Back into arrival order, and cap the text tail — by count and by bytes.
    keep.sort((a, b) => queuedAtMs(a) - queuedAtMs(b));
    let textCount = 0;
    let textBytes = 0;
    for (const item of keep) {
      if (envelopeClass(item) !== 'text') continue;
      textCount += 1;
      textBytes += envelopeBytes(item);
    }
    if (textCount > TEXT_MAILBOX_LIMIT || textBytes > TEXT_QUOTA_BYTES) {
      const drop = new Set();
      /* Oldest first: the newest text is what the person has not read yet,
         and the cap should take the mail that has waited the longest. */
      for (const item of keep) {
        if (textCount <= TEXT_MAILBOX_LIMIT && textBytes <= TEXT_QUOTA_BYTES) break;
        if (envelopeClass(item) !== 'text') continue;
        drop.add(item);
        textCount -= 1;
        textBytes -= envelopeBytes(item);
      }
      for (const item of drop) noteExpired(fingerprint, item, 'mailbox-full');
      changed = true;
      for (let i = keep.length - 1; i >= 0; i -= 1) {
        if (drop.has(keep[i])) keep.splice(i, 1);
      }
    }

    if (keep.length !== items.length) { changed = true; touched.add(fingerprint); }
    if (keep.length) offlineBoxes.set(fingerprint, keep);
    else offlineBoxes.delete(fingerprint);
  }

  const logCutoff = now - EXPIRY_LOG_RETENTION_MS;
  const prunedLog = expiryLog.filter((entry) => {
    const at = Date.parse(entry.expiredAt || '');
    return !Number.isFinite(at) || at >= logCutoff;
  });
  if (prunedLog.length !== expiryLog.length) {
    expiryLog = prunedLog;
    saveExpiryLog();
  } else if (changed) {
    saveExpiryLog();
  }

  /* Only what the sweep actually changed gets written - it usually touches a
     handful of mailboxes, and writing all of them would put the cost this
     change removed straight back. */
  touched.forEach((fingerprint) => saveOfflineBox(fingerprint));
  sweepRetention.changed = changed;
  return [...touched];
}

/* ------------------------------------------------------------------
 * Durable writes
 *
 * Every store used to be written straight over itself with writeFileSync. A
 * crash, an OOM kill or a power cut anywhere inside that call leaves a
 * truncated file — and for offline-messages.json, which routinely reaches
 * tens of megabytes, that is every queued message for every user gone, with
 * the next boot finding a JSON parse error where the mailboxes used to be.
 *
 * Write to a sibling temp file, flush it to the platter, then rename. rename
 * within a directory is atomic on POSIX and on NTFS: a reader sees either the
 * whole old file or the whole new one, never a half-written one.
 *
 * Pretty-printing is also gone. Nothing reads these by eye, and `null, 2` on a
 * 59 MB store costs both the time to produce roughly twice the bytes and the
 * disk to hold them.
 * ------------------------------------------------------------------ */
function writeJsonAtomic(targetPath, value) {
  const directory = path.dirname(targetPath);
  fs.mkdirSync(directory, { recursive: true });
  const temp = path.join(directory, `.${path.basename(targetPath)}.${process.pid}.tmp`);
  let handle = null;
  try {
    /* 0600, not the default 0644. What goes through here is the monitor's own
       password and the mailbox of queued envelopes; neither is something every
       account on the host, or every layer of a shared image, should be able to
       read. The mode is set on the temp file because rename() carries it. */
    handle = fs.openSync(temp, 'w', 0o600);
    fs.writeFileSync(handle, JSON.stringify(value));
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    fs.renameSync(temp, targetPath);
  try { const dirFd = fs.openSync(path.dirname(targetPath), 'r'); fs.fsyncSync(dirFd); fs.closeSync(dirFd); } catch (_dirSyncError) {}
  } catch (error) {
    if (handle !== null) { try { fs.closeSync(handle); } catch (_e) { /* noop */ } }
    try { fs.unlinkSync(temp); } catch (_e) { /* nothing to clean up */ }
    throw error;
  }
}

/* Write one mailbox. This is what nearly every call site actually wants: a
   message arrives for one person, or one person's queue is acknowledged. */
function saveOfflineBoxNow(fingerprint) {
  const clean = sanitizeFingerprint(fingerprint);
  if (!clean) return;
  /* The last word on what may become a filename. Nothing that reaches this
     function should be anything but a fingerprint — the queue path and the
     purge both refuse other shapes first — but a key that arrived before
     they did, or one read off an old disk, stops here rather than at a
     path.join. */
  if (!isFingerprintKey(clean)) return;
  const db = mailboxDb();
  if (db) {
    try {
      const items = offlineBoxes.get(clean);
      const started = Date.now();
      if (items && items.length) db.put('mailbox', clean, items);
      else db.delete('mailbox', clean);
      lastMailboxWriteMs = Date.now() - started;
    } catch (error) {
      console.error(`Failed to save mailbox ${clean}:`, error);
    }
    return;
  }
  try {
    fs.mkdirSync(OFFLINE_STORE_DIR, { recursive: true });
    const items = offlineBoxes.get(clean);
    if (items && items.length) {
      const started = Date.now();
      writeJsonAtomic(mailboxPath(clean), items);
      lastMailboxWriteMs = Date.now() - started;
    } else if (fs.existsSync(mailboxPath(clean))) {
      fs.unlinkSync(mailboxPath(clean));
    }
  } catch (error) {
    console.error(`Failed to save mailbox ${clean}:`, error);
  }
}

/* A mailbox is written whole, and it was written on every message that landed
   in it. A file arrives as one envelope per chunk, so chunk N rewrote the N-1
   already there: a 30 MB file cost about ten gigabytes of disk writes and took
   seventeen seconds to queue, and a 200 MB one was measured in hundreds of
   gigabytes. Nothing failed; it was simply slower the longer it ran.

   A trailing debounce collapses the burst into one write, and the wait grows
   with the box: a rewrite costs time in proportion to what is being written,
   so a fixed wait spends an ever larger share of the clock persisting. Waiting
   a multiple of however long the last write actually took holds that share
   roughly constant and needs no guess at the size. It is capped, because what
   a crash costs is the wait -- and the sweeps and the shutdown path both call
   saveOfflineBoxes(), which flushes everything pending along with the rest. */
const MAILBOX_SAVE_MIN_MS = 250;
/* A second at most between a message being acknowledged as queued and it
   being on disk. Four seconds was a window in which a crash lost mail the
   sender had already been told was safe. */
const MAILBOX_SAVE_MAX_MS = 1000;
const MAILBOX_SAVE_FACTOR = 4;

let lastMailboxWriteMs = 0;
const pendingMailboxSaves = new Map();

function mailboxSaveDelay() {
  const proportional = lastMailboxWriteMs * MAILBOX_SAVE_FACTOR;
  return Math.min(MAILBOX_SAVE_MAX_MS, Math.max(MAILBOX_SAVE_MIN_MS, proportional));
}

function saveOfflineBox(fingerprint) {
  const clean = sanitizeFingerprint(fingerprint);
  if (!clean) return;
  if (pendingMailboxSaves.has(clean)) return;
  pendingMailboxSaves.set(clean, setTimeout(() => {
    pendingMailboxSaves.delete(clean);
    saveOfflineBoxNow(clean);
  }, mailboxSaveDelay()));
}

/* Writes anything still waiting on its debounce. Called before a full save and
   on the way out, so nothing is lost to a timer that never fired. */
function flushPendingMailboxSaves() {
  for (const [clean, timer] of pendingMailboxSaves) {
    clearTimeout(timer);
    saveOfflineBoxNow(clean);
  }
  pendingMailboxSaves.clear();
}

/* Every mailbox. Only the sweeps and shutdown need this, and they run on a
   timer or once, not per message. */
function saveOfflineBoxes() {
  /* Whatever is mid-debounce is about to be written anyway; clearing the
     timers here stops one firing after a shutdown has already saved. */
  for (const timer of pendingMailboxSaves.values()) clearTimeout(timer);
  pendingMailboxSaves.clear();
  const db = mailboxDb();
  if (db) {
    try {
      db.replaceAll('mailbox', [...offlineBoxes].filter(([, items]) => items && items.length));
    } catch (error) {
      console.error('Failed to save offline boxes:', error);
    }
    return;
  }
  try {
    fs.mkdirSync(OFFLINE_STORE_DIR, { recursive: true });
    const live = new Set();
    offlineBoxes.forEach((items, fingerprint) => {
      if (!items || !items.length) return;
      live.add(`${fingerprint}.json`);
      writeJsonAtomic(mailboxPath(fingerprint), items);
    });
    /* A mailbox that emptied has to lose its file, or it comes back on boot. */
    fs.readdirSync(OFFLINE_STORE_DIR).forEach((name) => {
      if (!name.endsWith('.json') || live.has(name)) return;
      try { fs.unlinkSync(path.join(OFFLINE_STORE_DIR, name)); } catch (_e) { /* already gone */ }
    });
  } catch (error) {
    console.error('Failed to save offline boxes:', error);
  }
}

function loadSelfDestructRecords() {
  try {
    const raw = readWholeStore('self-destruct', SELF_DESTRUCT_STORE_PATH);
    if (raw === undefined) return new Map();
    return new Map(Object.entries(raw || {}).map(([id, record]) => [
      sanitizeSelfDestructId(id),
      normalizeSelfDestructRecord(record),
    ]).filter(([id, record]) => id && record));
  } catch (error) {
    console.error('Failed to load self-destruct records:', error);
    return new Map();
  }
}

function saveSelfDestructRecords() {
  try {
    writeWholeStore('self-destruct', SELF_DESTRUCT_STORE_PATH, Object.fromEntries(selfDestructRecords));
  } catch (error) {
    console.error('Failed to save self-destruct records:', error);
  }
}

function sanitizeSelfDestructId(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
}

function clampNonNegativeNumber(value, fallback = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function normalizeSelfDestructRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const id = sanitizeSelfDestructId(record.id);
  const payloadId = sanitizeSelfDestructId(record.payloadId);
  if (!id || !payloadId) return null;
  return {
    id,
    payloadId,
    timeLimitMs: clampNonNegativeNumber(record.timeLimitMs, 0, 30 * 24 * 60 * 60 * 1000),
    maxViews: clampNonNegativeNumber(record.maxViews, 0, 100000),
    opens: clampNonNegativeNumber(record.opens, 0, 100000000),
    createdAt: record.createdAt || new Date().toISOString(),
    firstOpenedAt: record.firstOpenedAt || null,
    updatedAt: record.updatedAt || record.createdAt || new Date().toISOString(),
  };
}

function selfDestructRecordStatus(record) {
  const now = Date.now();
  const firstOpenedAtMs = record.firstOpenedAt ? Date.parse(record.firstOpenedAt) : 0;
  const expiresAtMs = record.timeLimitMs > 0 && firstOpenedAtMs ? firstOpenedAtMs + record.timeLimitMs : 0;
  const expired = Boolean(expiresAtMs && now >= expiresAtMs);
  const remainingViews = record.maxViews > 0 ? Math.max(0, record.maxViews - record.opens) : 0;
  return {
    expired,
    expiresAt: expiresAtMs ? new Date(expiresAtMs).toISOString() : null,
    remainingViews,
  };
}

function publicSelfDestructRecord(record) {
  return {
    id: record.id,
    timeLimitMs: record.timeLimitMs,
    maxViews: record.maxViews,
    opens: record.opens,
    createdAt: record.createdAt,
    firstOpenedAt: record.firstOpenedAt,
    updatedAt: record.updatedAt,
    ...selfDestructRecordStatus(record),
  };
}

function pruneSelfDestructRecords() {
  const cutoff = Date.now() - 45 * 24 * 60 * 60 * 1000;
  let changed = false;
  for (const [id, record] of selfDestructRecords.entries()) {
    const touchedAtMs = Date.parse(record.updatedAt || record.firstOpenedAt || record.createdAt || '');
    if (touchedAtMs && touchedAtMs < cutoff) {
      selfDestructRecords.delete(id);
      changed = true;
    }
  }
  if (changed) saveSelfDestructRecords();
}

function touchPresence(record) {
  record.lastSeenAt = Date.now();
  record.updatedAt = new Date(record.lastSeenAt).toISOString();
}

function sanitizeFingerprint(value) {
  return String(value || '').trim().slice(0, 128);
}

/* A mailbox key is a fingerprint or it is nothing. The value a sender puts
   in toFingerprint reaches a filename through mailboxPath(), and path.join
   resolves '..', so anything that is not exactly 64 lowercase hex lets the
   sender choose which file gets written or deleted — '../relay-identity'
   sits one level above the mailboxes and is the file a relay must never
   lose. Queueing, wiping and the filesystem itself all answer to this. */
function isFingerprintKey(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ''));
}

function sanitizeSubscription(value) {
  if (!value || typeof value !== 'object') return null;
  const endpoint = String(value.endpoint || '').slice(0, 2048);
  if (!endpoint) return null;

  /* Two kinds of row live in this store.
   *
   * A browser's Push API subscription carries the two keys its vendor's
   * service needs to accept an encrypted payload. A UnifiedPush endpoint is
   * just a URL the distributor app on the phone handed out, with nothing to
   * encrypt to -- the distributor is the transport, and it is the person's own
   * choice of transport rather than Google's.
   *
   * The payload is the same either way, and it is the reason a bare URL is
   * acceptable here: it names no sender, carries no message text and says only
   * that something arrived. Anyone who learned the endpoint could make this
   * phone buzz. Nobody could learn anything from it. */
  if (String(value.type || '') === 'unifiedpush') {
    if (!/^https?:\/\//i.test(endpoint)) return null;
    const upTtlDays = PUSH_TTL_CHOICES.includes(Number(value.ttlDays)) ? Number(value.ttlDays) : null;
    const upDeviceId = typeof value.deviceId === 'string' ? value.deviceId.slice(0, 128) : '';
    const upExpiresAt = typeof value.expiresAt === 'string' && !Number.isNaN(Date.parse(value.expiresAt))
      ? value.expiresAt
      : null;
    return {
      type: 'unifiedpush',
      endpoint,
      expirationTime: null,
      lang: normalizePushLang(value.lang),
      ...(upTtlDays ? { ttlDays: upTtlDays } : {}),
      ...(upExpiresAt ? { expiresAt: upExpiresAt } : {}),
      ...(upDeviceId ? { deviceId: upDeviceId } : {}),
      ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
    };
  }

  const p256dh = String(value.keys?.p256dh || '').slice(0, 512);
  const auth = String(value.keys?.auth || '').slice(0, 512);
  if (!p256dh || !auth) return null;
  /* The expiry has to survive a reload. It did not: this function is what the
     loader maps every stored row through, and it used to drop ttlDays and
     expiresAt, so a restart turned every subscription into one that never
     expired and the sweep could never collect it. */
  const ttlDays = PUSH_TTL_CHOICES.includes(Number(value.ttlDays)) ? Number(value.ttlDays) : null;
  const deviceId = typeof value.deviceId === 'string' ? value.deviceId.slice(0, 128) : '';
  /* Which language this device reads. Two values, both harmless: it says
     nothing about who the person is that the relay does not already have. */
  const lang = normalizePushLang(value.lang);
  const expiresAt = typeof value.expiresAt === 'string' && !Number.isNaN(Date.parse(value.expiresAt))
    ? value.expiresAt
    : null;
  return {
    endpoint,
    expirationTime: value.expirationTime || null,
    keys: { p256dh, auth },
    lang,
    ...(ttlDays ? { ttlDays } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(deviceId ? { deviceId } : {}),
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
  };
}

function loadPushSubscriptions() {
  try {
    const raw = readWholeStore('push', PUSH_STORE_PATH);
    if (raw === undefined) return new Map();
    return new Map(Object.entries(raw || {}).map(([fingerprint, items]) => [
      sanitizeFingerprint(fingerprint),
      Array.isArray(items) ? items.map(sanitizeSubscription).filter(Boolean) : [],
    ]).filter(([fingerprint, items]) => fingerprint && items.length));
  } catch (error) {
    console.error('Failed to load push subscriptions:', error);
    return new Map();
  }
}

function savePushSubscriptions() {
  try {
    writeWholeStore('push', PUSH_STORE_PATH, Object.fromEntries(pushSubscriptions));
  } catch (error) {
    console.error('Failed to save push subscriptions:', error);
  }
}

function loadPolicyStore() {
  try {
    const raw = readWholeStore('policy', POLICY_STORE_PATH);
    if (raw === undefined) return { suspendedUsers: {}, kickedUsers: {} };
    return {
      suspendedUsers: raw?.suspendedUsers && typeof raw.suspendedUsers === 'object' ? raw.suspendedUsers : {},
      kickedUsers: raw?.kickedUsers && typeof raw.kickedUsers === 'object' ? raw.kickedUsers : {},
    };
  } catch (error) {
    console.error('Failed to load server policy store:', error);
    return { suspendedUsers: {}, kickedUsers: {} };
  }
}

function savePolicyStore() {
  try {
    writeWholeStore('policy', POLICY_STORE_PATH, {
      suspendedUsers: Object.fromEntries(suspendedUsers),
      kickedUsers: Object.fromEntries(kickedUsers),
      allowedUsers: Object.fromEntries(allowedUsers),
      allowlistEnabled,
    });
  } catch (error) {
    console.error('Failed to save server policy store:', error);
  }
}

function identityKey(identity) {
  const fingerprint = sanitizeFingerprint(identity?.fingerprint);
  if (fingerprint) return fingerprint;
  const peerId = String(identity?.peerId || '').trim();
  if (peerId) return peerId;
  const ip = normalizeIpValue(identity?.ip || '');
  const username = String(identity?.username || '').trim().toLowerCase();
  if (ip && isPublicIp(ip) && username) return `ip:${ip}:${username}`;
  return '';
}

function normalizeIpValue(value = '') {
  const clean = String(value || '')
    .trim()
    .replace(/^"|"$/g, '')
    .replace(/^::ffff:/, '')
    .replace(/^\[|\]$/g, '')
    .replace(/^for=/i, '');
  const ipv4WithPort = clean.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  return (ipv4WithPort ? ipv4WithPort[1] : clean).slice(0, 80);
}

function isContainerOrLoopbackIp(ip = '') {
  const clean = normalizeIpValue(ip);
  if (!clean) return false;
  if (clean === '127.0.0.1' || clean === '::1' || clean === 'localhost') return true;
  const match = clean.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const first = Number(match[1]);
  const second = Number(match[2]);
  return first === 172 && second >= 16 && second <= 31;
}

function isPublicIp(ip = '') {
  const clean = normalizeIpValue(ip);
  const match = clean.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return clean.includes(':') && clean !== '::1' && !clean.toLowerCase().startsWith('fc') && !clean.toLowerCase().startsWith('fd') && !clean.toLowerCase().startsWith('fe80');
  const first = Number(match[1]);
  const second = Number(match[2]);
  if (first === 10 || first === 127 || first === 0) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && second === 168) return false;
  if (first === 169 && second === 254) return false;
  return true;
}

function requestIp(req) {
  /* Bans, the monitor's lists and every record's address read this. The
     headers below are a CDN's to set, and without one in front a client can
     write any of them: a banned address would come back under a made-up one.
     So they count only where an operator says a CDN sets them. */
  if (process.env.CHAT_TRUST_CDN_HEADERS !== '1') return String(securityKey(req) || '').slice(0, 80);
  const forwardedHeader = String(req?.headers?.['x-forwarded-for'] || '');
  const forwardedDirective = String(req?.headers?.forwarded || '')
    .split(',')
    .map((part) => part.match(/for="?([^;,"]+)/i)?.[1] || '')
    .filter(Boolean);
  const candidates = [
    req?.headers?.['cf-connecting-ip'],
    req?.headers?.['true-client-ip'],
    req?.headers?.['x-real-ip'],
    req?.headers?.['x-client-ip'],
    ...forwardedHeader.split(','),
    ...forwardedDirective,
    req?.ip,
    req?.socket?.remoteAddress,
  ].flat().map(normalizeIpValue).filter(Boolean);
  const publicIp = candidates.find(isPublicIp);
  if (publicIp) return publicIp;
  const nonContainerIp = candidates.find((ip) => !isContainerOrLoopbackIp(ip));
  return (nonContainerIp || '').slice(0, 80);
}

function upgradeRequestIdentity(request, url = null) {
  const parsed = url || new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  return {
    peerId: String(parsed.searchParams.get('id') || parsed.searchParams.get('peerId') || '').slice(0, 160),
    fingerprint: sanitizeFingerprint(parsed.searchParams.get('fingerprint') || request.headers['x-p00rija-fingerprint']),
    clientId: String(parsed.searchParams.get('clientId') || '').slice(0, 80),
    username: String(parsed.searchParams.get('username') || '').slice(0, 80),
    ip: requestIp(request),
  };
}

function rejectRestrictedUpgrade(socket, restriction) {
  try {
    const code = restriction?.type === 'suspended' ? 4403 : 4401;
    const body = JSON.stringify({
      ok: false,
      restricted: true,
      restrictionType: restriction?.type || 'restricted',
      code,
    });
    socket.write([
      'HTTP/1.1 403 Forbidden',
      'Connection: close',
      'Content-Type: application/json; charset=utf-8',
      `Content-Length: ${Buffer.byteLength(body)}`,
      '',
      body,
    ].join('\r\n'));
  } catch (_error) {
    // Best-effort upgrade rejection.
  } finally {
    socket.destroy();
  }
}

function identitySnapshot(record = {}) {
  return {
    clientId: String(record.clientId || '').slice(0, 80),
    username: String(record.username || '').slice(0, 80),
    peerId: String(record.peerId || '').slice(0, 160),
    fingerprint: sanitizeFingerprint(record.fingerprint),
    ip: String(record.ip || '').split(',')[0].trim().replace('::ffff:', '').slice(0, 80),
  };
}

function hasUsableIdentity(identity = {}) {
  const snapshot = identitySnapshot(identity);
  if (snapshot.fingerprint || snapshot.peerId) return true;
  return Boolean(snapshot.username && snapshot.ip && isPublicIp(snapshot.ip));
}

function identityMatchesPolicy(identity, policy) {
  const current = identitySnapshot(identity);
  
  // 1. Strong matches (Fingerprint or PeerID)
  if (policy.fingerprint && current.fingerprint && policy.fingerprint === current.fingerprint) return true;
  if (policy.peerId && current.peerId && policy.peerId === current.peerId) return true;
  
  // 2. IP-based matching is allowed only for real public IP + explicit username.
  if (policy.ip && current.ip && policy.ip === current.ip && isPublicIp(policy.ip) && isPublicIp(current.ip)) {
    const pUser = String(policy.username || '').trim().toLowerCase();
    const cUser = String(current.username || '').trim().toLowerCase();
    if (pUser && cUser && pUser === cUser) return true;
  }
  
  return false;
}

function resolvePolicyKey(store, body = {}) {
  const directKey = String(body?.key || '').trim();
  if (directKey && store.has(directKey)) return directKey;
  const identity = {
    fingerprint: body?.fingerprint,
    peerId: body?.peerId,
    clientId: body?.clientId,
    username: body?.username,
    ip: body?.ip,
  };
  for (const [key, policy] of store.entries()) {
    if (identityMatchesPolicy(identity, policy)) return key;
  }
  return '';
}

function sanitizePolicyDurationMinutes(value, fallback) {
  const minutes = Number(value || fallback);
  if (!Number.isFinite(minutes)) return fallback;
  return Math.max(1, Math.min(60 * 24 * 30, Math.round(minutes)));
}

function sanitizePolicyDurationMs(msValue, minutesValue, fallbackMinutes) {
  const maxMs = 60 * 24 * 30 * 60 * 1000;
  const fromMs = Number(msValue);
  if (Number.isFinite(fromMs) && fromMs > 0) {
    return Math.max(1000, Math.min(maxMs, Math.round(fromMs)));
  }
  const minutes = Number(minutesValue || fallbackMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return fallbackMinutes * 60 * 1000;
  }
  return Math.max(1000, Math.min(maxMs, Math.round(minutes * 60 * 1000)));
}

