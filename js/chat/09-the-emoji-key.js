/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Part 9 of 36 of the Secure Chat module.
   Split out of the original single-file js/chat.js — see js/chat/README.md.
   These files share one global scope and are loaded in order; the numbering is
   that order and must not be changed.

   The emoji key — Telegram's call verification, six symbols wide
*/

/* =====================================================================
   The emoji key — Telegram's call verification, six symbols wide
   ---------------------------------------------------------------------
   End-to-end encryption stops someone reading the call. It does not stop
   someone *being* the other end: if a relay handed each of you its own
   key, both calls are encrypted and both are to the attacker. The only
   fix is comparing something derived from both keys over a channel the
   attacker does not control — and the channel you already have is the
   call itself: read the six symbols aloud.

   Six from an alphabet of 64 is 36 bits, in the same range as Telegram's
   four-of-333 and Matrix's seven-of-64. Both ends sort the fingerprints
   before hashing, so they land on the same six whichever side asks.
   The pictures are the point: people compare pictures reliably and
   64 hex characters not at all.
   ===================================================================== */
const SAS_EMOJI = [
  { e: '🐶', fa: 'سگ', en: 'Dog' }, { e: '🐱', fa: 'گربه', en: 'Cat' },
  { e: '🦁', fa: 'شیر', en: 'Lion' }, { e: '🐎', fa: 'اسب', en: 'Horse' },
  { e: '🦄', fa: 'اسب شاخ‌دار', en: 'Unicorn' }, { e: '🐷', fa: 'خوک', en: 'Pig' },
  { e: '🐘', fa: 'فیل', en: 'Elephant' }, { e: '🐰', fa: 'خرگوش', en: 'Rabbit' },
  { e: '🐼', fa: 'پاندا', en: 'Panda' }, { e: '🐓', fa: 'خروس', en: 'Rooster' },
  { e: '🐧', fa: 'پنگوئن', en: 'Penguin' }, { e: '🐢', fa: 'لاک‌پشت', en: 'Turtle' },
  { e: '🐟', fa: 'ماهی', en: 'Fish' }, { e: '🐙', fa: 'اختاپوس', en: 'Octopus' },
  { e: '🦋', fa: 'پروانه', en: 'Butterfly' }, { e: '🌷', fa: 'گل لاله', en: 'Flower' },
  { e: '🌳', fa: 'درخت', en: 'Tree' }, { e: '🌵', fa: 'کاکتوس', en: 'Cactus' },
  { e: '🍄', fa: 'قارچ', en: 'Mushroom' }, { e: '🌏', fa: 'کرهٔ زمین', en: 'Globe' },
  { e: '🌙', fa: 'ماه', en: 'Moon' }, { e: '☁️', fa: 'ابر', en: 'Cloud' },
  { e: '🔥', fa: 'آتش', en: 'Fire' }, { e: '🍌', fa: 'موز', en: 'Banana' },
  { e: '🍎', fa: 'سیب', en: 'Apple' }, { e: '🍓', fa: 'توت‌فرنگی', en: 'Strawberry' },
  { e: '🌽', fa: 'ذرت', en: 'Corn' }, { e: '🍕', fa: 'پیتزا', en: 'Pizza' },
  { e: '🎂', fa: 'کیک', en: 'Cake' }, { e: '❤️', fa: 'قلب', en: 'Heart' },
  { e: '🙂', fa: 'لبخند', en: 'Smiley' }, { e: '🤖', fa: 'ربات', en: 'Robot' },
  { e: '🎩', fa: 'کلاه', en: 'Hat' }, { e: '👓', fa: 'عینک', en: 'Glasses' },
  { e: '🔧', fa: 'آچار', en: 'Spanner' }, { e: '🎅', fa: 'بابانوئل', en: 'Santa' },
  { e: '👍', fa: 'شست بالا', en: 'Thumbs up' }, { e: '☂️', fa: 'چتر', en: 'Umbrella' },
  { e: '⌛', fa: 'ساعت شنی', en: 'Hourglass' }, { e: '⏰', fa: 'ساعت زنگ‌دار', en: 'Clock' },
  { e: '🎁', fa: 'هدیه', en: 'Gift' }, { e: '💡', fa: 'لامپ', en: 'Light bulb' },
  { e: '📕', fa: 'کتاب', en: 'Book' }, { e: '✏️', fa: 'مداد', en: 'Pencil' },
  { e: '📎', fa: 'گیره کاغذ', en: 'Paperclip' }, { e: '✂️', fa: 'قیچی', en: 'Scissors' },
  { e: '🔒', fa: 'قفل', en: 'Lock' }, { e: '🔑', fa: 'کلید', en: 'Key' },
  { e: '🔨', fa: 'چکش', en: 'Hammer' }, { e: '☎️', fa: 'تلفن', en: 'Telephone' },
  { e: '🏁', fa: 'پرچم', en: 'Flag' }, { e: '🚂', fa: 'قطار', en: 'Train' },
  { e: '🚲', fa: 'دوچرخه', en: 'Bicycle' }, { e: '✈️', fa: 'هواپیما', en: 'Aeroplane' },
  { e: '🚀', fa: 'موشک', en: 'Rocket' }, { e: '🏆', fa: 'جام', en: 'Trophy' },
  { e: '⚽', fa: 'توپ', en: 'Ball' }, { e: '🎸', fa: 'گیتار', en: 'Guitar' },
  { e: '🎺', fa: 'ترومپت', en: 'Trumpet' }, { e: '🔔', fa: 'زنگ', en: 'Bell' },
  { e: '⚓', fa: 'لنگر', en: 'Anchor' }, { e: '🎧', fa: 'هدفون', en: 'Headphones' },
  { e: '📁', fa: 'پوشه', en: 'Folder' }, { e: '📌', fa: 'سنجاق', en: 'Pin' },
];
const SAS_DOMAIN = 'P00RIJA-call-verify-v1';
const SAS_LENGTH = 6;

