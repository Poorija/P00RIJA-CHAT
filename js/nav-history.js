/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* =====================================================================
   Back and forward, the way the phone means them
   ---------------------------------------------------------------------
   The app moved between its screens — the chats list, a conversation, a page
   of Settings, a call — by showing and hiding things, and told the browser
   nothing. So the browser had one history entry, and the system's back gesture
   (Android's swipe from the edge, the hardware button, a browser's back
   arrow, iOS's edge swipe) had nowhere to go in the app and left it.

   Every screen change is now also a history entry, and a back or forward
   restores the screen that entry stands for:

     screen = the app tab; in the chat, which list and — on a phone, where the
              conversation is a screen of its own — which conversation; in
              Settings, the stack of pages.

   What is ON a screen — a sheet, a viewer, a dialog, the call in full screen —
   is not a screen, and a back with one of those open closes it and goes
   nowhere (closeTopOverlay). A call being on screen is never ended by a back:
   the call goes to its small window, the way a messenger does.

   At the first screen there is no entry before it, so the same gesture is what
   closes the app — which is what it should do there.

   iOS in a home-screen app or in the native shell has no edge swipe of its own
   to call history, so one is drawn here: from the left edge to the right is
   back, from the right edge to the left is forward. Everywhere else the system
   already sends one, and a second recogniser would run the move twice.
   ===================================================================== */
(function (global) {
  'use strict';

  const app = () => global.PoorijaApp;
  const SESSION = Math.random().toString(36).slice(2, 10);
  const screens = new Map();
  let seq = 0;
  let currentN = 0;
  let currentKey = '';
  let applying = false;
  let ready = false;
  let canForward = false;
  let commitTimer = 0;

  const compact = () => Boolean(global.matchMedia?.('(max-width: 1023px)').matches);
  const chat = () => (typeof chatState === 'object' && chatState ? chatState : null);
  const pages = () => global.PoorijaSettingsPages || null;
  const unlocked = () => {
    try { return typeof vaultLockState === 'function' ? Boolean(vaultLockState().unlocked) : true; } catch (_error) { return true; }
  };

  /* ---- what a screen is -------------------------------------------------- */

  function snapshot() {
    const tab = app()?.state?.activeTab || 'chat';
    const screen = { tab };
    const st = chat();
    if (tab === 'chat' && st) {
      screen.view = st.activeView || 'chats';
      if (compact() && st.activeConversationId && typeof getActiveConversation === 'function' && getActiveConversation()) {
        screen.conv = st.activeConversationId;
      }
    }
    /* The picker for one value ('choice') is a layer on a page, not a page. */
    if (tab === 'settings') screen.pages = (pages()?.stack?.() || ['root']).filter((id) => id !== 'choice');
    return screen;
  }
  const keyOf = (screen) => JSON.stringify(screen);

  /* ---- recording --------------------------------------------------------- */

  /* Called by the shell after anything that may have changed the screen. One
     gesture reaches it several times (a tab, then a view, then a thread), so
     it waits for the dust to settle and records where things ended up. */
  function note() {
    if (!ready || applying) return;
    global.clearTimeout(commitTimer);
    commitTimer = global.setTimeout(commit, 80);
  }

  function commit() {
    if (!ready || applying) return;
    const screen = snapshot();
    const key = keyOf(screen);
    if (key === currentKey) return;
    seq += 1;
    screens.set(seq, screen);
    try {
      history.pushState({ poorijaNav: seq, session: SESSION }, '', `#${screen.tab}`);
    } catch (_error) { return; }
    currentN = seq;
    currentKey = key;
    canForward = false;
  }

  /* ---- what sits on top of a screen --------------------------------------- */

  const visible = (node) => Boolean(node) && !node.classList.contains('hidden') && node.getBoundingClientRect().height > 0;

  function closeTopOverlay() {
    const dialog = document.querySelector('.poorija-dialog-backdrop:not(.hidden)');
    if (dialog) {
      (dialog.querySelector('.poorija-dialog-cancel:not(.hidden)') || dialog.querySelector('.poorija-dialog-ok'))?.click();
      return true;
    }
    if (global.PoorijaMessenger?.hasMenu?.()) { global.PoorijaMessenger.closeMenu(false); return true; }
    if (typeof videoViewer !== 'undefined' && videoViewer && typeof closeVideoViewer === 'function') { closeVideoViewer(); return true; }
    if (typeof photoViewer !== 'undefined' && photoViewer && typeof closePhotoViewer === 'function') { closePhotoViewer(); return true; }
    if (typeof peerPhotoCardElement !== 'undefined' && peerPhotoCardElement && typeof closePeerPhotoCard === 'function') { closePeerPhotoCard(); return true; }
    if (typeof packManagerElement !== 'undefined' && packManagerElement && typeof closePackManager === 'function') { closePackManager(); return true; }
    if (document.getElementById('chatScheduleModal') && typeof closeScheduleModal === 'function') { closeScheduleModal(); return true; }
    if (visible(document.getElementById('chatFullSheet')) && typeof closeFullSheet === 'function') { closeFullSheet(); return true; }
    if (visible(document.getElementById('chatSearchOverlay')) && typeof closeFullSearch === 'function') { closeFullSearch(); return true; }
    if (visible(document.getElementById('chatStartChatModal')) && typeof closeStartChatModal === 'function') { closeStartChatModal(); return true; }
    if (visible(document.getElementById('chatSafetyPanel')) && typeof closeSafetyPanel === 'function') { closeSafetyPanel(); return true; }
    if (app()?.state?.activeTab === 'settings' && pages()?.current?.() === 'choice') { pages().back(); global.PoorijaMessenger?.sync?.(); return true; }
    const st = chat();
    if (st?.selectionMode && typeof exitSelectionMode === 'function') { exitSelectionMode(); return true; }
    /* A call in full screen goes to its small window; it is never hung up by
       a back. */
    const call = document.getElementById('chatFloatingCall');
    if (st?.currentCall && call && visible(call) && !call.classList.contains('is-minimized')) {
      document.getElementById('chatMinimizeCallBtn')?.click();
      return true;
    }
    return false;
  }

  /* ---- going to a screen -------------------------------------------------- */

  function openConversationKey(key) {
    const st = chat();
    if (!st || typeof conversationRecordById !== 'function') return;
    const record = conversationRecordById(key);
    if (!record) return;
    st.activePeerClientId = record.clientId || '';
    st.activeConversationId = getConversationKey(record);
    if (typeof updateChatShellMode === 'function') updateChatShellMode();
    if (typeof renderPeers === 'function') renderPeers();
    if (typeof renderActivePeer === 'function') renderActivePeer();
    if (typeof renderMessages === 'function') renderMessages();
  }

  function closeConversation() {
    const st = chat();
    if (!st) return;
    st.activePeerClientId = '';
    st.activeConversationId = '';
    if (typeof updateChatShellMode === 'function') updateChatShellMode();
    if (typeof renderPeers === 'function') renderPeers();
    if (typeof renderActivePeer === 'function') renderActivePeer();
  }

  function applyScreen(screen) {
    const st = chat();
    if (app()?.state?.activeTab !== screen.tab) global.switchTab?.(screen.tab, { updateHash: false });
    if (screen.tab === 'chat' && st) {
      const view = screen.view || 'chats';
      if (st.activeView !== view && typeof global.setChatView === 'function') global.setChatView(view);
      if (screen.conv) {
        if (st.activeConversationId !== screen.conv) openConversationKey(screen.conv);
      } else if (compact() && st.activeConversationId) {
        closeConversation();
      }
    }
    if (screen.tab === 'settings') pages()?.restore?.(screen.pages || ['root']);
    global.PoorijaMessenger?.sync?.();
  }

  /* ---- the browser's back and forward ------------------------------------- */

  /* Step the browser back to the entry the person was on, for the cases where
     the move it just made is not one to follow. The entry it left is still
     there to return to, so nothing is added to the history. */
  let undoing = false;
  function undoStep(wentBack) {
    undoing = true;
    global.setTimeout(() => { undoing = false; }, 600);
    if (wentBack) global.history.forward(); else global.history.back();
  }

  function onPop(event) {
    if (!ready) return;
    if (undoing) { undoing = false; return; }
    const state = event.state;
    const mine = state && state.session === SESSION && screens.has(state.poorijaNav);
    const n = mine ? state.poorijaNav : 0;
    const wentBack = n <= currentN;
    /* A back with something open on the screen closes that and stays on the
       screen. */
    if (closeTopOverlay()) { undoStep(wentBack); return; }
    if (!unlocked()) { undoStep(wentBack); return; }
    const screen = screens.get(n);
    if (!screen) return;
    canForward = n < currentN || (wentBack && n < seq);
    applying = true;
    global.clearTimeout(commitTimer);
    try { applyScreen(screen); } catch (error) { console.warn('[nav] could not restore the screen', error); }
    currentN = n;
    global.setTimeout(() => {
      applying = false;
      currentKey = keyOf(snapshot());
    }, 140);
  }

  /* ---- iOS: an edge swipe that calls history ------------------------------- */

  function wantsOwnSwipe() {
    const ua = global.navigator?.userAgent || '';
    const ios = /iP(hone|ad|od)/.test(ua) || (global.navigator?.platform === 'MacIntel' && (global.navigator?.maxTouchPoints || 0) > 1);
    if (!ios) return false;
    const standalone = global.navigator?.standalone === true || global.matchMedia?.('(display-mode: standalone)').matches;
    return Boolean(standalone || global.__TAURI__ || global.__TAURI_INTERNALS__);
  }

  function wireEdgeSwipe() {
    const EDGE = 24;
    let start = null;
    global.addEventListener('touchstart', (event) => {
      if (event.touches.length !== 1) { start = null; return; }
      const touch = event.touches[0];
      const width = global.innerWidth;
      if (touch.clientX <= EDGE) start = { x: touch.clientX, y: touch.clientY, at: Date.now(), side: 'left' };
      else if (touch.clientX >= width - EDGE) start = { x: touch.clientX, y: touch.clientY, at: Date.now(), side: 'right' };
      else start = null;
    }, { passive: true });
    global.addEventListener('touchend', (event) => {
      if (!start) return;
      const touch = event.changedTouches[0];
      const dx = touch.clientX - start.x;
      const dy = Math.abs(touch.clientY - start.y);
      const quick = Date.now() - start.at < 700;
      const side = start.side;
      start = null;
      if (!quick || dy > 70) return;
      if (side === 'left' && dx > 70) global.history.back();
      else if (side === 'right' && dx < -70 && canForward) global.history.forward();
    }, { passive: true });
    global.addEventListener('touchcancel', () => { start = null; }, { passive: true });
  }

  /* ---- starting ----------------------------------------------------------- */

  function start() {
    if (ready) return;
    const screen = snapshot();
    screens.set(0, screen);
    currentKey = keyOf(screen);
    try {
      /* The entry the app was opened on is the first screen; a back from it is
         the one that leaves. */
      history.replaceState({ poorijaNav: 0, session: SESSION }, '', location.hash || `#${screen.tab}`);
    } catch (_error) { return; }
    ready = true;
    global.addEventListener('popstate', onPop);
    if (wantsOwnSwipe()) wireEdgeSwipe();
  }

  /* After the shell has drawn its first screen, so the first entry is the
     screen the person sees and not the one before it. */
  function begin() { global.setTimeout(start, 600); }
  if (document.readyState === 'complete') begin();
  else global.addEventListener('load', begin);

  global.PoorijaNav = {
    note,
    snapshot,
    /* app.js leaves the address alone while this is true: it used to rewrite
       the current entry's address on every tab change, which is the entry the
       person is leaving. */
    get active() { return ready; },
    canForward: () => canForward,
    back: () => global.history.back(),
    forward: () => global.history.forward(),
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
