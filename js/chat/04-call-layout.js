/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Part 4 of 36 of the Secure Chat module.
   Split out of the original single-file js/chat.js — see js/chat/README.md.
   These files share one global scope and are loaded in order; the numbering is
   that order and must not be changed.

   How the two pictures are fitted — what FaceTime and Telegram do
*/

/* =====================================================================
   How the two pictures are fitted — what FaceTime and Telegram do
   ---------------------------------------------------------------------
   A phone in portrait sends 9:16, a laptop sends 16:9, and each lands in
   a box shaped like the *other* person's screen. Cropping to fill is
   right when the shapes are close (that is what makes a phone-to-phone
   call look full-screen) and badly wrong when they are not: a 16:9 desk
   shot cropped into a 9:19.5 phone keeps a quarter of the width, which
   is the "why am I so zoomed in" complaint.

   So: measure both, and let the mismatch decide. Close enough -> cover.
   Too far apart -> contain, with a blurred blown-up copy of the same
   picture behind it so the frame is filled without inventing a crop.
   Telegram does exactly this; the alternative is black bars.

   None of it can live in the stylesheet, because the answer depends on
   the incoming track size, which only JavaScript can see.
   ===================================================================== */
const CALL_FIT_TOLERANCE = 1.35;
/* How long a call reaction stays on screen. Paired with the callReactFloat
   keyframes in the stylesheet — change both or neither. */
const CALL_REACTION_MS = 3000;
/* 'blur' reuses the caller's own frame, blown up behind the letterbox;
   'dark' paints a flat surface and moves nothing. */
/* Black by default behind a letterboxed picture.
   Two people on different devices — a phone in portrait talking to a desktop
   in landscape — never share an aspect ratio, so one of them always sees
   filler. Filling it with a blown-up blurred copy of the other person means
   the whole edge of the screen swims every time they move, for the length of
   the call. A flat black surround is what every video player does, and it is
   what this now does unless the blur is explicitly asked for. */
function callBackdropStyle() {
  return chatState.profile?.callBackdrop === 'blur' ? 'blur' : 'dark';
}

function callStageElements() {
  return Array.from(document.querySelectorAll('#chatFloatingCall .chat-remote-stage, #chatFloatingCall .chat-local-stage'));
}
function stagePrimaryVideo(stage) {
  return stage?.querySelector('video:not(.chat-stage-backdrop)') || null;
}

/* The blurred filler. Same MediaStream, second element — the decoder is
   shared, so this costs compositing rather than a second decode. Created only
   when a stage actually needs it and dropped the moment it does not. */
function syncStageBackdrop(stage, stream) {
  let backdrop = stage.querySelector('video.chat-stage-backdrop');
  if (!stream) {
    if (backdrop) {
      backdrop.srcObject = null;
      backdrop.remove();
    }
    return;
  }
  if (!backdrop) {
    backdrop = document.createElement('video');
    backdrop.className = 'chat-stage-backdrop';
    backdrop.autoplay = true;
    backdrop.muted = true;
    backdrop.defaultMuted = true;
    backdrop.playsInline = true;
    backdrop.setAttribute('playsinline', '');
    backdrop.setAttribute('muted', 'muted');
    backdrop.setAttribute('aria-hidden', 'true');
    stage.prepend(backdrop);
  }
  if (backdrop.srcObject !== stream) {
    backdrop.srcObject = stream;
    backdrop.play?.().catch(() => { /* autoplay policy; the main video carries the call */ });
  }
}

function applyCallStageFit(stage) {
  if (!stage) return;
  const video = stagePrimaryVideo(stage);
  const width = Number(video?.videoWidth || 0);
  const height = Number(video?.videoHeight || 0);
  if (!video || !width || !height) {
    stage.removeAttribute('data-fit');
    syncStageBackdrop(stage, null);
    return;
  }
  const videoRatio = width / height;
  stage.style.setProperty('--video-aspect', `${width} / ${height}`);
  nudgeStageWhenAspectChanges(stage);
  stage.dataset.videoOrientation = height > width ? 'portrait' : (width > height ? 'landscape' : 'square');
  /* The small tile is cut to the picture's own shape, so cover crops nothing
     and a portrait selfie never gets squeezed into a landscape thumbnail. */
  if (isCallTile(stage)) {
    stage.dataset.fit = 'cover';
    syncStageBackdrop(stage, null);
    return;
  }
  const boxWidth = stage.clientWidth;
  const boxHeight = stage.clientHeight;
  if (!boxWidth || !boxHeight) return;
  const boxRatio = boxWidth / boxHeight;
  const mismatch = Math.max(boxRatio / videoRatio, videoRatio / boxRatio);
  const fit = mismatch > CALL_FIT_TOLERANCE ? 'contain' : 'cover';
  stage.dataset.fit = fit;
  /* A blown-up blurred copy of a moving picture is motion in the corner of the
     eye for the whole call, and several people find that worse than a plain
     letterbox. 'dark' fills with a flat surface instead. */
  const wantsBackdrop = fit === 'contain' && callBackdropStyle() === 'blur';
  syncStageBackdrop(stage, wantsBackdrop ? video.srcObject : null);
}

