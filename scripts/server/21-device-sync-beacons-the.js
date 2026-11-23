/* One file per mailbox, not one file for the whole server.
 *
 * Every queued message used to rewrite the entire store. That is fine at a few
 * megabytes and quadratic after that: the cost of storing message N is the
 * size of messages 1..N-1, so a relay that has been busy for a while spends
 * seconds of synchronous I/O on every single delivery and never recovers. A
 * test relay here reached 328 MB and 3,496 envelopes, at which point a file
 * transfer that normally takes three minutes could not finish in ten.
 *
 * Sharding by recipient makes a write cost that recipient's own queue, which
 * is bounded by their quota. The whole store is never rewritten again.
 *
 * The legacy single file is imported once on boot and kept, renamed, so the
 * upgrade is reversible. */
/* ------------------------------------------------------------------
 * Device sync beacons — the only thing this relay keeps for multi-device.
 *
 * Several devices of one account sync with each other directly, while both
 * are online; the relay holds no history, no file and no session for them.
 * What a device that comes back needs is to know THAT it is behind and which
 * sibling holds what it missed, so it can ask the moment that sibling is
 * online. That is the beacon: one small blob per device, encrypted on the
 * device to the account's own key, opaque here, and capped hard so it can
 * never become a mailbox by the back door.
 * ------------------------------------------------------------------ */
function beaconPath(fingerprint) {
  return path.join(BEACON_DIR, `${fingerprint}.json`);
}
const beaconDb = () => stateStore('beacon', { dir: BEACON_DIR, key: (name) => (isFingerprintKey(name) ? name : '') });
function readBeaconsRaw(fingerprint) {
  const db = beaconDb();
  if (db) return db.get('beacon', fingerprint);
  return JSON.parse(fs.readFileSync(beaconPath(fingerprint), 'utf8'));
}
function writeBeacons(fingerprint, entries) {
  const db = beaconDb();
  if (db) {
    if (entries && Object.keys(entries).length) db.put('beacon', fingerprint, entries);
    else db.delete('beacon', fingerprint);
    return;
  }
  if (entries && Object.keys(entries).length) writeJsonAtomic(beaconPath(fingerprint), entries);
  else fs.unlinkSync(beaconPath(fingerprint));
}
function loadBeacons(fingerprint) {
  if (beaconCache.has(fingerprint)) return beaconCache.get(fingerprint);
  let entries = {};
  try {
    const raw = readBeaconsRaw(fingerprint);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) entries = raw;
  } catch (_error) { /* none yet */ }
  const cutoff = Date.now() - BEACON_TTL_MS;
  for (const [deviceId, entry] of Object.entries(entries)) {
    if (!entry || typeof entry.blob !== 'string' || !(Number(entry.at) > cutoff)) delete entries[deviceId];
  }
  beaconCache.set(fingerprint, entries);
  if (beaconCache.size > 2000) beaconCache.delete(beaconCache.keys().next().value);
  return entries;
}
function storeBeacon(fingerprint, deviceId, blob) {
  const entries = { ...loadBeacons(fingerprint) };
  entries[deviceId] = { blob, at: Date.now() };
  const ids = Object.keys(entries);
  if (ids.length > BEACON_MAX_DEVICES) {
    ids.sort((a, b) => entries[a].at - entries[b].at)
      .slice(0, ids.length - BEACON_MAX_DEVICES)
      .forEach((id) => { delete entries[id]; });
  }
  beaconCache.set(fingerprint, entries);
  try {
    writeBeacons(fingerprint, entries);
  } catch (error) {
    console.warn('[Beacon] could not be written:', error.message);
  }
}
function dropBeacons(fingerprint) {
  beaconCache.delete(fingerprint);
  try { writeBeacons(fingerprint, null); } catch (_error) { /* none */ }
  dropSiblingHeld(fingerprint);
}
/* One device is gone from the account — it left, or its primary revoked it:
   its beacon goes, and so does every copy held for it. */
function forgetSiblingDevice(fingerprint, deviceId) {
  if (!deviceId) return;
  const entries = loadBeacons(fingerprint);
  if (entries[deviceId]) {
    const kept = { ...entries };
    delete kept[deviceId];
    beaconCache.set(fingerprint, kept);
    try {
      writeBeacons(fingerprint, kept);
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('[Beacon] could not be written:', error.message);
    }
  }
  const store = loadSiblingHeld(fingerprint);
  const heldForIt = store.items.some((item) => item.pending.includes(deviceId)) || Boolean(store.overflow[deviceId]);
  if (!heldForIt) return;
  store.items = store.items
    .map((item) => ({ ...item, pending: item.pending.filter((id) => id !== deviceId) }))
    .filter((item) => item.pending.length);
  delete store.overflow[deviceId];
  saveSiblingHeld(fingerprint, store);
}

