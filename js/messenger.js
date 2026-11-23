/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* ============================================================================
   messenger.js — the shell of a messenger around the chat.

   WHAT WAS THERE
   --------------
   The chat came out of an app with two dozen tools, and it still wore that
   app's frame: a sidebar listing the app's tabs, and inside the chat a second
   menu of its own (chats, calls, groups, settings, search) above the list.
   Two menus, one inside the other, and the one that mattered was the smaller.

   WHAT THIS DOES
   --------------
   One bar, at the bottom, with what a messenger has:

       Chats · Calls · Groups · Local · Settings

   The first three are views of the chat (chatState.activeView), the last two
   are tabs of the app (state.activeTab). The bar hides that difference: it
   switches to the right tab and then to the right view. Everything the old
   sidebar reached that is not on the bar — the file manager, the security
   center, migration, help, about — is a row in Settings.

   WHAT IT DOES NOT DO
   -------------------
   It does not own any of the chat's state or redraw any of the chat. It calls
   the same switchTab() and setChatView() the old buttons called, and it reads
   the same two values to know what is lit. The old controls are still in the
   page, hidden by css/messenger.css, because the chat's own code holds on to
   them by id; taking them out is for when that code is cut down.
   ============================================================================ */

(function (global) {
  'use strict';

  const app = () => global.PoorijaApp;
  const el = (id) => document.getElementById(id);
  const fa = () => app()?.state?.language !== 'en';
  const t = (persian, english) => (fa() ? persian : english);
  const esc = (v) => app()?.escapeHTML?.(String(v ?? '')) ?? String(v ?? '');

  /* `view` is a view of the chat; without one the entry is an app tab. */
  const TABS = [
    { id: 'chats', tab: 'chat', view: 'chats', icon: 'fa-comment', fa: 'گفتگوها', en: 'Chats' },
    { id: 'calls', tab: 'chat', view: 'calls', icon: 'fa-phone', fa: 'تماس‌ها', en: 'Calls' },
    { id: 'groups', tab: 'chat', view: 'groups', icon: 'fa-user-group', fa: 'گروه‌ها', en: 'Groups' },
    { id: 'local', tab: 'locallink', icon: 'fa-tower-broadcast', fa: 'محلی', en: 'Local' },
    { id: 'settings', tab: 'settings', icon: 'fa-gear', fa: 'تنظیمات', en: 'Settings' },
  ];

  /* Local is a row of Settings, and a tab of the bar only if the person puts it
     there (Settings, Appearance). It is a tool for a few moments — two phones in
     a room, no internet — not one of the five places a messenger is used all
     day, and a bar of five squeezed the words on it. */
  const BAR_PREF_KEY = 'poorija_msgr_bar';
  function barPrefs() {
    try { const value = JSON.parse(localStorage.getItem(BAR_PREF_KEY) || '{}'); return value && typeof value === 'object' ? value : {}; } catch (_error) { return {}; }
  }
  const localInBar = () => barPrefs().local === true;
  const barTabs = () => TABS.filter((entry) => entry.id !== 'local' || localInBar());
  function setBarTab(id, on) {
    const next = { ...barPrefs(), [id]: Boolean(on) };
    try { localStorage.setItem(BAR_PREF_KEY, JSON.stringify(next)); } catch (_error) { /* private mode: it lasts until the page is closed */ }
    const bar = el('mobileTabBar');
    if (bar) delete bar.dataset.msgrSignature;
    sync();
  }

  /* What Settings leads to. `go` is either an app tab, or a function for the
     two that are screens of the chat itself. */
  const ROWS = [
    { id: 'local', icon: 'fa-tower-broadcast', fa: 'محلی', en: 'Local', tab: 'locallink' },
    { id: 'vault', icon: 'fa-folder-tree', fa: 'مدیریت فایل‌ها', en: 'File manager', tab: 'vault' },
    { id: 'migration', icon: 'fa-right-left', fa: 'مهاجرت و پشتیبان', en: 'Migration and backup', tab: 'migration' },
    { id: 'help', icon: 'fa-circle-question', fa: 'راهنما', en: 'Help', tab: 'help' },
    { id: 'about', icon: 'fa-circle-info', fa: 'درباره من', en: 'About me', tab: 'about' },
  ];

  /* chatState is a top-level const of the chat's scripts: in scope here by name,
     but not a property of window, so it is asked for by name. */
  const chatView = () => (typeof chatState === 'object' && chatState ? chatState.activeView : '') || 'chats';
  const shell = () => document.querySelector('.chat-shell');
  const profileOpen = () => Boolean(shell()?.classList.contains('msgr-profile-open'));

  /* Which entry of the bar is lit. The chat's connection pane and its profile
     screen, and every app tab that is a row in Settings, belong to Settings. */
  function activeId() {
    const tab = app()?.state?.activeTab || 'chat';
    if (tab === 'locallink') return localInBar() ? 'local' : 'settings';
    if (tab !== 'chat') return 'settings';
    if (profileOpen()) return 'settings';
    const view = chatView();
    return ['chats', 'calls', 'groups'].includes(view) ? view : 'settings';
  }

  /* The name on the top bar: where you are, in the words of the bar. */
  const pages = () => global.PoorijaSettingsPages || null;

  function title() {
    const tab = app()?.state?.activeTab || 'chat';
    if (tab === 'settings' && pages()?.depth?.() > 0) return pages().title();
    if (tab === 'chat' && profileOpen()) return t('پروفایل', 'Profile');
    if (tab === 'chat' && chatView() === 'connection') return t('اتصال و تنظیمات چت', 'Connection and chat settings');
    const row = ROWS.find((entry) => entry.tab === tab);
    if (row) return t(row.fa, row.en);
    const entry = TABS.find((item) => item.id === activeId());
    return entry ? t(entry.fa, entry.en) : 'P00RIJA Chat';
  }

  function closeProfile() {
    shell()?.classList.remove('msgr-profile-open');
  }

  /* The profile is a page of Settings, with everything on it. */
  function openProfile() {
    closeProfile();
    if (app()?.state?.activeTab !== 'settings') global.switchTab?.('settings');
    pages()?.reset?.();
    pages()?.open?.('me');
    sync();
  }

  /* To an entry of the bar, and for the chat optionally to a view the bar does
     not carry (its connection pane). */
  function go(id, viewOverride) {
    const entry = TABS.find((item) => item.id === id);
    if (!entry) return;
    closeProfile();
    if (id === 'settings' && app()?.state?.activeTab === 'settings') pages()?.reset?.();
    if (app()?.state?.activeTab !== entry.tab) global.switchTab?.(entry.tab);
    const view = viewOverride || entry.view;
    if (view && typeof global.setChatView === 'function' && chatView() !== view) global.setChatView(view);
    sync();
  }

  function openRow(id) {
    const row = ROWS.find((entry) => entry.id === id);
    if (!row) return;
    if (row.run) { row.run(); return; }
    closeProfile();
    global.switchTab?.(row.tab);
    sync();
  }

  /* ---- drawing ----------------------------------------------------------- */

  function renderBar() {
    const bar = el('mobileTabBar');
    if (!bar) return;
    const lit = activeId();
    const tabs = barTabs();
    const signature = `${fa() ? 'fa' : 'en'}|${tabs.map((entry) => entry.id).join(',')}`;
    if (bar.dataset.msgrSignature !== signature || bar.querySelectorAll('[data-msgr-tab]').length !== tabs.length) {
      const brand = `<div id="msgrDesktopBrand" class="msgr-brand" aria-label="P00RIJA Chat"><img src="assets/pwa-icons/icon-192.png" alt="" draggable="false"><span>CHAT</span></div>`;
      const lens = '<span class="msgr-lens" aria-hidden="true"></span>';
      const actions = `<div class="msgr-rail-bottom"><button id="msgrThemeBtn" type="button" class="msgr-rail-action"><i class="fas fa-moon" aria-hidden="true"></i><span class="msgr-rail-action-label"></span></button><button id="msgrRailProfileBtn" type="button" class="msgr-rail-profile"><span class="msgr-rail-avatar"><img id="msgrRailProfileImage" class="hidden" alt=""><span id="msgrRailProfileInitial">P</span><i class="msgr-rail-presence" aria-hidden="true"></i></span><span id="msgrRailProfileName" class="msgr-rail-action-label"></span></button></div>`;
      bar.innerHTML = brand + lens + tabs.map((entry) => `<button type="button" class="mobile-tab-btn" data-msgr-tab="${entry.id}" aria-label="${esc(t(entry.fa, entry.en))}"><i class="fas ${entry.icon}" aria-hidden="true"></i><span>${esc(t(entry.fa, entry.en))}</span></button>`).join('') + actions;
      bar.dataset.msgrSignature = signature;
      bar.style.gridTemplateColumns = `repeat(${tabs.length}, minmax(0, 1fr))`;
      buildDesktopChrome(bar);
    }
    let changed = false;
    bar.querySelectorAll('[data-msgr-tab]').forEach((button) => {
      const on = button.getAttribute('data-msgr-tab') === lit;
      if (on && !button.classList.contains('is-active')) changed = true;
      button.classList.toggle('is-active', on);
      if (on) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    syncDesktopChrome();
    placeLens(bar, changed);
  }

  function buildDesktopChrome(bar) {
    bar.querySelector('#msgrThemeBtn')?.addEventListener('click', () => el('themeToggleBtn')?.click());
    bar.querySelector('#msgrRailProfileBtn')?.addEventListener('click', openProfile);
  }

  function syncDesktopChrome() {
    const theme = el('msgrThemeBtn');
    const dark = document.documentElement.classList.contains('dark');
    if (theme) {
      const label = dark ? t('حالت روشن', 'Light mode') : t('حالت تاریک', 'Dark mode');
      theme.title = label;
      theme.setAttribute('aria-label', label);
      theme.querySelector('i')?.classList.toggle('fa-sun', dark);
      theme.querySelector('i')?.classList.toggle('fa-moon', !dark);
      const text = theme.querySelector('.msgr-rail-action-label');
      if (text) text.textContent = label;
    }
    let name = 'P00RIJA';
    try { name = chatState?.profile?.name || name; } catch (_error) { /* profile not mounted */ }
    const profile = el('msgrRailProfileBtn');
    if (profile) {
      const label = t(`پروفایل ${name}`, `${name} — profile`);
      profile.title = label;
      profile.setAttribute('aria-label', label);
    }
    if (el('msgrRailProfileName')) el('msgrRailProfileName').textContent = name;
    if (el('msgrRailProfileInitial')) el('msgrRailProfileInitial').textContent = Array.from(name.trim())[0]?.toUpperCase() || 'P';
    const source = el('chatProfileAvatarImage');
    const image = el('msgrRailProfileImage');
    if (image) {
      const src = source && !source.classList.contains('hidden') ? source.getAttribute('src') || '' : '';
      if (src) image.setAttribute('src', src); else image.removeAttribute('src');
      image.classList.toggle('hidden', !src);
      el('msgrRailProfileInitial')?.classList.toggle('hidden', Boolean(src));
    }
    const presence = document.querySelector('.msgr-rail-presence');
    if (presence) presence.className = `msgr-rail-presence ${el('chatConnectionDot')?.className || ''}`;
  }

  /* ---- the glass lens under the lit tab -----------------------------------

     The lit tab is not a coloured button, it is a piece of glass that slides
     to it: iOS 26 and 27's tab bar. The lens is one element moved by custom
     properties; CSS gives it its spring. It stretches a little in the
     direction it goes, the way a drop of liquid would, and the tab's icon
     answers with a small pop. A finger held on the bar carries the lens with
     it, and lets go onto the nearest tab. */
  let lensFrom = -1;
  function placeLens(bar, animate) {
    const lens = bar.querySelector('.msgr-lens');
    const button = bar.querySelector('.mobile-tab-btn.is-active');
    if (!lens || !button || !button.offsetWidth) return;
    const x = button.offsetLeft;
    const y = button.offsetTop;
    const vertical = bar.clientHeight > bar.clientWidth;
    bar.style.setProperty('--lx', `${x}px`);
    bar.style.setProperty('--ly', `${y}px`);
    bar.style.setProperty('--lw', `${button.offsetWidth}px`);
    /* In the side rail a tab is a fixed 58pt; a lens as tall as the rail itself has been seen when the bar was measured before the grid settled. */
    bar.style.setProperty('--lh', `${vertical ? Math.min(button.offsetHeight, 64) : button.offsetHeight}px`);
    if (animate && lensFrom >= 0) {
      const distance = vertical ? Math.abs(y - lensFrom) : Math.abs(x - lensFrom);
      lens.classList.remove('is-moving');
      void lens.offsetWidth;
      lens.style.setProperty('--stretch', String(1 + Math.min(0.5, distance / 700)));
      lens.classList.add('is-moving');
      button.classList.remove('is-popping');
      void button.offsetWidth;
      button.classList.add('is-popping');
    }
    lensFrom = vertical ? y : x;
  }

  function wireLens() {
    const bar = el('mobileTabBar');
    if (!bar || bar.dataset.lensWired) return;
    bar.dataset.lensWired = '1';
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => requestAnimationFrame(() => placeLens(bar, false))).observe(bar);
    global.addEventListener('resize', () => placeLens(bar, false));
    if (document.fonts?.ready) document.fonts.ready.then(() => placeLens(bar, false)).catch(() => {});
    /* Held and dragged. */
    let dragging = false;
    bar.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (!event.target.closest('.mobile-tab-btn')) return;
      dragging = true;
      bar.classList.add('is-pressed');
    });
    const follow = (event) => {
      if (!dragging) return;
      const vertical = bar.clientHeight > bar.clientWidth;
      const rect = bar.getBoundingClientRect();
      const lens = bar.querySelector('.msgr-lens');
      const button = bar.querySelector('.mobile-tab-btn.is-active');
      if (!lens || !button) return;
      const size = vertical ? button.offsetHeight : button.offsetWidth;
      const raw = vertical ? event.clientY - rect.top - size / 2 : event.clientX - rect.left - size / 2;
      const limit = (vertical ? bar.clientHeight : bar.clientWidth) - size;
      const at = Math.max(0, Math.min(limit, raw));
      bar.classList.add('is-dragging');
      bar.style.setProperty(vertical ? '--ly' : '--lx', `${at}px`);
    };
    bar.addEventListener('pointermove', follow);
    const release = (event) => {
      if (!dragging) return;
      dragging = false;
      bar.classList.remove('is-pressed', 'is-dragging');
      const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.mobile-tab-btn');
      if (hit) { /* the click that follows takes it there */ } else placeLens(bar, false);
    };
    bar.addEventListener('pointerup', release);
    bar.addEventListener('pointercancel', release);
    bar.addEventListener('pointerleave', () => { if (dragging) { dragging = false; bar.classList.remove('is-pressed', 'is-dragging'); placeLens(bar, false); } });
  }

  function wireShellKeyboard() {
    const bar = el('mobileTabBar');
    if (!bar) return;
    document.addEventListener('keydown', (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || String(event.key).toLowerCase() !== 'k') return;
      event.preventDefault();
      el('chatSearchOpenBtn')?.click();
    });
    bar.addEventListener('keydown', (event) => {
      const current = event.target.closest('[data-msgr-tab]');
      if (!current || !['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const buttons = [...bar.querySelectorAll('[data-msgr-tab]')];
      const index = buttons.indexOf(current);
      let next = index;
      if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = buttons.length - 1;
      else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % buttons.length;
      else next = (index - 1 + buttons.length) % buttons.length;
      event.preventDefault();
      go(buttons[next].getAttribute('data-msgr-tab'));
      bar.querySelectorAll('[data-msgr-tab]')[next]?.focus({ preventScroll: true });
    });
  }

  /* The list of Settings is drawn by js/messenger-settings.js. */
  function renderRows() { /* kept: other code calls it */ }

  function renderTop() {
    const name = el('msgrTitle');
    if (name) name.textContent = title();
    const tab = app()?.state?.activeTab || 'chat';
    const inList = tab === 'chat' && !profileOpen() && ['chats', 'groups'].includes(chatView());
    /* Back is for the places the bar does not name: a row of Settings, the
       chat's connection pane, the profile. */
    const nested = (tab !== 'chat' && tab !== 'locallink' && tab !== 'settings')
      || (tab === 'locallink' && !localInBar())
      || (tab === 'settings' && pages()?.depth?.() > 0)
      || (tab === 'chat' && (profileOpen() || chatView() === 'connection'));
    el('msgrBackBtn')?.classList.toggle('hidden', !nested);
    el('msgrSearchBtn')?.classList.toggle('hidden', tab !== 'chat' || profileOpen());
    el('msgrNewBtn')?.classList.toggle('hidden', !inList);
    /* The dot is the chat's own, copied: one source for whether it is online. */
    const dot = el('msgrStatus');
    const source = el('chatConnectionDot');
    if (dot && source) {
      dot.className = `msgr-status ${source.className}`;
      dot.title = el('chatConnectionStatus')?.textContent?.trim() || '';
    }
    const back = el('msgrBackBtn')?.querySelector('i');
    if (back) back.className = `fas fa-chevron-${fa() ? 'right' : 'left'}`;
  }

  /* Other code adds its own cards to the top of Settings after the page is
     built (the shared lock does). The rows are the way out of Settings, so
     they are kept first rather than left wherever the last arrival put them. */
  function rowsFirst() { /* the list is a page now */ }

  /* Which screen is up, for the stylesheet: html[data-msgr]. The chat's lists
     (chats, calls, groups) carry their own head and need no bar above them;
     everything else keeps the bar. */
  function screenId() {
    const tab = app()?.state?.activeTab || 'chat';
    if (tab !== 'chat') return tab;
    if (profileOpen()) return 'profile';
    return chatView();
  }

  function renderHead() {
    const head = el('uiHead');
    if (!head) return;
    const id = screenId();
    const names = { chats: t('گفتگوها', 'Chats'), calls: t('تماس‌ها', 'Calls'), groups: t('گروه‌ها', 'Groups') };
    const title = head.querySelector('#uiHeadTitle');
    if (title) title.textContent = names[id] || '';
    const search = head.querySelector('#uiHeadSearch span');
    if (search) search.textContent = t('جستجو', 'Search');
    const more = head.querySelector('#uiHeadMore');
    if (more) { more.title = t('بیشتر', 'More'); more.setAttribute('aria-label', more.title); }
    const compose = head.querySelector('#uiHeadNew');
    if (compose) {
      compose.title = id === 'groups' ? t('گروه جدید', 'New group') : t('گفتگوی جدید', 'New chat');
      compose.setAttribute('aria-label', compose.title);
      compose.classList.toggle('hidden', id === 'calls');
      const icon = compose.querySelector('i');
      if (icon) icon.className = `fas ${id === 'groups' ? 'fa-users' : 'fa-pen-to-square'}`;
    }
    const dot = head.querySelector('#uiHeadStatus');
    const source = el('chatConnectionDot');
    if (dot && source) {
      dot.className = `ui-head-status ${source.className}`;
      dot.title = el('chatConnectionStatus')?.textContent?.trim() || '';
    }
    /* The arrow that goes back to the list points the way reading goes back. */
    const back = el('chatBackToListBtn')?.querySelector('i');
    if (back) back.className = `fas fa-chevron-${fa() ? 'right' : 'left'}`;
  }

  function sync() {
    rowsFirst();
    document.documentElement.setAttribute('data-msgr', screenId());
    renderBar();
    renderTop();
    renderHead();
    syncWelcome();
    /* Where the app is now is also where the browser's history is: see
       js/nav-history.js. */
    global.PoorijaNav?.note?.();
  }

  /* ---- a menu that opens from a button ------------------------------------

     Pull-down menu, as on iOS: a glass panel that grows out of the button
     that opened it. `items` are { label, icon, danger, run } or 'sep'. */
  let openMenuEl = null;
  let openMenuAnchor = null;
  function closeMenu(restoreFocus = false) {
    const anchor = openMenuAnchor;
    anchor?.setAttribute?.('aria-expanded', 'false');
    openMenuAnchor = null;
    if (openMenuEl) {
      openMenuEl.remove();
      openMenuEl = null;
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('keydown', onMenuKey, true);
    }
    if (restoreFocus) anchor?.focus?.({ preventScroll: true });
  }
  function onOutside(event) { if (openMenuEl && !openMenuEl.contains(event.target)) closeMenu(false); }
  function onMenuKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !openMenuEl) return;
    const buttons = [...openMenuEl.querySelectorAll('.ui-menu-item')];
    if (!buttons.length) return;
    const current = buttons.indexOf(document.activeElement);
    let next = current;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else if (event.key === 'ArrowDown') next = (current + 1 + buttons.length) % buttons.length;
    else next = (current - 1 + buttons.length) % buttons.length;
    buttons[next].focus({ preventScroll: true });
    event.preventDefault();
  }
  function openMenu(anchor, items, positionAnchor = anchor) {
    closeMenu(false);
    openMenuAnchor = anchor;
    anchor.setAttribute?.('aria-expanded', 'true');
    const menu = document.createElement('div');
    menu.className = 'ui-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = items.map((item, index) => (item === 'sep'
      ? '<div class="ui-menu-sep" role="separator"></div>'
      : `<button type="button" role="menuitem" class="ui-menu-item${item.danger ? ' is-danger' : ''}" data-ui-menu="${index}"><span>${esc(item.label)}</span><i class="fas ${item.icon || ''}" aria-hidden="true"></i></button>`)).join('');
    document.body.appendChild(menu);
    const box = positionAnchor.getBoundingClientRect();
    const width = menu.offsetWidth;
    const rtl = document.documentElement.dir === 'rtl';
    let left = rtl ? box.left : box.right - width;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${Math.min(box.bottom + 6, window.innerHeight - menu.offsetHeight - 8)}px`;
    menu.style.transformOrigin = `${rtl ? 'top left' : 'top right'}`;
    menu.addEventListener('click', (event) => {
      const button = event.target.closest('[data-ui-menu]');
      if (!button) return;
      const item = items[Number(button.getAttribute('data-ui-menu'))];
      closeMenu();
      item?.run?.();
    });
    openMenuEl = menu;
    setTimeout(() => {
      document.addEventListener('pointerdown', onOutside, true);
      document.addEventListener('keydown', onMenuKey, true);
    }, 0);
    menu.querySelector('.ui-menu-item')?.focus?.({ preventScroll: true });
  }


  /* ---- what a row can do: a long press, or a right click ------------------

     The buttons a row used to show (pin, mute, archive, mark unread, export,
     lock, block) are still in it, out of sight, and the menu presses them: one
     source for what each does and for when it is allowed. */
  function openRowMenu(row, x, y) {
    const buttons = [...row.querySelectorAll('.chat-pin-actions button')];
    if (!buttons.length) return;
    const items = buttons.map((button) => {
      const icon = (button.querySelector('i')?.className || '').split(/\s+/).find((name) => name.startsWith('fa-') && name !== 'fas') || 'fa-circle';
      const danger = button.classList.contains('is-danger') || /ban|user-slash/.test(icon) && !button.classList.contains('is-on');
      return { label: button.title || icon, icon, danger, run: () => button.click() };
    });
    if (!row.hasAttribute('tabindex')) row.setAttribute('tabindex', '-1');
    const point = { getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y }) };
    openMenu(row, items, point);
  }

  /* ---- swiping a row, as in Telegram ---------------------------------------

     A row dragged sideways shows what letting go will do: dragged toward the
     end of the line (left in English, right in Persian), archive, or out of
     the archive; dragged the other way, read / unread. Further than
     SWIPE_COMMIT_PX and let go, it is done; less, the row springs back. The
     action is the row's own hidden button, as in the menu. A vertical move
     first is a scroll and the row does not move. */
  const SWIPE_COMMIT_PX = 72;
  function wireRowSwipes(list, cancelLongPress) {
    let drag = null;
    const rtl = () => document.documentElement.dir === 'rtl';
    const reset = (row) => {
      if (!row) return;
      row.style.transition = 'transform 0.28s var(--spring, ease)';
      row.style.transform = '';
      row.classList.remove('is-swiping', 'swipe-ready');
      row.removeAttribute('data-swipe-side');
      setTimeout(() => { row.style.transition = ''; row.querySelector('.ui-row-swipe')?.remove(); }, 300);
    };
    const hint = (row, side) => {
      let lane = row.querySelector('.ui-row-swipe');
      const button = row.querySelector(side === 'end' ? '[data-chat-archive-conversation]' : '[data-chat-unread-conversation]');
      if (!button) return null;
      if (!lane) { lane = document.createElement('span'); lane.className = 'ui-row-swipe'; lane.setAttribute('aria-hidden', 'true'); row.appendChild(lane); }
      const icon = (button.querySelector('i')?.className || '').split(/\s+/).find((n) => n.startsWith('fa-') && n !== 'fas') || 'fa-circle';
      lane.dataset.side = side;
      lane.innerHTML = `<i class="fas ${icon}"></i><span>${esc(button.title || '')}</span>`;
      return button;
    };
    list.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' || event.button > 0) return;
      const row = event.target.closest('.ui-row');
      if (!row || event.target.closest('button')) return;
      drag = { row, x: event.clientX, y: event.clientY, dx: 0, axis: '', button: null, side: '' };
    }, { passive: true });
    list.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.axis) {
        if (Math.hypot(dx, dy) < 10) return;
        drag.axis = Math.abs(dx) > Math.abs(dy) * 1.3 ? 'x' : 'y';
        if (drag.axis === 'y') { drag = null; return; }
        cancelLongPress();
        drag.row.classList.add('is-swiping');
        try { drag.row.setPointerCapture?.(event.pointerId); } catch (_error) { /* gone */ }
      }
      /* Toward the end of the line is negative x in English, positive in Persian. */
      const towardEnd = rtl() ? dx > 0 : dx < 0;
      const side = towardEnd ? 'end' : 'start';
      if (side !== drag.side) { drag.side = side; drag.button = hint(drag.row, side); drag.row.dataset.swipeSide = side; }
      const limited = Math.sign(dx) * Math.min(Math.abs(dx), 140);
      drag.dx = dx;
      drag.row.style.transform = `translateX(${limited}px)`;
      drag.row.classList.toggle('swipe-ready', Math.abs(dx) >= SWIPE_COMMIT_PX && Boolean(drag.button));
    }, { passive: true });
    const finish = () => {
      if (!drag) return;
      const { row, dx, button, axis } = drag;
      drag = null;
      if (axis !== 'x') return;
      const commit = Math.abs(dx) >= SWIPE_COMMIT_PX && button;
      reset(row);
      if (commit) {
        /* The swipe ends in a click on the row; it must not open the chat. */
        row.dataset.swiped = String(Date.now());
        setTimeout(() => { delete row.dataset.swiped; button.click(); }, 120);
      }
    };
    list.addEventListener('pointerup', finish);
    list.addEventListener('pointercancel', () => { if (drag) reset(drag.row); drag = null; });
    list.addEventListener('click', (event) => {
      const row = event.target.closest('.ui-row');
      if (!row?.dataset.swiped || !event.isTrusted) return;
      const recent = Date.now() - Number(row.dataset.swiped) < 600;
      delete row.dataset.swiped;
      if (recent) { event.stopPropagation(); event.preventDefault(); }
    }, true);
  }

  function wireRows() {
    const list = el('chatPeerList');
    if (!list) return;
    let timer = 0; let startX = 0; let startY = 0; let swallowUntil = 0;
    const clear = () => { clearTimeout(timer); timer = 0; };
    list.addEventListener('contextmenu', (event) => {
      const row = event.target.closest('.ui-row');
      if (!row) return;
      event.preventDefault();
      openRowMenu(row, event.clientX, event.clientY);
    });
    list.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse') return;
      const row = event.target.closest('.ui-row');
      if (!row) return;
      startX = event.clientX; startY = event.clientY;
      clear();
      timer = setTimeout(() => { swallowUntil = Date.now() + 700; openRowMenu(row, startX, startY); }, 480);
    });
    list.addEventListener('pointermove', (event) => { if (timer && Math.hypot(event.clientX - startX, event.clientY - startY) > 10) clear(); });
    /* The ⋯ on the row says the conversation has a menu, and opens it. */
    list.addEventListener('click', (event) => {
      const more = event.target.closest('[data-chat-row-more]');
      if (!more) return;
      event.stopPropagation();
      event.preventDefault();
      const row = more.closest('.ui-row');
      const box = more.getBoundingClientRect();
      if (row) openRowMenu(row, box.left + box.width / 2, box.bottom);
    });
    wireRowSwipes(list, clear);
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((type) => list.addEventListener(type, clear));
    /* The press that opened the menu must not also open the conversation: the
       click a lifted finger makes, right after the menu appears. Only that one
       (a real click, within a moment). A phone often sends no click at all
       after a long press, and a flag that waited for one swallowed the next
       click in the list instead, which is the menu pressing the row's own
       button: Pin, Mute, Mark unread, Lock and Block did nothing. */
    list.addEventListener('click', (event) => {
      if (!swallowUntil) return;
      const fresh = event.isTrusted && Date.now() < swallowUntil;
      swallowUntil = 0;
      if (!fresh) return;
      event.stopPropagation();
      event.preventDefault();
    }, true);
  }

  /* The button at the end of the composer is a microphone while there is
     nothing to send, and the send button once there is. */
  function wireComposer() {
    const box = el('chatComposer');
    const send = el('chatSendMessageBtn');
    if (!box || !send || box.dataset.msgrMic) return;
    box.dataset.msgrMic = '1';
    /* Nothing to send is no text AND no recorded voice message waiting: with a draft in the preview the button is
       Send, whatever the box says. (It read only the box, so after a recording was finished the button stayed a
       microphone and a tap on it started a second recording instead of sending the first — a voice message could
       not be sent from the button at all.) */
    const hasVoiceDraft = () => { try { return Boolean(chatState && chatState.voiceDraft); } catch (_error) { return false; } };
    const nothingToSend = () => !String(box.value || '').trim() && !hasVoiceDraft();
    const sync = () => {
      const empty = nothingToSend();
      send.classList.toggle('is-mic', empty);
      const icon = send.querySelector('i');
      if (icon) icon.className = `fas ${empty ? 'fa-microphone' : 'fa-paper-plane'}`;
      send.title = empty ? t('پیام صوتی', 'Voice message') : t('ارسال', 'Send');
    };
    const native = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    Object.defineProperty(box, 'value', {
      configurable: true,
      get() { return native.get.call(this); },
      set(value) { native.set.call(this, value); sync(); },
    });
    box.addEventListener('input', sync);
    box.addEventListener('change', sync);
    /* The voice preview appears and goes without the box changing: follow it. */
    const preview = el('chatVoicePreview');
    if (preview) new MutationObserver(sync).observe(preview, { attributes: true, attributeFilter: ['class', 'hidden', 'style'] });
    /* The chat sends on the button's *pointerdown* (so the keyboard keeps its
       focus) and a click follows it, which finds the box already empty. So the
       decision between the microphone and send is made once, at pointerdown,
       and the click that follows is read as the same press — otherwise a
       message would go and a recording start from one tap. A press with the
       keyboard has no pointerdown and is decided at the click. */
    const bar = send.closest('.chat-composer-bar');
    let pressed = '';
    let pressedAt = 0;
    const empty = nothingToSend;
    bar?.addEventListener('pointerdown', (event) => {
      if (!event.target.closest('#chatSendMessageBtn')) return;
      pressed = empty() ? 'mic' : 'send';
      pressedAt = Date.now();
      if (pressed !== 'mic') return;
      event.stopPropagation();
      event.preventDefault();
      el('chatVoiceMessageBtn')?.click();
    }, true);
    bar?.addEventListener('click', (event) => {
      if (!event.target.closest('#chatSendMessageBtn')) return;
      const recent = Date.now() - pressedAt < 1000;
      const mode = recent ? pressed : (empty() ? 'mic' : 'send');
      pressed = '';
      if (mode !== 'mic') return;
      event.stopPropagation();
      event.preventDefault();
      if (!recent) el('chatVoiceMessageBtn')?.click();
    }, true);
    sync();
  }

  function buildWelcome() {
    const thread = document.querySelector('.chat-thread');
    if (!thread || el('msgrWelcome')) return;
    const welcome = document.createElement('section');
    welcome.id = 'msgrWelcome';
    welcome.className = 'msgr-welcome';
    welcome.setAttribute('aria-labelledby', 'msgrWelcomeTitle');
    welcome.innerHTML = `<div class="msgr-welcome-mark" aria-hidden="true"><img src="assets/pwa-icons/icon-192.png" alt="" draggable="false"><span><i class="fas fa-shield-halved"></i></span></div><p class="msgr-welcome-eyebrow">P00RIJA CHAT</p><h2 id="msgrWelcomeTitle"></h2><p id="msgrWelcomeBody" class="msgr-welcome-body"></p><div class="msgr-welcome-actions"><button id="msgrWelcomeNew" type="button" class="msgr-welcome-primary"><i class="fas fa-pen-to-square" aria-hidden="true"></i><span></span></button><button id="msgrWelcomeSearch" type="button" class="msgr-welcome-secondary"><i class="fas fa-magnifying-glass" aria-hidden="true"></i><span></span></button></div><p class="msgr-welcome-shortcut"><kbd>Ctrl</kbd><span>+</span><kbd>K</kbd><span></span></p>`;
    thread.appendChild(welcome);
    el('msgrWelcomeNew').addEventListener('click', () => el('chatStartChatBtn')?.click());
    el('msgrWelcomeSearch').addEventListener('click', () => el('chatSearchOpenBtn')?.click());
    syncWelcome();
  }

  function syncWelcome() {
    if (!el('msgrWelcome')) return;
    el('msgrWelcomeTitle').textContent = t('گفتگوی امن، آرام و متعلق به شما', 'Secure conversations, beautifully simple');
    el('msgrWelcomeBody').textContent = t('یک گفتگو را انتخاب کنید یا گفتگوی تازه‌ای بسازید. پیام‌ها و تماس‌های شما با رمزنگاری سرتاسری محافظت می‌شوند.', 'Choose a conversation or start a new one. Your messages and calls stay protected with end-to-end encryption.');
    el('msgrWelcomeNew').querySelector('span').textContent = t('گفتگوی جدید', 'New chat');
    el('msgrWelcomeSearch').querySelector('span').textContent = t('جستجوی پیام‌ها', 'Search messages');
    const hint = el('msgrWelcome').querySelector('.msgr-welcome-shortcut > span:last-child');
    if (hint) hint.textContent = t('برای جستجو', 'to search');
  }

  function syncJumpLatest() {
    const button = el('chatJumpLatestBtn');
    const panel = el('chatMessages');
    if (!button || !panel) return;
    let active = true;
    try { active = Boolean(chatState.activeConversationId); } catch (_error) { active = false; }
    const remaining = panel.scrollHeight - panel.scrollTop - panel.clientHeight;
    button.classList.toggle('hidden', !active || remaining < 240);
  }

  function wireJumpLatest() {
    const thread = document.querySelector('.chat-thread');
    const panel = el('chatMessages');
    if (!thread || !panel || el('chatJumpLatestBtn')) return;
    const button = document.createElement('button');
    button.id = 'chatJumpLatestBtn';
    button.type = 'button';
    button.className = 'chat-jump-latest hidden';
    button.innerHTML = '<i class="fas fa-arrow-down" aria-hidden="true"></i><span></span>';
    const label = () => {
      button.querySelector('span').textContent = t('آخرین پیام', 'Latest message');
      button.setAttribute('aria-label', t('رفتن به آخرین پیام', 'Jump to the latest message'));
    };
    label();
    global.addEventListener('poorija:language-changed', label);
    thread.appendChild(button);
    let queued = false;
    const sync = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; syncJumpLatest(); });
    };
    panel.addEventListener('scroll', sync, { passive: true });
    new MutationObserver(sync).observe(panel, { childList: true });
    button.addEventListener('click', () => {
      const reduced = global.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      panel.scrollTo({ top: panel.scrollHeight, behavior: reduced ? 'auto' : 'smooth' });
      syncJumpLatest();
    });
    syncJumpLatest();
  }

  /* The head of the chat's lists: the title, what to do with the list, and the
     search that opens the chat's search popup. The controls the old head held
     are still in the page (the chat's code holds them by id) and are driven
     from here. */
  function buildHead() {
    const rail = document.querySelector('.chat-rail');
    if (!rail || el('uiHead')) return;
    const head = document.createElement('div');
    head.id = 'uiHead';
    head.className = 'ui-head';
    head.innerHTML = `
      <div class="ui-head-bar">
        <h1 id="uiHeadTitle" class="ui-head-title"></h1>
        <span id="uiHeadStatus" class="ui-head-status" aria-hidden="true"></span>
        <div class="ui-head-actions">
          <button id="uiHeadMore" type="button" class="ui-circle-btn" aria-haspopup="true"><i class="fas fa-ellipsis" aria-hidden="true"></i></button>
          <button id="uiHeadNew" type="button" class="ui-circle-btn is-tint"><i class="fas fa-pen-to-square" aria-hidden="true"></i></button>
        </div>
      </div>
      <button id="uiHeadSearch" type="button" class="ui-search"><i class="fas fa-magnifying-glass" aria-hidden="true"></i><span></span></button>`;
    rail.prepend(head);
    el('uiHeadNew').addEventListener('click', () => el('chatStartChatBtn')?.click());
    el('uiHeadSearch').addEventListener('click', () => el('chatSearchOpenBtn')?.click());
    el('uiHeadMore').addEventListener('click', (event) => {
      const click = (id) => () => el(id)?.click();
      openMenu(event.currentTarget, [
        { label: t('پیام‌های ذخیره‌شده', 'Saved messages'), icon: 'fa-bookmark', run: click('chatSavedMessagesBtn') },
        { label: t('درون‌ریزی گفتگوها', 'Import chats'), icon: 'fa-file-import', run: click('chatImportChatsBtn') },
        { label: t('برون‌ریزی گفتگوها', 'Export chats'), icon: 'fa-file-export', run: click('chatExportChatsBtn') },
        'sep',
        { label: t('پاک‌سازی کل تاریخچه', 'Clear all history'), icon: 'fa-eraser', danger: true, run: click('chatWipeHistoryBtn') },
      ]);
    });
  }

  /* ---- wiring ------------------------------------------------------------ */

  /* The text-size choice lands on <body> as an inline font-size (app.js). The
     messages, the composer and the chat list are drawn in pixels of their own,
     so they are handed that size as a variable and scale with it. */
  function followTextSize() {
    const apply = () => {
      const px = parseFloat(getComputedStyle(document.body).fontSize) || 16;
      document.documentElement.style.setProperty('--ui-text', `${px}px`);
      /* --fs is what every size in css/ui is multiplied by, so the text size
         reaches the lists, the pages and the bars, not only the bubbles. */
      document.documentElement.style.setProperty('--fs', String(Math.min(1.5, Math.max(0.75, px / 16))));
    };
    apply();
    new MutationObserver(apply).observe(document.body, { attributes: true, attributeFilter: ['style'] });
  }

  /* A slider fills with the tint as far as its knob (css/ui/57-controls.css reads
     --fill-pct). CSS cannot know the value, so it is written here: when it
     moves, and whenever the page redraws or a page is shown. */
  function followRanges() {
    const paint = (range) => {
      const min = Number(range.min) || 0;
      const max = Number(range.max) || 100;
      const value = Number(range.value);
      range.style.setProperty('--fill-pct', `${max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0}%`);
    };
    const paintAll = () => document.querySelectorAll('input[type="range"]').forEach(paint);
    document.addEventListener('input', (event) => { if (event.target?.type === 'range') paint(event.target); }, true);
    let timer = 0;
    const later = () => { clearTimeout(timer); timer = setTimeout(paintAll, 60); };
    const root = el('mainApp') || document.body;
    new MutationObserver(later).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'value'] });
    paintAll();
  }

  /* The chat's appearance settings (js/chat/24-settings-panels.js) write custom
     properties on the root, but the stylesheet also gives most of them a default,
     so CSS cannot tell "the person chose this" from "this is the default". What
     is written inline is what was chosen: it is copied to --ap-* names, which
     exist only when something was chosen, and css/ui/30-thread.css reads those. */
  function followAppearance() {
    const root = document.documentElement;
    const COPY = [['--chat-bubble-me', '--ap-bubble-me'], ['--chat-bubble-them', '--ap-bubble-them'], ['--chat-text-me', '--ap-text-me'], ['--chat-text-them', '--ap-text-them'],
      ['--chat-thread-bg', '--ap-bg'], ['--chat-thread-image', '--ap-image'], ['--chat-bg-blur', '--ap-blur'], ['--chat-sent-tick', '--ap-sent-tick'], ['--chat-delivered-tick', '--ap-delivered-tick'], ['--chat-seen-tick', '--ap-seen-tick']];
    const mirror = () => {
      for (const [from, to] of COPY) {
        const value = root.style.getPropertyValue(from);
        if (value) root.style.setProperty(to, value); else root.style.removeProperty(to);
      }
      const alpha = root.style.getPropertyValue('--chat-bubble-alpha');
      if (alpha) root.style.setProperty('--ap-alpha', `${Math.round(Number(alpha) <= 1 ? Number(alpha) * 100 : Number(alpha))}%`); else root.style.removeProperty('--ap-alpha');
      const radius = root.style.getPropertyValue('--chat-bubble-radius');
      if (radius) root.style.setProperty('--ap-radius', radius); else root.style.removeProperty('--ap-radius');
      const zoom = root.style.getPropertyValue('--chat-zoom');
      if (zoom) root.style.setProperty('--ap-zoom', zoom); else root.style.removeProperty('--ap-zoom');
      root.toggleAttribute('data-ap-image', Boolean(root.style.getPropertyValue('--chat-thread-image')));
    };
    const original = global.applyChatAppearance;
    if (typeof original === 'function' && !original.__msgrMirrored) {
      const wrapped = function applyChatAppearanceMirrored(...args) {
        const result = original.apply(this, args);
        Promise.resolve(result).finally(mirror);
        mirror();
        return result;
      };
      wrapped.__msgrMirrored = true;
      global.applyChatAppearance = wrapped;
    }
    mirror();
    /* The custom image arrives a moment after the call that asked for it. */
    new MutationObserver(mirror).observe(root, { attributes: true, attributeFilter: ['style'] });
  }

  /* The file a backup is restored from: the browser's own control reads
     "Choose File — no file selected" in English whatever the app speaks, and is
     the one grey pill on a page of Telegram's rows. The input stays (the
     backup's code reads it by id); a row opens it and says what it holds. */
  function enhanceFilePickers() {
    document.querySelectorAll('#content-migration input[type="file"]').forEach((input) => {
      if (input.dataset.msgrPick) return;
      input.dataset.msgrPick = '1';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'msgr-filepick';
      const paint = () => {
        const name = input.files && input.files[0] ? input.files[0].name : '';
        button.innerHTML = `<i class="fas fa-file-arrow-up" aria-hidden="true"></i><span>${esc(t('انتخاب فایل پشتیبان', 'Choose a backup file'))}</span><span class="msgr-filename" dir="ltr">${esc(name)}</span>`;
      };
      paint();
      button.addEventListener('click', () => input.click());
      input.addEventListener('change', paint);
      global.addEventListener('poorija:language-changed', paint);
      input.insertAdjacentElement('afterend', button);
    });
  }

  /* What the messages are encrypted with, as a line under the composer, for
     the person who wants to know: the protocol every conversation between two
     current apps runs (docs/PROTOCOL.md 2.7b-2.9: Ed25519 identity, a hybrid
     X25519 + ML-KEM-768 exchange, a Double Ratchet with a post-quantum step,
     AES-256-GCM per message). */
  function paintEncryptionNote() {
    const bar = document.querySelector('.chat-composer-bar');
    if (!bar) return;
    let note = bar.querySelector('.msgr-enc-note');
    if (!note) {
      note = document.createElement('div');
      note.className = 'msgr-enc-note';
      bar.appendChild(note);
    }
    /* The ratchet's name is said in the page's language; the algorithm names
       are names and stay as they are. */
    note.innerHTML = `<i class="fas fa-lock" aria-hidden="true"></i><span>${esc(t('رمزنگاری سرتاسری', 'End-to-end encrypted'))} · ${esc(t('رچت دوگانه', 'Double Ratchet'))} · <bdi dir="ltr">X25519 + ML-KEM-768 · AES-256-GCM</bdi></span>`;
  }

  function init() {
    paintEncryptionNote();
    global.addEventListener('poorija:language-changed', paintEncryptionNote);
    enhanceFilePickers();
    /* `tabbar-wide-on` is what shows the bar from 1024px up (css/styles.css). */
    document.documentElement.classList.add('msgr', 'tabbar-wide-on');
    followTextSize();
    followRanges();
    followAppearance();
    renderRows();
    buildHead();
    buildWelcome();
    wireLens();
    wireShellKeyboard();
    wireRows();
    wireComposer();
    wireJumpLatest();
    new MutationObserver(syncDesktopChrome).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    const profileName = el('chatProfileSummaryName');
    if (profileName) new MutationObserver(syncDesktopChrome).observe(profileName, { childList: true, characterData: true, subtree: true });
    const profileAvatar = el('chatProfileAvatarImage');
    if (profileAvatar) new MutationObserver(syncDesktopChrome).observe(profileAvatar, { attributes: true, attributeFilter: ['src', 'class'] });

    el('mobileTabBar')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-msgr-tab]');
      if (button) go(button.getAttribute('data-msgr-tab'));
    });
    el('msgrBackBtn')?.addEventListener('click', () => {
      /* A page of Settings goes back to the page it was opened from. */
      if (app()?.state?.activeTab === 'settings' && pages()?.depth?.() > 0) {
        pages().back();
        sync();
        return;
      }
      /* Everything else Back leaves was reached from Settings. */
      closeProfile();
      go('settings');
    });
    el('msgrSearchBtn')?.addEventListener('click', () => el('chatSearchOpenBtn')?.click());
    el('msgrNewBtn')?.addEventListener('click', () => el('chatStartChatBtn')?.click());

    /* The chat changes its view from more places than its own menu — a search
       result, a group opening, a call ending — and none of them know about
       the bar. Two of its functions are on every one of those paths between
       them: setChatView, and updateChatShellMode for the places that set the
       view directly. Both are top-level functions of classic scripts, so the
       name every caller uses is this property of window, and following them
       here follows all of them. After the frame, because the view is read. */
    for (const name of ['setChatView', 'updateChatShellMode']) {
      const original = global[name];
      if (typeof original !== 'function') continue;
      global[name] = function followedByMessenger(...args) {
        const result = original.apply(this, args);
        if (name === 'setChatView') closeProfile();
        sync();
        return result;
      };
    }
    global.addEventListener('poorija:tab-switched', () => { closeProfile(); sync(); });
    global.addEventListener('poorija:language-changed', () => {
      const bar = el('mobileTabBar');
      if (bar) delete bar.dataset.msgrSignature;
      renderRows();
      sync();
    });
    global.addEventListener('poorija:unlock', () => setTimeout(sync, 0));
    /* The connection dot changes without the view changing. */
    const dot = el('chatConnectionDot');
    if (dot && typeof MutationObserver === 'function') {
      new MutationObserver(renderTop).observe(dot, { attributes: true, attributeFilter: ['class'] });
    }
    sync();
  }

  global.PoorijaMessenger = { TABS, ROWS, barTabs, localInBar, setBarTab, go, openRow, openProfile, activeId, title, renderBar, sync, openMenu, closeMenu, hasMenu: () => Boolean(openMenuEl) };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof globalThis !== 'undefined' ? globalThis : this);
