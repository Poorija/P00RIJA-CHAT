/* ---- rosters across the family (guest mode) ---------------------------------
 *
 * A guest relay never had the account's roster, and without one it cannot
 * tell a revoked device from a live one. So a relay that stores a new roster
 * hands a copy to the family's other relays, sealed under a key made from the
 * account's fingerprint (scripts/lib/relay-guests.js): a relay, even a seized
 * one, can open a copy only for an account whose fingerprint it already
 * holds — when that account visits as a guest, or when the roster is one of
 * its own residents'. The identity key a roster's certificate is checked with
 * is kept beside the roster for the same reason. */
const ROSTER_COPY_DIR = path.join(ROSTER_DIR, 'copies');
const ROSTER_COPY_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const ROSTER_BACKFILL_MAX = 5000;
const rosterIdentityPath = (fingerprint) => path.join(ROSTER_DIR, `${fingerprint}.identity`);
function saveRosterIdentity(fingerprint, publicKeyData) {
  try {
    const key = String(publicKeyData || '');
    if (crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex') !== fingerprint) return false;
    if (fs.existsSync(rosterIdentityPath(fingerprint))) return true;
    fs.mkdirSync(ROSTER_DIR, { recursive: true });
    fs.writeFileSync(rosterIdentityPath(fingerprint), key, { mode: 0o600 });
    return true;
  } catch (_error) { return false; }
}
function loadRosterIdentity(fingerprint) {
  try { return fs.readFileSync(rosterIdentityPath(fingerprint), 'utf8').trim(); } catch (_error) { return ''; }
}
/* Index → fingerprint for the rosters this relay holds, so a copy that is an
   update of one of them is recognised. */
let rosterCopyIndexes = null;
function rosterFingerprintForIndex(index) {
  if (!rosterCopyIndexes) {
    rosterCopyIndexes = new Map();
    try {
      const db = rosterDb();
      const names = db ? db.keys('roster').map((key) => `${key}.json`) : fs.readdirSync(ROSTER_DIR);
      for (const name of names) {
        const match = /^([a-f0-9]{64})\.json$/.exec(name);
        if (match) rosterCopyIndexes.set(guestRules.rosterCopyIndex(match[1]), match[1]);
      }
    } catch (_error) { /* no rosters yet */ }
  }
  return rosterCopyIndexes.get(index) || '';
}
function noteRosterHeld(fingerprint) {
  if (rosterCopyIndexes) rosterCopyIndexes.set(guestRules.rosterCopyIndex(fingerprint), fingerprint);
}
const rosterCopyStore = guestRules.createRosterCopyStore({ dir: ROSTER_COPY_DIR, ttlMs: ROSTER_COPY_TTL_MS });
function familyLinks({ guestTakersOnly = false } = {}) {
  const takers = new Set((directoryState.doc?.body?.relays || []).filter((relay) => relay.guests === true).map((relay) => relay.id));
  return directoryMembers().filter((id) => !guestTakersOnly || takers.has(id)).map((id) => relayPeers.linkFor(id)).filter(Boolean);
}
function shareRosterCopy(fingerprint, roster, publicKeyData) {
  let copy;
  try { copy = guestRules.sealRosterCopy(fingerprint, roster, publicKeyData); } catch (_error) { return; }
  for (const link of familyLinks()) {
    try { link.send({ kind: 'roster-copy', copy }); } catch (_error) { /* the link went */ }
  }
}
/* Everything held, to one relay that takes guests: when its link comes up,
   and when the family list first says it takes guests. */
function sendRosterCopiesTo(link) {
  if (!link?.isOpen?.()) return;
  const taker = (directoryState.doc?.body?.relays || []).some((relay) => relay.id === link.peerId && relay.guests === true);
  if (!taker || !directoryMembers().includes(link.peerId)) return;
  rosterFingerprintForIndex('');
  const fingerprints = Array.from(rosterCopyIndexes.values()).slice(0, ROSTER_BACKFILL_MAX);
  let at = 0;
  const step = () => {
    for (let n = 0; n < 20 && at < fingerprints.length; n += 1, at += 1) {
      const fp = fingerprints[at];
      const roster = loadRoster(fp);
      const key = loadRosterIdentity(fp);
      if (!roster || !key) continue;
      try { link.send({ kind: 'roster-copy', copy: guestRules.sealRosterCopy(fp, roster, key) }); } catch (_error) { return; }
    }
    if (at < fingerprints.length && link.isOpen?.()) setImmediate(step);
  };
  step();
}
/* A copy off a family link: kept if newer than the one held; and if it is an
   update of a roster this relay holds, taken on under the usual rule — signed
   by the primary the held roster names, with a higher sequence number. */
function receiveRosterCopy(payload, link) {
  const copy = payload?.copy;
  if (!directoryMembers().includes(link?.peerId)) return;
  if (!copy || typeof copy !== 'object' || !/^[a-f0-9]{64}$/.test(String(copy.i || '')) || !Number.isSafeInteger(copy.seq)
    || typeof copy.iv !== 'string' || typeof copy.ct !== 'string' || copy.ct.length > 64 * 1024 || copy.iv.length > 24) return;
  rosterCopyStore.keep(copy, link.peerId);
  const fp = rosterFingerprintForIndex(copy.i);
  if (!fp) return;
  const opened = guestRules.openRosterCopy(fp, copy);
  if (!opened) return;
  const current = loadRoster(fp);
  if (rosterRefusal(opened.roster, current, opened.publicKeyData, fp)) return;
  saveRoster(fp, opened.roster);
  saveRosterIdentity(fp, opened.publicKeyData);
  console.log(`[Roster] ${fp.slice(0, 12)} now at ${opened.roster.seq}, from a family relay`);
  enforceRoster(fp, opened.roster);
  for (const candidate of verifiedByFingerprint.get(fp) || []) {
    if (candidate.ws?.readyState === WebSocket.OPEN) safeSend(candidate.ws, { type: 'roster', roster: opened.roster, ...(candidate.guest ? { guest: true } : {}) });
  }
}
/* What a guest is judged by: every roster this relay can stand behind for the
 * account. Its own, if it holds one, and every self-consistent roster among
 * the family's copies, each followed as far as valid successors lead, and the
 * one the device carries on top of each, again only as a successor. The
 * device is refused if ANY of them revokes it: a revocation is the account's
 * primary speaking, and this relay cannot tell which relay is the account's
 * real home — the device names one, and a revoked device would name the
 * wrong one. Nothing founded elsewhere is kept here; only a valid successor of
 * this relay's own roster is. The roster handed to the device is its own
 * one's, else its home relay's, else the newest. */
function guestRosterView(fingerprint, publicKeyData, helloRoster, homeId = '') {
  const own = loadRoster(fingerprint);
  const held = rosterCopyStore.copies(guestRules.rosterCopyIndex(fingerprint))
    .map((entry) => ({ from: entry.from, opened: guestRules.openRosterCopy(fingerprint, entry.copy) }))
    .filter((entry) => entry.opened);
  const extend = (base) => {
    let current = base;
    for (let round = 0; round < 8; round += 1) {
      const next = held.find((entry) => entry.opened.roster.seq > current.seq && !rosterRefusal(entry.opened.roster, current, entry.opened.publicKeyData, fingerprint));
      if (!next) break;
      current = next.opened.roster;
    }
    if (helloRoster && !rosterRefusal(helloRoster, current, publicKeyData, fingerprint)) current = helloRoster;
    return current;
  };
  const chains = [];
  if (own) chains.push({ from: 'own', roster: extend(own) });
  for (const entry of held) {
    if (!rosterRefusal(entry.opened.roster, null, entry.opened.publicKeyData, fingerprint)) chains.push({ from: entry.from, roster: extend(entry.opened.roster) });
  }
  if (!chains.length && helloRoster && !rosterRefusal(helloRoster, null, publicKeyData, fingerprint)) chains.push({ from: 'hello', roster: helloRoster });
  const ownChain = chains.find((chain) => chain.from === 'own');
  if (ownChain && ownChain.roster !== own) {
    saveRoster(fingerprint, ownChain.roster);
    saveRosterIdentity(fingerprint, publicKeyData);
    if (ownChain.roster === helloRoster) shareRosterCopy(fingerprint, helloRoster, publicKeyData);
  }
  const pick = ownChain || chains.find((chain) => chain.from === homeId) || chains.slice().sort((a, b) => b.roster.seq - a.roster.seq)[0];
  return { roster: pick?.roster || null, chains: chains.map((chain) => chain.roster) };
}
const guestViewRevokes = (view, deviceId, deviceKey) => view.chains.some((roster) => rosterRevokes(roster, deviceId, deviceKey));
/* A roster written where this relay holds none of its own: taken only if it
   follows from every roster the family holds for the account. Where rival
   rosters exist, none follows from all of them, and nothing is written —
   that is for the account's home to settle. '' when it may be written. */
function familyWriteRefusal(next, view, publicKeyData, fingerprint) {
  if (!view.chains.length) return '';
  const refusals = view.chains.map((roster) => rosterRefusal(next, roster, publicKeyData, fingerprint));
  return refusals.find((reason) => reason) || '';
}

/* ------------------------------------------------------------------
 * Held for an absent sibling.
 *
 * Devices of one account sync with each other directly while both are online.
 * A device that is away used to catch up only when it and a sibling were
 * online together — so if the sibling had gone by the time it came back, it
 * had nothing. Now a device sending its siblings a sync envelope also hands
 * the relay a copy for each sibling that is NOT here at that moment: the
 * relay keeps it — sealed to the account's own key, unreadable here — for
 * exactly those devices, delivers it when each connects, and forgets it the
 * moment each has acknowledged it.
 *
 * What it will keep, and for how long, is the whole design:
 *   - only device-sync envelopes from the account's own proven owner, each at
 *     most 96 KB — history and what changed in it, never a file (the client
 *     never puts file bytes in one, and the cap would refuse them anyway);
 *   - only for devices the account has (its beacons) that are not connected
 *     and awake — a device that is here gets the live copy and nothing is
 *     stored for it;
 *   - at most 4 MB and 2,000 items per account, oldest dropped first, and a
 *     device whose items were dropped is told so (it then asks a sibling for
 *     what it missed, device to device, as before); 256 MB across the whole
 *     relay (CHAT_SIBLING_MAX_BYTES), past which nothing more is held; no more
 *     than 32 MB of it in memory at once;
 *   - fourteen days at most;
 *   - and never a message meant to disappear (on a timer, or view-once): the
 *     client keeps those to the live copy alone.
 * ------------------------------------------------------------------ */
function siblingHeldPath(fingerprint) {
  return path.join(SIBLING_DIR, `${fingerprint}.json`);
}
const siblingDb = () => stateStore('sibling', { dir: SIBLING_DIR, key: (name) => (isFingerprintKey(name) ? name : '') });
function siblingStoreChars(store) {
  return store.items.reduce((sum, item) => sum + (item.envelope?.length || 0), 0);
}
/* What every account holds, read once from the files at start. */
function countSiblingHeld() {
  siblingHeldChars.clear();
  siblingTotalChars = 0;
  try {
    const db = siblingDb();
    if (db) {
      for (const [key, size] of db.sizes('sibling')) {
        siblingHeldChars.set(key, size);
        siblingTotalChars += size;
      }
      return;
    }
    for (const name of fs.readdirSync(SIBLING_DIR)) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      const size = fs.statSync(path.join(SIBLING_DIR, name)).size;
      siblingHeldChars.set(name.slice(0, -5), size);
      siblingTotalChars += size;
    }
  } catch (_error) { /* nothing held yet */ }
}
function cacheSiblingHeld(fingerprint, store) {
  const previous = siblingHeldCache.get(fingerprint);
  if (previous) siblingCachedChars -= previous.__chars || 0;
  siblingHeldCache.delete(fingerprint);
  store.__chars = siblingStoreChars(store);
  siblingHeldCache.set(fingerprint, store);
  siblingCachedChars += store.__chars;
  for (const [key, cached] of siblingHeldCache) {
    if (siblingCachedChars <= SIBLING_CACHE_MAX_CHARS || siblingHeldCache.size <= 1) break;
    if (key === fingerprint) continue;
    siblingHeldCache.delete(key);
    siblingCachedChars -= cached.__chars || 0;
  }
}
function loadSiblingHeld(fingerprint) {
  if (siblingHeldCache.has(fingerprint)) return siblingHeldCache.get(fingerprint);
  let store = { items: [], overflow: {} };
  try {
    const db = siblingDb();
    const raw = db ? db.get('sibling', fingerprint) : JSON.parse(fs.readFileSync(siblingHeldPath(fingerprint), 'utf8'));
    if (raw && Array.isArray(raw.items)) store = { items: raw.items, overflow: raw.overflow && typeof raw.overflow === 'object' ? raw.overflow : {} };
  } catch (_error) { /* none yet */ }
  const devices = new Set(Object.keys(loadBeacons(fingerprint)));
  const cutoff = Date.now() - SIBLING_TTL_MS;
  store.items = store.items
    .filter((item) => item && typeof item.id === 'string' && typeof item.envelope === 'string' && Number(item.at) > cutoff)
    .map((item) => ({ ...item, pending: (Array.isArray(item.pending) ? item.pending : []).filter((deviceId) => devices.has(deviceId)) }))
    .filter((item) => item.pending.length);
  cacheSiblingHeld(fingerprint, store);
  return store;
}
function saveSiblingHeld(fingerprint, store) {
  cacheSiblingHeld(fingerprint, store);
  const before = siblingHeldChars.get(fingerprint) || 0;
  try {
    if (!store.items.length && !Object.keys(store.overflow).length) {
      siblingHeldChars.delete(fingerprint);
      siblingTotalChars -= before;
      const db = siblingDb();
      if (db) db.delete('sibling', fingerprint);
      else fs.unlinkSync(siblingHeldPath(fingerprint));
      return;
    }
    const { __chars: _chars, ...onDisk } = store;
    const db = siblingDb();
    if (db) db.put('sibling', fingerprint, onDisk);
    else writeJsonAtomic(siblingHeldPath(fingerprint), onDisk);
    siblingHeldChars.set(fingerprint, store.__chars);
    siblingTotalChars += store.__chars - before;
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('[Siblings] could not be written:', error.message);
  }
}
function dropSiblingHeld(fingerprint) {
  const cached = siblingHeldCache.get(fingerprint);
  if (cached) siblingCachedChars -= cached.__chars || 0;
  siblingHeldCache.delete(fingerprint);
  siblingTotalChars -= siblingHeldChars.get(fingerprint) || 0;
  siblingHeldChars.delete(fingerprint);
  try {
    const db = siblingDb();
    if (db) db.delete('sibling', fingerprint);
    else fs.unlinkSync(siblingHeldPath(fingerprint));
  } catch (_error) { /* none */ }
}
/* The account's devices that are connected and awake right now. One that is
   registered but frozen (an iPhone's app in the background) reads nothing
   off its socket, so it counts as away and a copy is kept for it too. */
