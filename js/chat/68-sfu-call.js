/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* ============================================================================
   Large group calls through an SFU, encrypted end to end (roadmap 3.2)
   ============================================================================

   A mesh call sends every picture and every voice to every other member: N-1
   uploads per device, which a phone on a slow line cannot do past four or
   five people. For a larger call on one relay, each device now sends ONCE,
   to the relay's SFU (scripts/sfu.js), which hands the frames to the others.

   The SFU holds no key. Each device encodes its own audio (Opus) and video
   (VP8) with WebCodecs and encrypts every encoded frame with SFrame (RFC 9605,
   js/crypto/sframe.js) under a base key of its own, which it hands to the
   other members inside the pairwise ratchet (the gcall-sfkey signal); the SFU
   sees a header and ciphertext. A member who leaves: everyone still in makes
   a new key and hands it to those still in, so what the one who left kept
   opens nothing that follows. A key is taken only from the member the pairwise
   session authenticated, and a frame only when the slot it came in on belongs
   to the member whose key opens it.

   Used when: the call has more than four people, every one of them reads
   'sfu1', every one is on this device's relay, and the relay says it has an
   SFU. Otherwise the call is the mesh it always was. It rides the stage, the
   roster and the signalling of the mesh call (12-, 13-, 14-, 16-group-call-*):
   a participant's tile gets a MediaStream made from what was decoded.
   ============================================================================ */

const SFU_MIN_PEOPLE = 5;
const SFU_VIDEO = { width: 640, height: 360, fps: 15, bitrate: 500000, keyEveryMs: 4000 };
const SFU_KIND_AUDIO = 1;
const SFU_KIND_VIDEO = 2;

function sfuSupported() {
  return typeof AudioEncoder === 'function' && typeof AudioDecoder === 'function'
    && typeof VideoEncoder === 'function' && typeof VideoDecoder === 'function'
    && typeof AudioWorkletNode === 'function' && typeof PoorijaSFrame === 'object';
}

/* ---- the room ---------------------------------------------------------------- */

