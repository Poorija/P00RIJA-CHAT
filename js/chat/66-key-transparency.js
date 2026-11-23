/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* ============================================================================
   Key transparency, in the app (roadmap 1.4, release 2.10)
   ============================================================================

   Every relay keeps an append-only log of the v4 keys it has seen proven, and
   signs its head (scripts/lib/key-log.js, docs/design/1.4-key-transparency.md).
   Here the app:

     - checks a contact's keys against the log of the relay that is their home
       (PoorijaKeyLog.check: the head is signed by the relay key the app
       pinned, it extends the last head this device saw of that relay, and the
       keys are in it), and keeps the answer on the contact as `keyLog`;
     - says so in the safety panel: logged, not yet logged, or that the relay
       showed two different logs (which is the lie this exists to catch);
     - checks its own fingerprint now and then on its own relay: a key there
       this device does not hold is somebody having registered under its name;
     - before a large file or a screen share to a contact whose safety number
       has not been compared, shows one line above the composer that says so,
       with "Compare now" and "Not now". It informs; it never blocks.
   ============================================================================ */

const KT_RECHECK_MS = 12 * 60 * 60 * 1000;
const KT_LARGE_FILE_BYTES = 10 * 1024 * 1024;
const KT_SNOOZE_MS = 24 * 60 * 60 * 1000;
const ktInFlight = new Map();
/* The answers, per contact fingerprint, encrypted with the other stores (a
   contact record is rebuilt from a fixed list of fields, so the answer is not
   kept on it). */
const KT_STORE_KEY = 'poorija_chat_kt_contacts';
let ktResults = null;
function ktStore() {
  if (!ktResults) ktResults = loadEncrypted(KT_STORE_KEY, {}) || {};
  return ktResults;
}
window.addEventListener('poorija:lock', () => { ktResults = null; });
function keyLogOf(peer) { return peer?.fingerprint ? ktStore()[peer.fingerprint] || null : null; }

function ktKeysOf(peer) {
  const sk = String(peer?.publicKeyData || '');
  if (!sk || typeof PoorijaIdentity === 'undefined' || PoorijaIdentity.keyKind(sk) !== 'v4') return null;
  return { fp: String(peer.fingerprint || ''), sk, ak: String(peer.agreeKey || ''), akSig: String(peer.agreeKeySig || '') };
}
/* The relay to ask: the contact's home as their card or presence named it,
   with the key the id is the hash of; this device's own relay otherwise (the
   one that served the key in presence). */
function ktRelayFor(peer) {
  const home = peer?.homeRelay;
  if (home?.origin && home.id && home.key) return { origin: home.origin, pin: { id: home.id, key: home.key } };
  const origin = typeof chatServerOrigin === 'function' ? chatServerOrigin() : '';
  const pinned = origin && typeof relayPinFor === 'function' ? relayPinFor(origin) : null;
  return pinned?.id && pinned?.publicKey ? { origin, pin: { id: pinned.id, key: pinned.publicKey } } : null;
}