function liveSiblingDeviceIds(fingerprint) {
  const live = new Set();
  for (const candidate of verifiedByFingerprint.get(fingerprint) || []) {
    if (candidate.ws?.readyState !== WebSocket.OPEN || !candidate.deviceId) continue;
    if (!isAppAwake(candidate)) continue;
    live.add(candidate.deviceId);
  }
  return live;
}
function holdForAbsentSiblings(record, envelopeText) {
  const fingerprint = record.fingerprint;
  const live = liveSiblingDeviceIds(fingerprint);
  const pending = Object.keys(loadBeacons(fingerprint))
    .filter((deviceId) => deviceId !== record.deviceId && !live.has(deviceId));
  if (!pending.length) return 0;
  /* The relay as a whole is full: hold nothing more. The away device will
     catch up from a sibling, device to device, as before. */
  if (siblingTotalChars + envelopeText.length > SIBLING_GLOBAL_MAX_CHARS) return -1;
  const store = loadSiblingHeld(fingerprint);
  store.items.push({ id: crypto.randomUUID(), at: Date.now(), envelope: envelopeText, pending });
  let total = store.items.reduce((sum, item) => sum + item.envelope.length, 0);
  while (store.items.length > SIBLING_ACCOUNT_MAX_ITEMS || total > SIBLING_ACCOUNT_MAX_CHARS) {
    const dropped = store.items.shift();
    total -= dropped.envelope.length;
    for (const deviceId of dropped.pending) store.overflow[deviceId] = true;
  }
  saveSiblingHeld(fingerprint, store);
  return pending.length;
}
/* What is waiting for this device, a batch at a time: the next batch goes
   when this one is acknowledged. */
