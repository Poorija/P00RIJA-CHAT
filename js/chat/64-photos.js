/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* ============================================================================
   Photos: sent as pictures, looked at, and changed.
   ============================================================================

   A picture used to be a file. It went out as one, arrived as one — a shield,
   a name, a Download button — and nobody who has used a messenger expects to
   press Download to see what a friend just sent.

   WHAT A PHOTO IS ON THE WIRE
   ---------------------------
   Nothing new. A photo is a file message (type 'file', the same chunked,
   encrypted transfer, the same vault entry, the same forward, search and
   export paths) with `photo: true`, its size in `mediaWidth` and
   `mediaHeight`, and an optional `caption` riding in the same message. An
   older build, or the parent app, shows it as the file it always was. A flag
   is what makes this safe: the vault, the group permissions, view-once and the
   self-destruct preview are all keyed on 'file', and none of them has to learn
   about a new type.

   WHAT DECIDES IT IS A PICTURE
   ----------------------------
   The sender says so, and the receiver does not take its word: the bytes are
   looked at (jpeg, png, webp or gif — never SVG, whatever the name or the
   announced type) before an <img> is drawn, and a file that fails the look is
   drawn as a file. A self-destruct or view-once picture keeps its existing,
   unsavable preview.

   THE THREE WAYS IN
   -----------------
     Photos (the gallery button): the stills go as photos — redrawn through a
       canvas at up to 2560 px, which is also where the camera, the place and
       the time stored inside the file end — after a sheet that lets the sender
       turn, crop and adjust them, add a caption, or send the originals as
       files instead. A GIF is never redrawn: it would stop moving.
     File (the paperclip, or File in the sheet): the file at its original size
       and quality. Nothing here redraws it; the app's own metadata cleaning,
       when it is switched on, still applies to it as to every file.
     Profile picture: tapping it looks at it first (save, edit, change).

   Everything is drawn with canvas and nothing is fetched: the page's content
   security policy allows blob: and data: images and nothing more.
   ============================================================================ */

const PHOTO_MAX_SIDE = 2560;
const PHOTO_EDIT_SOURCE_SIDE = 4096;
const PHOTO_JPEG_QUALITY = 0.86;
const PHOTO_CAPTION_MAX = 1000;
const PHOTO_NAME_PATTERN = /\.(png|jpe?g|webp|gif|avif|bmp|heic|heif)$/i;

/* What the bytes of each picture entry turned out to be: 'ok', 'bad' or
   'pending'. Asked once per entry, answered from the vault's own copy. */
const photoVerdicts = new Map();

function photoText(fa, en) {
  return typeof t === 'function' ? t(fa, en) : en;
}
function photoEsc(value) {
  return app().escapeHTML(String(value ?? ''));
}

/* ---- is it a picture ------------------------------------------------------ */

function looksLikePhotoFile(file) {
  if (!file) return false;
  if (/svg/i.test(file.type || '') || /\.svg$/i.test(file.name || '')) return false;
  return /^image\/(png|jpe?g|webp|gif|avif|bmp|heic|heif)$/i.test(file.type || '') || PHOTO_NAME_PATTERN.test(file.name || '');
}

/* From the first bytes of a file, never from its name or announced type. */
function sniffPhotoBytes(bytes) {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  return '';
}
async function sniffPhotoBlob(blob) {
  try {
    return sniffPhotoBytes(new Uint8Array(await blob.slice(0, 16).arrayBuffer()));
  } catch (_error) {
    return '';
  }
}

async function verifyPhotoEntry(entry) {
  if (!entry?.id || photoVerdicts.has(entry.id)) return;
  photoVerdicts.set(entry.id, 'pending');
  let verdict = 'bad';
  try {
    const blob = await (await fetch(entry.downloadUrl)).blob();
    if (await sniffPhotoBlob(blob)) verdict = 'ok';
  } catch (_error) { /* a dead URL: the bubble falls back to the file card */ }
  photoVerdicts.set(entry.id, verdict);
  if (chatState.history?.[chatState.activeConversationId]?.some((item) => item.id === entry.id)) renderMessages();
}

/* ---- the bubble ----------------------------------------------------------- */

/* The inside of a photo's bubble, or '' when the entry is to be drawn as the
   file it also is. */
function photoBubbleBody(entry) {
  if (!entry || entry.type !== 'file' || !entry.photo) return '';
  /* A self-destruct or view-once picture is meant not to be kept: it keeps
     its own preview, which cannot be saved. */
  if (Number(entry.timerSeconds || 0) > 0 || entry.viewOnce) return '';
  const width = Number(entry.mediaWidth) || 0;
  const height = Number(entry.mediaHeight) || 0;
  const ratio = width && height ? Math.min(2.4, Math.max(0.45, width / height)) : 1.33;
  const caption = typeof entry.caption === 'string' && entry.caption
    ? `<div class="chat-photo-caption" dir="auto">${photoEsc(entry.caption)}</div>` : '';
  const url = typeof safeMediaUrl === 'function' ? safeMediaUrl(entry.downloadUrl) : '';
  if (!url) {
    /* Not hydrated from the vault yet is a picture on its way; gone for good is
       a file that says so. */
    if (entry.mediaMissing) return '';
    return `<div class="chat-photo is-loading" style="--ar:${ratio}" aria-hidden="true"></div>${caption}`;
  }
  const verdict = photoVerdicts.get(entry.id);
  if (verdict === 'bad') return '';
  if (verdict !== 'ok') {
    verifyPhotoEntry(entry);
    return `<div class="chat-photo is-loading" style="--ar:${ratio}" aria-hidden="true"></div>${caption}`;
  }
  const label = photoText('باز کردن عکس', 'Open the photo');
  return `<button type="button" class="chat-photo" data-chat-photo="${photoEsc(entry.id)}" style="--ar:${ratio}" aria-label="${photoEsc(label)}"><img src="${photoEsc(url)}" alt="" draggable="false" decoding="async"></button>${caption}`;
}

/* ---- a video sent as a video --------------------------------------------- */

const VIDEO_NAME_PATTERN = /\.(mp4|m4v|mov|webm|3gp|mkv)$/i;
function looksLikeVideoFile(file) {
  if (!file) return false;
  return /^video\//i.test(file.type || '') || VIDEO_NAME_PATTERN.test(file.name || '');
}
/* The video's first frame, size and length, read on this device before it is
   sent; null when the browser cannot play it (it then goes as a file). */
/* A still for a video the browser here could not open (an iPhone's HEVC .mov
   in a browser without that codec): dark, with a play mark. */
async function placeholderPoster() {
  const canvas = canvasOf(320, 180);
  const g = canvas.getContext('2d');
  g.fillStyle = '#111'; g.fillRect(0, 0, 320, 180);
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.beginPath(); g.moveTo(146, 70); g.lineTo(146, 110); g.lineTo(180, 90); g.closePath(); g.fill();
  return URL.createObjectURL(await canvasToBlob(canvas, 'image/jpeg', 0.8));
}
/* The video's size, length and a still, read on this device before it is
   sent. A video is sent as a video whatever this answers: iOS Safari fires
   no loadeddata on a video that is not playing (only loadedmetadata), and a
   browser without the codec reads nothing at all, and both used to send the
   video as a file. Unknown size and length are sent as 0. */
async function probeVideo(file, { posterSide = 720 } = {}) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  const wait = (events, ms) => new Promise((resolve) => {
    const timer = setTimeout(() => done(false), ms);
    const done = (ok) => { clearTimeout(timer); events.forEach((name) => video.removeEventListener(name, yes)); video.removeEventListener('error', no); resolve(ok); };
    const yes = () => done(true);
    const no = () => done(false);
    events.forEach((name) => video.addEventListener(name, yes, { once: true }));
    video.addEventListener('error', no, { once: true });
  });
  try {
    video.muted = true; video.playsInline = true; video.setAttribute('playsinline', ''); video.preload = 'auto'; video.src = url;
    try { video.load(); } catch (_error) { /* some engines load on src */ }
    const meta = await wait(['loadedmetadata'], 8000);
    const width = meta ? (video.videoWidth || 0) : 0;
    const height = meta ? (video.videoHeight || 0) : 0;
    /* A WebM straight from a recorder carries no length (Infinity) until the
       player has been sent past its end once. */
    if (meta && !Number.isFinite(video.duration)) {
      const back = wait(['durationchange'], 3000);
      try { video.currentTime = 1e9; } catch (_error) { /* no seeking */ }
      await back;
    }
    const durationMs = meta && Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0;
    let poster = '';
    if (width && height) {
      try {
        const seeked = wait(['seeked', 'loadeddata'], 2500);
        video.currentTime = Math.min(0.1, (Number.isFinite(video.duration) ? video.duration : 1) / 2);
        await seeked;
        const scale = Math.min(1, posterSide / Math.max(width, height));
        const canvas = canvasOf(Math.round(width * scale), Math.round(height * scale));
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        poster = URL.createObjectURL(await canvasToBlob(canvas, 'image/jpeg', 0.8));
      } catch (_error) { poster = ''; }
    }
    return { width, height, durationMs, poster: poster || await placeholderPoster(), readable: Boolean(width && height) };
  } catch (_error) {
    return { width: 0, height: 0, durationMs: 0, poster: await placeholderPoster(), readable: false };
  } finally {
    try { video.removeAttribute('src'); video.load(); } catch (_error) { /* gone */ }
    URL.revokeObjectURL(url);
  }
}
function formatVideoLength(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600); const m = Math.floor((total % 3600) / 60); const sec = total % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}
/* The inside of a video's bubble: the video itself, playing in the thread
   with its own controls (inline, muted until the person turns the sound on),
   its length in the corner. '' for anything that stays a file card. */