/* ------------------------------------------------------------------
 * The device roster — which devices are still part of an account.
 *
 * Every device of an account holds the same identity key, so that key cannot
 * be what tells the account's first device — its primary — from the others.
 * Each device also has a key of its own, made on it and never exported. The
 * roster names the primary by that key, with a certificate the identity key
 * signed (only a device of the account can make one), and the roster itself
 * is signed with the primary's own device key: no other device of the
 * account, and not this relay, can write one that verifies. A successor must
 * be signed by the primary the stored roster names, with a higher sequence
 * number; handing the role on is that primary signing a roster that names
 * another device.
 *
 * The relay keeps the newest valid roster and enforces what it revokes: a
 * revoked device — by its id, or by its key once proven — is told so and
 * shut out the moment its identity is proven, its beacon and whatever was
 * held for it are dropped, and a socket of it already connected is closed.
 * Nothing in the roster is secret: device ids, public keys and a label like
 * "macOS app" — no name, no history.
 * ------------------------------------------------------------------ */
const ROSTER_DEVICE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const ROSTER_KEY_TEXT = /^[A-Za-z0-9+/=]{40,400}$/;
const ROSTER_SIGNATURE_TEXT = /^[A-Za-z0-9+/=]{40,1100}$/;
function rosterPath(fingerprint) {
  return path.join(ROSTER_DIR, `${fingerprint}.json`);
}
const rosterDb = () => stateStore('roster', { dir: ROSTER_DIR, key: (name) => (isFingerprintKey(name) ? name : '') });
function loadRoster(fingerprint) {
  if (rosterCache.has(fingerprint)) return rosterCache.get(fingerprint);
  let roster = null;
  try {
    const db = rosterDb();
    roster = db ? (db.get('roster', fingerprint) ?? null) : JSON.parse(fs.readFileSync(rosterPath(fingerprint), 'utf8'));
  } catch (_error) { roster = null; }
  if (!roster || typeof roster !== 'object' || roster.fp !== fingerprint) roster = null;
  rosterCache.set(fingerprint, roster);
  if (rosterCache.size > 2000) rosterCache.delete(rosterCache.keys().next().value);
  return roster;
}
function saveRoster(fingerprint, roster) {
  rosterCache.set(fingerprint, roster);
  noteRosterHeld(fingerprint);
  try {
    const db = rosterDb();
    if (db) db.put('roster', fingerprint, roster);
    else {
      fs.mkdirSync(ROSTER_DIR, { recursive: true });
      writeJsonAtomic(rosterPath(fingerprint), roster);
    }
  } catch (error) {
    console.warn('[Roster] could not be written:', error.message);
  }
}
function dropRoster(fingerprint) {
  rosterCache.delete(fingerprint);
  try {
    const db = rosterDb();
    if (db) db.delete('roster', fingerprint);
    else fs.unlinkSync(rosterPath(fingerprint));
  } catch (_error) { /* none */ }
}
/* Exactly the bytes the client signs (js/chat/58-device-roster.js), field by
   field in a fixed order, so neither side depends on how an object's keys
   happen to be ordered. */