/* The fingerprints of the encryption this very call is using.
 *
 * The six symbols were made from the two identity keys alone, which are pinned and
 * do not change from call to call: they prove who the contacts are, and nothing
 * about the call. A server that carries the signalling can put its own DTLS
 * fingerprint in each side's offer and answer, end the encryption at itself and
 * pass the media on; both phones then show the same six symbols, made from the
 * same two pinned keys, and both are talking to it. The fingerprints are what the
 * call is actually keyed to, so the code is made from those as well: each phone
 * reads them from the descriptions it applied, a server in the middle has to make
 * them differ, and the six symbols then differ with them. Sorted, so both ends
 * land on the same string whichever description is whose. */
function callTransportFingerprints(pc) {
  /* Exactly one fingerprint in a description, or none is used. A description that lists
     several leaves it to the browser which one the peer's certificate must match, and a
     server that lists the same extra fingerprints in both descriptions could make the
     two sets equal while terminating the encryption at itself: so a description with
     more than one distinct fingerprint line (or none) gives no code at all, and the
     strip stays hidden rather than showing one that can be steered. */
  const only = (description) => {
    const found = [...String(description?.sdp || '').matchAll(/^a=fingerprint:(\S+)\s+([0-9A-Fa-f:]+)\s*$/gm)]
      .map((m) => `${m[1].toLowerCase()} ${m[2].toUpperCase()}`);
    const distinct = [...new Set(found)];
    return distinct.length === 1 ? distinct[0] : '';
  };
  const local = only(pc?.localDescription);
  const remote = only(pc?.remoteDescription);
  if (!local || !remote) return '';
  /* A pair, not a set: two equal entries (a description reflected back) stay two. */
  return [local, remote].sort().join('|');
}