/* Checks one contact, at most every twelve hours unless `force`. */
async function checkContactKeyLog(peer, { force = false } = {}) {
  if (typeof PoorijaKeyLog === 'undefined' || !peer?.fingerprint) return null;
  const keys = ktKeysOf(peer);
  if (!keys) return null;
  const kept = keyLogOf(peer);
  if (!force && kept?.checkedAt && Date.now() - kept.checkedAt < KT_RECHECK_MS && kept.sk === keys.sk) return kept;
  const relay = ktRelayFor(peer);
  if (!relay) return null;
  const key = `${peer.fingerprint}|${relay.origin}`;
  if (ktInFlight.has(key)) return ktInFlight.get(key);
  const job = (async () => {
    const verdict = await PoorijaKeyLog.check(relay.origin, relay.pin, keys);
    if (verdict.state === 'error') return kept || null;
    const result = { state: verdict.state, relayId: relay.pin.id, sk: keys.sk, checkedAt: Date.now(), size: verdict.head?.size || 0 };
    ktStore()[peer.fingerprint] = result;
    saveEncrypted(KT_STORE_KEY, ktStore());
    if (verdict.state === 'forked' || verdict.state === 'mismatch') {
      notify(verdict.state === 'forked'
        ? t('رلهٔ مخاطب دو فهرست متفاوت از کلیدها نشان داده است. پیش از ادامه، شمارهٔ امنیتی را با او مقایسه کنید.', 'Your contact\'s relay has shown two different key logs. Compare the safety number with them before going on.')
        : t('کلید این مخاطب با کلیدی که رلهٔ او ثبت کرده نمی‌خواند. شمارهٔ امنیتی را با او مقایسه کنید.', 'This contact\'s key does not match the one their relay logged. Compare the safety number with them.'), 'warning');
    }
    if (typeof renderSafetyPanel === 'function') renderSafetyPanel().catch(() => {});
    return result;
  })().finally(() => ktInFlight.delete(key));
  ktInFlight.set(key, job);
  return job;
}

/* This device's own keys on its own relay. A key logged under its fingerprint
   that it does not hold is the one thing a log of this kind can tell a person
   about themselves. Once a day. */
async function checkOwnKeyLog() {
  if (typeof PoorijaKeyLog === 'undefined' || !chatState.identity?.fingerprint) return;
  const own = ktKeysOf(ownIdentityRecord());
  if (!own) return;
  if (Date.now() - (Number(chatState.profile.keyLogSelfAt) || 0) < 24 * 60 * 60 * 1000) return;
  const relay = ktRelayFor({});
  if (!relay) return;
  const verdict = await PoorijaKeyLog.check(relay.origin, relay.pin, own);
  if (verdict.state === 'error' || verdict.state === 'unsupported') return;
  chatState.profile.keyLogSelfAt = Date.now();
  saveEncrypted(CHAT_PROFILE_STORAGE_KEY, chatState.profile);
  if (verdict.otherKeys || verdict.state === 'mismatch') {
    notify(t('رلهٔ شما کلید دیگری هم به نام شما ثبت کرده است. اگر دستگاه تازه‌ای نساخته‌اید، کسی به نام شما ثبت‌نام کرده است.', 'Your relay has logged another key under your name. If you did not set up a new device, someone has registered as you.'), 'warning');
  }
  if (verdict.state === 'forked') {
    notify(t('رلهٔ شما دو فهرست متفاوت از کلیدها نشان داده است.', 'Your relay has shown two different key logs.'), 'warning');
  }
}

/* ---- the line in the safety panel ------------------------------------------ */

function keyLogLine(peer) {
  const state = keyLogOf(peer)?.state || '';
  const lines = {
    logged: ['is-verified', 'fa-list-check', t('کلید او در فهرست شفافیت رلهٔ او ثبت است و فهرست دست‌کاری نشده.', 'Their key is in their relay\'s transparency log, and the log has not been rewritten.')],
    'not-logged': ['', 'fa-hourglass-half', t('کلید او هنوز در فهرست رلهٔ او ثبت نشده (رلهٔ قدیمی‌تر یا کلید تازه).', 'Their key is not in their relay\'s log yet (an older relay, or a new key).')],
    unsupported: ['', 'fa-circle-info', t('رلهٔ او هنوز فهرست شفافیت کلید ندارد.', 'Their relay does not keep a key transparency log yet.')],
    mismatch: ['is-warning', 'fa-triangle-exclamation', t('کلیدی که رلهٔ او ثبت کرده با کلید او یکی نیست.', 'The key their relay logged is not the key you have for them.')],
    forked: ['is-warning', 'fa-triangle-exclamation', t('رلهٔ او دو فهرست متفاوت نشان داده است: ممکن است کسی میان شما باشد.', 'Their relay has shown two different logs: someone may be in between.')],
  };
  const pick = lines[state];
  if (!pick) return '';
  const [cls, icon, text] = pick;
  return `<div class="chat-safety-state chat-safety-keylog ${cls}" data-safety-keylog="${app().escapeHTML(state)}"><i class="fas ${icon}"></i><span>${app().escapeHTML(text)}</span></div>`;
}
function decorateKeyLog(panel, peer) {
  const card = panel?.querySelector('.chat-safety-card');
  if (!card || card.querySelector('[data-safety-keylog]')) return;
  const html = keyLogLine(peer);
  const anchor = card.querySelector('.chat-safety-state');
  if (html && anchor) anchor.insertAdjacentHTML('afterend', html);
  if (peer && !keyLogOf(peer)) checkContactKeyLog(peer).catch(() => {});
}