function refreshCallLayout() {
  callStageElements().forEach(applyCallStageFit);
}

/* WebKit on iOS lays a <video> out against the box it had when the picture
   first reported a size, and the box changes shape a moment later (the tile is
   cut to the picture's aspect, --video-aspect, only once the first frame has
   said what that is). The result was the self-view with a black margin all the
   way round — the picture drawn at half size in the middle of its own tile —
   until the tile was dragged, because moving it is the only thing that made
   WebKit lay the video out again. This is that, without the finger: a
   one-pixel change of the video's width, forced and taken back, across two
   frames and again a little later. */
function nudgeVideoLayout(video) {
  if (!video) return;
  const kick = () => {
    video.style.setProperty('width', 'calc(100% - 0.5px)', 'important');
    void video.offsetWidth;
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => video.style.removeProperty('width')));
  };
  kick();
  window.setTimeout(kick, 350);
}
function nudgeStageWhenAspectChanges(stage) {
  const aspect = stage?.style.getPropertyValue('--video-aspect') || '';
  if (!stage || stage.dataset.nudgedFor === aspect) return;
  stage.dataset.nudgedFor = aspect;
  nudgeVideoLayout(stagePrimaryVideo(stage));
}

/* The box changes shape on rotation, on a window resize, and when the roles
   swap — every one of those can flip the cover/contain answer. */
function watchCallStageSize() {
  const stage = document.querySelector('#chatFloatingCall .chat-floating-call-stage');
  if (!stage || stage.dataset.sizeWatched || typeof ResizeObserver !== 'function') return;
  stage.dataset.sizeWatched = '1';
  new ResizeObserver(resizeObserverFrame(() => refreshCallLayout())).observe(stage);
}

/* FaceTime's self-view: drag it anywhere, it snaps to the nearest corner, and
   a tap (as opposed to a drag) swaps the two feeds. */
function bindCallSelfViewGestures() {
  /* Either box can be the small one — swapping the primary view swaps which —
     so both get the drag/tap treatment and the CSS decides who is a tile. */
  document.querySelectorAll('#chatFloatingCall .chat-local-stage, #chatFloatingCall .chat-remote-stage')
    .forEach(bindCallTileGestures);
}
function bindCallTileGestures(tile) {
  const stage = document.querySelector('#chatFloatingCall .chat-floating-call-stage');
  if (!tile || !stage || tile.dataset.gesturesBound) return;
  tile.dataset.gesturesBound = '1';
  let dragging = false;
  let moved = 0;
  let startX = 0;
  let startY = 0;
  let originX = 0;
  let originY = 0;

  const corners = () => {
    const stageBox = stage.getBoundingClientRect();
    const tileBox = tile.getBoundingClientRect();
    const pad = 14;
    return {
      'top-start': { x: pad, y: pad },
      'top-end': { x: stageBox.width - tileBox.width - pad, y: pad },
      'bottom-start': { x: pad, y: stageBox.height - tileBox.height - pad },
      'bottom-end': { x: stageBox.width - tileBox.width - pad, y: stageBox.height - tileBox.height - pad },
    };
  };
  const place = (x, y) => {
    tile.style.setProperty('--self-x', `${x}px`);
    tile.style.setProperty('--self-y', `${y}px`);
  };
  const snap = (x, y) => {
    const spots = corners();
    let best = null;
    let bestDistance = Infinity;
    Object.values(spots).forEach((spot) => {
      const distance = ((spot.x - x) ** 2) + ((spot.y - y) ** 2);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = spot;
      }
    });
    if (!best) return;
    tile.classList.add('is-snapping');
    place(best.x, best.y);
    window.setTimeout(() => tile.classList.remove('is-snapping'), 220);
  };

  tile.addEventListener('pointerdown', (event) => {
    if (event.button != null && event.button !== 0) return;
    if (!isCallTile(tile)) return;
    dragging = true;
    moved = 0;
    startX = event.clientX;
    startY = event.clientY;
    const stageBox = stage.getBoundingClientRect();
    const tileBox = tile.getBoundingClientRect();
    originX = tileBox.left - stageBox.left;
    originY = tileBox.top - stageBox.top;
    capturePointerSafely(tile, event.pointerId);
    tile.classList.add('is-dragging');
  });
  tile.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
    place(originX + dx, originY + dy);
  });
  const finish = (event) => {
    if (!dragging) return;
    dragging = false;
    tile.classList.remove('is-dragging');
    releasePointerSafely(tile, event.pointerId);
    const stageBox = stage.getBoundingClientRect();
    const tileBox = tile.getBoundingClientRect();
    if (moved < 6) {
      /* A tap, not a drag — swap which feed is the big one. Only the small
         tile responds; tapping the full-bleed video toggles the chrome. */
      if (isCallTile(tile)) document.getElementById('chatSwapVideoLayoutBtn')?.click();
      return;
    }
    snap(tileBox.left - stageBox.left, tileBox.top - stageBox.top);
  };
  tile.addEventListener('pointerup', finish);
  tile.addEventListener('pointercancel', finish);
}