const sfuRoomWaits = new Map();
function settleSfuRoom(message) {
  const wait = sfuRoomWaits.get(String(message?.tag || ''));
  if (!wait) return;
  sfuRoomWaits.delete(String(message.tag));
  wait(message);
}
function requestSfuRoom() {
  return new Promise((resolve) => {
    if (!chatState.ws || chatState.ws.readyState !== WebSocket.OPEN) { resolve(null); return; }
    const tag = `sfu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timer = window.setTimeout(() => { sfuRoomWaits.delete(tag); resolve(null); }, 8000);
    sfuRoomWaits.set(tag, (message) => { window.clearTimeout(timer); resolve(message?.ok ? { room: message.room, exp: message.exp, cap: message.cap, url: message.url || '' } : null); });
    chatState.ws.send(JSON.stringify({ type: 'sfu-room', tag }));
  });
}
function sfuUrlFor(room) {
  if (room?.url && /^wss?:\/\//.test(room.url)) return room.url;
  const origin = new URL(chatServerOrigin());
  origin.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
  origin.pathname = room?.url || '/sfu';
  return origin.toString();
}

/* Whether this call should go through the SFU, decided by the one who starts
   it. Returns the room to put in the invitation, or null for the mesh. */
/* The relays of this device's family, by origin: the operator's signed
   directory (61-relay-directory.js). Their pages already allow a socket to one
   another (nginx puts every family origin in connect-src), so a member whose
   home is one of them can reach this relay's SFU. A test bed with no
   directory names its relays in __POORIJA_SFU_FAMILY__. */
function sfuFamilyOrigins() {
  const out = new Set();
  const add = (value) => { try { out.add(new URL(value).origin); } catch (_error) { /* not an origin */ } };
  for (const relay of chatState.profile?.relayDirectory?.body?.relays || []) for (const origin of relay?.origins || []) add(origin);
  for (const origin of window.__POORIJA_SFU_FAMILY__ || []) add(origin);
  return out;
}
/* A member reaches this relay's SFU when they are on this relay, or on a
   relay of the same family. Anyone else keeps the call on the mesh. */
function memberReachesSfu(peer) {
  if (!(typeof callNeedsRelay === 'function' && callNeedsRelay(peer))) return true;
  const home = peer?.homeRelay?.origin;
  if (!home) return false;
  try { return sfuFamilyOrigins().has(new URL(home).origin); } catch (_error) { return false; }
}

async function chooseSfuForCall(members) {
  const minPeople = Number(window.__POORIJA_SFU_MIN_PEOPLE__) || SFU_MIN_PEOPLE;
  if (!sfuSupported() || members.length + 1 < minPeople) return null;
  if (!members.every((peer) => typeof peerSupports === 'function' && peerSupports(peer, 'sfu1'))) return null;
  if (!members.every(memberReachesSfu)) return null;
  /* The relay says whether its SFU answers. */
  try {
    const health = await (await fetch(new URL('/chat-health', chatServerOrigin()), { cache: 'no-store' })).json();
    if (health?.sfu !== true) return null;
  } catch (_error) { return null; }
  const room = await requestSfuRoom();
  /* The address in full: a member on another relay of the family opens it
     from a page of another origin, where "/sfu" would name their own relay. */
  if (room) room.url = sfuUrlFor(room);
  /* Everyone in the call can authenticate a frame's metadata (cap sfu2):
     the call says so, and every frame then binds its kind, its key-frame
     flag and its sender's slot (sfuFrameMetadata). A call with one member
     who cannot keeps the version-1 binding, for everyone. */
  if (room) room.aad = members.every((peer) => peerSupports(peer, 'sfu2')) ? 2 : 1;
  return room;
}

/* ---- what a frame's authentication covers -------------------------------------- */

/* Version 1: the kind (audio or video) alone. The key-frame flag and the
   sender's slot travel beside the frame, outside it, so the relay could
   rewrite them: mark a delta frame a key frame, or present one member's
   frame as another's slot (roadmap 5.2, finding F4). Version 2 binds all
   three: u8 kind ‖ u8 flags ‖ u16 slot (the sender's, from the SFU's
   welcome, and the slot its key message announced). */
function sfuFrameMetadata(media, kind, keyFrame, slot) {
  if ((media?.room?.aad || 1) < 2) return Uint8Array.of(kind);
  return Uint8Array.of(kind, keyFrame ? 1 : 0, (slot >> 8) & 0xff, slot & 0xff);
}

/* ---- keys ----------------------------------------------------------------------- */

function sfuState() { return chatState.groupCall?.sfuMedia || null; }
const randomKid = () => crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;

async function makeOwnSfuKey(media) {
  const base = crypto.getRandomValues(new Uint8Array(16));
  const kid = randomKid();
  media.own = { kid, base, keys: await PoorijaSFrame.deriveKeys(base, kid), ctr: 0 };
}
function sfuKeyMessage(media) {
  return {
    type: 'gcall-sfkey',
    callId: chatState.groupCall.callId,
    slot: media.slot,
    kid: media.own.kid,
    key: btoa(String.fromCharCode(...media.own.base)),
    fromFingerprint: myCallIdentity(),
  };
}
function sendSfuKey(to) {
  const media = sfuState();
  if (!media?.own || !media.slot) return;
  signalGroupCall(to, sfuKeyMessage(media));
}
/* A new key for everyone still here, when someone has gone. */
async function rotateSfuKey() {
  const media = sfuState();
  if (!media) return;
  await makeOwnSfuKey(media);
  media.forceKeyFrame = true;
  const audience = groupCallAudience();
  if (audience) sendSfuKey(audience);
}
/* From the member the pairwise session authenticated — never the name the
   message gives itself. */
async function handleSfuKey(message, provenFingerprint) {
  const media = sfuState();
  if (!media || message.callId !== chatState.groupCall.callId || !provenFingerprint) return;
  if (!Number.isSafeInteger(message.kid) || !Number.isSafeInteger(message.slot)) return;
  let base;
  try { base = Uint8Array.from(atob(String(message.key || '')), (c) => c.charCodeAt(0)); } catch (_error) { return; }
  if (base.length !== 16) return;
  /* Two members whose random KIDs met would have each other's frames tried
     with the wrong key (and one of them silenced). The newcomer's KID is
     refused and they are asked for another; this device's own KID clashing
     with theirs is renewed here (finding F4). */
  const held = media.keysByKid.get(message.kid);
  if (held && held.fp !== provenFingerprint) {
    signalGroupCall(provenFingerprint, { type: 'gcall-sfkey-clash', callId: chatState.groupCall.callId, kid: message.kid });
    return;
  }
  if (media.own && media.own.kid === message.kid) { await rotateSfuKey(); }
  const keys = await PoorijaSFrame.deriveKeys(base, message.kid);
  media.keysByKid.set(message.kid, { keys, fp: provenFingerprint, slot: message.slot });
  media.slotToFp.set(message.slot, provenFingerprint);
  /* Old keys of the same person stay a few seconds for frames in flight. */
  for (const [kid, entry] of media.keysByKid) {
    if (entry.fp === provenFingerprint && kid !== message.kid) window.setTimeout(() => media.keysByKid.delete(kid), 5000);
  }
  requestKeyFrameFrom(message.slot);
}

/* ---- sending -------------------------------------------------------------------- */

async function sendSfuFrame(kind, data, keyFrame) {
  const media = sfuState();
  if (!media?.own || media.ws?.readyState !== WebSocket.OPEN) return;
  if (media.ws.bufferedAmount > 1024 * 1024 && kind === SFU_KIND_VIDEO && !keyFrame) return;
  const ctr = media.own.ctr;
  media.own.ctr += 1;
  const sealed = await PoorijaSFrame.encryptFrame(media.own.keys, ctr, data, sfuFrameMetadata(media, kind, keyFrame, media.slot));
  const out = new Uint8Array(sealed.length + 2);
  out[0] = kind;
  out[1] = keyFrame ? 1 : 0;
  out.set(sealed, 2);
  media.ws.send(out);
  media.sent += 1;
}

async function startSfuCapture(media, stream) {
  const audioTrack = stream.getAudioTracks()[0];
  if (audioTrack) {
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.audioWorklet.addModule('js/chat/sfu-worklet.js');
    media.audioContext = ctx;
    const encoder = new AudioEncoder({
      output: (chunk) => { const buf = new Uint8Array(chunk.byteLength); chunk.copyTo(buf); sendSfuFrame(SFU_KIND_AUDIO, buf, true); },
      error: (error) => console.warn('[SFU] audio encoder:', error?.message || error),
    });
    encoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 32000 });
    media.audioEncoder = encoder;
    const source = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
    const capture = new AudioWorkletNode(ctx, 'poorija-sfu-capture');
    let ts = 0;
    capture.port.onmessage = (event) => {
      if (encoder.state !== 'configured' || chatState.groupCall?.muted) return;
      const data = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: 960, numberOfChannels: 1, timestamp: ts, data: event.data });
      ts += 20000;
      encoder.encode(data);
      data.close();
    };
    source.connect(capture);
    media.captureNode = capture;
  }
  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack) {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([videoTrack]);
    video.play().catch(() => {});
    const canvas = document.createElement('canvas');
    canvas.width = SFU_VIDEO.width;
    canvas.height = SFU_VIDEO.height;
    const draw = canvas.getContext('2d');
    const encoder = new VideoEncoder({
      output: (chunk) => { const buf = new Uint8Array(chunk.byteLength); chunk.copyTo(buf); sendSfuFrame(SFU_KIND_VIDEO, buf, chunk.type === 'key'); },
      error: (error) => console.warn('[SFU] video encoder:', error?.message || error),
    });
    encoder.configure({ codec: 'vp8', width: SFU_VIDEO.width, height: SFU_VIDEO.height, bitrate: SFU_VIDEO.bitrate, framerate: SFU_VIDEO.fps, latencyMode: 'realtime' });
    media.videoEncoder = encoder;
    let lastKey = 0;
    media.videoTimer = window.setInterval(() => {
      if (encoder.state !== 'configured' || video.readyState < 2 || chatState.groupCall?.videoOff) return;
      if (encoder.encodeQueueSize > 2) return;
      draw.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = new VideoFrame(canvas, { timestamp: Math.round(performance.now() * 1000) });
      const now = Date.now();
      const keyFrame = media.forceKeyFrame || now - lastKey > SFU_VIDEO.keyEveryMs;
      if (keyFrame) { lastKey = now; media.forceKeyFrame = false; }
      encoder.encode(frame, { keyFrame });
      frame.close();
    }, Math.round(1000 / SFU_VIDEO.fps));
  }
}

/* ---- receiving ------------------------------------------------------------------ */

function requestKeyFrameFrom(slot) {
  const media = sfuState();
  if (media?.ws?.readyState === WebSocket.OPEN) media.ws.send(JSON.stringify({ type: 'key-request', to: slot }));
}

/* What is heard and seen of one person, made into a MediaStream their tile
   plays like any other. */
/* One per person, made once: frames that arrive while it is being made wait
   for the same one rather than finding a sender with no decoders yet. */
function sfuSenderFor(media, fp) {
  if (!media.senderJobs) media.senderJobs = new Map();
  if (!media.senderJobs.has(fp)) media.senderJobs.set(fp, makeSfuSender(media, fp));
  return media.senderJobs.get(fp);
}
async function makeSfuSender(media, fp) {
  const sender = { fp, frames: 0, needKey: true };
  media.senders.set(fp, sender);
  const ctx = media.audioContext || new AudioContext({ sampleRate: 48000 });
  if (!media.audioContext) { await ctx.audioWorklet.addModule('js/chat/sfu-worklet.js'); media.audioContext = ctx; }
  const play = new AudioWorkletNode(ctx, 'poorija-sfu-play');
  const out = ctx.createMediaStreamDestination();
  play.connect(out);
  sender.audioDecoder = new AudioDecoder({
    output: (data) => {
      const samples = new Float32Array(data.numberOfFrames);
      data.copyTo(samples, { planeIndex: 0, format: 'f32-planar' });
      data.close();
      play.port.postMessage(samples, [samples.buffer]);
      sender.audioFrames = (sender.audioFrames || 0) + 1;
    },
    error: (error) => console.warn('[SFU] audio decoder:', error?.message || error),
  });
  sender.audioDecoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
  const canvas = document.createElement('canvas');
  canvas.width = SFU_VIDEO.width;
  canvas.height = SFU_VIDEO.height;
  const draw = canvas.getContext('2d');
  sender.videoDecoder = new VideoDecoder({
    output: (frame) => { draw.drawImage(frame, 0, 0, canvas.width, canvas.height); frame.close(); sender.videoFrames = (sender.videoFrames || 0) + 1; },
    error: (error) => { console.warn('[SFU] video decoder:', error?.message || error); sender.needKey = true; },
  });
  sender.videoDecoder.configure({ codec: 'vp8' });
  const tracks = [...out.stream.getAudioTracks()];
  if (chatState.groupCall.mode === 'video') tracks.push(...canvas.captureStream(SFU_VIDEO.fps).getVideoTracks());
  sender.stream = new MediaStream(tracks);
  const entry = chatState.groupCall.participants.get(fp) || chatState.groupCall.participants.get(groupCallParticipantKey(findPeerByAnyKey(fp)));
  if (entry) { entry.stream = sender.stream; renderGroupCallStage(); }
  return sender;
}

async function receiveSfuFrame(media, buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 5) return;
  const slot = (bytes[0] << 8) | bytes[1];
  const kind = bytes[2];
  const keyFrame = (bytes[3] & 1) === 1;
  const sealed = bytes.subarray(4);
  let header;
  try { header = PoorijaSFrame.decodeHeader(sealed); } catch (_error) { return; }
  const known = media.keysByKid.get(header.kid);
  /* A frame opens only with the key of the member its slot belongs to. */
  if (!known || media.slotToFp.get(slot) !== known.fp) { media.refused += 1; return; }
  if (!media.replay.fresh(header.kid, header.ctr)) { media.refused += 1; return; }
  let opened;
  try {
    opened = await PoorijaSFrame.decryptFrame(async (kid) => (kid === header.kid ? known.keys : null), sealed, sfuFrameMetadata(media, kind, keyFrame, slot));
  } catch (_error) { media.refused += 1; return; }
  /* Only a frame that authenticated moves the window (js/crypto/sframe.js). */
  if (!media.replay.accept(header.kid, header.ctr)) { media.refused += 1; return; }
  const sender = await sfuSenderFor(media, known.fp);
  sender.frames += 1;
  const timestamp = Math.round(performance.now() * 1000);
  try {
    if (kind === SFU_KIND_AUDIO && sender.audioDecoder.state === 'configured') {
      sender.audioDecoder.decode(new EncodedAudioChunk({ type: 'key', timestamp, data: opened.frame }));
    } else if (kind === SFU_KIND_VIDEO && sender.videoDecoder.state === 'configured') {
      if (sender.needKey && !keyFrame) { requestKeyFrameFrom(slot); return; }
      sender.needKey = false;
      sender.videoDecoder.decode(new EncodedVideoChunk({ type: keyFrame ? 'key' : 'delta', timestamp, data: opened.frame }));
    }
  } catch (error) {
    sender.needKey = true;
    console.warn('[SFU] a frame could not be decoded:', error?.message || error);
  }
}

/* ---- the call -------------------------------------------------------------------- */

/* Joins the room named in the invitation (or the one the caller made) with
   the call's local stream. */
async function startSfuMedia(room) {
  if (!room || !sfuSupported() || !groupCallActive()) return false;
  const media = {
    room, ws: null, slot: 0, own: null, keysByKid: new Map(), slotToFp: new Map(),
    senders: new Map(), replay: PoorijaSFrame.createReplayWindow(4096), sent: 0, refused: 0, forceKeyFrame: true,
  };
  chatState.groupCall.sfuMedia = media;
  chatState.groupCall.sfu = room;
  await makeOwnSfuKey(media);
  const ws = new WebSocket(sfuUrlFor(room));
  ws.binaryType = 'arraybuffer';
  media.ws = ws;
  ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', room: room.room, exp: room.exp, cap: room.cap })));
  ws.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') { receiveSfuFrame(media, event.data).catch(() => {}); return; }
    let message;
    try { message = JSON.parse(event.data); } catch (_error) { return; }
    if (message.type === 'welcome') {
      media.slot = message.slot;
      const audience = groupCallAudience();
      if (audience) sendSfuKey(audience);
      startSfuCapture(media, chatState.groupCall.localStream).catch((error) => console.warn('[SFU] capture:', error?.message || error));
    } else if (message.type === 'key-request') {
      media.forceKeyFrame = true;
    } else if (message.type === 'peer-leave') {
      const fp = media.slotToFp.get(message.slot);
      media.slotToFp.delete(message.slot);
      if (fp) stopSfuSender(media, fp);
    }
  });
  ws.addEventListener('close', (event) => {
    if (chatState.groupCall?.sfuMedia !== media) return;
    if (event.code === 4003 || event.code === 4008) notify(t('اتاق تماس گروهی در دسترس نیست.', 'The group call room is not available.'), 'warning');
  });
  return true;
}
function stopSfuSender(media, fp) {
  const sender = media.senders.get(fp);
  if (!sender) return;
  try { sender.audioDecoder?.close(); } catch (_error) { /* closed */ }
  try { sender.videoDecoder?.close(); } catch (_error) { /* closed */ }
  sender.stream?.getTracks().forEach((track) => track.stop());
  media.senders.delete(fp);
  media.senderJobs?.delete(fp);
}
function stopSfuMedia() {
  const media = sfuState();
  if (!media) return;
  try { media.ws?.send(JSON.stringify({ type: 'bye' })); } catch (_error) { /* gone */ }
  try { media.ws?.close(); } catch (_error) { /* gone */ }
  window.clearInterval(media.videoTimer);
  try { media.audioEncoder?.close(); } catch (_error) { /* closed */ }
  try { media.videoEncoder?.close(); } catch (_error) { /* closed */ }
  for (const fp of [...media.senders.keys()]) stopSfuSender(media, fp);
  try { media.audioContext?.close(); } catch (_error) { /* closed */ }
  if (chatState.groupCall) chatState.groupCall.sfuMedia = null;
}

/* What the stage and the tests read. */
function sfuCallStats() {
  const media = sfuState();
  if (!media) return null;
  return {
    slot: media.slot, sent: media.sent, refused: media.refused, kid: media.own?.kid || 0,
    from: Object.fromEntries([...media.senders].map(([fp, s]) => [fp, { frames: s.frames, audio: s.audioFrames || 0, video: s.videoFrames || 0 }])),
  };
}

window.PoorijaSfuCall = { supported: sfuSupported, chooseSfuForCall, startSfuMedia, stopSfuMedia, rotateSfuKey, sendSfuKey, handleSfuKey, stats: sfuCallStats, requestSfuRoom };

/* ---- published to globalThis (roadmap 2.1, tools/esm-chat.cjs) ---- */
Object.defineProperties(globalThis, {
  "SFU_MIN_PEOPLE": { get() { return SFU_MIN_PEOPLE; }, set() { throw new TypeError('Assignment to constant variable SFU_MIN_PEOPLE.'); }, configurable: true },
  "SFU_VIDEO": { get() { return SFU_VIDEO; }, set() { throw new TypeError('Assignment to constant variable SFU_VIDEO.'); }, configurable: true },
  "SFU_KIND_AUDIO": { get() { return SFU_KIND_AUDIO; }, set() { throw new TypeError('Assignment to constant variable SFU_KIND_AUDIO.'); }, configurable: true },
  "SFU_KIND_VIDEO": { get() { return SFU_KIND_VIDEO; }, set() { throw new TypeError('Assignment to constant variable SFU_KIND_VIDEO.'); }, configurable: true },
  "sfuSupported": { get() { return sfuSupported; }, set(value) { sfuSupported = value; }, configurable: true },
  "sfuRoomWaits": { get() { return sfuRoomWaits; }, set() { throw new TypeError('Assignment to constant variable sfuRoomWaits.'); }, configurable: true },
  "settleSfuRoom": { get() { return settleSfuRoom; }, set(value) { settleSfuRoom = value; }, configurable: true },
  "requestSfuRoom": { get() { return requestSfuRoom; }, set(value) { requestSfuRoom = value; }, configurable: true },
  "sfuUrlFor": { get() { return sfuUrlFor; }, set(value) { sfuUrlFor = value; }, configurable: true },
  "sfuFamilyOrigins": { get() { return sfuFamilyOrigins; }, set(value) { sfuFamilyOrigins = value; }, configurable: true },
  "memberReachesSfu": { get() { return memberReachesSfu; }, set(value) { memberReachesSfu = value; }, configurable: true },
  "chooseSfuForCall": { get() { return chooseSfuForCall; }, set(value) { chooseSfuForCall = value; }, configurable: true },
  "sfuFrameMetadata": { get() { return sfuFrameMetadata; }, set(value) { sfuFrameMetadata = value; }, configurable: true },
  "sfuState": { get() { return sfuState; }, set(value) { sfuState = value; }, configurable: true },
  "randomKid": { get() { return randomKid; }, set() { throw new TypeError('Assignment to constant variable randomKid.'); }, configurable: true },
  "makeOwnSfuKey": { get() { return makeOwnSfuKey; }, set(value) { makeOwnSfuKey = value; }, configurable: true },
  "sfuKeyMessage": { get() { return sfuKeyMessage; }, set(value) { sfuKeyMessage = value; }, configurable: true },
  "sendSfuKey": { get() { return sendSfuKey; }, set(value) { sendSfuKey = value; }, configurable: true },
  "rotateSfuKey": { get() { return rotateSfuKey; }, set(value) { rotateSfuKey = value; }, configurable: true },
  "handleSfuKey": { get() { return handleSfuKey; }, set(value) { handleSfuKey = value; }, configurable: true },
  "sendSfuFrame": { get() { return sendSfuFrame; }, set(value) { sendSfuFrame = value; }, configurable: true },
  "startSfuCapture": { get() { return startSfuCapture; }, set(value) { startSfuCapture = value; }, configurable: true },
  "requestKeyFrameFrom": { get() { return requestKeyFrameFrom; }, set(value) { requestKeyFrameFrom = value; }, configurable: true },
  "sfuSenderFor": { get() { return sfuSenderFor; }, set(value) { sfuSenderFor = value; }, configurable: true },
  "makeSfuSender": { get() { return makeSfuSender; }, set(value) { makeSfuSender = value; }, configurable: true },
  "receiveSfuFrame": { get() { return receiveSfuFrame; }, set(value) { receiveSfuFrame = value; }, configurable: true },
  "startSfuMedia": { get() { return startSfuMedia; }, set(value) { startSfuMedia = value; }, configurable: true },
  "stopSfuSender": { get() { return stopSfuSender; }, set(value) { stopSfuSender = value; }, configurable: true },
  "stopSfuMedia": { get() { return stopSfuMedia; }, set(value) { stopSfuMedia = value; }, configurable: true },
  "sfuCallStats": { get() { return sfuCallStats; }, set(value) { sfuCallStats = value; }, configurable: true },
});
