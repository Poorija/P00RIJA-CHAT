/* ---- home's side of a guest stay elsewhere ------------------------------------
 *
 * A home relay filtered for one person is up for everyone else, so senders
 * keep sending to it. On that person's signed notice, handed on by the guest
 * relay they reached, home sends a copy of their mail there — what waits, and
 * what arrives — and keeps its own. It stops when the notice runs out, when
 * the guest relay says the stay ended, or when the device proves itself here
 * again; a notice signed before that moment is a replay and counts for
 * nothing. */
/* ---- one account on two guest relays -----------------------------------------
 *
 * Each device becomes a guest on its own, so two devices of one account can
 * end up on two relays. A relay taking a guest tells the family a blinded
 * index of the account; only a relay hosting that same account recognises
 * it, and the two then copy new mail for it to each other — once: the copy
 * carries where it came from and how far it has been forwarded. */
const guestSiblingIndexes = new Map();
function guestSiblingIndex(fingerprint) {
  let index = guestSiblingIndexes.get(fingerprint);
  if (!index) {
    index = crypto.createHash('sha256').update(`poorija-guest-sibling|${fingerprint}`, 'utf8').digest('hex');
    guestSiblingIndexes.set(fingerprint, index);
    if (guestSiblingIndexes.size > 20000) guestSiblingIndexes.delete(guestSiblingIndexes.keys().next().value);
  }
  return index;
}
const guestSiblings = new Map();
function noteGuestSibling(fingerprint, relayId, until) {
  const held = guestSiblings.get(fingerprint) || new Map();
  held.set(relayId, until);
  guestSiblings.set(fingerprint, held);
  if (guestSiblings.size > 20000) guestSiblings.delete(guestSiblings.keys().next().value);
}
function announceGuestSibling(fingerprint) {
  const frame = { kind: 'guest-sibling', i: guestSiblingIndex(fingerprint), until: Date.now() + GUEST_TTL_MS };
  for (const link of familyLinks()) {
    try { link.send(frame); } catch (_error) { /* the link went */ }
  }
}
/* A live guest socket of this account here that gave its own signed route
   statement (fp, this relay, until — nothing else). */
function guestNoticeHereFor(fingerprint) {
  const record = Array.from(verifiedByFingerprint.get(fingerprint) || []).find((candidate) => candidate.guest && candidate.guestRouteSigned && candidate.ws?.readyState === WebSocket.OPEN);
  return record ? { ...record.guestRouteSigned, publicKeyData: record.publicKeyData } : null;
}
/* The account's own word that it is a guest at that relay: the only thing
   that makes that relay a sibling. A relay merely claiming to host the
   account gets nothing, and a statement no newer than the stay there that
   already ended counts for nothing. */
const siblingFloorKey = (relayId) => `sibling:${relayId}`;
function guestSiblingProofHolds(fingerprint, proof, relayId) {
  const s = proof?.statement;
  if (!s || s.fp !== fingerprint || s.guest !== relayId) return false;
  if (!guestRules.verifyIdentityStatement({ statement: s, sig: proof.sig, publicKeyData: proof.publicKeyData }, { type: 'guest-route' }).ok) return false;
  return Number(s.until) > guestBook.floorOf(fingerprint, siblingFloorKey(relayId));
}
/* Three steps over the family links: an index; from a relay that matches it,
   its device's signed notice; back, this relay's device's notice. Each side
   adds the other only on a notice that holds. */