function videoBubbleBody(entry) {
  if (!entry || entry.type !== 'file' || !entry.video) return '';
  if (Number(entry.timerSeconds || 0) > 0 || entry.viewOnce) return '';
  const width = Number(entry.mediaWidth) || 0;
  const height = Number(entry.mediaHeight) || 0;
  const ratio = width && height ? Math.min(2.4, Math.max(0.45, width / height)) : 1.78;
  const caption = typeof entry.caption === 'string' && entry.caption
    ? `<div class="chat-photo-caption" dir="auto">${photoEsc(entry.caption)}</div>` : '';
  const url = typeof safeMediaUrl === 'function' ? safeMediaUrl(entry.downloadUrl) : '';
  if (!url) {
    if (entry.mediaMissing) return '';
    return `<div class="chat-photo chat-video is-loading" style="--ar:${ratio}" aria-hidden="true"></div>${caption}`;
  }
  const length = entry.durationMs ? `<span class="chat-video-length">${photoEsc(formatVideoLength(entry.durationMs))}</span>` : '';
  /* In the thread it is a still with a play button, as in Telegram and
     WhatsApp; a tap opens it full screen in the app's own player. The
     browser's own full screen is never used: on Android it recreates the
     app's window, which locked the app and asked for the fingerprint again. */
  const label = photoText('پخش ویدیو', 'Play the video');
  return `<button type="button" class="chat-photo chat-video" data-chat-video="${photoEsc(entry.id)}" style="--ar:${ratio}" aria-label="${photoEsc(label)}"><video src="${photoEsc(url)}#t=0.1" preload="metadata" playsinline muted disablepictureinpicture tabindex="-1" aria-hidden="true"></video><span class="chat-video-play" aria-hidden="true"><i class="fas fa-play"></i></span>${length}</button>${caption}`;
}

/* ---- the video player ----------------------------------------------------- */

let videoViewer = null;
function closeVideoViewer() {
  if (!videoViewer) return;
  const { root, video, onKey } = videoViewer;
  videoViewer = null;
  try { video.pause(); video.removeAttribute('src'); video.load(); } catch (_error) { /* gone */ }
  document.removeEventListener('keydown', onKey, true);
  root.classList.remove('is-open');
  root.classList.add('is-closing');
  setTimeout(() => root.remove(), 180);
}
async function saveVideo(entry) {
  let blob = null;
  try { blob = await (await fetch(entry.downloadUrl)).blob(); } catch (_error) { blob = null; }
  if (!blob) { notify(photoText('ویدیو خوانده نشد.', 'The video could not be read.'), 'error'); return; }
  const name = String(entry.name || '') || `video-${Date.now()}.mp4`;
  /* As for a photo: on a phone, the share sheet is where "Save video" is. */
  if (photoIsTouch() && typeof navigator.canShare === 'function') {
    const file = new File([blob], name, { type: blob.type || entry.mime || 'video/mp4' });
    try {
      if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return; }
    } catch (error) {
      if (error?.name === 'AbortError') return;
    }
  }
  chatDownloadBlob(blob, name);
  notify(photoText('ویدیو ذخیره شد.', 'Video saved.'), 'success');
}
function openVideoEntry(entryId) {
  const list = chatState.history?.[chatState.activeConversationId] || [];
  const entry = list.find((item) => item && item.id === entryId);
  const url = entry && typeof safeMediaUrl === 'function' ? safeMediaUrl(entry.downloadUrl) : '';
  if (!entry || !url) return;
  closeVideoViewer();
  const root = document.createElement('div');
  root.className = 'pv pv-video';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', photoText('ویدیو', 'Video'));
  root.tabIndex = -1;
  const who = entry.direction === 'out' ? photoText('شما', 'You') : (entry.senderName || activePeer?.()?.username || '');
  const when = entry.createdAt ? new Date(entry.createdAt).toLocaleString(photoText('fa-IR', 'en-GB'), { dateStyle: 'medium', timeStyle: 'short' }) : '';
  root.innerHTML = `
    <div class="pv-top">
      <button type="button" class="pv-btn" data-pvv="close" aria-label="${photoEsc(photoText('بستن', 'Close'))}"><i class="fas fa-xmark" aria-hidden="true"></i></button>
      <div class="pv-title"><strong>${photoEsc(who)}</strong><span>${photoEsc(when)}</span></div>
      <button type="button" class="pv-btn" data-pvv="save" aria-label="${photoEsc(photoText('ذخیرهٔ ویدیو', 'Save video'))}" title="${photoEsc(photoText('ذخیرهٔ ویدیو', 'Save video'))}"><i class="fas fa-download" aria-hidden="true"></i></button>
    </div>
    <div class="pv-stage pv-video-stage"><video class="pv-video-el" playsinline controls autoplay controlslist="nofullscreen nodownload noremoteplayback" disablepictureinpicture disableremoteplayback></video></div>
    ${entry.caption ? `<div class="pv-bottom"><div class="pv-caption" dir="auto">${photoEsc(entry.caption)}</div></div>` : ''}`;
  document.body.appendChild(root);
  const video = root.querySelector('video');
  video.src = url;
  /* A double tap on the picture would ask the browser for full screen. */
  video.addEventListener('dblclick', (event) => { event.preventDefault(); event.stopPropagation(); }, true);
  video.addEventListener('error', () => notify(photoText('این ویدیو روی این دستگاه پخش نمی‌شود؛ با دکمهٔ ذخیره آن را بردارید.', 'This video does not play on this device; save it with the button above.'), 'warning'));
  const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeVideoViewer(); } };
  document.addEventListener('keydown', onKey, true);
  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-pvv]');
    if (!button) return;
    if (button.dataset.pvv === 'close') closeVideoViewer();
    else if (button.dataset.pvv === 'save') saveVideo(entry);
  });
  videoViewer = { root, video, onKey, entryId };
  requestAnimationFrame(() => { root.classList.add('is-open'); root.focus({ preventScroll: true }); });
  video.play?.().catch(() => { /* the person presses play */ });
}
document.addEventListener('click', (event) => {
  const button = event.target.closest?.('[data-chat-video]');
  if (!button || chatState.selectionMode) return;
  event.preventDefault();
  event.stopPropagation();
  if (Date.now() < mediaHeldUntil) return;
  openVideoEntry(button.getAttribute('data-chat-video'));
}, true);

/* An album: up to 25 pictures and videos sent together arrive as as many
   messages (each its own transfer, each reactable and deletable), and are
   drawn as one grid. Adjacent bubbles of one album, from one side, are moved
   into a wrapper; the last keeps its time and ticks under the grid. */
const ALBUM_MAX = 25;
function groupAlbumBubbles(panel) {
  const bubbles = [...panel.querySelectorAll(':scope > .chat-message-bubble[data-album]')];
  let run = [];
  const flush = () => {
    if (run.length >= 2) {
      const wrap = document.createElement('div');
      const first = run[0];
      wrap.className = `chat-album ${first.classList.contains('me') ? 'is-out' : 'is-in'}`;
      wrap.dataset.albumSize = String(Math.min(run.length, 10));
      wrap.style.setProperty('--album-n', String(run.length));
      first.before(wrap);
      run.forEach((bubble, index) => {
        wrap.appendChild(bubble);
        /* The meta carries an inline display (27-message-render.js), which a
           stylesheet cannot override: the time is said once, under the last. */
        if (index < run.length - 1) bubble.querySelector(':scope > .chat-message-meta')?.style.setProperty('display', 'none', 'important');
      });
    }
    run = [];
  };
  for (const bubble of bubbles) {
    const prev = run[run.length - 1];
    const same = prev && prev.dataset.album === bubble.dataset.album && prev.nextElementSibling === bubble
      && prev.classList.contains('me') === bubble.classList.contains('me');
    if (!same) flush();
    run.push(bubble);
  }
  flush();
}

/* A picture entry of the open conversation that can be looked at now. */
function photoEntriesOfActiveConversation() {
  const list = chatState.history?.[chatState.activeConversationId] || [];
  return list.filter((entry) => entry && entry.type === 'file' && entry.photo
    && !(Number(entry.timerSeconds || 0) > 0) && !entry.viewOnce
    && entry.downloadUrl && photoVerdicts.get(entry.id) === 'ok');
}

function photoItemOf(entry) {
  return {
    id: entry.id,
    url: entry.downloadUrl,
    name: photoFileName(entry),
    caption: entry.caption || '',
    at: entry.createdAt || '',
    own: entry.direction === 'out',
    who: entry.direction === 'out' ? photoText('شما', 'You') : (entry.senderName || activePeer()?.username || ''),
    entryId: entry.id,
  };
}
function photoFileName(entry) {
  const stamp = String(entry?.createdAt || new Date().toISOString()).replace(/[^0-9]/g, '').slice(0, 14) || String(Date.now());
  const original = String(entry?.name || '');
  const ext = (/\.(png|jpe?g|webp|gif)$/i.exec(original) || [])[0] || '.jpg';
  return /^photo-/i.test(original) ? original : `photo-${stamp}${ext.toLowerCase()}`;
}

function openPhotoEntry(entryId) {
  const photos = photoEntriesOfActiveConversation();
  const index = photos.findIndex((entry) => entry.id === entryId);
  if (index < 0) return;
  openPhotoViewer({ items: photos.map(photoItemOf), index, kind: 'chat' });
}

/* A tap on a photo. Not while messages are being picked: a tap then means
   "this one too". A press held on it (or a right click) is the message's
   own menu instead, with the reactions, as on any other message: the tap that
   opens the viewer used to stop every click on the picture, so a photo could
   not be reacted to at all. */
let mediaHoldTimer = 0;
let mediaHeldUntil = 0;
function openMediaToolbar(target) {
  const bubble = target.closest?.('.chat-message-bubble');
  if (!bubble || typeof bubble.onclick !== 'function') return false;
  mediaHeldUntil = Date.now() + 700;
  bubble.onclick({ target: bubble });
  return true;
}
document.addEventListener('pointerdown', (event) => {
  const media = event.target.closest?.('[data-chat-photo], [data-chat-video]');
  window.clearTimeout(mediaHoldTimer);
  if (!media || event.pointerType === 'mouse' || chatState.selectionMode) return;
  const x = event.clientX; const y = event.clientY;
  const cancel = (move) => {
    if (move && Math.hypot(move.clientX - x, move.clientY - y) < 10) return;
    window.clearTimeout(mediaHoldTimer);
    document.removeEventListener('pointermove', cancel, true);
  };
  document.addEventListener('pointermove', cancel, true);
  document.addEventListener('pointerup', () => cancel(), { once: true, capture: true });
  mediaHoldTimer = window.setTimeout(() => openMediaToolbar(media), 450);
}, true);
document.addEventListener('contextmenu', (event) => {
  const media = event.target.closest?.('[data-chat-photo], [data-chat-video]');
  if (!media || chatState.selectionMode) return;
  event.preventDefault();
  openMediaToolbar(media);
}, true);
document.addEventListener('click', (event) => {
  const button = event.target.closest?.('[data-chat-photo]');
  if (!button) return;
  if (chatState.selectionMode) return;
  event.preventDefault();
  event.stopPropagation();
  if (Date.now() < mediaHeldUntil) return;
  openPhotoEntry(button.getAttribute('data-chat-photo'));
}, true);