function rosterSignedText(roster) {
  return 'poorija-roster|1|' + JSON.stringify([
    roster.fp, roster.seq, roster.at,
    [roster.primary.d, roster.primary.k, roster.primary.n],
    roster.cert,
    roster.members.map((member) => [member.d, member.k, member.n, member.at]),
    roster.revoked.map((entry) => [entry.d, entry.k, entry.at, entry.why]),
    roster.signer,
  ]);
}
function rosterCertText(roster) {
  return `poorija-roster-primary|${roster.fp}|${roster.primary.d}|${roster.primary.k}`;
}
function rosterLabelValid(text) {
  return typeof text === 'string' && text.length <= 48 && !/[\u0000-\u001f\u007f]/.test(text);
}
function rosterShapeValid(roster, fingerprint) {
  if (!roster || typeof roster !== 'object' || Array.isArray(roster)) return false;
  if (roster.v !== 1 || roster.fp !== fingerprint) return false;
  if (!Number.isSafeInteger(roster.seq) || roster.seq < 1 || !Number.isSafeInteger(roster.at) || roster.at < 0) return false;
  const primary = roster.primary;
  if (!primary || !ROSTER_DEVICE_ID.test(String(primary.d || '')) || !ROSTER_KEY_TEXT.test(String(primary.k || '')) || !rosterLabelValid(primary.n)) return false;
  if (!ROSTER_SIGNATURE_TEXT.test(String(roster.cert || '')) || !ROSTER_SIGNATURE_TEXT.test(String(roster.sig || ''))) return false;
  if (!ROSTER_KEY_TEXT.test(String(roster.signer || ''))) return false;
  if (!Array.isArray(roster.members) || roster.members.length > ROSTER_MAX_MEMBERS) return false;
  if (!Array.isArray(roster.revoked) || roster.revoked.length > ROSTER_MAX_REVOKED) return false;
  for (const member of roster.members) {
    if (!member || !ROSTER_DEVICE_ID.test(String(member.d || '')) || !ROSTER_KEY_TEXT.test(String(member.k || ''))
      || !rosterLabelValid(member.n) || !Number.isSafeInteger(member.at)) return false;
  }
  for (const entry of roster.revoked) {
    if (!entry || !ROSTER_DEVICE_ID.test(String(entry.d || '')) || (entry.k !== '' && !ROSTER_KEY_TEXT.test(String(entry.k || '')))
      || !Number.isSafeInteger(entry.at) || (entry.why !== 'revoked' && entry.why !== 'left')) return false;
  }
  /* The primary cannot be one of the devices it revoked. */
  if (roster.revoked.some((entry) => entry.d === primary.d || (entry.k && entry.k === primary.k))) return false;
  return true;
}
function rosterSignaturesValid(roster, identityPublicKeyData) {
  try {
    /* The certificate is the account key's, RSA (v3) or Ed25519 (v4). */
    if (!identityV4.verifyProof(String(identityPublicKeyData || ''), Buffer.from(rosterCertText(roster)), roster.cert)) return false;
    const primaryKey = crypto.createPublicKey({ key: Buffer.from(roster.primary.k, 'base64'), format: 'der', type: 'spki' });
    if (primaryKey.asymmetricKeyType !== 'ec' || primaryKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return false;
    const signerKey = crypto.createPublicKey({ key: Buffer.from(roster.signer, 'base64'), format: 'der', type: 'spki' });
    if (signerKey.asymmetricKeyType !== 'ec' || signerKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return false;
    return crypto.verify('sha256', Buffer.from(rosterSignedText(roster)), { key: signerKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(roster.sig, 'base64'));
  } catch (_error) {
    return false;
  }
}
/* Who may write the next one: the primary the stored roster names — the
   only key that can hand the role on, too. With none stored, a roster that
   its own primary signed. */
function rosterRefusal(next, current, identityPublicKeyData, fingerprint) {
  let text = '';
  try { text = JSON.stringify(next); } catch (_error) { text = ''; }
  if (!text || text.length > ROSTER_MAX_CHARS || !rosterShapeValid(next, fingerprint)) return 'malformed';
  if (!rosterSignaturesValid(next, identityPublicKeyData)) return 'bad-signature';
  if (!current) return next.signer === next.primary.k ? '' : 'not-primary';
  if (next.seq <= current.seq) return 'stale';
  return next.signer === current.primary.k ? '' : 'not-primary';
}
function rosterRevokes(roster, deviceId, deviceKey) {
  if (!roster || !Array.isArray(roster.revoked)) return false;
  return roster.revoked.some((entry) => (deviceId && entry.d === deviceId) || (deviceKey && entry.k && entry.k === deviceKey));
}
function provenDeviceKey(record) {
  return record?.deviceKeyProven ? record.deviceKey : '';
}
/* A revoked device that has just proven the account's identity: it is told
   why, with the roster that says so (which it can verify for itself), and
   the socket is closed. Nothing addressed to the account reaches it. */
function shutOutRevokedDevice(record, roster) {
  record.identityVerified = false;
  record.deviceRevoked = true;
  unindexVerified(record);
  safeSend(record.ws, { type: 'device-revoked', roster });
  setTimeout(() => {
    try { if (record.ws?.readyState === WebSocket.OPEN) record.ws.close(4410, 'device-revoked'); } catch (_error) {}
  }, 400).unref?.();
  setTimeout(() => {
    try { if (record.ws && record.ws.readyState !== WebSocket.CLOSED) record.ws.terminate(); } catch (_error) {}
    presence.delete(record.clientId);
    broadcastPeers();
  }, 1500).unref?.();
}
function enforceRoster(fingerprint, roster) {
  for (const entry of roster.revoked) forgetSiblingDevice(fingerprint, entry.d);
  for (const candidate of [...(verifiedByFingerprint.get(fingerprint) || [])]) {
    if (rosterRevokes(roster, candidate.deviceId, provenDeviceKey(candidate))) shutOutRevokedDevice(candidate, roster);
  }
}