function receiveGuestSibling(payload, link) {
  if (!directoryMembers().includes(link?.peerId)) return;
  const index = String(payload?.i || '');
  if (!/^[a-f0-9]{64}$/.test(index)) return;
  const fingerprint = guestBook.liveGuests().map((entry) => entry.fp).find((fp) => guestSiblingIndex(fp) === index);
  if (!fingerprint) return;
  const mine = guestNoticeHereFor(fingerprint);
  if (!mine) return;
  if (payload.proof) {
    if (!guestSiblingProofHolds(fingerprint, payload.proof, link.peerId)) return;
    noteGuestSibling(fingerprint, link.peerId, Number(payload.proof.statement.until) || 0);
    if (payload.step === 2) {
      try { link.send({ kind: 'guest-sibling', i: index, step: 3, proof: mine }); } catch (_error) { /* the link went */ }
    }
    return;
  }
  try { link.send({ kind: 'guest-sibling', i: index, step: 2, proof: mine }); } catch (_error) { /* the link went */ }
}
/* This relay's stay for the account ended: its siblings stop copying here. */
function endGuestSiblings(fingerprint) {
  const held = guestSiblings.get(fingerprint);
  if (!held) return;
  for (const relayId of held.keys()) {
    const link = relayPeers.linkFor(relayId);
    if (link) { try { link.send({ kind: 'guest-sibling-end', i: guestSiblingIndex(fingerprint) }); } catch (_error) { /* the link went */ } }
    guestSiblingCopied.delete(`${fingerprint}|${relayId}`);
  }
  guestSiblings.delete(fingerprint);
}
function receiveGuestSiblingEnd(payload, link) {
  const index = String(payload?.i || '');
  for (const [fingerprint, held] of guestSiblings) {
    if (guestSiblingIndex(fingerprint) !== index || !held.has(link?.peerId)) continue;
    guestBook.noteFloor(fingerprint, siblingFloorKey(link.peerId), held.get(link.peerId));
    held.delete(link.peerId);
    guestSiblingCopied.delete(`${fingerprint}|${link.peerId}`);
  }
}
const guestSiblingCopied = new Map();
function copyToGuestSiblings(fingerprint, items) {
  const held = guestSiblings.get(fingerprint);
  if (!held || !guestBook.isGuest(fingerprint)) return;
  for (const [relayId, until] of held) {
    if (until <= Date.now()) {
      held.delete(relayId);
      guestSiblingCopied.delete(`${fingerprint}|${relayId}`);
      continue;
    }
    const key = `${fingerprint}|${relayId}`;
    const copied = guestSiblingCopied.get(key) || new Set();
    const fresh = items.filter((item) => item.via !== relayId && (Number(item.hops) || 0) < GUEST_FORWARD_HOPS && !copied.has(item.relayId));
    if (!fresh.length) continue;
    if (forwardMail(relayId, fingerprint, fresh, { remove: false })) {
      for (const item of fresh) copied.add(item.relayId);
      if (copied.size > 5000) copied.delete(copied.values().next().value);
      guestSiblingCopied.set(key, copied);
    }
  }
}

const remoteGuestCopied = new Map();
/* What was copied to a guest relay for one account is forgotten once no
   device of that account is a guest there any more: the set only ever
   exists to stop the same item going twice during one stay. */
function forgetRemoteCopies(fingerprint) {
  const still = new Set(guestBook.remoteFor(fingerprint).map((entry) => entry.guest));
  for (const key of Array.from(remoteGuestCopied.keys())) {
    const [fp, relayId] = key.split('|');
    if (fp === fingerprint && !still.has(relayId)) remoteGuestCopied.delete(key);
  }
}
/* The sweep: every copied set whose stay is over, here or on a sibling. */
function pruneGuestCopies() {
  for (const key of Array.from(remoteGuestCopied.keys())) {
    const [fp, relayId] = key.split('|');
    if (!guestBook.remoteFor(fp).some((entry) => entry.guest === relayId)) remoteGuestCopied.delete(key);
  }
  for (const [fp, held] of Array.from(guestSiblings)) {
    for (const [relayId, until] of Array.from(held)) {
      if (until <= Date.now() || !guestBook.isGuest(fp)) { held.delete(relayId); guestSiblingCopied.delete(`${fp}|${relayId}`); }
    }
    if (!held.size) guestSiblings.delete(fp);
  }
  for (const key of Array.from(guestSiblingCopied.keys())) {
    const [fp, relayId] = key.split('|');
    if (!guestSiblings.get(fp)?.has(relayId)) guestSiblingCopied.delete(key);
  }
}
function copyToRemoteGuests(fingerprint, items) {
  const remotes = guestBook.remoteFor(fingerprint);
  if (!remotes.length) return;
  for (const guestRelay of new Set(remotes.map((entry) => entry.guest))) {
    const key = `${fingerprint}|${guestRelay}`;
    const copied = remoteGuestCopied.get(key) || new Set();
    const fresh = items.filter((item) => item.via !== guestRelay && (Number(item.hops) || 0) < GUEST_FORWARD_HOPS && !copied.has(item.relayId));
    if (!fresh.length) continue;
    if (forwardMail(guestRelay, fingerprint, fresh, { remove: false })) {
      for (const item of fresh) copied.add(item.relayId);
      if (copied.size > 5000) copied.delete(copied.values().next().value);
      remoteGuestCopied.set(key, copied);
    }
  }
}
function receiveGuestNotice(payload, link) {
  if (!directoryMembers().includes(link?.peerId)) return;
  const statement = payload?.statement;
  const verdict = guestRules.verifyIdentityStatement({ statement, sig: payload?.sig, publicKeyData: payload?.publicKeyData }, { type: 'guest-at' });
  if (!verdict.ok || statement.home !== relayIdentity.id || statement.guest !== link.peerId) return;
  if (statement.at <= guestBook.floorOf(statement.fp, statement.deviceId)) return;
  if (rosterRevokes(loadRoster(statement.fp), statement.deviceId, '')) return;
  guestBook.noteRemote({ fp: statement.fp, deviceId: statement.deviceId, guest: link.peerId, until: statement.until });
  console.log(`[Guests] ${statement.fp.slice(0, 12)} is a guest at ${link.peerId.slice(0, 12)}; its mail is copied there`);
  copyToRemoteGuests(statement.fp, offlineBoxes.get(statement.fp) || []);
}
/* ---- a home filtered for one person: the move --------------------------------
 *
 * A guest whose home works for everyone else but has been unreachable from
 * their own internet for days may move it here (js/chat/62-guest-mode.js asks
 * them). The move is the person's own statement, signed with their identity
 * key: { v: 1, type: 'home-move', fp, from, to, at }. This relay takes it for
 * itself as `to`, makes the person a resident, and hands it to `from`; the
 * old home checks it again, hands over its mailbox, forwards for thirty days,
 * and tells the account's other devices. Each relay takes only a statement
 * signed after the newest one it took, so an old move cannot be replayed. */