/* ---- saving and sharing --------------------------------------------------- */

const photoIsTouch = () => {
  try { return window.matchMedia('(pointer: coarse)').matches; } catch (_error) { return false; }
};

async function photoBlobOf(url) {
  return (await fetch(url)).blob();
}
async function savePhoto(item) {
  let blob;
  try { blob = await photoBlobOf(item.url); } catch (_error) { blob = null; }
  if (!blob) { notify(photoText('عکس خوانده نشد.', 'The photo could not be read.'), 'error'); return; }
  const name = item.name || 'photo.jpg';
  /* On a phone the share sheet is where "Save Image" lives; a download of a
     blob from an installed web app is not reliably a save at all. */
  if (photoIsTouch() && typeof navigator.canShare === 'function') {
    const file = new File([blob], name, { type: blob.type || 'image/jpeg' });
    try {
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        return;
      }
    } catch (error) {
      if (error?.name === 'AbortError') return;
    }
  }
  chatDownloadBlob(blob, name);
  notify(photoText('عکس ذخیره شد.', 'Photo saved.'), 'success');
}
async function sharePhoto(item) {
  let blob;
  try { blob = await photoBlobOf(item.url); } catch (_error) { blob = null; }
  if (!blob) return;
  const file = new File([blob], item.name || 'photo.jpg', { type: blob.type || 'image/jpeg' });
  try {
    if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) await navigator.share({ files: [file] });
  } catch (error) {
    if (error?.name !== 'AbortError') console.warn('[Photos] share failed:', error);
  }
}
const photoCanShare = () => typeof navigator.canShare === 'function'
  && (() => { try { return navigator.canShare({ files: [new File([new Uint8Array(1)], 'x.jpg', { type: 'image/jpeg' })] }); } catch (_error) { return false; } })();

/* ---- the viewer ----------------------------------------------------------- */

let photoViewer = null;

function closePhotoViewer() {
  if (!photoViewer) return;
  const { root, onKey, restore } = photoViewer;
  document.removeEventListener('keydown', onKey, true);
  root.classList.add('is-closing');
  window.setTimeout(() => root.remove(), 160);
  photoViewer = null;
  try { restore?.focus?.(); } catch (_error) { /* gone */ }
}

/* items: { id, url, name, caption, at, own, who, entryId }[] — kind: 'chat' or 'avatar'.
   The viewer owns the gestures (swipe between, pinch, double-tap, drag down to
   close) and a bar of what can be done with the picture in front of it. */
function openPhotoViewer({ items, index = 0, kind = 'chat', onChange = null, onRemove = null }) {
  if (!Array.isArray(items) || !items.length) return;
  closePhotoViewer();
  const root = document.createElement('div');
  root.id = 'photoViewer';
  root.className = 'pv';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', photoText('نمایش عکس', 'Photo viewer'));
  root.tabIndex = -1;
  const canShare = photoCanShare();
  const actions = [
    /* fa-download: the vendored Font Awesome (free) has no arrow-down-to-bracket, and the button drew a word with no picture. */
    { id: 'save', icon: 'fa-download', label: photoText('ذخیره', 'Save') },
    ...(canShare ? [{ id: 'share', icon: 'fa-arrow-up-from-bracket', label: photoText('اشتراک', 'Share') }] : []),
    ...(kind === 'chat' || kind === 'avatar' ? [{ id: 'edit', icon: 'fa-crop-simple', label: photoText('ویرایش', 'Edit') }] : []),
    ...(kind === 'chat' ? [{ id: 'forward', icon: 'fa-share', label: photoText('هدایت', 'Forward') }] : []),
    ...(kind === 'avatar' ? [{ id: 'change', icon: 'fa-camera', label: photoText('تغییر', 'Change') }] : []),
    ...(kind === 'avatar' && onRemove ? [{ id: 'remove', icon: 'fa-trash', label: photoText('حذف', 'Remove'), danger: true }] : []),
  ];
  root.innerHTML = `
    <div class="pv-top">
      <button type="button" class="pv-btn" data-pv="close" aria-label="${photoEsc(photoText('بستن', 'Close'))}"><i class="fas fa-xmark" aria-hidden="true"></i></button>
      <div class="pv-title"><strong data-pv-who></strong><span data-pv-when></span></div>
      <span class="pv-spacer"></span>
    </div>
    <div class="pv-stage"><img class="pv-img" alt="" draggable="false"></div>
    <div class="pv-bottom">
      <div class="pv-caption" data-pv-caption dir="auto"></div>
      <div class="pv-bar">${actions.map((action) => `<button type="button" class="pv-act${action.danger ? ' is-danger' : ''}" data-pv="${action.id}"><i class="fas ${action.icon}" aria-hidden="true"></i><span>${photoEsc(action.label)}</span></button>`).join('')}</div>
    </div>`;
  document.body.appendChild(root);
  const stage = root.querySelector('.pv-stage');
  const img = root.querySelector('.pv-img');
  const view = { s: 1, x: 0, y: 0 };
  let at = Math.min(Math.max(0, index), items.length - 1);
  let chromeHidden = false;

  const paint = () => { img.style.transform = `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.s})`; };
  const fit = () => {
    const box = stage.getBoundingClientRect();
    const nw = img.naturalWidth || 1; const nh = img.naturalHeight || 1;
    const k = Math.min(box.width / nw, box.height / nh);
    return { w: nw * k, h: nh * k, bw: box.width, bh: box.height };
  };
  const clampPan = () => {
    const f = fit();
    const maxX = Math.max(0, (f.w * view.s - f.bw) / 2);
    const maxY = Math.max(0, (f.h * view.s - f.bh) / 2);
    view.x = Math.max(-maxX, Math.min(maxX, view.x));
    view.y = Math.max(-maxY, Math.min(maxY, view.y));
  };
  const reset = (animate) => {
    img.style.transition = animate ? 'transform 220ms cubic-bezier(0.32, 0.72, 0, 1)' : 'none';
    view.s = 1; view.x = 0; view.y = 0; paint();
  };
  const when = (value) => {
    if (!value) return '';
    try { return new Intl.DateTimeFormat(photoText('fa-IR', 'en-GB'), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); } catch (_error) { return ''; }
  };
  const show = (next, direction = 0) => {
    at = Math.min(Math.max(0, next), items.length - 1);
    const item = items[at];
    img.style.transition = 'none';
    img.src = item.url;
    view.s = 1; view.x = direction * 60; view.y = 0; paint();
    if (direction) requestAnimationFrame(() => { img.style.transition = 'transform 220ms cubic-bezier(0.32, 0.72, 0, 1)'; view.x = 0; paint(); });
    root.querySelector('[data-pv-who]').textContent = item.who || '';
    const count = items.length > 1 ? `${at + 1} / ${items.length}` : '';
    root.querySelector('[data-pv-when]').textContent = [count, when(item.at)].filter(Boolean).join(' · ');
    const cap = root.querySelector('[data-pv-caption]');
    cap.textContent = item.caption || '';
    cap.hidden = !item.caption;
    const neighbour = items[at + 1] || items[at - 1];
    if (neighbour) { const warm = new Image(); warm.src = neighbour.url; }
    onChange?.(item, at);
  };
  const step = (delta) => {
    if (at + delta < 0 || at + delta >= items.length) { reset(true); return; }
    show(at + delta, delta > 0 ? 1 : -1);
  };

  /* -- gestures: one finger pans or swipes, two pinch, a double tap zooms -- */
  const pointers = new Map();
  let pinch = null;
  let drag = null;
  let lastTap = { t: 0, x: 0, y: 0 };
  stage.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    stage.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    img.style.transition = 'none';
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: view.s, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, x: view.x, y: view.y };
      drag = null;
    } else if (pointers.size === 1) {
      drag = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, t: Date.now(), moved: 0, mode: '' };
    }
  });
  stage.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      view.s = Math.max(1, Math.min(6, pinch.s * d / pinch.d));
      view.x = pinch.x + ((a.x + b.x) / 2 - pinch.mx);
      view.y = pinch.y + ((a.y + b.y) / 2 - pinch.my);
      clampPan(); paint();
      return;
    }
    if (!drag) return;
    const dx = event.clientX - drag.x; const dy = event.clientY - drag.y;
    drag.moved = Math.max(drag.moved, Math.hypot(dx, dy));
    if (view.s > 1.02) { view.x = drag.vx + dx; view.y = drag.vy + dy; clampPan(); paint(); return; }
    if (!drag.mode && drag.moved > 8) drag.mode = Math.abs(dy) > Math.abs(dx) ? 'v' : 'h';
    if (drag.mode === 'h') { view.x = dx; paint(); }
    if (drag.mode === 'v') {
      view.y = dy; paint();
      root.style.setProperty('--pv-fade', String(Math.max(0.25, 1 - Math.abs(dy) / 520)));
    }
  });
  const finish = (event) => {
    const had = pointers.delete(event.pointerId);
    if (!had) return;
    if (pinch) { if (pointers.size < 2) { pinch = null; if (view.s < 1.05) reset(true); } return; }
    if (!drag || pointers.size) return;
    const dx = event.clientX - drag.x; const dy = event.clientY - drag.y;
    const quick = Date.now() - drag.t;
    const mode = drag.mode;
    const moved = drag.moved;
    drag = null;
    root.style.setProperty('--pv-fade', '1');
    if (view.s > 1.02) return;
    if (mode === 'v' && dy > 110) { closePhotoViewer(); return; }
    if (mode === 'h' && (Math.abs(dx) > 70 || (Math.abs(dx) / Math.max(quick, 1)) > 0.45)) { step(dx < 0 ? 1 : -1); return; }
    if (moved < 8 && quick < 320) {
      const now = Date.now();
      if (now - lastTap.t < 320 && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 36) {
        lastTap = { t: 0, x: 0, y: 0 };
        img.style.transition = 'transform 220ms cubic-bezier(0.32, 0.72, 0, 1)';
        if (view.s > 1.05) { view.s = 1; view.x = 0; view.y = 0; } else {
          const box = stage.getBoundingClientRect();
          view.s = 2.6;
          view.x = (box.left + box.width / 2 - event.clientX) * (view.s - 1);
          view.y = (box.top + box.height / 2 - event.clientY) * (view.s - 1);
          clampPan();
        }
        paint();
        return;
      }
      lastTap = { t: now, x: event.clientX, y: event.clientY };
      window.setTimeout(() => {
        if (lastTap.t !== now) return;
        chromeHidden = !chromeHidden;
        root.classList.toggle('is-bare', chromeHidden);
      }, 330);
      return;
    }
    reset(true);
  };
  stage.addEventListener('pointerup', finish);
  stage.addEventListener('pointercancel', finish);
  stage.addEventListener('wheel', (event) => {
    event.preventDefault();
    img.style.transition = 'none';
    view.s = Math.max(1, Math.min(6, view.s * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
    if (view.s === 1) { view.x = 0; view.y = 0; }
    clampPan(); paint();
  }, { passive: false });

  const onKey = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePhotoViewer(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); step(1); }
  };
  document.addEventListener('keydown', onKey, true);

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-pv]');
    if (!button) return;
    const action = button.getAttribute('data-pv');
    const item = items[at];
    if (action === 'close') closePhotoViewer();
    else if (action === 'save') await savePhoto(item);
    else if (action === 'share') await sharePhoto(item);
    else if (action === 'edit') {
      if (kind === 'avatar') { closePhotoViewer(); openOwnAvatarEditor(item.url); return; }
      let blob = null;
      try { blob = await photoBlobOf(item.url); } catch (_error) { blob = null; }
      if (!blob) { notify(photoText('عکس خوانده نشد.', 'The photo could not be read.'), 'error'); return; }
      openPhotoEditor(blob, {
        title: photoText('ویرایش عکس', 'Edit photo'),
        doneLabel: photoText('تمام', 'Done'),
        onDone: (result) => offerEditedPhoto(result, item),
      });
    } else if (action === 'forward') {
      closePhotoViewer();
      if (item.entryId && typeof handleForwardMessage === 'function') handleForwardMessage(item.entryId);
    } else if (action === 'change') {
      closePhotoViewer();
      openOwnAvatarChooser();
    } else if (action === 'remove') {
      closePhotoViewer();
      onRemove?.();
    }
  });

  photoViewer = { root, onKey, restore: document.activeElement };
  show(at);
  requestAnimationFrame(() => { root.classList.add('is-open'); root.focus({ preventScroll: true }); });
}