async function verificationEmoji(localFp, remoteFp, count = SAS_LENGTH, binding = '') {
  if (!localFp || !remoteFp) return [];
  /* Domain-separated from the safety number so the two displays cannot be
     replayed against each other, and sorted so both ends agree. With the call's
     own fingerprints in it (callTransportFingerprints) it is a different domain,
     so a code made without them is never taken for one made with them. */
  const domain = binding ? `${SAS_DOMAIN}-bound` : SAS_DOMAIN;
  const material = `${domain}|${[String(localFp), String(remoteFp)].sort().join('|')}${binding ? `|${binding}` : ''}`;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material)));
  const picks = [];
  /* 256 is a whole multiple of 64, so the modulo is uniform. */
  for (let i = 0; i < count; i += 1) picks.push(SAS_EMOJI[digest[i] % SAS_EMOJI.length]);
  return picks;
}

/* The strip lives under the call header and fades with the rest of the chrome.
   Tapping it opens the card that says what to do with it. */
async function syncCallVerification() {
  const strip = document.getElementById('chatCallVerifyStrip');
  const card = document.getElementById('chatCallVerifyCard');
  if (!strip) return;
  const peer = activeCallPeerRecord();
  const localFp = chatState.identity?.fingerprint || '';
  const remoteFp = peer?.fingerprint || '';
  const show = Boolean(chatState.currentCall && localFp && remoteFp);
  strip.classList.toggle('hidden', !show);
  if (!show) {
    card?.classList.add('hidden');
    strip.dataset.key = '';
    return;
  }
  /* Shown once the call has its descriptions: a code made before it has them would be
     the unbound one, and a different one a moment later. */
  const binding = callTransportFingerprints(chatState.currentCall?.peerConnection);
  if (!binding) {
    strip.classList.add('hidden');
    card?.classList.add('hidden');
    strip.dataset.key = '';
    syncCallVerification.tries = (syncCallVerification.tries || 0) + 1;
    if (syncCallVerification.tries < 60) setTimeout(() => syncCallVerification().catch(() => {}), 1000);
    return;
  }
  syncCallVerification.tries = 0;
  const key = `${localFp}|${remoteFp}|${binding}|${isPeerVerified(remoteFp) ? 'v' : 'u'}`;
  if (strip.dataset.key === key) return;
  strip.dataset.key = key;
  const picks = await verificationEmoji(localFp, remoteFp, SAS_LENGTH, binding);
  const verified = isPeerVerified(remoteFp);
  strip.classList.toggle('is-verified', verified);
  const emojiEl = strip.querySelector('.chat-call-verify-emoji');
  if (emojiEl) emojiEl.textContent = picks.map((pick) => pick.e).join(' ');
  strip.title = t('کلید تصویری تماس — برای توضیح بزنید', 'Call emoji key — tap for details');
  if (!card) return;
  card.innerHTML = `
    <div class="chat-call-verify-head">
      <strong>${app().escapeHTML(t('این شش نماد را با هم بخوانید', 'Read these six aloud to each other'))}</strong>
      <button type="button" data-verify-close aria-label="${app().escapeHTML(t('بستن', 'Close'))}"><i class="fas fa-xmark"></i></button>
    </div>
    <p>${app().escapeHTML(t(
      'اگر روی هر دو گوشی یکی بودند، هیچ‌کس میان شما نیست. این نمادها از کلید خودِ همین تماس ساخته می‌شوند، پس سرویسی که وسط تماس بایستد هم آن‌ها را عوض می‌کند. اگر فرق داشتند، تماس را قطع کنید.',
      'If they match on both phones, nobody is in the middle. They are made from this call\'s own encryption keys, so a server standing inside the call changes them as well. If they differ, hang up.',
    ))}</p>
    <div class="chat-call-verify-grid">
      ${picks.map((pick) => `<span><b>${pick.e}</b><i>${app().escapeHTML(t(pick.fa, pick.en))}</i></span>`).join('')}
    </div>
    <button type="button" class="chat-call-verify-confirm ${verified ? 'is-verified' : ''}" data-verify-toggle="${app().escapeHTML(remoteFp)}">
      <i class="fas ${verified ? 'fa-circle-check' : 'fa-circle-question'}"></i>
      <span>${app().escapeHTML(verified ? t('تأییدشده — لغو تأیید', 'Verified — undo') : t('یکی بودند، تأیید می‌کنم', 'They matched — mark verified'))}</span>
    </button>`;
}