function pumpSiblingHeld(record, ws) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !record.deviceId || !isFingerprintKey(record.fingerprint)) return;
  const store = loadSiblingHeld(record.fingerprint);
  const mine = store.items.filter((item) => item.pending.includes(record.deviceId));
  const overflow = Boolean(store.overflow[record.deviceId]);
  if (!mine.length && !overflow) return;
  const batch = mine.slice(0, SIBLING_DELIVERY_BATCH);
  safeSend(ws, {
    type: 'sibling-held',
    items: batch.map((item) => ({ id: item.id, envelope: item.envelope })),
    more: mine.length > batch.length,
    overflow,
  });
}
function ackSiblingHeld(record, ids) {
  const store = loadSiblingHeld(record.fingerprint);
  const acked = new Set(ids);
  let changed = false;
  store.items = store.items.map((item) => {
    if (!acked.has(item.id) || !item.pending.includes(record.deviceId)) return item;
    changed = true;
    return { ...item, pending: item.pending.filter((deviceId) => deviceId !== record.deviceId) };
  }).filter((item) => item.pending.length);
  if (store.overflow[record.deviceId]) {
    delete store.overflow[record.deviceId];
    changed = true;
  }
  if (changed) saveSiblingHeld(record.fingerprint, store);
}

/* A write interrupted between the temp file and the rename leaves a
   `.name.pid.tmp` behind. The real file is whole either way; the leftover is
   only clutter, and on a long-lived volume clutter that never goes away. */