/* What to do with a picture that has just been changed. */
async function offerEditedPhoto(result, item) {
  const conversation = typeof getActiveConversation === 'function' ? getActiveConversation() : null;
  const choices = [
    ...(conversation ? [{ value: 'send', label: photoText('ارسال در همین گفتگو', 'Send in this chat'), hint: photoText('به‌عنوان عکس تازه', 'as a new photo') }] : []),
    { value: 'save', label: photoText('ذخیره روی دستگاه', 'Save to this device'), hint: photoText('نسخه‌ٔ تغییریافته', 'the changed copy') },
  ];
  const choice = await PoorijaDialogs.choose(
    photoText('با عکس تغییریافته چه کنیم؟', 'What should be done with the changed photo?'),
    choices,
    { cancelLabel: photoText('هیچ‌کدام', 'Neither') },
  );
  if (choice === 'save') {
    await savePhoto({ url: URL.createObjectURL(result.file), name: result.file.name });
  } else if (choice === 'send') {
    closePhotoViewer();
    await sendPhotoFiles([{ file: result.file, width: result.width, height: result.height }], { caption: '' });
  }
}

/* ---- the profile picture ---------------------------------------------------- */

function openOwnAvatarChooser() {
  if (typeof toggleAvatarChooser === 'function') toggleAvatarChooser(true);
}
function openOwnAvatarEditor(url) {
  openOwnAvatarChooser();
  if (typeof openAvatarEditor === 'function') openAvatarEditor(url, { prepareOriginalForSave: true });
}
/* The profile picture, looked at before it is changed. With none set, the
   chooser is all there is to show. */
function viewOwnAvatar() {
  const data = String(chatState.profile?.avatarData || '');
  const url = typeof sanitizeAvatarData === 'function' ? sanitizeAvatarData(data) : '';
  if (!url) { openOwnAvatarChooser(); return; }
  openPhotoViewer({
    kind: 'avatar',
    items: [{ id: 'avatar', url, name: 'profile.jpg', caption: '', at: chatState.profile?.updatedAt || '', own: true, who: chatState.profile?.name || photoText('شما', 'You') }],
    onRemove: () => { if (typeof setProfileAvatarData === 'function') { setProfileAvatarData(''); renderStaticUi(); notify(photoText('عکس پروفایل حذف شد.', 'Profile photo removed.'), 'info'); } },
  });
}
window.PoorijaPhotos = { viewOwnAvatar, openPhotoViewer, openPhotoEditor: (...args) => openPhotoEditor(...args), photoBubbleBody };

/* ---- canvas helpers ----------------------------------------------------------- */

async function decodePhoto(file) {
  /* An engine that cannot draw the container (HEIC outside Safari, a raw file)
     is handed what the format module can get out of it. */
  let source = file;
  let bitmap = null;
  try { bitmap = await createImageBitmap(source); } catch (_error) { bitmap = null; }
  if (!bitmap && window.PoorijaImageFormats) {
    try {
      const drawable = await window.PoorijaImageFormats.toDrawableDataUrl(file);
      source = await (await fetch(drawable.dataUrl)).blob();
      bitmap = await createImageBitmap(source);
    } catch (_error) { bitmap = null; }
  }
  return bitmap;
}
function canvasOf(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}
function sourceCanvasFrom(bitmap, maxSide) {
  const k = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = canvasOf(bitmap.width * k, bitmap.height * k);
  const g = canvas.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}
function rotateFlipCanvas(source, quarter, flip) {
  const swap = quarter % 2 === 1;
  const canvas = canvasOf(swap ? source.height : source.width, swap ? source.width : source.height);
  const g = canvas.getContext('2d');
  g.translate(canvas.width / 2, canvas.height / 2);
  g.rotate((quarter * Math.PI) / 2);
  if (flip) g.scale(-1, 1);
  g.drawImage(source, -source.width / 2, -source.height / 2);
  return canvas;
}
const PHOTO_PRESETS = [
  { id: 'none', fa: 'اصلی', en: 'Original', b: 0, c: 0, s: 0, w: 0 },
  { id: 'vivid', fa: 'پرجلوه', en: 'Vivid', b: 0.04, c: 0.18, s: 0.35, w: 0 },
  { id: 'warm', fa: 'گرم', en: 'Warm', b: 0.03, c: 0.06, s: 0.1, w: 0.6 },
  { id: 'cool', fa: 'سرد', en: 'Cool', b: 0, c: 0.06, s: 0.05, w: -0.6 },
  { id: 'mono', fa: 'سیاه‌وسفید', en: 'Mono', b: 0, c: 0.12, s: -1, w: 0 },
  { id: 'fade', fa: 'محو', en: 'Fade', b: 0.1, c: -0.2, s: -0.25, w: 0.1 },
];
/* Brightness, contrast, saturation and warmth, in one pass over the pixels. */
function adjustCanvas(canvas, adj) {
  if (!adj.b && !adj.c && !adj.s && !adj.w) return;
  const g = canvas.getContext('2d');
  const image = g.getImageData(0, 0, canvas.width, canvas.height);
  const d = image.data;
  const shift = adj.b * 127;
  const contrast = 1 + adj.c;
  const saturation = 1 + adj.s;
  const warm = adj.w * 28;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i]; let gr = d[i + 1]; let b = d[i + 2];
    const luma = 0.299 * r + 0.587 * gr + 0.114 * b;
    r = luma + (r - luma) * saturation;
    gr = luma + (gr - luma) * saturation;
    b = luma + (b - luma) * saturation;
    r = (r - 128) * contrast + 128 + shift + warm;
    gr = (gr - 128) * contrast + 128 + shift;
    b = (b - 128) * contrast + 128 + shift - warm;
    d[i] = r < 0 ? 0 : (r > 255 ? 255 : r);
    d[i + 1] = gr < 0 ? 0 : (gr > 255 ? 255 : gr);
    d[i + 2] = b < 0 ? 0 : (b > 255 ? 255 : b);
  }
  g.putImageData(image, 0, 0);
}
function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/* A picture made ready to send: redrawn at no more than PHOTO_MAX_SIDE, which
   leaves behind everything a file carries but its pixels. */
async function compressPhoto(file) {
  const bitmap = await decodePhoto(file);
  if (!bitmap) throw new Error('the picture could not be decoded');
  const source = sourceCanvasFrom(bitmap, PHOTO_MAX_SIDE);
  bitmap.close?.();
  const flat = canvasOf(source.width, source.height);
  const g = flat.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, flat.width, flat.height);
  g.drawImage(source, 0, 0);
  const blob = await canvasToBlob(flat, 'image/jpeg', PHOTO_JPEG_QUALITY);
  if (!blob) throw new Error('the picture could not be re-encoded');
  return { blob, width: flat.width, height: flat.height };
}

/* ---- the editor ---------------------------------------------------------------- */

let photoEditor = null;

/* Drawing on a picture: a pen, and a mosaic brush for a face or a number.
   Strokes are kept in the picture's own proportions (points from 0 to 1, a size that
   is a fraction of its width), so they land alike on the preview and on the full-size
   picture that is sent. The mosaic is made from what is under it when it is painted,
   earlier strokes included. */
