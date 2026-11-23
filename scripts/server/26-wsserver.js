wsServer.on('connection', (ws, req) => {
  const clientId = crypto.randomUUID();
  const ip = requestIp(req);
  const upgradeIdentity = upgradeRequestIdentity(req);

  console.log(`[Presence] New connection from ${ip}, clientId: ${clientId}`);

  const record = {
    clientId,
    ws,
    ip,
    username: upgradeIdentity.username || '',
    peerId: upgradeIdentity.peerId || '',
    publicKeyData: '',
    fingerprint: upgradeIdentity.fingerprint || '',
    /* Flipped only by a proven id-challenge answer (or the escape hatch). */
    identityVerified: false,
    avatarData: '',
    mood: '',
    /* A token bucket, refilled by the clock rather than emptied by a lockout:
       HTTP has had rate buckets since the beginning, the socket never did,
       and every expensive thing a relay does — get-peers builds the whole
       table, hello re-runs the duplicate walk and an RSA challenge — is one
       frame away on a path that was never counted. The numbers sit above
       what the app's own heaviest flows ever ask for, so a person never
       meets the limit; a loop meets it immediately. */
    rateTokens: WS_RATE_BURST,
    rateCheckedAt: Date.now(),
    updatedAt: new Date().toISOString(),
    lastSeenAt: Date.now(),
    connectedAt: Date.now(),
  };

  presence.set(clientId, record);
  /* The traffic rows key on this id; the back-pointer keeps the outbound
     side from having to hunt the presence map on every send. */
  ws.__poorijaClientId = clientId;
  const initialRestriction = getRestrictionForIdentity(record);
  if (initialRestriction) {
    disconnectRestrictedPeer(record, initialRestriction);
    return;
  }
  /* `identity`: the kinds of account key this relay proves (identity v4).
     An app moves its account to v4 only on a relay that says 'v4' here. */
  safeSend(ws, { type: 'welcome', clientId, identity: ['v3', 'v4'] });

  // Browsers answer ping frames from inside the network stack, even while the
  // page's JavaScript is frozen. Counting that as activity keeps a backgrounded
  // phone registered instead of dropping it and forcing a reconnect on return.
  ws.on('pong', () => { touchPresence(record); });

  ws.on('message', (raw) => {
    totalMessagesReceived++;
    totalBytesReceived += raw.length;
    noteClientTraffic(clientId, 'in', raw.length, record.username || '');

    /* Refill by elapsed time, then spend one token on this frame. A socket
       over the line is answered, not disconnected: a person's browser
       reconnects, and the point is to price the frame, not to punish it. */
    const sinceChecked = Date.now() - record.rateCheckedAt;
    if (sinceChecked > 0) {
      record.rateTokens = Math.min(WS_RATE_BURST, record.rateTokens + sinceChecked * WS_RATE_REFILL_PER_MS);
      record.rateCheckedAt = Date.now();
    }
    if (record.rateTokens < 1) {
      /* Answered once a second at most — answering every frame of a flood
         made the relay send as much as it was sent — and a socket still
         flooding after many thousands of refusals is closed. */
      record.throttled = (record.throttled || 0) + 1;
      const now = Date.now();
      if (!record.slowDownSentAt || now - record.slowDownSentAt >= 1000) {
        record.slowDownSentAt = now;
        safeSend(ws, { type: 'error', reason: 'slow-down' });
      }
      if (record.throttled > WS_FLOOD_CLOSE_AFTER) {
        try { ws.close(4429, 'flood'); } catch (_error) { /* gone */ }
      }
      return;
    }
    record.throttled = 0;
    record.rateTokens -= 1;

    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (_error) {
      safeSend(ws, { type: 'error', reason: 'invalid-json' });
      return;
    }
    /* JSON.parse accepts more than messages. `null`, `true` and `42` are all
       valid JSON, and each of them reaches this handler as something without
       a `type` — where reading one throws, nothing above catches it, and the
       process-level handler answers by flushing and exiting. A frame that is
       not an object is not a message, whatever its bytes claimed, and an
       array is no more a message than a number is. */
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      safeSend(ws, { type: 'error', reason: 'invalid-json' });
      return;
    }
    touchPresence(record);
    /* A frame the page composed and sent: proof the JavaScript is running,
       which the pong above is not. */
    /* What a page sends on its own timers (its keep-alive, the presence
       questions it asks about its contacts) is not the person coming back:
       a page in the background sends those too, and every one of them
       cleared `away`, so a phone in a pocket read as online on the other
       relays of the family. Anything else the page sends (a message, a
       read receipt, a call) is a person, as before. */
    const automatic = message.type === 'presence-state' || message.type === 'ping'
      || message.auto === 1;
    if (!(automatic && record.away)) record.lastActiveAt = Date.now();
    if (!automatic) record.away = false;

    if (message.type === 'hello') {
      record.username = String(message.username || '').slice(0, 80);
      record.peerId = String(message.peerId || '').slice(0, 160);
      /* Which install said hello, not which identity: two devices may hold one
         key pair, and this is the only field that tells their sockets apart.
         A random client-generated string, no more identifying than peerId. */
      record.deviceId = String(message.deviceId || '').slice(0, 128);
      /* The install's own public key (P-256), separate from the identity the
         account's devices share. Only a claim until the proof below signs
         this socket's challenge with it; the roster's revocations are
         enforced against it from then on. */
      const deviceKey = String(message.deviceKey || '');
      record.deviceKey = ROSTER_KEY_TEXT.test(deviceKey) ? deviceKey : '';
      record.deviceKeyProven = false;
      /* A public key is under a kilobyte in every format the app uses, and the
         field is rebroadcast to every connected client on every presence
         change — one of the few fields with no ceiling of its own. */
      record.publicKeyData = String(message.publicKeyData || '').slice(0, 4096);
      record.fingerprint = sanitizeFingerprint(message.fingerprint);
      noteKnownIdentity(record.fingerprint);
      /* Guest mode: the home relay this identity is a guest from. Anything
         that is not a plain string is kept as a refusal waiting to happen,
         not dropped: dropping it would make this socket a resident. */
      record.wantsGuest = message.guestOf !== undefined && message.guestOf !== null && message.guestOf !== '';
      record.guestOf = record.wantsGuest ? (typeof message.guestOf === 'string' ? message.guestOf.slice(0, 64).toLowerCase() : 'invalid') : '';
      record.guest = false;
      /* The newest roster the device holds, for a guest relay that may hold
         none: judged as a successor of what is known, never on its word. */
      record.helloRoster = null;
      record.guestNotice = null;
      record.guestNoticeSigned = null;
      record.guestRoute = null;
      record.guestRouteSigned = null;
      const signedPart = (value) => (value && typeof value === 'object' && value.statement && typeof value.statement === 'object'
        && typeof value.sig === 'string' && value.sig.length <= 1100 ? { statement: value.statement, sig: value.sig } : null);
      if (record.wantsGuest) {
        record.guestNotice = signedPart(message.guestNotice);
        record.guestRoute = signedPart(message.guestRoute);
      }
      /* Smart relay choice: a resident of another relay of the family moving
         its home here directly, on its own signed statement. */
      record.homeMoveRequest = record.wantsGuest ? null : signedPart(message.homeMove);
      /* Identity v4: the statement that moves this account from its old RSA
         key, checked once the new key is proven (acceptIdentityContinuation). */
      record.continuation = null;
      if (message.continuation && typeof message.continuation === 'object' && !Array.isArray(message.continuation)) {
        try { if (JSON.stringify(message.continuation).length <= 8192) record.continuation = message.continuation; } catch (_error) { /* not kept */ }
      }
      if (record.wantsGuest && message.roster && typeof message.roster === 'object' && !Array.isArray(message.roster)) {
        try { if (JSON.stringify(message.roster).length <= ROSTER_MAX_CHARS) record.helloRoster = message.roster; } catch (_error) { /* not kept */ }
      }
      /* Not kept. The relay has no use for a photograph — the presence table
         never carries one — and the copy it kept here was cut at 100,000
         characters and then handed to anybody who asked for the peer list:
         half a picture over the whole one a contact's card had delivered,
         and everybody's photograph for every stranger on the relay. Avatars
         travel on the profile card, between the people concerned. */
      record.avatarData = '';
      record.mood = String(message.mood || '').slice(0, 40);
      /* The prekey is a public value and the relay only forwards it. It is
         what lets somebody write to this device while it is offline without
         falling back to the never-changing identity key. */
      record.prekeyId = String(message.prekeyId || '').slice(0, 64);
      record.prekeyPublic = String(message.prekeyPublic || '').slice(0, 512);
      record.prekeyExpiresAt = String(message.prekeyExpiresAt || '').slice(0, 40);
      /* The identity key's signature over that prekey. Forwarded like the
         prekey itself: the relay cannot make one, which is the point of it —
         a client checks it against the identity key it has pinned, so a
         prekey this relay swapped for its own is one nobody writes to. */
      record.prekeySig = String(message.prekeySig || '').slice(0, 1024);
      /* The prekey's ML-KEM-768 half (1184 bytes, so about 1.6 kB here) and
         the statement that signs it in. Forwarded, like the rest. */
      record.prekeyPq = String(message.prekeyPq || '').slice(0, 2048);
      record.prekeyPqSig = String(message.prekeyPqSig || '').slice(0, 1024);
      /* Identity v4's agreement key, 32 bytes, and its 64-byte signature. */
      record.agreeKey = /^[A-Za-z0-9+/]{43}=$/.test(String(message.agreeKey || '')) ? String(message.agreeKey) : '';
      record.agreeKeySig = /^[A-Za-z0-9+/=]{86,88}$/.test(String(message.agreeKeySig || '')) ? String(message.agreeKeySig) : '';
      /* What the client's build reads — short tokens, forwarded as they are.
         A contact's device reads 'ss1' to decide whether to seal the sender
         of what it queues here. */
      /* A hello starts the conversation again: the next table it gets is the
         whole one, then changes. */
      record.peersSynced = false;
      record.caps = Array.isArray(message.caps)
        /* 32, not 8: a build that grew a ninth capability (sfu2) had it cut
           off here, and its contacts never learnt it. */
        ? Array.from(new Set(message.caps.map((cap) => String(cap || '')).filter((cap) => /^[a-z0-9-]{1,16}$/.test(cap)))).slice(0, 32)
        : [];
      record.updatedAt = new Date().toISOString();
      if (!hasUsableIdentity(record)) {
        console.warn(`[Presence] Rejecting unidentified peer from ${record.ip}`);
        safeSend(ws, { type: 'error', reason: 'identity-required' });
        try { ws.close(4400, 'identity-required'); } catch (_error) {}
        presence.delete(clientId);
        broadcastPeers();
        return;
      }
      
      const restriction = getRestrictionForIdentity(record);
      if (restriction) {
        console.log(`[Presence] Restricted peer rejected after hello: ${record.username} (${restriction.type})`);
        disconnectRestrictedPeer(record, restriction);
        return;
      }

      /* The duplicate close used to happen here, on the hello's say-so. It
         waits for proof now — see closeDuplicatePresenceRecords. */
      console.log(`[Presence] Peer identified: ${record.username} (${record.peerId}) fingerprint: ${record.fingerprint}`);

      /* The key and the fingerprint must describe the same identity before
         anything else is checked: the fingerprint IS sha256 of the SPKI, so
         a key that hashes to something else is a claim with the wrong proof
         attached. */
      if (record.publicKeyData) {
        /* Under the rules of the key's own kind: an RSA SPKI hashes to the
           fingerprint, a v4 Ed25519 key hashes to it under its label. */
        if (!identityV4.keyMatchesFingerprint(record.publicKeyData, record.fingerprint)) {
          console.warn(`[Presence] Identity mismatch from ${record.ip}: key does not hash to ${record.fingerprint}`);
          safeSend(ws, { type: 'error', reason: 'identity-mismatch' });
          try { ws.close(4403, 'identity-mismatch'); } catch (_error) {}
          presence.delete(clientId);
          broadcastPeers();
          return;
        }
      }

      if (!IDENTITY_PROOF_REQUIRED) {
        /* Escape hatch: the claim itself counts as the proof, as before. */
        clearIdentityChallenge(record);
        record.identityVerified = true;
        /* A device the account's primary revoked stays out, escape hatch or
           not; with nothing proven, its id is what names it. */
        const view = record.wantsGuest ? guestRosterView(record.fingerprint, record.publicKeyData, record.helloRoster, record.guestOf) : null;
        const roster = view ? view.roster : loadRoster(record.fingerprint);
        if (!view && rosterRevokes(roster, record.deviceId, '')) {
          shutOutRevokedDevice(record, roster);
          return;
        }
        if (view && !admitGuest(record, view)) return;
      /* Mark the socket too: safeSendText reads this to decide whether the
         buffer limit is a hostile-socket kill or a slow-reader backoff. */
      ws.__poorijaVerifiedFingerprint = record.fingerprint || '';
        indexVerified(record);
        if (!record.guest && record.homeMoveRequest && !acceptDirectMove(record)) return;
        if (!record.guest) noteProvenIdentity(record.fingerprint);
        if (!record.guest) logProvenKey(record);
        closeDuplicatePresenceRecords(record);
        deliverHeldMail(record, ws);
        safeSend(ws, { type: 'roster', roster: roster || null, ...(record.guest ? { guest: true } : {}) });
        broadcastPeers();
        return;
      }

      if (record.publicKeyData) {
        /* Mail waits one round trip: only the private key matching the
           claimed fingerprint can open the challenge and echo it back. */
        beginIdentityChallenge(record);
      } else {
        /* Nothing to seal a challenge with means nothing was proven either;
           the fingerprint stays unverified — presence continues, but the
           mailbox and the ACKs do not answer to this socket. */
        clearIdentityChallenge(record);
        record.identityVerified = false;
        safeSend(ws, { type: 'error', reason: 'identity-unverified' });
      }
      broadcastPeers();
      return;
    }

    if (message.type === 'id-proof') {
      /* The late answer to a challenge a later hello replaced: set aside
         quietly, whether or not the current one is answered yet. */
      try {
        const answer = Buffer.from(String(message.nonce || ''), 'base64');
        const superseded = (record.idSupersededNonces || []).findIndex((nonce) => answer.length === nonce.length && crypto.timingSafeEqual(answer, nonce));
        if (superseded >= 0) {
          record.idSupersededNonces.splice(superseded, 1);
          return;
        }
      } catch (_error) { /* a malformed answer is judged below */ }
      if (!record.idChallengeNonce) {
        safeSend(ws, { type: 'error', reason: 'identity-unverified' });
        return;
      }
      let proven = false;
      /* What the device's own signature below is over: the nonce this proof
         answered, whichever of the two it was. */
      let proofNonce = String(message.nonce || '');
      if (message.sig && record.idSignNonce) {
        proofNonce = record.idSignNonce.toString('base64');
        proven = identityProofSigned(record.publicKeyData, 'socket', record.fingerprint, proofNonce, message.sig);
      } else if (record.idSignOnly) {
        /* A v4 account was sent nothing to open; only a signature answers. */
        proven = false;
      } else {
        try {
          const answer = Buffer.from(String(message.nonce || ''), 'base64');
          proven = answer.length === record.idChallengeNonce.length
            && crypto.timingSafeEqual(answer, record.idChallengeNonce);
        } catch (_error) { /* a malformed answer counts as no answer */ }
      }
      if (proven) {
        clearIdentityChallenge(record);
        record.identityVerified = true;
        /* The same answer signed with the install's own key proves which
           device this is, not only which account. */
        record.deviceKeyProven = false;
        if (record.deviceKey && message.deviceSig) {
          try {
            const deviceKey = crypto.createPublicKey({ key: Buffer.from(record.deviceKey, 'base64'), format: 'der', type: 'spki' });
            record.deviceKeyProven = deviceKey.asymmetricKeyType === 'ec' && crypto.verify(
              'sha256',
              Buffer.from(`poorija-device-proof|${record.fingerprint}|${record.deviceId}|${proofNonce}`),
              { key: deviceKey, dsaEncoding: 'ieee-p1363' },
              Buffer.from(String(message.deviceSig), 'base64'),
            );
          } catch (_error) { record.deviceKeyProven = false; }
        }
        /* A guest is judged by the family's copy of its roster too, and told
           "revoked" as a guest refusal; anyone else as before. */
        const view = record.wantsGuest ? guestRosterView(record.fingerprint, record.publicKeyData, record.helloRoster, record.guestOf) : null;
        const roster = view ? view.roster : loadRoster(record.fingerprint);
        if (!view && rosterRevokes(roster, record.deviceId, provenDeviceKey(record))) {
          console.log(`[Presence] Revoked device shut out for ${record.fingerprint}`);
          shutOutRevokedDevice(record, roster);
          return;
        }
        /* Without a roster of its own, this relay goes by the family's: a
           device any of them revokes is out here too. A relay with its own
           keeps to it — a rival roster planted elsewhere must not be able to
           lock the account's real devices out of their home. */
        if (!view && !roster) {
          const family = guestRosterView(record.fingerprint, record.publicKeyData, null, '');
          const revoking = family.chains.find((chain) => rosterRevokes(chain, record.deviceId, provenDeviceKey(record)));
          if (revoking) {
            console.log(`[Presence] Revoked device shut out for ${record.fingerprint}, by the family's roster`);
            shutOutRevokedDevice(record, revoking);
            return;
          }
        }
        /* A guest is taken in or refused here, before anything is delivered;
           taken in, it is never written down as living here. */
        if (view && !admitGuest(record, view)) return;
        /* Moved home elsewhere: a device of the account that still comes here
           is told, with the signed statement, and follows. */
        const movedStatement = !record.guest ? guestBook.movedStatement(record.fingerprint) : null;
        if (movedStatement) safeSend(ws, { type: 'home-move', statement: movedStatement.statement, sig: movedStatement.sig });
        /* Proven here again: home stops copying this device's mail to a
           guest relay, and an older notice of it stops counting. */
        if (!record.guest && guestBook.remoteFor(record.fingerprint).some((entry) => entry.deviceId === guestDeviceOf(record))) {
          guestBook.dropRemote(record.fingerprint, guestDeviceOf(record));
          guestBook.noteFloor(record.fingerprint, guestDeviceOf(record), Date.now());
          forgetRemoteCopies(record.fingerprint);
        }
        /* A resident's roster without the identity key beside it (stored
           before guest mode) gets it now, and goes to the family. */
        if (!record.guest && roster && !loadRosterIdentity(record.fingerprint) && saveRosterIdentity(record.fingerprint, record.publicKeyData)) {
          shareRosterCopy(record.fingerprint, roster, record.publicKeyData);
        }
        indexVerified(record);
        /* A move here straight from another family relay (smart relay choice):
           refused, the socket goes and nothing is delivered. */
        if (!record.guest && record.homeMoveRequest && !acceptDirectMove(record)) return;
        if (!record.guest) noteProvenIdentity(record.fingerprint);
        if (!record.guest) logProvenKey(record);
        closeDuplicatePresenceRecords(record);
        console.log(`[Presence] Identity proven for ${record.fingerprint}`);
        if (record.continuation) acceptIdentityContinuation(record);
        deliverHeldMail(record, ws);
        /* Which devices the account has, as its primary last signed it — or
           that it has no roster yet, which is an answer too: the device that
           made the identity founds one on hearing it. */
        safeSend(ws, { type: 'roster', roster: roster || null, ...(record.guest ? { guest: true } : {}) });
        /* Proven now, so announced now: the table carries only proven
           identities (broadcastPeers). */
        broadcastPeers();
      } else {
        /* Wrong answer: the nonce is spent so it cannot be guessed at again,
           and the socket stays with its degraded presence until a later
           hello proves otherwise. */
        clearIdentityChallenge(record);
        safeSend(ws, { type: 'error', reason: 'identity-unverified' });
      }
      return;
    }

    /* "Does this person live here, or stay here as a guest?" asked of this
       relay by one of its own: the question a linked relay is asked over
       transit, for one fingerprint the asker already holds. How two guests
       of the same relay find each other. */
    if (message.type === 'route-query') {
      if (!record.identityVerified) return;
      const now = Date.now();
      if (!record.routeQueries || now - record.routeQueries.since > 60000) record.routeQueries = { since: now, count: 0 };
      record.routeQueries.count += 1;
      if (record.routeQueries.count > 120) return;
      const asked = sanitizeFingerprint(String(message.toFingerprint || '').slice(0, 128));
      const home = (residentSocketUp(asked) || identityLivesHere(asked)) && !guestBook.movedTo(asked);
      const guestHere = !home && guestBook.isGuest(asked);
      safeSend(ws, {
        type: 'route', toFingerprint: asked, home, up: Boolean(findOpenPresenceByFingerprint(asked)),
        ...(guestHere ? { guest: true, ...(guestNoticeFor(asked) ? { notice: guestNoticeFor(asked) } : {}) } : {}), tag: String(message.tag || '').slice(0, 96),
      });
      return;
    }

    /* A guest moving its home here, on its own signed statement. */
    if (message.type === 'home-move') {
      if (!record.identityVerified) return;
      acceptHomeMoveHere(record, message);
      return;
    }

    /* A guest going home says so first: its stay here ends, and whatever is
       left for it follows it home. The socket stays a guest's — never a
       resident's — until it closes. */
    if (message.type === 'guest-end') {
      if (!record.guest || !record.identityVerified) return;
      record.guestNoticeSigned = null;
      record.guestRouteSigned = null;
      endGuestStay(record.fingerprint, guestDeviceOf(record));
      safeSend(ws, { type: 'guest-ended' });
      return;
    }

    if (message.type === 'relay-ack') {
      /* An ACK destroys mail, so only the proven owner of the fingerprint
         may spend one. */
      if (!record.identityVerified) {
        safeSend(ws, { type: 'error', reason: 'identity-unverified' });
        return;
      }
      /* And only a fingerprint names mail. The proof binds the socket to a
         key, not the claimed label to a shape, so the label is checked
         before it is allowed to touch the store. */
      if (!isFingerprintKey(record.fingerprint)) {
        safeSend(ws, { type: 'error', reason: 'identity-unverified' });
        return;
      }
      const ids = Array.isArray(message.ids) ? message.ids : [];
      const queued = offlineBoxes.get(record.fingerprint) || [];
      if (queued.length && ids.length) {
        /* A Set, because the app acknowledges one envelope per message and a
           file is thousands of them: an includes() per queued item per ACK is
           the same quadratic the retention sweep used to have. */
        const acked = new Set(ids.slice(0, 200));
        const next = queued.filter(msg => !acked.has(msg.relayId));
        if (next.length !== queued.length) {
          console.log(`[Presence] ACK received for ${queued.length - next.length} messages from ${record.fingerprint}`);
          if (next.length) {
            offlineBoxes.set(record.fingerprint, next);
          } else {
            offlineBoxes.delete(record.fingerprint);
          }
          saveOfflineBox(record.fingerprint);
        }
        /* The window reopens by whatever was acknowledged, whether or not it
           was still in the mailbox -- an ACK for something already gone is a
           duplicate, and treating it as nothing to do is what used to leave
           both sides waiting. */
        if (record.sentMail) for (const id of acked) record.sentMail.delete(id);
        pumpHeldMail(record, ws);
      }
      return;
    }

    /* Held for an absent sibling (holdForAbsentSiblings): a copy of a
       device-sync envelope for the account's devices that are away, what is
       waiting for this device, and its acknowledgement. The account's proven
       owner only, and only its own sealed device-sync envelopes. */
    if (message.type === 'sibling-hold' || message.type === 'sibling-fetch' || message.type === 'sibling-ack') {
      if (!record.identityVerified || !isFingerprintKey(record.fingerprint) || !record.deviceId) {
        safeSend(ws, { type: 'error', reason: 'identity-unverified' });
        return;
      }
      if (message.type === 'sibling-fetch') {
        pumpSiblingHeld(record, ws);
        return;
      }
      if (message.type === 'sibling-ack') {
        const ids = (Array.isArray(message.ids) ? message.ids : []).slice(0, 500).map((id) => String(id || '').slice(0, 64));
        ackSiblingHeld(record, ids);
        pumpSiblingHeld(record, ws);
        return;
      }
      const envelope = message.envelope;
      const text = envelope && typeof envelope === 'object' ? JSON.stringify(envelope) : '';
      if (!text || text.length > SIBLING_ITEM_MAX_CHARS || envelope.type !== 'device-sync'
        || envelope.fromFingerprint !== record.fingerprint) {
        safeSend(ws, { type: 'error', reason: 'sibling-hold-refused' });
        return;
      }
      const held = holdForAbsentSiblings(record, text);
      safeSend(ws, { type: 'sibling-hold-ok', held });
      return;
    }

    /* The account's device-sync beacons. Only the proven owner of the
       fingerprint may read or write them: they say which devices exist and
       when each last synced, which is the account's business alone. */
    if (message.type === 'roster-put' || message.type === 'roster-get') {
      /* Asked while the identity is being proven again (every hello re-asks):
         the proof's own answer carries the roster, so this one is let go
         without an error the app would show as "not accepted". */
      if (!record.identityVerified && record.idChallengeNonce) return;
      if (!record.identityVerified || !isFingerprintKey(record.fingerprint) || !record.publicKeyData) {
        safeSend(ws, { type: 'error', reason: 'identity-unverified' });
        return;
      }
      const view = record.guest ? guestRosterView(record.fingerprint, record.publicKeyData, null, record.guestOf) : null;
      const current = view ? view.roster : loadRoster(record.fingerprint);
      if (message.type === 'roster-get') {
        safeSend(ws, { type: 'roster', roster: current, ...(record.guest ? { guest: true } : {}) });
        return;
      }
      const next = message.roster;
      /* A guest writes only a successor of a roster this relay can stand
         behind, and it is not kept here as this relay's own: it goes to the
         family as a copy — home takes it if it follows from home's roster —
         and into this relay's own copy slot. Founding a roster is its home's
         business. */
      if (view) {
        if (!view.chains.length) {
          safeSend(ws, { type: 'roster-refused', reason: 'no-anchor', roster: null });
          return;
        }
        const refusal = familyWriteRefusal(next, view, record.publicKeyData, record.fingerprint);
        if (refusal) {
          safeSend(ws, { type: 'roster-refused', reason: refusal, roster: current });
          return;
        }
        try { rosterCopyStore.keep(guestRules.sealRosterCopy(record.fingerprint, next, record.publicKeyData), relayIdentity.id); } catch (_error) { /* not kept */ }
        shareRosterCopy(record.fingerprint, next, record.publicKeyData);
        safeSend(ws, { type: 'roster-stored', seq: next.seq });
        for (const candidate of verifiedByFingerprint.get(record.fingerprint) || []) {
          if (candidate === record || candidate.ws?.readyState !== WebSocket.OPEN) continue;
          safeSend(candidate.ws, { type: 'roster', roster: next, ...(candidate.guest ? { guest: true } : {}) });
        }
        return;
      }
      /* A first roster for someone the family already holds one for must
         follow from it: otherwise any relay but the account's home would
         take a rival founding from a revoked device that connects there. */
      if (!current) {
        const refusal = familyWriteRefusal(next, guestRosterView(record.fingerprint, record.publicKeyData, null, ''), record.publicKeyData, record.fingerprint);
        if (refusal) {
          safeSend(ws, { type: 'roster-refused', reason: refusal, roster: null });
          return;
        }
      }
      const refusal = rosterRefusal(next, current, record.publicKeyData, record.fingerprint);
      if (refusal) {
        safeSend(ws, { type: 'roster-refused', reason: refusal, roster: current });
        return;
      }
      saveRoster(record.fingerprint, next);
      saveRosterIdentity(record.fingerprint, record.publicKeyData);
      /* The family keeps a sealed copy: a guest relay elsewhere, and home
         after a guest stay, judge this account's devices by it. */
      shareRosterCopy(record.fingerprint, next, record.publicKeyData);
      console.log(`[Roster] ${record.fingerprint.slice(0, 12)} now at ${next.seq}: ${next.members.length} device(s), ${next.revoked.length} gone`);
      safeSend(ws, { type: 'roster-stored', seq: next.seq });
      enforceRoster(record.fingerprint, next);
      for (const candidate of verifiedByFingerprint.get(record.fingerprint) || []) {
        if (candidate === record || candidate.ws?.readyState !== WebSocket.OPEN) continue;
        safeSend(candidate.ws, { type: 'roster', roster: next });
      }
      return;
    }
    /* A device leaving its account says so on the way out: its beacon and
       whatever was held for it go now, not after thirty days. Its own only. */
    if (message.type === 'beacon-drop') {
      if (!record.identityVerified || !isFingerprintKey(record.fingerprint) || !record.deviceId) {
        safeSend(ws, { type: 'error', reason: 'identity-unverified' });
        return;
      }
      forgetSiblingDevice(record.fingerprint, record.deviceId);
      safeSend(ws, { type: 'beacon-dropped', deviceId: record.deviceId });
      return;
    }
    /* A room on this relay's group-call SFU (roadmap 3.2): a fresh room id and
       the capability that admits a socket to it for six hours. Only for a
       proven account, at most twenty an hour; the host hands it to the
       members inside the encrypted call invite. */
    if (message.type === 'sfu-room') {
      if (!record.identityVerified || !isFingerprintKey(record.fingerprint)) {
        safeSend(ws, { type: 'error', reason: 'identity-unverified', tag: message.tag });
        return;
      }
      const now = Date.now();
      record.sfuRooms = (record.sfuRooms || []).filter((at) => now - at < 60 * 60 * 1000);
      if (!sfuUp || record.sfuRooms.length >= 20) {
        safeSend(ws, { type: 'sfu-room', ok: false, reason: sfuUp ? 'rate-limited' : 'no-sfu', tag: message.tag });
        return;
      }
      record.sfuRooms.push(now);
      const room = sfuRoomsLib.newRoomId();
      const exp = now + 6 * 60 * 60 * 1000;
      safeSend(ws, { type: 'sfu-room', ok: true, room, exp, cap: sfuRoomsLib.mintCapability(SFU_SECRET, room, exp), url: SFU_PUBLIC, tag: message.tag });
      return;
    }
    if (message.type === 'beacon-put' || message.type === 'beacon-get') {
      if (!record.identityVerified || !isFingerprintKey(record.fingerprint)) {
        safeSend(ws, { type: 'error', reason: 'identity-unverified' });
        return;
      }
      if (message.type === 'beacon-get') {
        const entries = loadBeacons(record.fingerprint);
        const roster = loadRoster(record.fingerprint);
        safeSend(ws, {
          type: 'beacons',
          items: Object.entries(entries)
            .filter(([deviceId]) => !rosterRevokes(roster, deviceId, ''))
            .map(([deviceId, entry]) => ({ deviceId, blob: entry.blob, at: entry.at })),
        });
        return;
      }
      const deviceId = String(message.deviceId || '').slice(0, 128);
      const blob = String(message.blob || '');
      if (!deviceId || !/^[A-Za-z0-9_-]+$/.test(deviceId) || !blob
        || blob.length > BEACON_MAX_CHARS || !/^[A-Za-z0-9+/=]+$/.test(blob)) {
        safeSend(ws, { type: 'error', reason: 'beacon-refused' });
        return;
      }
      storeBeacon(record.fingerprint, deviceId, blob);
      safeSend(ws, { type: 'beacon-stored', deviceId });
      /* The account's other live devices hear that something changed, so a
         sibling that is online can come and sync straight away. */
      for (const candidate of verifiedByFingerprint.get(record.fingerprint) || []) {
        if (candidate === record || candidate.ws?.readyState !== WebSocket.OPEN) continue;
        safeSend(candidate.ws, { type: 'beacon-changed', deviceId });
      }
      return;
    }

    /* An envelope for somebody on another relay. This relay cannot open it and
       will not try: it looks at the one field it is meant to read, finds the
       link, and passes it on. Nothing about it is written down. */
    if (message.type === 'transit') {
      const senderRestriction = getRestrictionForIdentity(record);
      if (senderRestriction) {
        disconnectRestrictedPeer(record, senderRestriction);
        return;
      }
      carryTransitEnvelope(message, {
        clientId,
        tag: String(message.tag || '').slice(0, 96),
        reply: (payload) => safeSend(ws, payload),
      });
      return;
    }

    if (message.type === 'relay') {
      const senderRestriction = getRestrictionForIdentity(record);
      if (senderRestriction) {
        disconnectRestrictedPeer(record, senderRestriction);
        return;
      }
      /* The sender's name rides along as metadata for the recipient's relay,
         and an unproven socket chose it itself. A socket that has not answered
         the identity challenge may still send — a client races its first
         frames against its own proof all the time — but nothing it sends
         leaves claiming to be somebody. The proof, when it lands, restores
         the name; the challenge is one round trip, not a lifestyle. */
      deliverRelayMessage(message, {
        clientId,
        fromFingerprint: record.identityVerified ? record.fingerprint : '',
        reply: (payload) => safeSend(ws, payload),
      });
      return;
    }

    /* A sender taking back envelopes it queued here for somebody who will
       never collect them — a contact who turned out to live on another relay,
       to whom the same messages have now been sent the right way. Only the
       proven sender of an envelope may withdraw it, and only by the tag it
       sent it with; nothing else in anybody's mailbox can be touched. */
    if (message.type === 'relay-withdraw') {
      if (!record.identityVerified || !isFingerprintKey(record.fingerprint)) {
        safeSend(ws, { type: 'error', reason: 'identity-unverified' });
        return;
      }
      const box = sanitizeFingerprint(message.toFingerprint);
      const tags = new Set((Array.isArray(message.tags) ? message.tags : [])
        .slice(0, 500).map((tag) => String(tag || '').slice(0, 96)).filter(Boolean));
      /* A sealed-sender envelope carries no sender to match, only the hash of
         a secret its sender alone can derive for it (wd). Presenting the
         secret is the proof; the relay never learns which envelopes are whose
         until they are taken back. */
      const secretHashes = new Set((Array.isArray(message.secrets) ? message.secrets : [])
        .slice(0, 500).map((secret) => String(secret || ''))
        .filter((secret) => /^[a-f0-9]{64}$/.test(secret))
        .map((secret) => crypto.createHash('sha256').update(secret).digest('hex')));
      let withdrawn = 0;
      if (box && isFingerprintKey(box) && (tags.size || secretHashes.size)) {
        const queued = offlineBoxes.get(box) || [];
        const kept = queued.filter((item) => !(
          (item.fromFingerprint === record.fingerprint && tags.has(String(item.payload?.tag || '')))
          || (item.payload?.wd && secretHashes.has(String(item.payload.wd)))
        ));
        withdrawn = queued.length - kept.length;
        if (withdrawn) {
          if (kept.length) offlineBoxes.set(box, kept);
          else offlineBoxes.delete(box);
          saveOfflineBox(box);
        }
      }
      safeSend(ws, { type: 'withdrawn', toFingerprint: box, count: withdrawn });
      return;
    }

    /* Emergency wipe, asked for from the device that owns the mailbox.
       The socket is the proof: it is the same binding every other relay
       operation trusts, and the record it carries is the one being emptied.
       Everything keyed to this identity goes — queued envelopes, push
       subscriptions, self-destruct records — and the reply is sent before the
       socket is dropped so the client knows it happened. */
    /* A dissolved group. The relay never held the group itself - it forwards
       sealed envelopes and cannot read one - so what it can do is drop
       everything still queued that belongs to that conversation, from every
       mailbox, so nothing addressed to a group that no longer exists is left
       waiting for somebody to come back and collect it.
       The conversation id is the sender's own; it identifies a thread, not a
       person, and the relay already sees the addressing of every envelope. */
    if (message.type === 'purge-space') {
      /* It empties a conversation's mail out of everybody's mailbox: a proven
         identity at the very least, never an anonymous socket. */
      if (!record.identityVerified) {
        safeSend(ws, { type: 'purged', removed: 0, scope: 'space', refused: 'identity-unverified' });
        return;
      }
      const conversationId = String(message.conversationId || '').slice(0, 200);
      let removed = 0;
      if (conversationId) {
        const touched = [];
        /* Capped: a hostile mailbox-count flood turns this synchronous walk into
   a multi-second event-loop stall. The first ten thousand boxes is plenty
   for any honest relay; the rest can wait for the retention sweep. */
let purgeWalked = 0;
for (const [box, queue] of offlineBoxes.entries()) {
    if (++purgeWalked > 10000) break;
          const kept = (queue || []).filter((item) => item?.payload?.spaceId !== conversationId
            && item?.payload?.space?.conversationId !== conversationId);
          if (kept.length !== queue.length) {
            removed += queue.length - kept.length;
            touched.push(box);
            if (kept.length) offlineBoxes.set(box, kept);
            else offlineBoxes.delete(box);
          }
        }
        /* A group's members, not everybody on the relay. */
        touched.forEach((box) => saveOfflineBox(box));
      }
      console.log(`[Purge] dissolved group: ${removed} queued envelope(s) dropped`);
      safeSend(ws, { type: 'purged', removed, scope: 'space' });
      return;
    }
    if (message.type === 'purge-me') {
      /* Proven, not claimed. A hello names a fingerprint and carries its
         public key — both public — so without the proof anybody could empty
         anybody's queued mail, beacons and push registration. */
      if (!record.identityVerified) {
        safeSend(ws, { type: 'purged', removed: 0, refused: 'identity-unverified' });
        return;
      }
      const target = record.fingerprint || '';
      let removed = 0;
      /* The hello that set this fingerprint was never challenged — a hello
         alone claims a name without proving anything, and `purge-me` acts on
         the claim. A claimed key that is not a fingerprint names no mailbox
         this relay keeps, and running the purge against it would hand the
         claimant a filename to delete. */
      if (target && isFingerprintKey(target)) {
        removed += (offlineBoxes.get(target) || []).length;
        offlineBoxes.delete(target);
        saveOfflineBox(target);
        dropBeacons(target);
        /* The roster goes only when its own primary wipes: from any other
           device, removing it would let that device name itself primary. */
        const roster = loadRoster(target);
        if (roster && provenDeviceKey(record) && provenDeviceKey(record) === roster.primary.k) dropRoster(target);
        const pushKey = pushIndexKey(target);
        if (pushSubscriptions.has(pushKey)) {
          pushSubscriptions.delete(pushKey);
          savePushSubscriptions();
        }
        /* Self-destruct records are deliberately not linked to an identity —
           they carry a payload id and nothing else — so there is no "mine" to
           purge here. They expire on their own limits, which is the guarantee
           they were built to make. */
      }
      console.log(`[Purge] emergency wipe for ${target || 'unknown'}: ${removed} queued envelope(s) dropped`);
      safeSend(ws, { type: 'purged', removed });
      return;
    }
    if (message.type === 'ping') {
      safeSend(ws, { type: 'pong', timestamp: Date.now() });
      return;
    }
    /* The page says it is going away before the platform freezes it. iOS
       fires visibilitychange and pagehide while there is still a moment to
       send, so this arrives ahead of the heartbeat lapsing and the very next
       message is pushed rather than dropped into a socket nobody is reading.
       The heartbeat rule below still stands on its own for the case where the
       freeze wins the race. */
    if (message.type === 'presence-state') {
      record.away = message.state === 'away';
      broadcastPeers();
      return;
    }
    if (message.type === 'get-peers') {
      /* The whole table with keys and prekeys — kilobytes per person. Asked
         for when a contact is added: a few in a row are answered at once,
         then one every ten seconds per socket, and never onto a socket still
         behind, or a thousand requests in a row would be gigabytes in memory.
         A request past the budget is not dropped: it waits for the next
         answer, so every contact added in a burst still gets its keys. */
      if (record.peersAskTimer) return;
      const answer = () => {
        record.peersAskTimer = null;
        if (ws.readyState !== WebSocket.OPEN) return;
        const wait = peersAskWait(record);
        if (wait > 0 || ws.bufferedAmount > PRESENCE_BUFFER_LIMIT) {
          record.peersAskTimer = setTimeout(answer, wait > 0 ? wait : 2000);
          return;
        }
        record.peersAskTokens -= 1;
        safeSend(ws, { type: 'peers', peers: snapshotPeers() });
        /* That answer replaced the client's copy of the table. The next tick
           gives a delta-reading client the broadcast table again, so the
           changes that follow it apply to the very set they were made from. */
        record.peersSynced = false;
        broadcastPeers();
      };
      answer();
      return;
    }
  });

  ws.on('close', (code, reason) => {
    clearIdentityChallenge(record);
    clearTimeout(record.peersAskTimer);
    console.log(`[Presence] Connection closed for ${clientId} (${record.username}). Code: ${code}, Reason: ${reason}`);
    presence.delete(clientId);
    unindexVerified(record);
    broadcastPeers();
  });

  ws.on('error', (error) => {
    clearIdentityChallenge(record);
    console.error(`[Presence] Connection error for ${clientId} (${record.username}):`, error);
    presence.delete(clientId);
    unindexVerified(record);
    broadcastPeers();
  });
});