function sweepStaleTempFiles(directory) {
  try {
    const cutoff = Date.now() - 60 * 1000;
    for (const name of fs.readdirSync(directory)) {
      if (!/^\..+\.\d+\.tmp$/.test(name)) continue;
      const full = path.join(directory, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch (_error) { /* raced with another sweep */ }
    }
  } catch (_error) { /* directory not there yet */ }
}

function mailboxPath(fingerprint) {
  return path.join(OFFLINE_STORE_DIR, `${fingerprint}.json`);
}

function importLegacyOfflineStore() {
  if (!fs.existsSync(OFFLINE_STORE_PATH)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(OFFLINE_STORE_PATH, 'utf8'));
    const boxes = new Map(Object.entries(raw || {}).map(([fingerprint, items]) => [
      sanitizeFingerprint(fingerprint),
      Array.isArray(items) ? items : [],
    ]).filter(([fingerprint, items]) => fingerprint && items.length));
    fs.mkdirSync(OFFLINE_STORE_DIR, { recursive: true });
    boxes.forEach((items, fingerprint) => writeJsonAtomic(mailboxPath(fingerprint), items));
    /* Renamed rather than deleted: if this upgrade turns out to be wrong, the
       old store is still sitting there whole. */
    fs.renameSync(OFFLINE_STORE_PATH, `${OFFLINE_STORE_PATH}.migrated`);
    console.log(`[Store] imported ${boxes.size} mailbox(es) from the single-file store.`);
    return boxes;
  } catch (error) {
    console.error('Failed to import the legacy offline store:', error);
    return null;
  }
}