const PHOTO_INK_COLOURS = ['#ffffff', '#111111', '#ff3b30', '#ffcc00', '#34c759', '#0a84ff'];
function paintInk(ctx, w, h, strokes) {
  for (const stroke of strokes) {
    const pts = stroke.points;
    if (!pts.length) continue;
    const width = Math.max(1, stroke.size * w);
    if (stroke.tool === 'blur') {
      const block = Math.max(4, Math.round(width / 2));
      /* Halved again and again until it is the size of the blocks: one jump down samples
         a few pixels and calls it an average, and a fine pattern then survives. */
      const targetW = Math.max(1, Math.round(w / block));
      const targetH = Math.max(1, Math.round(h / block));
      let small = ctx.canvas;
      while (small.width / 2 >= targetW && small.height / 2 >= targetH) {
        const half = canvasOf(small.width / 2, small.height / 2);
        half.getContext('2d').drawImage(small, 0, 0, half.width, half.height);
        small = half;
      }
      if (small.width !== targetW || small.height !== targetH) {
        const last = canvasOf(targetW, targetH);
        last.getContext('2d').drawImage(small, 0, 0, targetW, targetH);
        small = last;
      }
      ctx.save();
      ctx.beginPath();
      /* A finger that moves fast leaves gaps between the points it reported: the brush is
         laid along the line between them, a quarter of its width apart, so it is a stroke. */
      const dab = (x, y) => { ctx.moveTo(x + width / 2, y); ctx.arc(x, y, width / 2, 0, Math.PI * 2); };
      let last = null;
      for (const [nx, ny] of pts) {
        const x = nx * w; const y = ny * h;
        if (last) {
          const steps = Math.min(400, Math.ceil(Math.hypot(x - last[0], y - last[1]) / (width * 0.25)));
          for (let i = 1; i < steps; i += 1) dab(last[0] + ((x - last[0]) * i) / steps, last[1] + ((y - last[1]) * i) / steps);
        }
        dab(x, y);
        last = [x, y];
      }
      ctx.clip();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(small, 0, 0, w, h);
      ctx.restore();
    } else {
      ctx.save();
      ctx.strokeStyle = stroke.colour;
      ctx.fillStyle = stroke.colour;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(pts[0][0] * w, pts[0][1] * h);
      if (pts.length === 1) { ctx.arc(pts[0][0] * w, pts[0][1] * h, width / 2, 0, Math.PI * 2); ctx.fill(); }
      else { for (const [x, y] of pts.slice(1)) ctx.lineTo(x * w, y * h); ctx.stroke(); }
      ctx.restore();
    }
  }
}

/* Turn, flip, crop (free or to a shape) and adjust. `source` is a Blob; the
   result handed to onDone is { file, width, height }, a JPEG made on a canvas. */