/* ---- the banner -------------------------------------------------------------- */

function keyBannerSnoozed(fp) {
  const until = Number((chatState.profile.keyBannerSnooze || {})[fp]) || 0;
  return until > Date.now();
}
/* Before something that matters more than a message: shows the line once for
   this contact and returns at once (the action goes on). `what` is 'file' or
   'screen'. */
function noteHighRiskAction(peer, what, size = 0) {
  if (!peer?.fingerprint || peer.isGroup || peer.isSelf) return;
  if (what === 'file' && !(size > KT_LARGE_FILE_BYTES)) return;
  if (typeof isPeerVerified === 'function' && isPeerVerified(peer.fingerprint)) return;
  if (keyBannerSnoozed(peer.fingerprint)) return;
  showKeyBanner(peer);
}
function showKeyBanner(peer) {
  const composer = document.getElementById('chatComposer');
  const holder = composer?.closest('.chat-composer, .chat-composer-wrap, form') || composer?.parentElement;
  if (!holder?.parentElement) return;
  let banner = document.getElementById('chatKeyBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'chatKeyBanner';
    banner.className = 'chat-key-banner';
    banner.setAttribute('role', 'status');
    holder.parentElement.insertBefore(banner, holder);
  }
  const name = peer.displayName || peer.username || t('این مخاطب', 'this contact');
  banner.dataset.fp = peer.fingerprint;
  banner.innerHTML = `<i class="fas fa-shield-halved" aria-hidden="true"></i>`
    + `<span>${app().escapeHTML(t(`شمارهٔ امنیتی را با ${name} مقایسه نکرده‌اید. برای اطمینان از اینکه کسی میان شما نیست، آن را مقایسه کنید.`, `You have not compared the safety number with ${name}. Compare it to be sure no one is in between.`))}</span>`
    + `<button type="button" class="chat-soft-btn" data-key-banner-compare>${app().escapeHTML(t('الان مقایسه کن', 'Compare now'))}</button>`
    + `<button type="button" class="chat-soft-btn" data-key-banner-later>${app().escapeHTML(t('بعداً', 'Not now'))}</button>`;
  banner.hidden = false;
}
function hideKeyBanner() {
  const banner = document.getElementById('chatKeyBanner');
  if (banner) banner.hidden = true;
}
document.addEventListener('click', (event) => {
  if (event.target?.closest?.('[data-key-banner-compare]')) {
    hideKeyBanner();
    if (typeof openSafetyPanel === 'function') openSafetyPanel();
    return;
  }
  if (event.target?.closest?.('[data-key-banner-later]')) {
    const fp = document.getElementById('chatKeyBanner')?.dataset.fp || '';
    if (fp) {
      chatState.profile.keyBannerSnooze = { ...(chatState.profile.keyBannerSnooze || {}), [fp]: Date.now() + KT_SNOOZE_MS };
      saveEncrypted(CHAT_PROFILE_STORAGE_KEY, chatState.profile);
    }
    hideKeyBanner();
  }
});
/* Another conversation opened: the line was about the one before. */
let ktBannerConversation = '';
window.setInterval(() => {
  const now = chatState.activeConversationId || '';
  if (now !== ktBannerConversation) { ktBannerConversation = now; hideKeyBanner(); }
}, 1000);