/* The mailboxes in the database: one row per recipient. The single-file store
   of old is imported into the per-file layout first (as before), and that
   into the database. */
function mailboxDb() {
  return stateStore('mailbox', () => {
    importLegacyOfflineStore();
    return { dir: OFFLINE_STORE_DIR, key: (name) => (isFingerprintKey(sanitizeFingerprint(name)) ? sanitizeFingerprint(name) : '') };
  });
}

function loadOfflineBoxes() {
  sweepStaleTempFiles(OFFLINE_STORE_DIR);
  sweepStaleTempFiles(path.dirname(OFFLINE_STORE_PATH));
  sweepStaleTempFiles(BEACON_DIR);
  sweepStaleTempFiles(SIBLING_DIR);
  countSiblingHeld();
  const db = mailboxDb();
  if (db) {
    const boxes = new Map();
    for (const [fingerprint, items] of db.entries('mailbox')) {
      if (Array.isArray(items) && items.length && isFingerprintKey(fingerprint)) boxes.set(fingerprint, items);
    }
    return boxes;
  }
  try {
    const imported = importLegacyOfflineStore();
    if (imported) return imported;
    if (!fs.existsSync(OFFLINE_STORE_DIR)) return new Map();
    const boxes = new Map();
    fs.readdirSync(OFFLINE_STORE_DIR).forEach((name) => {
      if (!name.endsWith('.json')) return;
      const fingerprint = sanitizeFingerprint(name.slice(0, -5));
      if (!fingerprint) return;
      try {
        const items = JSON.parse(fs.readFileSync(path.join(OFFLINE_STORE_DIR, name), 'utf8'));
        if (Array.isArray(items) && items.length) boxes.set(fingerprint, items);
      } catch (error) {
        /* One unreadable mailbox must not cost every other mailbox. */
        console.error(`Failed to read mailbox ${name}:`, error.message);
      }
    });
    return boxes;
  } catch (error) {
    console.error('Failed to load offline boxes:', error);
    return new Map();
  }
}