async function openPhotoEditor(source, { title = '', doneLabel = '', onDone = null, onCancel = null } = {}) {
  if (photoEditor) return;
  const bitmap = await decodePhoto(source);
  if (!bitmap) { notify(photoText('این عکس باز نشد.', 'That photo could not be opened.'), 'error'); return; }
  let base = sourceCanvasFrom(bitmap, PHOTO_EDIT_SOURCE_SIDE);
  const original = base;
  bitmap.close?.();
  const state = { quarter: 0, flip: false, crop: { x: 0, y: 0, w: 1, h: 1 }, ratio: 0, adj: { b: 0, c: 0, s: 0, w: 0 }, preset: 'none', tab: 'crop', ink: [], tool: 'pen', colour: '#ff3b30', pen: 4 };
  const root = document.createElement('div');
  root.className = 'pe';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', title || photoText('ویرایش عکس', 'Edit photo'));
  const shapes = [
    { id: 'free', label: photoText('آزاد', 'Free'), ratio: 0 },
    { id: 'orig', label: photoText('اصلی', 'Original'), ratio: -1 },
    { id: '1', label: '1:1', ratio: 1 },
    { id: '43', label: '4:3', ratio: 4 / 3 },
    { id: '34', label: '3:4', ratio: 3 / 4 },
    { id: '169', label: '16:9', ratio: 16 / 9 },
    { id: '916', label: '9:16', ratio: 9 / 16 },
  ];
  const slider = (id, label) => `<label class="pe-slider"><span>${photoEsc(label)}</span><input type="range" min="-100" max="100" step="1" value="0" data-pe-adj="${id}"><output data-pe-out="${id}">0</output></label>`;
  root.innerHTML = `
    <div class="pe-top">
      <button type="button" class="pe-text" data-pe="cancel">${photoEsc(photoText('انصراف', 'Cancel'))}</button>
      <strong>${photoEsc(title || photoText('ویرایش عکس', 'Edit photo'))}</strong>
      <button type="button" class="pe-text is-primary" data-pe="done">${photoEsc(doneLabel || photoText('تمام', 'Done'))}</button>
    </div>
    <div class="pe-stage"><div class="pe-frame"><canvas class="pe-canvas"></canvas><div class="pe-crop" data-h="move">
      <i data-h="nw"></i><i data-h="n"></i><i data-h="ne"></i><i data-h="e"></i><i data-h="se"></i><i data-h="s"></i><i data-h="sw"></i><i data-h="w"></i>
      <b class="pe-grid" aria-hidden="true"></b>
    </div></div></div>
    <div class="pe-panel" data-pe-panel="crop">
      <div class="pe-row">
        <button type="button" class="pe-icon" data-pe="left" aria-label="${photoEsc(photoText('چرخش به چپ', 'Rotate left'))}"><i class="fas fa-rotate-left"></i></button>
        <button type="button" class="pe-icon" data-pe="right" aria-label="${photoEsc(photoText('چرخش به راست', 'Rotate right'))}"><i class="fas fa-rotate-right"></i></button>
        <button type="button" class="pe-icon" data-pe="flip" aria-label="${photoEsc(photoText('برعکس', 'Flip'))}"><i class="fas fa-left-right"></i></button>
        <button type="button" class="pe-chip" data-pe="reset">${photoEsc(photoText('بازنشانی', 'Reset'))}</button>
      </div>
      <div class="pe-chips">${shapes.map((shape) => `<button type="button" class="pe-chip${shape.id === 'free' ? ' is-on' : ''}" data-pe-shape="${shape.id}">${photoEsc(shape.label)}</button>`).join('')}</div>
    </div>
    <div class="pe-panel" data-pe-panel="adjust" hidden>
      <div class="pe-chips">${PHOTO_PRESETS.map((preset) => `<button type="button" class="pe-chip${preset.id === 'none' ? ' is-on' : ''}" data-pe-preset="${preset.id}">${photoEsc(photoText(preset.fa, preset.en))}</button>`).join('')}</div>
      ${slider('b', photoText('روشنایی', 'Brightness'))}${slider('c', photoText('کنتراست', 'Contrast'))}${slider('s', photoText('اشباع', 'Saturation'))}${slider('w', photoText('گرمی', 'Warmth'))}
    </div>
    <div class="pe-panel" data-pe-panel="draw" hidden>
      <div class="pe-row">
        ${PHOTO_INK_COLOURS.map((colour) => `<button type="button" class="pe-swatch${colour === '#ff3b30' ? ' is-on' : ''}" data-pe-ink="${colour}" style="--ink:${colour}" aria-label="${colour}"></button>`).join('')}
      </div>
      <div class="pe-chips">
        <button type="button" class="pe-chip is-on" data-pe-tool="pen"><i class="fas fa-pen"></i> ${photoEsc(photoText('قلم', 'Pen'))}</button>
        <button type="button" class="pe-chip" data-pe-tool="blur"><i class="fas fa-eye-slash"></i> ${photoEsc(photoText('محو', 'Blur'))}</button>
        <button type="button" class="pe-chip" data-pe="undo"><i class="fas fa-rotate-left"></i> ${photoEsc(photoText('واگرد', 'Undo'))}</button>
        <button type="button" class="pe-chip" data-pe="clearink">${photoEsc(photoText('پاک‌کردن همه', 'Clear'))}</button>
      </div>
      <label class="pe-slider"><span>${photoEsc(photoText('اندازه', 'Size'))}</span><input type="range" min="1" max="10" step="1" value="4" data-pe-size><output data-pe-size-out>4</output></label>
    </div>
    <div class="pe-tabs">
      <button type="button" class="pe-tab is-on" data-pe-tab="crop"><i class="fas fa-crop-simple"></i><span>${photoEsc(photoText('برش', 'Crop'))}</span></button>
      <button type="button" class="pe-tab" data-pe-tab="draw"><i class="fas fa-pen-nib"></i><span>${photoEsc(photoText('رسم', 'Draw'))}</span></button>
      <button type="button" class="pe-tab" data-pe-tab="adjust"><i class="fas fa-sliders"></i><span>${photoEsc(photoText('تنظیم', 'Adjust'))}</span></button>
    </div>`;
  document.body.appendChild(root);
  const stage = root.querySelector('.pe-stage');
  const frame = root.querySelector('.pe-frame');
  const display = root.querySelector('.pe-canvas');
  const cropBox = root.querySelector('.pe-crop');
  let rotated = rotateFlipCanvas(base, state.quarter, state.flip);

  /* The picture as the stage shows it: the turned image, fitted, with the
     adjustments run over it so what is seen is what is sent. */
  const drawStage = () => {
    const box = stage.getBoundingClientRect();
    const k = Math.min((box.width - 24) / rotated.width, (box.height - 24) / rotated.height);
    /* Not rounded: the frame has exactly the picture's shape, so a crop that is
       square on the screen is square in the picture. */
    const w = Math.max(40, rotated.width * k);
    const h = Math.max(40, rotated.height * k);
    const scale = Math.min(1, 1100 / Math.max(rotated.width, rotated.height));
    display.width = Math.max(1, Math.round(rotated.width * scale));
    display.height = Math.max(1, Math.round(rotated.height * scale));
    display.style.width = `${w}px`;
    display.style.height = `${h}px`;
    frame.style.width = `${w}px`;
    frame.style.height = `${h}px`;
    const g = display.getContext('2d');
    g.drawImage(rotated, 0, 0, display.width, display.height);
    paintInk(g, display.width, display.height, state.ink);
    adjustCanvas(display, state.adj);
    placeCrop();
  };
  const placeCrop = () => {
    const c = state.crop;
    cropBox.style.left = `${c.x * 100}%`;
    cropBox.style.top = `${c.y * 100}%`;
    cropBox.style.width = `${c.w * 100}%`;
    cropBox.style.height = `${c.h * 100}%`;
  };
  const frameSize = () => {
    const box = frame.getBoundingClientRect();
    return { w: box.width || 1, h: box.height || 1 };
  };
  /* The largest rectangle of this shape that fits, in the middle. `ratio` is
     width over height as shown on the screen. */
  const fitCropTo = (ratio) => {
    const f = frameSize();
    const want = ratio === -1 ? f.w / f.h : ratio;
    if (!want) { state.crop = { x: 0, y: 0, w: 1, h: 1 }; return; }
    let w = 1; let h = (f.w / want) / f.h;
    if (h > 1) { h = 1; w = (f.h * want) / f.w; }
    state.crop = { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
  };

  /* -- dragging the crop: the box, an edge or a corner -- */
  let grab = null;
  cropBox.addEventListener('pointerdown', (event) => {
    const handle = event.target.getAttribute?.('data-h');
    if (!handle) return;
    event.preventDefault();
    cropBox.setPointerCapture?.(event.pointerId);
    grab = { handle, x: event.clientX, y: event.clientY, start: { ...state.crop } };
  });
  cropBox.addEventListener('pointermove', (event) => {
    if (!grab) return;
    const f = frameSize();
    const dx = (event.clientX - grab.x) / f.w;
    const dy = (event.clientY - grab.y) / f.h;
    const s = grab.start;
    const min = 0.08;
    let { x, y, w, h } = s;
    const handle = grab.handle;
    if (handle === 'move') {
      x = Math.min(1 - w, Math.max(0, s.x + dx));
      y = Math.min(1 - h, Math.max(0, s.y + dy));
    } else {
      let left = s.x; let top = s.y; let right = s.x + s.w; let bottom = s.y + s.h;
      if (handle.includes('w')) left = Math.min(right - min, Math.max(0, s.x + dx));
      if (handle.includes('e')) right = Math.max(left + min, Math.min(1, s.x + s.w + dx));
      if (handle.includes('n')) top = Math.min(bottom - min, Math.max(0, s.y + dy));
      if (handle.includes('s')) bottom = Math.max(top + min, Math.min(1, s.y + s.h + dy));
      w = right - left; h = bottom - top; x = left; y = top;
      const ratio = state.ratio === -1 ? f.w / f.h : state.ratio;
      if (ratio) {
        /* Held to its shape: the side that was dragged leads, the other follows. */
        const horizontal = handle === 'e' || handle === 'w' || (handle.length === 2 && Math.abs(dx) * f.w >= Math.abs(dy) * f.h);
        if (horizontal) {
          let nh = (w * f.w) / ratio / f.h;
          if (nh > 1) { nh = 1; w = (nh * f.h * ratio) / f.w; }
          h = nh;
        } else {
          let nw = (h * f.h * ratio) / f.w;
          if (nw > 1) { nw = 1; h = (nw * f.w) / ratio / f.h; }
          w = nw;
        }
        if (handle.includes('w')) x = s.x + s.w - w; else if (handle.includes('e')) x = s.x; else x = s.x + (s.w - w) / 2;
        if (handle.includes('n')) y = s.y + s.h - h; else if (handle.includes('s')) y = s.y; else y = s.y + (s.h - h) / 2;
        x = Math.min(1 - w, Math.max(0, x));
        y = Math.min(1 - h, Math.max(0, y));
      }
    }
    state.crop = { x, y, w, h };
    placeCrop();
  });
  const release = () => { grab = null; };
  cropBox.addEventListener('pointerup', release);
  cropBox.addEventListener('pointercancel', release);

  /* Turning a picture that has been drawn on: the drawing is made part of the picture first,
     so that it turns with it (and can then be undone no further back than the turn). */
  const bakeInk = () => {
    if (!state.ink.length) return;
    const baked = canvasOf(rotated.width, rotated.height);
    const bakedContext = baked.getContext('2d');
    bakedContext.drawImage(rotated, 0, 0);
    paintInk(bakedContext, baked.width, baked.height, state.ink);
    base = baked;
    state.quarter = 0;
    state.flip = false;
    state.ink = [];
    rotated = rotateFlipCanvas(base, 0, false);
  };
  const turn = (delta) => {
    bakeInk();
    state.quarter = (state.quarter + delta + 4) % 4;
    rotated = rotateFlipCanvas(base, state.quarter, state.flip);
    fitCropTo(state.ratio);
    drawStage();
  };
  const setTab = (tab) => {
    state.tab = tab;
    root.querySelectorAll('[data-pe-tab]').forEach((button) => button.classList.toggle('is-on', button.getAttribute('data-pe-tab') === tab));
    root.querySelectorAll('[data-pe-panel]').forEach((panel) => { panel.hidden = panel.getAttribute('data-pe-panel') !== tab; });
    root.classList.toggle('is-adjusting', tab === 'adjust');
    root.classList.toggle('is-drawing', tab === 'draw');
  };
  const syncSliders = () => {
    for (const id of ['b', 'c', 's', 'w']) {
      const input = root.querySelector(`[data-pe-adj="${id}"]`);
      const value = Math.round(state.adj[id] * 100);
      if (input) input.value = String(value);
      const out = root.querySelector(`[data-pe-out="${id}"]`);
      if (out) out.textContent = String(value);
    }
  };

  const close = () => {
    window.removeEventListener('resize', drawStage);
    document.removeEventListener('keydown', onKey, true);
    root.remove();
    photoEditor = null;
  };
  const onKey = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); onCancel?.(); }
  };
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', drawStage);

  root.addEventListener('click', async (event) => {
    const el = event.target.closest('[data-pe],[data-pe-tab],[data-pe-shape],[data-pe-preset],[data-pe-ink],[data-pe-tool]');
    if (!el) return;
    if (el.hasAttribute('data-pe-ink')) {
      state.colour = el.getAttribute('data-pe-ink');
      state.tool = 'pen';
      root.querySelectorAll('[data-pe-ink]').forEach((swatch) => swatch.classList.toggle('is-on', swatch === el));
      root.querySelectorAll('[data-pe-tool]').forEach((chip) => chip.classList.toggle('is-on', chip.getAttribute('data-pe-tool') === 'pen'));
      return;
    }
    if (el.hasAttribute('data-pe-tool')) {
      state.tool = el.getAttribute('data-pe-tool');
      root.querySelectorAll('[data-pe-tool]').forEach((chip) => chip.classList.toggle('is-on', chip === el));
      return;
    }
    if (el.hasAttribute('data-pe-tab')) { setTab(el.getAttribute('data-pe-tab')); return; }
    if (el.hasAttribute('data-pe-shape')) {
      const shape = shapes.find((item) => item.id === el.getAttribute('data-pe-shape'));
      state.ratio = shape.ratio;
      root.querySelectorAll('[data-pe-shape]').forEach((chip) => chip.classList.toggle('is-on', chip === el));
      fitCropTo(state.ratio);
      placeCrop();
      return;
    }
    if (el.hasAttribute('data-pe-preset')) {
      const preset = PHOTO_PRESETS.find((item) => item.id === el.getAttribute('data-pe-preset'));
      state.adj = { b: preset.b, c: preset.c, s: preset.s, w: preset.w };
      state.preset = preset.id;
      root.querySelectorAll('[data-pe-preset]').forEach((chip) => chip.classList.toggle('is-on', chip === el));
      syncSliders();
      drawStage();
      return;
    }
    const action = el.getAttribute('data-pe');
    if (action === 'cancel') { close(); onCancel?.(); }
    else if (action === 'undo') { state.ink.pop(); drawStage(); }
    else if (action === 'clearink') { state.ink = []; drawStage(); }
    else if (action === 'left') turn(-1);
    else if (action === 'right') turn(1);
    else if (action === 'flip') { bakeInk(); state.flip = !state.flip; rotated = rotateFlipCanvas(base, state.quarter, state.flip); drawStage(); }
    else if (action === 'reset') {
      state.quarter = 0; state.flip = false; state.ratio = 0; state.adj = { b: 0, c: 0, s: 0, w: 0 }; state.preset = 'none';
      base = original;
      state.ink = [];
      rotated = rotateFlipCanvas(base, 0, false);
      state.crop = { x: 0, y: 0, w: 1, h: 1 };
      root.querySelectorAll('[data-pe-shape]').forEach((chip) => chip.classList.toggle('is-on', chip.getAttribute('data-pe-shape') === 'free'));
      root.querySelectorAll('[data-pe-preset]').forEach((chip) => chip.classList.toggle('is-on', chip.getAttribute('data-pe-preset') === 'none'));
      syncSliders();
      drawStage();
    } else if (action === 'done') {
      el.disabled = true;
      try {
        const result = await renderEditedPhoto(rotated, state);
        close();
        onDone?.(result);
      } catch (error) {
        console.warn('[Photos] the edit could not be made:', error);
        notify(photoText('عکس آماده نشد.', 'The photo could not be prepared.'), 'error');
        el.disabled = false;
      }
    }
  });
  root.addEventListener('input', (event) => {
    const sizeInput = event.target.closest('[data-pe-size]');
    if (sizeInput) { state.pen = Number(sizeInput.value) || 4; root.querySelector('[data-pe-size-out]').textContent = String(state.pen); return; }
    const input = event.target.closest('[data-pe-adj]');
    if (!input) return;
    const id = input.getAttribute('data-pe-adj');
    state.adj[id] = Number(input.value) / 100;
    root.querySelector(`[data-pe-out="${id}"]`).textContent = input.value;
    root.querySelectorAll('[data-pe-preset]').forEach((chip) => chip.classList.remove('is-on'));
    state.preset = 'custom';
    drawStage();
  });

  /* Drawing: a finger or a mouse on the picture, while the Draw tab is up. */
  let stroke = null;
  const where = (event) => {
    const box = frame.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (event.clientX - box.left) / (box.width || 1))), Math.min(1, Math.max(0, (event.clientY - box.top) / (box.height || 1)))];
  };
  frame.addEventListener('pointerdown', (event) => {
    if (state.tab !== 'draw') return;
    event.preventDefault();
    frame.setPointerCapture?.(event.pointerId);
    stroke = { tool: state.tool, colour: state.colour, size: (state.tool === 'blur' ? 0.02 : 0.004) * state.pen, points: [where(event)] };
    state.ink.push(stroke);
    drawStage();
  });
  frame.addEventListener('pointermove', (event) => {
    if (!stroke) return;
    stroke.points.push(where(event));
    drawStage();
  });
  const endStroke = () => { stroke = null; };
  frame.addEventListener('pointerup', endStroke);
  frame.addEventListener('pointercancel', endStroke);

  photoEditor = { root, state };
  requestAnimationFrame(() => { root.classList.add('is-open'); fitCropTo(state.ratio); drawStage(); });
}