function verifiedPeers() {
  const stored = loadEncrypted('poorija_chat_verified', null);
  return stored && typeof stored === 'object' ? stored : {};
}
function isPeerVerified(fingerprint) {
  return Boolean(fingerprint && verifiedPeers()[fingerprint]);
}
function setPeerVerified(fingerprint, verified) {
  const map = verifiedPeers();
  if (verified) map[fingerprint] = new Date().toISOString();
  else delete map[fingerprint];
  saveEncrypted('poorija_chat_verified', map);
  renderActivePeer();
  renderSafetyPanel();
}
async function renderSafetyPanel() {
  const panel = document.getElementById('chatSafetyPanel');
  if (!panel || panel.classList.contains('hidden')) return;
  const peer = activePeer();
  const localFp = chatState.identity?.fingerprint || '';
  /* While a key change is pending, the number that must be compared is the
     NEW key's — the friend's fresh install shows the number of their new key,
     and comparing against the pinned old one here would report a mismatch
     between two honest devices. */
  const offeredFp = (peer?.keyChangedAt && peer?.pendingFingerprint) ? peer.pendingFingerprint : '';
  const remoteFp = offeredFp || peer?.fingerprint || '';
  const code = await safetyNumber(localFp, remoteFp);
  const verified = isPeerVerified(remoteFp);
  panel.innerHTML = `
    <div class="chat-safety-backdrop" data-safety-close></div>
    <section class="chat-safety-card" role="dialog" aria-modal="true">
      <header>
        <h4>${app().escapeHTML(t('تأیید کلید', 'Verify the key'))}</h4>
        <button type="button" data-safety-close aria-label="${app().escapeHTML(t('بستن', 'Close'))}"><i class="fas fa-xmark"></i></button>
      </header>
      ${offeredFp ? `
        <p class="chat-safety-hint chat-safety-hint-pending">${app().escapeHTML(t(
          'این شمارهٔ کلید تازه‌ای است که هنوز نپذیرفته‌اید — همان چیزی که روی نصب جدید خودِ او دیده می‌شود. با آن مقایسه کنید.',
          'This is the number of the new key you have not accepted yet — the same one shown on their fresh install. Compare against that one.',
        ))}</p>
      ` : ''}
      ${code ? `
        <p class="chat-safety-hint">${app().escapeHTML(t(
          'این کد روی هر دو دستگاه باید یکسان باشد. آن را از راهی جز همین برنامه با هم بسنجید — تماس تلفنی، یا رو در رو.',
          'This code must match on both devices. Compare it over some channel other than this app — a phone call, or in person.',
        ))}</p>
        <div class="chat-safety-emoji" title="${app().escapeHTML(t('همان شش نمادی که هنگام تماس نشان داده می‌شود', 'The same six symbols shown during a call'))}">${(await verificationEmoji(localFp, remoteFp)).map((pick) => `<span><b>${pick.e}</b><i>${app().escapeHTML(t(pick.fa, pick.en))}</i></span>`).join('')}</div>
        <div class="chat-safety-words">${code.words.map((word) => `<span>${app().escapeHTML(word)}</span>`).join('')}</div>
        <div class="chat-safety-digits" dir="ltr">${code.digits.map((group) => `<span>${group}</span>`).join('')}</div>
        <div class="chat-safety-state ${verified ? 'is-verified' : ''}">
          <i class="fas ${verified ? 'fa-circle-check' : 'fa-circle-question'}"></i>
          <span>${app().escapeHTML(verified ? t('این مخاطب تأیید شده است.', 'This contact is verified.') : t('هنوز تأیید نشده.', 'Not verified yet.'))}</span>
        </div>
        <button type="button" data-safety-toggle="${app().escapeHTML(remoteFp)}" class="chat-safety-btn ${verified ? 'is-undo' : ''}">
          ${app().escapeHTML(verified ? t('لغو تأیید', 'Remove verification') : t('کد یکسان است — تأیید می‌کنم', 'The codes match — mark verified'))}
        </button>`
      : `<p class="chat-safety-hint">${app().escapeHTML(t('برای این گفتگو کلیدی در دسترس نیست.', 'No key is available for this conversation.'))}</p>`}
    </section>`;
  /* The scan-to-verify half (48-key-verify.js). */
  if (code && typeof decorateSafetyPanel === 'function') decorateSafetyPanel(panel, { localFp, remoteFp, offeredFp, peer });
  /* Whether their key is in their relay's transparency log (66-key-transparency.js). */
  if (code && !offeredFp && typeof decorateKeyLog === 'function') decorateKeyLog(panel, peer);
}
/* .chat-shell is overflow:hidden, which clips a fixed-position child however
   high its z-index is. Both the group panel and the rules dialog hit this and
   were moved to the body; this one was still inside, so pressing "verify key"
   opened a panel nobody could see. */