/* ---- now and then ---------------------------------------------------------- */

function sweepKeyLogs() {
  if (typeof chatState !== 'object' || !chatState?.peers) return;
  const peers = (Array.isArray(chatState.peers) ? chatState.peers : []).filter((peer) => ktKeysOf(peer));
  let delay = 0;
  for (const peer of peers.slice(0, 50)) {
    delay += 1500;
    window.setTimeout(() => checkContactKeyLog(peer).catch(() => {}), delay);
  }
  window.setTimeout(() => checkOwnKeyLog().catch(() => {}), delay + 1500);
}
window.setTimeout(sweepKeyLogs, 20 * 1000);
window.setInterval(sweepKeyLogs, 60 * 60 * 1000);

/* ---- published to globalThis (roadmap 2.1, tools/esm-chat.cjs) ---- */
Object.defineProperties(globalThis, {
  "KT_RECHECK_MS": { get() { return KT_RECHECK_MS; }, set() { throw new TypeError('Assignment to constant variable KT_RECHECK_MS.'); }, configurable: true },
  "KT_LARGE_FILE_BYTES": { get() { return KT_LARGE_FILE_BYTES; }, set() { throw new TypeError('Assignment to constant variable KT_LARGE_FILE_BYTES.'); }, configurable: true },
  "KT_SNOOZE_MS": { get() { return KT_SNOOZE_MS; }, set() { throw new TypeError('Assignment to constant variable KT_SNOOZE_MS.'); }, configurable: true },
  "ktInFlight": { get() { return ktInFlight; }, set() { throw new TypeError('Assignment to constant variable ktInFlight.'); }, configurable: true },
  "KT_STORE_KEY": { get() { return KT_STORE_KEY; }, set() { throw new TypeError('Assignment to constant variable KT_STORE_KEY.'); }, configurable: true },
  "ktResults": { get() { return ktResults; }, set(value) { ktResults = value; }, configurable: true },
  "ktStore": { get() { return ktStore; }, set(value) { ktStore = value; }, configurable: true },
  "keyLogOf": { get() { return keyLogOf; }, set(value) { keyLogOf = value; }, configurable: true },
  "ktKeysOf": { get() { return ktKeysOf; }, set(value) { ktKeysOf = value; }, configurable: true },
  "ktRelayFor": { get() { return ktRelayFor; }, set(value) { ktRelayFor = value; }, configurable: true },
  "checkContactKeyLog": { get() { return checkContactKeyLog; }, set(value) { checkContactKeyLog = value; }, configurable: true },
  "checkOwnKeyLog": { get() { return checkOwnKeyLog; }, set(value) { checkOwnKeyLog = value; }, configurable: true },
  "keyLogLine": { get() { return keyLogLine; }, set(value) { keyLogLine = value; }, configurable: true },
  "decorateKeyLog": { get() { return decorateKeyLog; }, set(value) { decorateKeyLog = value; }, configurable: true },
  "keyBannerSnoozed": { get() { return keyBannerSnoozed; }, set(value) { keyBannerSnoozed = value; }, configurable: true },
  "noteHighRiskAction": { get() { return noteHighRiskAction; }, set(value) { noteHighRiskAction = value; }, configurable: true },
  "showKeyBanner": { get() { return showKeyBanner; }, set(value) { showKeyBanner = value; }, configurable: true },
  "hideKeyBanner": { get() { return hideKeyBanner; }, set(value) { hideKeyBanner = value; }, configurable: true },
  "ktBannerConversation": { get() { return ktBannerConversation; }, set(value) { ktBannerConversation = value; }, configurable: true },
  "sweepKeyLogs": { get() { return sweepKeyLogs; }, set(value) { sweepKeyLogs = value; }, configurable: true },
});