async function renderEditedPhoto(turned, state) {
  let rotated = turned;
  if (state.ink?.length) {
    rotated = canvasOf(turned.width, turned.height);
    const inked = rotated.getContext('2d');
    inked.drawImage(turned, 0, 0);
    paintInk(inked, rotated.width, rotated.height, state.ink);
  }
  const c = state.crop;
  const sx = Math.round(c.x * rotated.width);
  const sy = Math.round(c.y * rotated.height);
  const sw = Math.max(1, Math.min(rotated.width - sx, Math.round(c.w * rotated.width)));
  let sh = Math.max(1, Math.min(rotated.height - sy, Math.round(c.h * rotated.height)));
  /* A shape that was asked for is the shape that comes out, to the pixel: the
     two sides are rounded separately above and could be one apart. */
  const shape = state.ratio === -1 ? rotated.width / rotated.height : state.ratio;
  if (shape > 0) sh = Math.max(1, Math.min(rotated.height - sy, Math.round(sw / shape)));
  const k = Math.min(1, PHOTO_MAX_SIDE / Math.max(sw, sh));
  const out = canvasOf(sw * k, sh * k);
  const g = out.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, out.width, out.height);
  g.imageSmoothingQuality = 'high';
  g.drawImage(rotated, sx, sy, sw, sh, 0, 0, out.width, out.height);
  adjustCanvas(out, state.adj);
  const blob = await canvasToBlob(out, 'image/jpeg', PHOTO_JPEG_QUALITY);
  if (!blob) throw new Error('the edited photo could not be encoded');
  const file = new File([blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
  return { file, width: out.width, height: out.height };
}

/* ---- sending -------------------------------------------------------------------- */

/* Photos that are ready — [{ file, width, height }] — one after the other, each
   its own message, the caption on the first. */
async function sendPhotoFiles(list, { caption = '' } = {}) {
  const text = String(caption || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, PHOTO_CAPTION_MAX);
  const failed = [];
  /* Two or more sent together are an album: one id, each its place. */
  const albumId = list.length >= 2 ? generateId('album').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48) : '';
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    try {
      await sendEncryptedBlob(item.file, 'file', item.video ? (item.durationMs || 0) : 0, {
        ...(item.video ? { video: true } : { photo: true }),
        mediaWidth: item.width || 0,
        mediaHeight: item.height || 0,
        ...(albumId ? { albumId, albumIndex: i, albumCount: list.length } : {}),
        ...(i === 0 && text ? { caption: text } : {}),
      });
    } catch (error) {
      console.error('[Photos] a photo did not send', error);
      failed.push(item.file?.name || 'photo');
    }
  }
  if (failed.length) notify(photoText(`ارسال نشد: ${failed.join('، ')}`, `Could not send: ${failed.join(', ')}`), 'error');
}

/* ---- the sheet that opens with the pictures chosen --------------------------------- */

async function openPhotoComposer(files, { onFinished = null } = {}) {
  /* Pictures and videos open the sheet together (an album, as in Telegram),
     at most ALBUM_MAX of them; the rest of a larger choice goes as files. */
  const media = files.filter((file) => looksLikePhotoFile(file) || looksLikeVideoFile(file));
  const pictures = media.slice(0, ALBUM_MAX);
  if (media.length > ALBUM_MAX) notify(photoText(`در هر آلبوم حداکثر ${ALBUM_MAX} مورد؛ بقیه به‌صورت فایل فرستاده می‌شوند.`, `An album holds up to ${ALBUM_MAX}; the rest are sent as files.`), 'info');
  const others = files.filter((file) => !pictures.includes(file));
  if (!pictures.length) { onFinished?.({ pictures: [], others }); return; }
  if (!getActiveConversation()) {
    notify(photoText('اول یک گفتگو را باز کنید، بعد عکس را بفرستید.', 'Open a conversation first, then send the photo.'), 'warning');
    return;
  }
  /* Looked at before the sheet opens: what cannot be drawn here is sent as a file. */
  const items = [];
  for (const file of pictures) {
    if (looksLikeVideoFile(file)) {
      const probe = await probeVideo(file);
      items.push({ file, width: probe.width, height: probe.height, durationMs: probe.durationMs, video: true, animated: false, url: probe.poster, edited: null });
      continue;
    }
    const bitmap = await decodePhoto(file);
    const animated = /gif/i.test(file.type || '') || /\.gif$/i.test(file.name || '');
    if (!bitmap) { others.push(file); continue; }
    const preview = sourceCanvasFrom(bitmap, 1400);
    const url = URL.createObjectURL(await canvasToBlob(preview, 'image/jpeg', 0.82));
    items.push({ file, width: bitmap.width, height: bitmap.height, animated, url, edited: null });
    bitmap.close?.();
  }
  if (!items.length) { onFinished?.({ pictures: [], others }); return; }

  const root = document.createElement('div');
  root.className = 'pc';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', photoText('ارسال مدیا', 'Send media'));
  let current = 0;
  let mode = 'photo';
  const conversation = getActiveConversation();
  const who = conversation?.username || conversation?.name || '';
  root.innerHTML = `
    <div class="pc-top">
      <button type="button" class="pc-btn" data-pc="cancel" aria-label="${photoEsc(photoText('انصراف', 'Cancel'))}"><i class="fas fa-xmark"></i></button>
      <div class="pc-title"><strong data-pc-title></strong><span>${photoEsc(who)}</span></div>
      <div class="pc-mode" role="tablist">
        <button type="button" class="is-on" role="tab" data-pc-mode="photo">${photoEsc(photoText('مدیا', 'Media'))}</button>
        <button type="button" role="tab" data-pc-mode="file">${photoEsc(photoText('فایل', 'File'))}</button>
      </div>
    </div>
    <div class="pc-stage"><img class="pc-img" alt="" draggable="false"></div>
    <div class="pc-strip" data-pc-strip></div>
    <div class="pc-foot">
      <div class="pc-tools">
        <button type="button" class="pc-tool" data-pc="edit"><i class="fas fa-crop-simple"></i><span>${photoEsc(photoText('ویرایش', 'Edit'))}</span></button>
        <button type="button" class="pc-tool" data-pc="remove"><i class="fas fa-trash"></i><span>${photoEsc(photoText('حذف', 'Remove'))}</span></button>
      </div>
      <p class="pc-note" data-pc-note></p>
      <div class="pc-send">
        <input class="pc-caption" type="text" dir="auto" maxlength="${PHOTO_CAPTION_MAX}" placeholder="${photoEsc(photoText('افزودن توضیح…', 'Add a caption…'))}" enterkeyhint="send">
        <button type="button" class="pc-go" data-pc="send" aria-label="${photoEsc(photoText('ارسال', 'Send'))}"><i class="fas fa-paper-plane"></i></button>
      </div>
    </div>`;
  document.body.appendChild(root);
  const img = root.querySelector('.pc-img');
  const strip = root.querySelector('[data-pc-strip]');
  const caption = root.querySelector('.pc-caption');
  const note = root.querySelector('[data-pc-note]');

  const urlOf = (item) => item.editedUrl || item.url;
  const paint = () => {
    const item = items[current];
    img.src = urlOf(item);
    const videos = items.filter((entry) => entry.video).length;
    root.querySelector('[data-pc-title]').textContent = items.length === 1
      ? (videos ? photoText('یک ویدیو', 'One video') : photoText('یک عکس', 'One photo'))
      : (videos === items.length ? photoText(`${items.length} ویدیو`, `${items.length} videos`)
        : (videos ? photoText(`آلبوم ${items.length} تایی`, `Album of ${items.length}`) : photoText(`${items.length} عکس`, `${items.length} photos`)));
    strip.hidden = items.length < 2;
    strip.innerHTML = items.map((entry, index) => `<button type="button" class="pc-thumb${index === current ? ' is-on' : ''}${entry.video ? ' is-video' : ''}" data-pc-thumb="${index}"><img alt="" src="${photoEsc(urlOf(entry))}">${entry.video ? '<i class="fas fa-play" aria-hidden="true"></i>' : ''}</button>`).join('');
    root.querySelector('[data-pc="edit"]').hidden = mode !== 'photo' || item.animated || item.video;
    note.textContent = mode === 'file'
      ? photoText('به‌صورت فایل، با همان اندازه و کیفیت اصلی فرستاده می‌شود.', 'Sent as a file, at its original size and quality.')
      : (item.video
        ? photoText(`ویدیو همان‌طور که هست فرستاده می‌شود و در گفتگو پخش می‌شود (${formatVideoLength(item.durationMs)}).${items.length > 1 ? ' همه با هم، به‌صورت یک آلبوم.' : ''}`, `The video is sent as it is and plays in the conversation (${formatVideoLength(item.durationMs)}).${items.length > 1 ? ' All of them together, as one album.' : ''}`)
        : item.animated
        ? photoText('گیف همان‌طور که هست فرستاده می‌شود تا متحرک بماند.', 'A GIF is sent as it is, so that it keeps moving.')
        : photoText('عکس فشرده می‌شود و اطلاعات دوربین و مکان از آن پاک است.', 'The photo is resized, and what the camera and the place left in the file is not kept.'));
    caption.hidden = mode === 'file';
  };
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    root.remove();
    for (const entry of items) { URL.revokeObjectURL(entry.url); if (entry.editedUrl) URL.revokeObjectURL(entry.editedUrl); }
  };
  const onKey = (event) => {
    if (event.key === 'Escape' && !photoEditor) { event.preventDefault(); event.stopPropagation(); close(); onFinished?.({ pictures: [], others: [] }); }
  };
  document.addEventListener('keydown', onKey, true);

  root.addEventListener('click', async (event) => {
    const el = event.target.closest('[data-pc],[data-pc-mode],[data-pc-thumb]');
    if (!el) return;
    if (el.hasAttribute('data-pc-thumb')) { current = Number(el.getAttribute('data-pc-thumb')) || 0; paint(); return; }
    if (el.hasAttribute('data-pc-mode')) {
      mode = el.getAttribute('data-pc-mode');
      root.querySelectorAll('[data-pc-mode]').forEach((button) => button.classList.toggle('is-on', button === el));
      paint();
      return;
    }
    const action = el.getAttribute('data-pc');
    if (action === 'cancel') { close(); onFinished?.({ pictures: [], others: [] }); }
    else if (action === 'remove') {
      const [gone] = items.splice(current, 1);
      URL.revokeObjectURL(gone.url); if (gone.editedUrl) URL.revokeObjectURL(gone.editedUrl);
      if (!items.length) { close(); onFinished?.({ pictures: [], others }); return; }
      current = Math.min(current, items.length - 1);
      paint();
    } else if (action === 'edit') {
      const item = items[current];
      openPhotoEditor(item.edited?.file || item.file, {
        title: photoText('ویرایش عکس', 'Edit photo'),
        onDone: (result) => {
          if (item.editedUrl) URL.revokeObjectURL(item.editedUrl);
          item.edited = result;
          item.editedUrl = URL.createObjectURL(result.file);
          paint();
        },
      });
    } else if (action === 'send') {
      el.disabled = true;
      const chosen = items.slice();
      const text = caption.value;
      const asFiles = mode === 'file';
      close();
      try {
        if (asFiles) {
          for (const item of chosen) {
            try { await sendFile(item.file); } catch (error) { console.error('[Photos] file send failed', error); notify(photoText(`ارسال نشد: ${item.file.name}`, `Could not send: ${item.file.name}`), 'error'); }
          }
        } else {
          const ready = [];
          for (const item of chosen) {
            try {
              if (item.video) { ready.push({ file: item.file, width: item.width, height: item.height, durationMs: item.durationMs, video: true }); continue; }
              if (item.edited) { ready.push(item.edited); continue; }
              if (item.animated) { ready.push({ file: item.file, width: item.width, height: item.height }); continue; }
              const made = await compressPhoto(item.file);
              ready.push({ file: new File([made.blob], `photo-${Date.now()}-${ready.length + 1}.jpg`, { type: 'image/jpeg', lastModified: Date.now() }), width: made.width, height: made.height });
            } catch (error) {
              /* One that cannot be redrawn goes as the file it is. */
              console.warn('[Photos] could not redraw a picture; sending it as a file:', error);
              await sendFile(item.file).catch(() => {});
            }
          }
          await sendPhotoFiles(ready, { caption: text });
        }
      } finally {
        onFinished?.({ pictures: chosen, others });
      }
    }
  });
  caption.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); root.querySelector('[data-pc="send"]')?.click(); }
  });
  paint();
  requestAnimationFrame(() => root.classList.add('is-open'));
  return root;
}
window.PoorijaPhotos.openPhotoComposer = openPhotoComposer;
window.PoorijaPhotos.sniff = sniffPhotoBlob;
window.PoorijaPhotos.compress = compressPhoto;
window.PoorijaPhotos.photoVerdicts = photoVerdicts;