/* The rings around the avatar follow the remote speaker's actual level, which
   is the cue Telegram uses to show a voice call is live rather than frozen. */
function startCallLevelMeter(stream) {
  stopCallLevelMeter();
  if (!stream?.getAudioTracks?.().length) return;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  try {
    const context = new AudioContextClass();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.75;
    source.connect(analyser);
    const buffer = new Uint8Array(analyser.frequencyBinCount);
    const hero = document.querySelector('#chatFloatingCall .chat-call-hero');
    const tick = () => {
      if (!chatState.callLevelMeter) return;
      analyser.getByteFrequencyData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) sum += buffer[i];
      const level = Math.min(1, (sum / buffer.length) / 90);
      hero?.style.setProperty('--call-level', level.toFixed(3));
      chatState.callLevelFrame = requestAnimationFrame(tick);
    };
    chatState.callLevelMeter = { context, source, analyser };
    chatState.callLevelFrame = requestAnimationFrame(tick);
  } catch (error) {
    console.warn('[Call] level meter unavailable', error);
  }
}

function stopCallLevelMeter() {
  if (chatState.callLevelFrame) cancelAnimationFrame(chatState.callLevelFrame);
  chatState.callLevelFrame = 0;
  const meter = chatState.callLevelMeter;
  chatState.callLevelMeter = null;
  if (!meter) return;
  try {
    meter.source.disconnect();
    meter.analyser.disconnect();
    meter.context.close?.();
  } catch (_error) { /* already torn down */ }
  document.querySelector('#chatFloatingCall .chat-call-hero')?.style.setProperty('--call-level', '0');
}

/* Name and status live on the hero for voice calls, where there is no video to
   carry them; the header keeps its own copy for the video layout. */
function syncCallHeroCopy() {
  const nameEl = document.getElementById('chatCallHeroName');
  const statusEl = document.getElementById('chatCallHeroStatus');
  if (!nameEl || !statusEl) return;
  nameEl.textContent = document.getElementById('chatFloatingCallTitle')?.textContent || '';
  const status = document.getElementById('chatFloatingCallStatus')?.textContent || '';
  const duration = document.getElementById('chatCallDuration');
  const durationText = duration && !duration.classList.contains('hidden') ? duration.textContent : '';
  statusEl.textContent = durationText || status;
}

/* ---- published to globalThis (roadmap 2.1, tools/esm-chat.cjs) ---- */
Object.defineProperties(globalThis, {
  "CALL_FIT_TOLERANCE": { get() { return CALL_FIT_TOLERANCE; }, set() { throw new TypeError('Assignment to constant variable CALL_FIT_TOLERANCE.'); }, configurable: true },
  "CALL_REACTION_MS": { get() { return CALL_REACTION_MS; }, set() { throw new TypeError('Assignment to constant variable CALL_REACTION_MS.'); }, configurable: true },
  "callBackdropStyle": { get() { return callBackdropStyle; }, set(value) { callBackdropStyle = value; }, configurable: true },
  "callStageElements": { get() { return callStageElements; }, set(value) { callStageElements = value; }, configurable: true },
  "stagePrimaryVideo": { get() { return stagePrimaryVideo; }, set(value) { stagePrimaryVideo = value; }, configurable: true },
  "syncStageBackdrop": { get() { return syncStageBackdrop; }, set(value) { syncStageBackdrop = value; }, configurable: true },
  "applyCallStageFit": { get() { return applyCallStageFit; }, set(value) { applyCallStageFit = value; }, configurable: true },
  "refreshCallLayout": { get() { return refreshCallLayout; }, set(value) { refreshCallLayout = value; }, configurable: true },
  "nudgeVideoLayout": { get() { return nudgeVideoLayout; }, set(value) { nudgeVideoLayout = value; }, configurable: true },
  "nudgeStageWhenAspectChanges": { get() { return nudgeStageWhenAspectChanges; }, set(value) { nudgeStageWhenAspectChanges = value; }, configurable: true },
  "watchCallStageSize": { get() { return watchCallStageSize; }, set(value) { watchCallStageSize = value; }, configurable: true },
  "bindCallSelfViewGestures": { get() { return bindCallSelfViewGestures; }, set(value) { bindCallSelfViewGestures = value; }, configurable: true },
  "bindCallTileGestures": { get() { return bindCallTileGestures; }, set(value) { bindCallTileGestures = value; }, configurable: true },
  "startCallLevelMeter": { get() { return startCallLevelMeter; }, set(value) { startCallLevelMeter = value; }, configurable: true },
  "stopCallLevelMeter": { get() { return stopCallLevelMeter; }, set(value) { stopCallLevelMeter = value; }, configurable: true },
  "syncCallHeroCopy": { get() { return syncCallHeroCopy; }, set(value) { syncCallHeroCopy = value; }, configurable: true },
});
