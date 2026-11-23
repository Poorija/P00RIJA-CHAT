/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* ============================================================================
   The first good path, in under a second (roadmap 3.3)
   ============================================================================

   A relay may be reachable at several addresses: its own, the mirrors it
   publishes (52-relay-mirrors.js) and the front doors another relay of the
   family keeps. Until now the others were tried only after the main address
   had been silent for 25 seconds, and then one after another, each with an
   eight-second proof: a blocked main address cost the person most of a minute,
   every time, on every reload.

   Now, whenever the app connects and the address it used last is not known to
   be good, every address it knows for its own relay is asked at once for the
   relay's health; the first one that answers within the race window is used,
   and the address that is up is remembered (for the next reload) so the race
   is not run again while it keeps working. The race only decides which
   address to try first. Nothing is believed on the strength of an answer:
     - an address other than the configured one must still prove it reaches
       the relay's own key (proveRelayAt, the nonce sealed to the pinned key)
       before anything goes to it;
     - the relay key is the one this device pinned; an answer from an address
       that names another relay id is not counted.

   What a browser can do and this does: WebSocket over ordinary TLS on 443-
   style ports, several fronts, a parallel race. What it cannot: choose ALPN,
   speak QUIC from page code, set ECH — those are the relay proxy's to do.
   ============================================================================ */

const RACE_WINDOW_MS = 800;
const RACE_TIMEOUT_MS = 4000;
const RACE_GOOD_FOR_MS = 10 * 60 * 1000;

/* Every address this device knows for its relay, configured first. */
function raceCandidates() {
  const configured = configuredRelayOrigin();
  const pin = relayPinFor(configured) || relayPinFor(chatServerOrigin());
  if (!pin?.id) return { pin: null, origins: [configured] };
  const mirrors = typeof knownMirrorsFor === 'function' ? knownMirrorsFor(pin.id) : [];
  const doors = (chatState.profile.knownFrontDoors?.[pin.id] || []).filter((origin) => typeof origin === 'string');
  return { pin, origins: Array.from(new Set([configured, ...mirrors, ...doors])) };
}

/* One address: its /chat-health, with how long it took. A relay that names
   another id there is not this relay (whatever the address says). */
async function raceOne(origin, pin, signal) {
  const started = performance.now();
  try {
    const response = await fetch(new URL('/chat-health', origin), { mode: 'cors', cache: 'no-store', signal });
    if (!response.ok) return null;
    const body = await response.json();
    if (pin?.id && body?.relayId && body.relayId !== pin.id) return null;
    return { origin, ms: performance.now() - started };
  } catch (_error) {
    return null;
  }
}

/* The race. Resolves with the first address that answers, or, if none does
   within the window, the first of any that answers before the timeout; null
   when none does. */
async function raceRelayPaths({ windowMs = RACE_WINDOW_MS, timeoutMs = RACE_TIMEOUT_MS } = {}) {
  const { pin, origins } = raceCandidates();
  if (origins.length < 2) return origins[0] ? { origin: origins[0], ms: 0, alone: true } : null;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const answers = origins.map((origin) => raceOne(origin, pin, controller.signal));
    const first = await new Promise((resolve) => {
      let left = answers.length;
      answers.forEach((job) => job.then((value) => {
        if (value) resolve(value);
        left -= 1;
        if (!left) resolve(null);
      }));
    });
    if (first) chatState.lastPathRace = { ...first, at: Date.now(), withinWindow: first.ms <= windowMs, tried: origins.length };
    return first;
  } finally {
    window.clearTimeout(timer);
    controller.abort();
  }
}

/* Before a connection: when the address in use is not known to be good, race
   them all and move to the winner (proved first when it is not the configured
   one). Returns true when it changed address. */
async function preferFastestRelayPath() {
  if (chatState.pathRaceRunning) return false;
  const kept = chatState.profile.goodPath;
  const current = chatServerOrigin();
  if (kept?.origin === current && Date.now() - Number(kept.at || 0) < RACE_GOOD_FOR_MS) return false;
  chatState.pathRaceRunning = true;
  try {
    const winner = await raceRelayPaths();
    if (!winner?.origin) return false;
    const configured = configuredRelayOrigin();
    chatState.profile.goodPath = { origin: winner.origin, at: Date.now(), ms: Math.round(winner.ms) };
    saveEncrypted(CHAT_PROFILE_STORAGE_KEY, chatState.profile);
    if (winner.origin === current) return false;
    const { pin } = raceCandidates();
    if (winner.origin !== configured) {
      if (!pin || typeof proveRelayAt !== 'function' || !(await proveRelayAt(winner.origin, pin))) return false;
    }
    if (typeof switchRelayOrigin === 'function') switchRelayOrigin(winner.origin, pin);
    return true;
  } finally {
    chatState.pathRaceRunning = false;
  }
}

/* A connection that is not up a second after it started: race now rather than
   wait out the failover timer. */
window.setInterval(() => {
  if (typeof isUnlocked === 'function' && !isUnlocked()) return;
  if (chatState.manualOffline || chatState.profile?.chatEnabled === false) return;
  if (typeof guestStayActive === 'function' && guestStayActive()) return;
  if (typeof relayTransportUp === 'function' && relayTransportUp()) {
    const current = chatServerOrigin();
    if (chatState.profile.goodPath?.origin !== current) chatState.profile.goodPath = { origin: current, at: Date.now() };
    else chatState.profile.goodPath.at = Date.now();
    return;
  }
  if (!chatState.wsConnectStartedAt || Date.now() - chatState.wsConnectStartedAt < 1000) return;
  if (navigator.onLine === false) return;
  preferFastestRelayPath().catch(() => {});
}, 1500);

window.raceRelayPaths = raceRelayPaths;
window.preferFastestRelayPath = preferFastestRelayPath;

/* ---- published to globalThis (roadmap 2.1, tools/esm-chat.cjs) ---- */
Object.defineProperties(globalThis, {
  "RACE_WINDOW_MS": { get() { return RACE_WINDOW_MS; }, set() { throw new TypeError('Assignment to constant variable RACE_WINDOW_MS.'); }, configurable: true },
  "RACE_TIMEOUT_MS": { get() { return RACE_TIMEOUT_MS; }, set() { throw new TypeError('Assignment to constant variable RACE_TIMEOUT_MS.'); }, configurable: true },
  "RACE_GOOD_FOR_MS": { get() { return RACE_GOOD_FOR_MS; }, set() { throw new TypeError('Assignment to constant variable RACE_GOOD_FOR_MS.'); }, configurable: true },
  "raceCandidates": { get() { return raceCandidates; }, set(value) { raceCandidates = value; }, configurable: true },
  "raceOne": { get() { return raceOne; }, set(value) { raceOne = value; }, configurable: true },
  "raceRelayPaths": { get() { return raceRelayPaths; }, set(value) { raceRelayPaths = value; }, configurable: true },
  "preferFastestRelayPath": { get() { return preferFastestRelayPath; }, set(value) { preferFastestRelayPath = value; }, configurable: true },
});