/* ---- published to globalThis (roadmap 2.1, tools/esm-chat.cjs) ---- */
Object.defineProperties(globalThis, {
  "PHOTO_MAX_SIDE": { get() { return PHOTO_MAX_SIDE; }, set() { throw new TypeError('Assignment to constant variable PHOTO_MAX_SIDE.'); }, configurable: true },
  "PHOTO_EDIT_SOURCE_SIDE": { get() { return PHOTO_EDIT_SOURCE_SIDE; }, set() { throw new TypeError('Assignment to constant variable PHOTO_EDIT_SOURCE_SIDE.'); }, configurable: true },
  "PHOTO_JPEG_QUALITY": { get() { return PHOTO_JPEG_QUALITY; }, set() { throw new TypeError('Assignment to constant variable PHOTO_JPEG_QUALITY.'); }, configurable: true },
  "PHOTO_CAPTION_MAX": { get() { return PHOTO_CAPTION_MAX; }, set() { throw new TypeError('Assignment to constant variable PHOTO_CAPTION_MAX.'); }, configurable: true },
  "PHOTO_NAME_PATTERN": { get() { return PHOTO_NAME_PATTERN; }, set() { throw new TypeError('Assignment to constant variable PHOTO_NAME_PATTERN.'); }, configurable: true },
  "photoVerdicts": { get() { return photoVerdicts; }, set() { throw new TypeError('Assignment to constant variable photoVerdicts.'); }, configurable: true },
  "photoText": { get() { return photoText; }, set(value) { photoText = value; }, configurable: true },
  "photoEsc": { get() { return photoEsc; }, set(value) { photoEsc = value; }, configurable: true },
  "looksLikePhotoFile": { get() { return looksLikePhotoFile; }, set(value) { looksLikePhotoFile = value; }, configurable: true },
  "sniffPhotoBytes": { get() { return sniffPhotoBytes; }, set(value) { sniffPhotoBytes = value; }, configurable: true },
  "sniffPhotoBlob": { get() { return sniffPhotoBlob; }, set(value) { sniffPhotoBlob = value; }, configurable: true },
  "verifyPhotoEntry": { get() { return verifyPhotoEntry; }, set(value) { verifyPhotoEntry = value; }, configurable: true },
  "photoBubbleBody": { get() { return photoBubbleBody; }, set(value) { photoBubbleBody = value; }, configurable: true },
  "VIDEO_NAME_PATTERN": { get() { return VIDEO_NAME_PATTERN; }, set() { throw new TypeError('Assignment to constant variable VIDEO_NAME_PATTERN.'); }, configurable: true },
  "looksLikeVideoFile": { get() { return looksLikeVideoFile; }, set(value) { looksLikeVideoFile = value; }, configurable: true },
  "placeholderPoster": { get() { return placeholderPoster; }, set(value) { placeholderPoster = value; }, configurable: true },
  "probeVideo": { get() { return probeVideo; }, set(value) { probeVideo = value; }, configurable: true },
  "formatVideoLength": { get() { return formatVideoLength; }, set(value) { formatVideoLength = value; }, configurable: true },
  "videoBubbleBody": { get() { return videoBubbleBody; }, set(value) { videoBubbleBody = value; }, configurable: true },
  "videoViewer": { get() { return videoViewer; }, set(value) { videoViewer = value; }, configurable: true },
  "closeVideoViewer": { get() { return closeVideoViewer; }, set(value) { closeVideoViewer = value; }, configurable: true },
  "saveVideo": { get() { return saveVideo; }, set(value) { saveVideo = value; }, configurable: true },
  "openVideoEntry": { get() { return openVideoEntry; }, set(value) { openVideoEntry = value; }, configurable: true },
  "ALBUM_MAX": { get() { return ALBUM_MAX; }, set() { throw new TypeError('Assignment to constant variable ALBUM_MAX.'); }, configurable: true },
  "groupAlbumBubbles": { get() { return groupAlbumBubbles; }, set(value) { groupAlbumBubbles = value; }, configurable: true },
  "photoEntriesOfActiveConversation": { get() { return photoEntriesOfActiveConversation; }, set(value) { photoEntriesOfActiveConversation = value; }, configurable: true },
  "photoItemOf": { get() { return photoItemOf; }, set(value) { photoItemOf = value; }, configurable: true },
  "photoFileName": { get() { return photoFileName; }, set(value) { photoFileName = value; }, configurable: true },
  "openPhotoEntry": { get() { return openPhotoEntry; }, set(value) { openPhotoEntry = value; }, configurable: true },
  "mediaHoldTimer": { get() { return mediaHoldTimer; }, set(value) { mediaHoldTimer = value; }, configurable: true },
  "mediaHeldUntil": { get() { return mediaHeldUntil; }, set(value) { mediaHeldUntil = value; }, configurable: true },
  "openMediaToolbar": { get() { return openMediaToolbar; }, set(value) { openMediaToolbar = value; }, configurable: true },
  "photoIsTouch": { get() { return photoIsTouch; }, set() { throw new TypeError('Assignment to constant variable photoIsTouch.'); }, configurable: true },
  "photoBlobOf": { get() { return photoBlobOf; }, set(value) { photoBlobOf = value; }, configurable: true },
  "savePhoto": { get() { return savePhoto; }, set(value) { savePhoto = value; }, configurable: true },
  "sharePhoto": { get() { return sharePhoto; }, set(value) { sharePhoto = value; }, configurable: true },
  "photoCanShare": { get() { return photoCanShare; }, set() { throw new TypeError('Assignment to constant variable photoCanShare.'); }, configurable: true },
  "photoViewer": { get() { return photoViewer; }, set(value) { photoViewer = value; }, configurable: true },
  "closePhotoViewer": { get() { return closePhotoViewer; }, set(value) { closePhotoViewer = value; }, configurable: true },
  "openPhotoViewer": { get() { return openPhotoViewer; }, set(value) { openPhotoViewer = value; }, configurable: true },
  "offerEditedPhoto": { get() { return offerEditedPhoto; }, set(value) { offerEditedPhoto = value; }, configurable: true },
  "openOwnAvatarChooser": { get() { return openOwnAvatarChooser; }, set(value) { openOwnAvatarChooser = value; }, configurable: true },
  "openOwnAvatarEditor": { get() { return openOwnAvatarEditor; }, set(value) { openOwnAvatarEditor = value; }, configurable: true },
  "viewOwnAvatar": { get() { return viewOwnAvatar; }, set(value) { viewOwnAvatar = value; }, configurable: true },
  "decodePhoto": { get() { return decodePhoto; }, set(value) { decodePhoto = value; }, configurable: true },
  "canvasOf": { get() { return canvasOf; }, set(value) { canvasOf = value; }, configurable: true },
  "sourceCanvasFrom": { get() { return sourceCanvasFrom; }, set(value) { sourceCanvasFrom = value; }, configurable: true },
  "rotateFlipCanvas": { get() { return rotateFlipCanvas; }, set(value) { rotateFlipCanvas = value; }, configurable: true },
  "PHOTO_PRESETS": { get() { return PHOTO_PRESETS; }, set() { throw new TypeError('Assignment to constant variable PHOTO_PRESETS.'); }, configurable: true },
  "adjustCanvas": { get() { return adjustCanvas; }, set(value) { adjustCanvas = value; }, configurable: true },
  "canvasToBlob": { get() { return canvasToBlob; }, set(value) { canvasToBlob = value; }, configurable: true },
  "compressPhoto": { get() { return compressPhoto; }, set(value) { compressPhoto = value; }, configurable: true },
  "photoEditor": { get() { return photoEditor; }, set(value) { photoEditor = value; }, configurable: true },
  "PHOTO_INK_COLOURS": { get() { return PHOTO_INK_COLOURS; }, set() { throw new TypeError('Assignment to constant variable PHOTO_INK_COLOURS.'); }, configurable: true },
  "paintInk": { get() { return paintInk; }, set(value) { paintInk = value; }, configurable: true },
  "openPhotoEditor": { get() { return openPhotoEditor; }, set(value) { openPhotoEditor = value; }, configurable: true },
  "renderEditedPhoto": { get() { return renderEditedPhoto; }, set(value) { renderEditedPhoto = value; }, configurable: true },
  "sendPhotoFiles": { get() { return sendPhotoFiles; }, set(value) { sendPhotoFiles = value; }, configurable: true },
  "openPhotoComposer": { get() { return openPhotoComposer; }, set(value) { openPhotoComposer = value; }, configurable: true },
});