const MOVE_FORWARD_MS = Number(process.env.CHAT_MOVE_FORWARD_MS || 30 * 24 * 60 * 60 * 1000);
const MOVE_PENDING_MS = 7 * 24 * 60 * 60 * 1000;
function sendMoveHome(fingerprint, home, signed) {
  const link = relayPeers.linkFor(home);
  if (link) {
    try {
      link.send({ kind: 'home-move', statement: signed.statement, sig: signed.sig, publicKeyData: signed.publicKeyData });
      return;
    } catch (_error) { /* kept below */ }
  }
  guestBook.notePendingMove(fingerprint, home, signed, MOVE_PENDING_MS);
}
function retryPendingMoves(onlyHome = '') {
  for (const entry of guestBook.pendingMoves()) {
    if (onlyHome && entry.home !== onlyHome) continue;
    const link = relayPeers.linkFor(entry.home);
    if (!link) continue;
    try { link.send({ kind: 'home-move', statement: entry.signed.statement, sig: entry.signed.sig, publicKeyData: entry.signed.publicKeyData }); } catch (_error) { /* next time */ }
  }
}
function moveRefusal(signed, { fingerprint, to, from }) {
  const verdict = guestRules.verifyIdentityStatement(signed, { type: 'home-move' });
  if (!verdict.ok) return verdict.reason;
  const s = signed.statement;
  if (s.fp !== fingerprint) return 'not-yours';
  if (s.to !== to) return 'not-here';
  if (s.from !== from) return 'not-your-home';
  if (s.at <= guestBook.moveAtOf(fingerprint)) return 'replay';
  return '';
}
/* The guest's own request, on its socket here. */
function acceptHomeMoveHere(record, message) {
  const signed = { statement: message.statement, sig: message.sig, publicKeyData: record.publicKeyData };
  const reason = !record.guest ? 'not-a-guest' : moveRefusal(signed, { fingerprint: record.fingerprint, to: relayIdentity.id, from: record.guestOf });
  if (reason) {
    safeSend(record.ws, { type: 'home-move-refused', reason });
    return;
  }
  const fingerprint = record.fingerprint;
  guestBook.noteMoveAt(fingerprint, signed.statement.at);
  guestBook.dropGuests(fingerprint);
  guestNotices.delete(fingerprint);
  endGuestSiblings(fingerprint);
  for (const candidate of verifiedByFingerprint.get(fingerprint) || []) candidate.guest = false;
  noteProvenIdentity(fingerprint);
  console.log(`[Guests] ${fingerprint.slice(0, 12)} moved home here from ${signed.statement.from.slice(0, 12)}`);
  sendMoveHome(fingerprint, signed.statement.from, signed);
  safeSend(record.ws, { type: 'home-move-ok', to: relayIdentity.id });
}
/* A move straight from a resident of another family relay, carried in the
   hello (js/chat/63-relay-choice.js): checked once the identity is proven, the
   same way as a guest's, without needing this relay to take guests. */
function acceptDirectMove(record) {
  const signed = { ...record.homeMoveRequest, publicKeyData: record.publicKeyData };
  record.homeMoveRequest = null;
  const from = String(signed.statement?.from || '');
  const reason = !directoryMembers().includes(from) ? 'not-family'
    : moveRefusal(signed, { fingerprint: record.fingerprint, to: relayIdentity.id, from });
  if (reason) {
    /* Not moved, so not living here either: said once, then the socket goes
       — staying on would make this relay claim the person for ninety days. */
    record.identityVerified = false;
    unindexVerified(record);
    safeSend(record.ws, { type: 'home-move-refused', reason });
    setTimeout(() => {
      try { if (record.ws?.readyState === WebSocket.OPEN) record.ws.close(4409, 'home-move-refused'); } catch (_error) { /* gone */ }
    }, 300).unref?.();
    setTimeout(() => {
      try { if (record.ws && record.ws.readyState !== WebSocket.CLOSED) record.ws.terminate(); } catch (_error) { /* gone */ }
      presence.delete(record.clientId);
      broadcastPeers();
    }, 1500).unref?.();
    return false;
  }
  const fingerprint = record.fingerprint;
  guestBook.noteMoveAt(fingerprint, signed.statement.at);
  guestBook.dropGuests(fingerprint);
  guestNotices.delete(fingerprint);
  endGuestSiblings(fingerprint);
  console.log(`[Guests] ${fingerprint.slice(0, 12)} moved home here directly from ${from.slice(0, 12)}`);
  sendMoveHome(fingerprint, from, signed);
  safeSend(record.ws, { type: 'home-move-ok', to: relayIdentity.id });
  return true;
}

