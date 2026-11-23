/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

'use strict';

/* Rooms of a group call's selective forwarding unit (roadmap 3.2).

   The SFU takes each participant's media once and hands it to the others. It
   never holds a key: every frame is already SFrame-encrypted (RFC 9605) on the
   sender's device under that sender's own key, which only the call's members
   were given, inside their pairwise ratchets. What the SFU sees is a room, a
   slot number per socket, the size and timing of frames, and an opaque header.

   Who may use a room: a capability the relay mints for a proven account and
   the host hands to the members inside the encrypted call invite —
   HMAC-SHA256(secret, "poorija-sfu/1|room|exp"). Holding it buys bandwidth in
   that room only, never a way to read anything, so it is a guard against an
   open media relay, not against eavesdropping (the keys are that).

   Wire, on the SFU socket:
     text   JSON control: hello → welcome {slot, peers}; peer-join / peer-leave;
            key-request {to} (forwarded); bye.
     binary from a client:  u8 kind ‖ u8 flags ‖ SFrame bytes
            to a client:    u16 slot ‖ u8 kind ‖ u8 flags ‖ SFrame bytes
            kind 1 audio, 2 video; flags bit 0 = key frame. */

const crypto = require('crypto');

const CAP_LABEL = 'poorija-sfu/1';
const ROOM_RE = /^[a-f0-9]{32}$/;
const MAX_FRAME_BYTES = 256 * 1024;

function mintCapability(secret, room, exp) {
  return crypto.createHmac('sha256', secret).update(`${CAP_LABEL}|${room}|${exp}`).digest('base64url');
}
function capabilityHolds(secret, room, exp, cap, now = Date.now()) {
  if (!ROOM_RE.test(String(room || '')) || !Number.isSafeInteger(exp) || exp < now) return false;
  const want = Buffer.from(mintCapability(secret, room, exp));
  const got = Buffer.from(String(cap || ''));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
const newRoomId = () => crypto.randomBytes(16).toString('hex');

/* `send(socket, data)` and `bufferedOf(socket)` let a test drive this without
   sockets; the server passes ws's. */
/** @param {{ maxPerRoom?: number, maxRooms?: number, maxBuffered?: number, send: (socket: any, data: any) => void, bufferedOf: (socket: any) => number }} options */
function createRooms({ maxPerRoom = 25, maxRooms = 500, maxBuffered = 2 * 1024 * 1024, send, bufferedOf }) {
  const rooms = new Map();
  const stats = { framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0, dropped: 0 };

  function join(socket, room) {
    if (!rooms.has(room) && rooms.size >= maxRooms) return { ok: false, reason: 'busy' };
    const r = rooms.get(room) || { members: new Map(), nextSlot: 1 };
    if (r.members.size >= maxPerRoom) return { ok: false, reason: 'full' };
    const slot = r.nextSlot;
    r.nextSlot = (r.nextSlot % 65535) + 1;
    r.members.set(slot, socket);
    rooms.set(room, r);
    socket.__sfu = { room, slot };
    const peers = [...r.members.keys()].filter((s) => s !== slot);
    for (const [s, other] of r.members) if (s !== slot) send(other, JSON.stringify({ type: 'peer-join', slot }));
    return { ok: true, slot, peers };
  }
  function leave(socket) {
    const where = socket.__sfu;
    if (!where) return;
    const r = rooms.get(where.room);
    socket.__sfu = null;
    if (!r) return;
    r.members.delete(where.slot);
    if (!r.members.size) { rooms.delete(where.room); return; }
    for (const other of r.members.values()) send(other, JSON.stringify({ type: 'peer-leave', slot: where.slot }));
  }
  /* A frame from one member to every other member of its room. A receiver
     whose socket is already backed up does not get this one (media is live;
     a frame late by seconds is worse than no frame). */
  function frame(socket, data) {
    const where = socket.__sfu;
    if (!where) return false;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 3 || buf.length > MAX_FRAME_BYTES) return false;
    const kind = buf[0];
    if (kind !== 1 && kind !== 2) return false;
    const r = rooms.get(where.room);
    if (!r) return false;
    stats.framesIn += 1;
    stats.bytesIn += buf.length;
    const out = Buffer.allocUnsafe(buf.length + 2);
    out.writeUInt16BE(where.slot, 0);
    buf.copy(out, 2);
    for (const [slot, other] of r.members) {
      if (slot === where.slot) continue;
      if (bufferedOf(other) > maxBuffered) { stats.dropped += 1; continue; }
      send(other, out);
      stats.framesOut += 1;
      stats.bytesOut += out.length;
    }
    return true;
  }
  /* A key-frame request, from a receiver to one sender. */
  function relayControl(socket, message) {
    const where = socket.__sfu;
    if (!where || message?.type !== 'key-request' || !Number.isSafeInteger(message.to)) return false;
    const target = rooms.get(where.room)?.members.get(message.to);
    if (!target) return false;
    send(target, JSON.stringify({ type: 'key-request', from: where.slot }));
    return true;
  }
  return {
    join, leave, frame, relayControl,
    stats: () => ({ rooms: rooms.size, participants: [...rooms.values()].reduce((n, r) => n + r.members.size, 0), ...stats }),
  };
}

module.exports = { mintCapability, capabilityHolds, newRoomId, createRooms, ROOM_RE, MAX_FRAME_BYTES };