function portalToBody(id) {
  const node = document.getElementById(id);
  if (node && node.parentElement !== document.body) document.body.appendChild(node);
  return node;
}
function openSafetyPanel() {
  if (!activePeer()) {
    notify(t('اول یک گفتگوی مستقیم را باز کنید.', 'Open a direct conversation first.'), 'warning');
    return;
  }
  portalToBody('chatSafetyPanel')?.classList.remove('hidden');
  renderSafetyPanel().catch(console.error);
}
function closeSafetyPanel() {
  document.getElementById('chatSafetyPanel')?.classList.add('hidden');
}

/* ---- published to globalThis (roadmap 2.1, tools/esm-chat.cjs) ---- */
Object.defineProperties(globalThis, {
  "SAS_EMOJI": { get() { return SAS_EMOJI; }, set() { throw new TypeError('Assignment to constant variable SAS_EMOJI.'); }, configurable: true },
  "SAS_DOMAIN": { get() { return SAS_DOMAIN; }, set() { throw new TypeError('Assignment to constant variable SAS_DOMAIN.'); }, configurable: true },
  "SAS_LENGTH": { get() { return SAS_LENGTH; }, set() { throw new TypeError('Assignment to constant variable SAS_LENGTH.'); }, configurable: true },
  "callTransportFingerprints": { get() { return callTransportFingerprints; }, set(value) { callTransportFingerprints = value; }, configurable: true },
  "verificationEmoji": { get() { return verificationEmoji; }, set(value) { verificationEmoji = value; }, configurable: true },
  "syncCallVerification": { get() { return syncCallVerification; }, set(value) { syncCallVerification = value; }, configurable: true },
  "verifiedPeers": { get() { return verifiedPeers; }, set(value) { verifiedPeers = value; }, configurable: true },
  "isPeerVerified": { get() { return isPeerVerified; }, set(value) { isPeerVerified = value; }, configurable: true },
  "setPeerVerified": { get() { return setPeerVerified; }, set(value) { setPeerVerified = value; }, configurable: true },
  "renderSafetyPanel": { get() { return renderSafetyPanel; }, set(value) { renderSafetyPanel = value; }, configurable: true },
  "portalToBody": { get() { return portalToBody; }, set(value) { portalToBody = value; }, configurable: true },
  "openSafetyPanel": { get() { return openSafetyPanel; }, set(value) { openSafetyPanel = value; }, configurable: true },
  "closeSafetyPanel": { get() { return closeSafetyPanel; }, set(value) { closeSafetyPanel = value; }, configurable: true },
});