/* The old home's side, off the new home's link. */
function receiveHomeMove(payload, link) {
  if (!directoryMembers().includes(link?.peerId)) return;
  const signed = { statement: payload?.statement, sig: payload?.sig, publicKeyData: payload?.publicKeyData };
  const fingerprint = String(signed.statement?.fp || '');
  const reason = moveRefusal(signed, { fingerprint, to: link.peerId, from: relayIdentity.id });
  if (reason) {
    /* Already taken (the new home sent it again): said so, so it stops. */
    if (reason === 'replay' && guestBook.movedTo(fingerprint) === link.peerId) {
      try { link.send({ kind: 'home-move-ack', fp: fingerprint }); } catch (_error) { /* the link went */ }
    }
    return;
  }
  guestBook.noteMoveAt(fingerprint, signed.statement.at);
  provenIdentities.delete(fingerprint);
  noteKnownIdentity(fingerprint, { force: true });
  guestBook.noteMoved(fingerprint, link.peerId, MOVE_FORWARD_MS, signed);
  guestBook.dropRemote(fingerprint);
  forgetRemoteCopies(fingerprint);
  console.log(`[Guests] ${fingerprint.slice(0, 12)} moved home to ${link.peerId.slice(0, 12)}; its mail follows for ${Math.round(MOVE_FORWARD_MS / 86400000)} days`);
  forwardMovedMail(fingerprint);
  for (const candidate of verifiedByFingerprint.get(fingerprint) || []) {
    if (candidate.ws?.readyState === WebSocket.OPEN) safeSend(candidate.ws, { type: 'home-move', statement: signed.statement, sig: signed.sig });
  }
  try { link.send({ kind: 'home-move-ack', fp: fingerprint }); } catch (_error) { /* the link went */ }
}
/* Everything waiting here for someone who moved, to their new home. */
function forwardMovedMail(fingerprint) {
  const to = guestBook.movedTo(fingerprint);
  if (!to) return;
  const items = (offlineBoxes.get(fingerprint) || []).filter((item) => item.via !== to && (Number(item.hops) || 0) < GUEST_FORWARD_HOPS);
  if (items.length) forwardMail(to, fingerprint, items, { remove: true });
}

function receiveGuestEndFrame(payload, link) {
  const fp = String(payload?.fp || '');
  const deviceId = String(payload?.deviceId || '');
  if (!/^[a-f0-9]{64}$/.test(fp)) return;
  for (const entry of guestBook.remoteFor(fp)) {
    if (entry.guest !== link?.peerId || (deviceId && entry.deviceId !== deviceId)) continue;
    guestBook.dropRemote(fp, entry.deviceId);
    guestBook.noteFloor(fp, entry.deviceId, Date.now());
  }
  forgetRemoteCopies(fp);
}
/* One device's stay ends (it said guest-end, or its record ran out). */
function endGuestStay(fingerprint, deviceId) {
  const home = guestBook.homeOf(fingerprint);
  const result = guestBook.end(fingerprint, deviceId);
  const homeLink = home ? relayPeers.linkFor(home) : null;
  if (homeLink) {
    try { homeLink.send({ kind: 'guest-end', fp: fingerprint, deviceId }); } catch (_error) { /* the link went */ }
  }
  console.log(`[Guests] ${String(fingerprint).slice(0, 12)} stay ended for one device${result.last ? ', the last' : ''}`);
  if (result.last) onGuestStayEnded(fingerprint, result.home);
  /* The sibling relays were let in on a signed notice of a device here; with
     none left, they stop copying here. */
  else if (!guestNoticeHereFor(fingerprint)) endGuestSiblings(fingerprint);
  return result;
}
/* The account's last guest device has gone: what waits here for it goes home. */
function onGuestStayEnded(fingerprint, home) {
  endGuestSiblings(fingerprint);
  const homeLink = home ? relayPeers.linkFor(home) : null;
  if (homeLink) {
    try { homeLink.send({ kind: 'guest-end', fp: fingerprint, deviceId: '' }); } catch (_error) { /* the link went */ }
  }
  forwardLeftovers(fingerprint, home);
}

