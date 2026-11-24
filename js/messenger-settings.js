/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* ============================================================================
   Settings, the way a messenger lays them out.

   Telegram's Settings is one list: you at the top, then Saved Messages, Calls,
   Devices; then Notifications, Privacy and Security, Data and Storage,
   Appearance, Language; then Help. Each row is a page of its own with a way
   back, and a page is a short list of rows: a switch, a value that opens a
   choice, a button. Nothing is a form you scroll through.

   WHAT THIS DOES
   --------------
   It draws that list and those pages. It does not own any setting. The things
   the app already knew how to do (the password, the lock, the fonts, the
   notifications, the relay) are controls in the page under their own ids, and
   all the code that reads and writes them addresses them there. So:

     - a switch, a choice or a field on one of these pages is a view of the
       control that was already there: it shows its value and, when changed,
       sets it and fires its own change event;
     - a button on one of them presses the original;
     - what is too big to rebuild (the relay settings, the storage cards, the
       list of devices) is moved, node and listener together, into its page.

   The old Settings tab is a heap of cards written for another app: the
   algorithms of the encryption suite, the order of its tabs, its desktop
   shell. Those controls stay in the page, out of sight, because the code that
   reads the settings still names them; there is nothing to set in them.
   ============================================================================ */

(function (global) {
  'use strict';

  const app = () => global.PoorijaApp;
  const el = (id) => document.getElementById(id);
  const fa = () => app()?.state?.language !== 'en';
  const t = (persian, english) => (fa() ? persian : english);
  const esc = (v) => app()?.escapeHTML?.(String(v ?? '')) ?? String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const chev = () => `<i class="fas fa-chevron-${fa() ? 'left' : 'right'} msgr-row-chevron" aria-hidden="true"></i>`;

  const stack = ['root'];
  const actions = new Map();
  let actionSeq = 0;
  let host = null;

  /* ---- what a row is ---------------------------------------------------- */

  function act(fn) {
    actionSeq += 1;
    actions.set(String(actionSeq), fn);
    /* A page is drawn again each time it is shown; the ids of the drawing before
       are dead. Kept for a few thousand draws, then dropped (the next draw makes
       its own). */
    if (actions.size > 4000) {
      const keep = [...actions.keys()].slice(-1500);
      const live = new Map(keep.map((key) => [key, actions.get(key)]));
      actions.clear();
      live.forEach((value, key) => actions.set(key, value));
    }
    return actionSeq;
  }

  function tile(o) {
    if (!o.icon) return '';
    return `<i class="fas ${o.icon}" style="--tile:${o.tile || 'var(--tint-fill)'}" aria-hidden="true"></i>`;
  }

  /* A row that goes somewhere or does something. */
  function row(o) {
    const id = o.go ? act(() => open(o.go)) : (o.fn ? act(o.fn) : 0);
    const value = o.value !== undefined && o.value !== '' ? `<span class="msgr-row-value">${esc(o.value)}</span>` : '';
    const arrow = o.go || o.arrow ? chev() : '';
    return `<button type="button" class="msgr-row${o.danger ? ' is-danger' : ''}${o.icon ? '' : ' no-tile'}"${id ? ` data-a="${id}"` : ''}${o.row ? ` data-msgr-row="${o.row}"` : ''}>${tile(o)}<span class="msgr-row-label">${esc(o.label)}</span>${value}${arrow}</button>`;
  }

  /* What a page asks you to press (connect, export, report), as Telegram's
     buttons, not as rows of a list: kind is primary, tinted (the default) or
     danger; wide takes the whole line. Several together are one grid. */
  function button(o) {
    const id = o.fn ? act(o.fn) : 0;
    return `<button type="button" class="tg-btn${o.kind ? ` is-${o.kind}` : ''}${o.wide ? ' is-wide' : ''}"${id ? ` data-a="${id}"` : ''}>${o.icon ? `<i class="fas ${o.icon}" aria-hidden="true"></i>` : ''}<span>${esc(o.label)}</span></button>`;
  }
  function buttons(header, list, footer) {
    const body = list.filter(Boolean).join('');
    if (!body) return '';
    return `${header ? `<div class="msgr-group-head">${esc(header)}</div>` : ''}<div class="msgr-btns">${body}</div>${footer ? `<div class="msgr-group-foot">${esc(footer)}</div>` : ''}`;
  }

  /* A switch that is a view of a checkbox the app already has. */
  function toggle(o) {
    const source = el(o.source);
    if (!source) return '';
    return `<label class="msgr-row msgr-switch-row${o.icon ? '' : ' no-tile'}">${tile(o)}<span class="msgr-row-label">${esc(o.label)}</span><span class="msgr-switch"><input type="checkbox" data-bind="${o.source}"${source.checked ? ' checked' : ''}><i></i></span></label>`;
  }

  /* A switch that is not a view of any control the app already has: what it does
     is a function, called with the new state. */
  function switchRow(o) {
    const id = act((on) => o.fn(on));
    return `<label class="msgr-row msgr-switch-row${o.icon ? '' : ' no-tile'}">${tile(o)}<span class="msgr-row-label">${esc(o.label)}</span><span class="msgr-switch"><input type="checkbox" data-sw="${id}"${o.on ? ' checked' : ''}><i></i></span></label>`;
  }

  /* A value taken from a select the app already has, chosen on a page of its own. */
  function choice(o) {
    const source = el(o.source);
    if (!source) return '';
    const current = source.selectedOptions?.[0]?.textContent?.replace(/\s*\(.*?\)\s*$/, '').trim() || '';
    return row({ icon: o.icon, tile: o.tile, label: o.label, value: o.shown || current, fn: () => openChoice(o) , arrow: true });
  }

  /* A line of text that is a view of an input the app already has: the label on
     one side, the field on the other, and what is typed goes to the original. */
  function field(o) {
    const source = el(o.source);
    if (!source) return '';
    return `<label class="msgr-row msgr-field-row no-tile"><span class="msgr-field-label">${esc(o.label)}</span><input class="msgr-input" data-field="${o.source}" type="${o.type || 'text'}" value="${esc(source.value)}" placeholder="${esc(o.placeholder || source.placeholder || '')}" autocomplete="off" autocapitalize="off" spellcheck="false"${o.ltr ? ' dir="ltr"' : ''}></label>`;
  }

  function group(header, rowsHtml, footer) {
    const body = rowsHtml.filter(Boolean).join('');
    if (!body) return '';
    return `${header ? `<div class="msgr-group-head">${esc(header)}</div>` : ''}<div class="msgr-group">${body}</div>${footer ? `<div class="msgr-group-foot">${esc(footer)}</div>` : ''}`;
  }

  /* chatState and CHAT_MAX_CLOCKS are top-level consts of the chat's scripts:
     in scope here by name, but not properties of window. They were read as
     global.chatState, which is undefined, so the clocks page always saw none
     kept and every city added replaced the one before it. */
  const chatSt = () => (typeof chatState === 'object' && chatState ? chatState : null);
  const maxClocks = () => (typeof chatMaxClocks === 'function' ? chatMaxClocks() : 2);
  /* The cities kept: the chat's list once it has one, and what was saved until
     then — never "none" for a list that has simply not been read yet. */
  const keptClocks = () => {
    const live = chatSt()?.clocks;
    if (Array.isArray(live)) return live;
    try { return (typeof loadClocks === 'function' && loadClocks()) || []; } catch (_error) { return []; }
  };
  const lockApi = () => { try { return global.PoorijaChat?.vaultLock?.() || null; } catch (_error) { return null; } };
  const press = (id) => () => el(id)?.click();
  const call = (name, ...args) => () => { try { return global[name]?.(...args); } catch (error) { console.warn('[settings]', name, error); return undefined; } };
  const textOf = (id) => (el(id)?.textContent || '').trim();
  /* The sentence the old page put under a switch, for the footer of the group
     the switch is in now. A hidden one means the feature is not on offer. */
  const hintOf = (id) => {
    const note = el(id)?.closest('.chat-toggle')?.nextElementSibling;
    return note && note.matches('p') && !note.classList.contains('hidden') ? note.textContent.trim() : '';
  };
  const offered = (id) => { const row = el(id)?.closest('.chat-toggle'); return Boolean(row) && !row.classList.contains('hidden'); };

  /* ---- pages ------------------------------------------------------------- */

  const PAGES = {};

  /* A page is a title and blocks. A native block is drawn again each time the
     page is shown (it shows live values); a legacy block is filled once with
     nodes the app already has. */
  function definePage(id, def) { PAGES[id] = def; }

  function initials(name) {
    const clean = String(name || '').trim();
    return clean ? [...clean][0].toUpperCase() : 'P';
  }

  function avatarHtml(size) {
    const image = el('chatProfileAvatarImage');
    const photo = image && !image.classList.contains('hidden') && image.getAttribute('src') ? image.getAttribute('src') : '';
    const name = textOf('chatProfileSummaryName') || el('chatProfileName')?.value || 'P00RIJA';
    return `<span class="msgr-avatar" style="--s:${size}px">${photo ? `<img alt="" src="${esc(photo)}">` : esc(initials(name))}</span>`;
  }

  function syncProfileViews() {
    const name = el('chatProfileName')?.value || textOf('chatProfileSummaryName') || 'P00RIJA';
    const page = host?.querySelector('.msgr-page:not([hidden])');
    const heroName = page?.querySelector('.msgr-hero-name');
    if (heroName) heroName.textContent = name;
    const heroAvatar = page?.querySelector('.msgr-hero-avatar .msgr-avatar');
    if (heroAvatar) heroAvatar.outerHTML = avatarHtml(96);
    const rootName = host?.querySelector('.msgr-hc-name');
    if (rootName) rootName.textContent = name;
    const rootAvatar = host?.querySelector('.msgr-hc-avatar .msgr-avatar');
    if (rootAvatar) rootAvatar.outerHTML = avatarHtml(88);
    page?.querySelectorAll('[data-profile-name]').forEach((input) => {
      if (document.activeElement !== input) input.value = name;
    });
  }

  function wireLiveProfile() {
    const avatar = el('chatProfileAvatarImage');
    if (avatar) new MutationObserver(syncProfileViews).observe(avatar, { attributes: true, attributeFilter: ['src', 'class'] });
    const summary = el('chatProfileSummaryName');
    if (summary) new MutationObserver(syncProfileViews).observe(summary, { childList: true, characterData: true, subtree: true });
  }

  /* -- root: the card, then the list -- */

  /* The card at the top is the profile card the chat has always had (P00RIJA
     Cryptography's too): who you are and what you are doing, whether you are
     connected, the time here and in the cities you keep (a column left of the
     picture), the pixel companion (right of it), and three doors. The clocks and the companion are the live nodes of the
     chat, moved in while the card is drawn and parked again before it is drawn
     the next time, so their timers and listeners are never lost. */
  const HERO_PARTS = ['chatProfileClocks', 'chatPet'];
  function parkHeroParts() {
    const park = el('msgrParked');
    if (!park) return;
    for (const id of HERO_PARTS) { const node = el(id); if (node && node.parentNode !== park) park.appendChild(node); }
  }
  function heroHtml() {
    const name = textOf('chatProfileSummaryName') || el('chatProfileName')?.value || 'P00RIJA';
    const status = textOf('chatConnectionStatus') || t('عدم اتصال', 'Disconnected');
    const tone = (typeof chatState === 'object' && chatState?.connectionState) || 'offline';
    const mood = String((typeof chatState === 'object' && chatState?.profile?.mood) || '').trim();
    return `<div class="msgr-hero-card">
      <div class="msgr-hc-row">
        <div class="msgr-hc-clocks" data-slot="clocks"></div>
        <button type="button" class="msgr-hc-avatar" data-a="${act(() => open('me'))}" aria-label="${esc(t('پروفایل', 'Profile'))}">${avatarHtml(88)}</button>
        <div class="msgr-hc-pet" data-slot="pet"></div>
      </div>
      <div class="msgr-hc-id">
        <div class="msgr-hc-top">
          <button type="button" class="msgr-hc-name" data-msgr-row="profile" data-a="${act(() => open('me'))}">${esc(name)}</button>
          <button type="button" class="msgr-hc-mood" data-a="${act(() => open('me'))}"><i class="fas fa-circle-half-stroke"></i><span>${esc(mood || t('وضعیت', 'Status'))}</span></button>
        </div>
        <div class="msgr-hc-status" data-tone="${esc(tone)}"><i class="msgr-hc-dot"></i><span>${esc(status)}</span></div>
      </div>
      <div class="msgr-hc-quick">
        <button type="button" class="msgr-hc-btn" data-a="${act(press('chatShowIdentityQrBtn'))}"><i class="fas fa-id-card"></i><span>${esc(t('هویت و QR', 'Identity'))}</span></button>
        <button type="button" class="msgr-hc-btn" data-a="${act(() => open('me'))}"><i class="fas fa-user-pen"></i><span>${esc(t('پروفایل', 'Profile'))}</span></button>
        <button type="button" class="msgr-hc-btn is-lock" data-a="${act(() => global.lockApp?.())}"><i class="fas fa-lock"></i><span>${esc(t('قفل', 'Lock'))}</span></button>
      </div>
    </div>`;
  }
  definePage('root', {
    title: () => t('تنظیمات', 'Settings'),
    root: true,
    blocks: [{
      native: () => {
        parkHeroParts();
        return heroHtml()
          + group('', [
            row({ icon: 'fa-mobile-screen-button', tile: '#ff9500', label: t('دستگاه‌های من', 'My devices'), row: 'devices', go: 'devices' }),
            row({ icon: 'fa-tower-broadcast', tile: '#30b0c7', label: t('محلی', 'Local'), row: 'local', arrow: true, fn: () => PoorijaMessenger.openRow('local') }),
          ])
          + group('', [
            row({ icon: 'fa-bell', tile: '#ff3b30', label: t('اعلان‌ها و صداها', 'Notifications and sounds'), row: 'notifications', go: 'notifications' }),
            row({ icon: 'fa-lock', tile: '#8e8e93', label: t('حریم خصوصی و امنیت', 'Privacy and security'), row: 'privacy', go: 'privacy' }),
            row({ icon: 'fa-database', tile: '#34c759', label: t('داده و حافظه', 'Data and storage'), row: 'data', go: 'data' }),
            row({ icon: 'fa-palette', tile: '#32ade6', label: t('ظاهر', 'Appearance'), row: 'appearance', go: 'appearance' }),
            row({ icon: 'fa-language', tile: '#af52de', label: t('زبان', 'Language'), value: fa() ? 'فارسی' : 'English', row: 'language', go: 'language' }),
            row({ icon: 'fa-network-wired', tile: '#5e5ce6', label: t('سرور و اتصال', 'Server and connection'), row: 'connection', go: 'connection' }),
          ])
          + group('', [
            row({ icon: 'fa-circle-question', tile: '#ff9500', label: t('راهنما', 'Help'), row: 'help', arrow: true, fn: () => PoorijaMessenger.openRow('help') }),
            row({ icon: 'fa-circle-info', tile: '#0a84ff', label: t('درباره من', 'About me'), row: 'about', arrow: true, fn: () => PoorijaMessenger.openRow('about') }),
          ])
          + group('', [
            row({ icon: 'fa-right-from-bracket', tile: '#ff3b30', label: t('قفل برنامه', 'Lock the app'), row: 'lock', danger: true, fn: () => global.lockApp?.() }),
          ]);
      },
      state: (holder) => {
        const there = (id, slot) => `${el(id) ? 1 : 0}${holder.querySelector(`[data-slot="${slot}"] #${id}`) ? 1 : 0}`;
        return `${there('chatProfileClocks', 'clocks')}${there('chatPet', 'pet')}`;
      },
      after: (holder) => {
        const clocks = el('chatProfileClocks');
        const pet = el('chatPet');
        const clocksSlot = holder.querySelector('[data-slot="clocks"]');
        const petSlot = holder.querySelector('[data-slot="pet"]');
        if (clocks && clocksSlot) {
          clocksSlot.appendChild(clocks);
          clocks.hidden = false;
          if (!clocks.dataset.msgrOpens) {
            clocks.dataset.msgrOpens = '1';
            clocks.addEventListener('click', (event) => {
              if (!event.target.closest('.msgr-hc-clocks')) return;
              event.stopImmediatePropagation();
              event.preventDefault();
              open('clocks');
            }, true);
          }
        }
        if (pet && petSlot) { petSlot.appendChild(pet); pet.hidden = false; }
        try { global.renderProfileClocks?.(); } catch (_error) { /* the chat is not up yet */ }
      },
    }],
  });

  /* -- world clocks: the manager the chat opened as a sheet, here in Settings -- */
  definePage('clocks', {
    title: () => t('ساعت‌های جهانی', 'World clocks'),
    blocks: [{
      native: () => {
        const zones = keptClocks();
        const local = `<div class="msgr-row no-tile msgr-clock-row"><span class="msgr-row-label">${esc(t('ساعت محلی', 'Local time'))}</span><span class="msgr-row-value">${esc(global.formatZoneTime?.() || '')}</span></div>`;
        const kept = zones.map((clock) => `<div class="msgr-row no-tile msgr-clock-row"><span class="msgr-row-label">${esc(clock.label || global.clockLabelFor?.(clock.tz) || clock.tz)}<small>${esc(global.zoneOffsetLabel?.(clock.tz) || '')}</small></span><span class="msgr-row-value">${esc(global.formatZoneTime?.(clock.tz) || '')}</span><button type="button" class="msgr-icon-btn is-danger" data-a="${act(() => { global.saveClocks?.(zones.filter((item) => item.tz !== clock.tz)); refresh(); })}" aria-label="${esc(t('حذف', 'Remove'))}"><i class="fas fa-trash"></i></button></div>`);
        return group(t('ساعت‌های شما', 'Your clocks'), [local, ...kept], zones.length >= maxClocks() ? t('به سقف ساعت‌ها رسیده‌اید؛ برای افزودن یکی را حذف کنید.', 'You are at the limit; remove one to add another.') : '')
          + group(t('افزودن شهر', 'Add a city'), [`<label class="msgr-row msgr-input-row no-tile"><input class="msgr-input" data-clock-search type="search" placeholder="${esc(t('جستجوی شهر یا منطقهٔ زمانی', 'Search a city or time zone'))}" autocomplete="off" spellcheck="false"></label>`])
          + '<div class="msgr-clock-results" data-clock-results></div>';
      },
      after: (holder) => {
        const input = holder.querySelector('[data-clock-search]');
        const results = holder.querySelector('[data-clock-results]');
        const zones = global.knownTimeZones?.() || [];
        input?.addEventListener('input', () => {
          const query = input.value.trim().toLowerCase();
          if (!query) { results.innerHTML = ''; return; }
          const matches = zones.filter((tz) => tz.toLowerCase().includes(query)).slice(0, 30);
          results.innerHTML = matches.length
            ? `<div class="msgr-group">${matches.map((tz) => `<button type="button" class="msgr-row no-tile msgr-clock-row" data-add="${esc(tz)}"><span class="msgr-row-label">${esc(global.clockLabelFor?.(tz) || tz)}<small>${esc(tz)}</small></span><span class="msgr-row-value">${esc(global.formatZoneTime?.(tz) || '')}</span><i class="fas fa-plus msgr-add-mark" aria-hidden="true"></i></button>`).join('')}</div>`
            : `<div class="msgr-group-foot">${esc(t('چیزی پیدا نشد.', 'Nothing found.'))}</div>`;
          results.querySelectorAll('[data-add]').forEach((button) => button.addEventListener('click', () => {
            const tz = button.dataset.add;
            const current = keptClocks();
            if (current.some((clock) => clock.tz === tz)) return;
            if (current.length >= maxClocks()) { global.notify?.(t(`حداکثر ${maxClocks()} ساعت می‌توانید اضافه کنید.`, `${maxClocks()} clocks is the maximum.`), 'warning'); return; }
            global.saveClocks?.([...current, { tz, label: global.clockLabelFor?.(tz) || tz }]);
            refresh();
          }));
        });
      },
    }],
  });

  /* -- you: everything on one page, no sheets -- */
  definePage('me', {
    title: () => t('پروفایل', 'Profile'),
    blocks: [{
      native: () => {
        const name = el('chatProfileName')?.value || textOf('chatProfileSummaryName') || '';
        const mood = String((typeof chatState === 'object' && chatState?.profile?.mood) || '');
        const fingerprint = textOf('chatFingerprint') || (typeof chatState === 'object' ? chatState?.identity?.fingerprint : '') || '';
        const peerId = textOf('chatPeerId') || '';
        const devices = textOf('chatLinkedDeviceCount');
        const hero = `<div class="msgr-hero"><button type="button" class="msgr-hero-avatar" data-a="${act(press('chatProfileAvatarBtn'))}" aria-label="${esc(t('تغییر تصویر', 'Change picture'))}">${avatarHtml(96)}<span class="msgr-hero-edit"><i class="fas fa-camera"></i></span></button><div class="msgr-hero-name">${esc(name || 'P00RIJA')}</div><div class="msgr-hero-sub">${esc(textOf('chatConnectionStatus'))}</div></div>`;
        return hero
          + group(t('نام', 'Name'), [`<label class="msgr-row msgr-input-row no-tile"><input class="msgr-input" data-profile-name type="text" maxlength="40" value="${esc(name)}" placeholder="${esc(t('نام نمایشی', 'Display name'))}" autocomplete="off"></label>`], t('این نام را مخاطبانتان می‌بینند.', 'Your contacts see this name.'))
          + group(t('وضعیت', 'Status'), [`<label class="msgr-row msgr-input-row no-tile"><input class="msgr-input" data-profile-mood type="text" maxlength="40" value="${esc(mood)}" placeholder="${esc(t('مثلاً: سر کار', 'e.g. At work'))}" autocomplete="off"></label>`], t('کنار نامتان در گفتگوها دیده می‌شود.', 'Shown beside your name in conversations.'))
          + group(t('هویت امن', 'Secure identity'), [
            fingerprint ? `<button type="button" class="msgr-row no-tile msgr-copy" data-a="${act(() => copyText(fingerprint))}"><span class="msgr-row-label">${esc(t('اثر انگشت کلید', 'Key fingerprint'))}</span><code class="msgr-code" dir="ltr">${esc(fingerprint.slice(0, 32))}…</code></button>` : '',
            peerId ? `<button type="button" class="msgr-row no-tile msgr-copy" data-a="${act(() => copyText(peerId))}"><span class="msgr-row-label">${esc(t('شناسهٔ دستگاه', 'Device id'))}</span><code class="msgr-code" dir="ltr">${esc(peerId.slice(0, 22))}</code></button>` : '',
            row({ icon: 'fa-qrcode', tile: '#0a84ff', label: t('نمایش کد QR', 'Show my QR code'), fn: press('chatShowIdentityQrBtn') }),
            row({ icon: 'fa-copy', tile: '#32ade6', label: t('کپی کارت هویت', 'Copy my identity card'), fn: () => global.copyChatFullIdentity?.() }),
            row({ icon: 'fa-file-export', tile: '#34c759', label: t('خروجی پروفایل همراه', 'Export portable profile'), fn: press('chatIdentityProfileExportBtn') }),
            row({ icon: 'fa-file-import', tile: '#ff9500', label: t('ورود پروفایل همراه', 'Import portable profile'), fn: press('chatIdentityProfileImportBtn') }),
            row({ icon: 'fa-link', tile: '#5e5ce6', label: t('وصل کردن این دستگاه به حساب', 'Link this device to an account'), fn: press('chatIdentityLinkBtn') }),
            row({ icon: 'fa-mobile-screen-button', tile: '#8e8e93', label: t('دستگاه‌های وصل‌شده', 'Linked devices'), value: devices, go: 'devices' }),
          ])
          + companionGroup()
          + group('', [row({ icon: 'fa-clock', tile: '#8e8e93', label: t('ساعت‌های جهانی', 'World clocks'), go: 'clocks' })])
          + group('', [row({ icon: 'fa-rotate', tile: '#ff3b30', label: t('بازنشانی کلید چت', 'Reset chat key'), danger: true, fn: press('chatResetIdentityBtn') })], t('همهٔ مخاطبان باید کلید تازه را دوباره بپذیرند.', 'Everyone has to accept the new key again.'));
      },
      after: (body) => {
        const name = body.querySelector('[data-profile-name]');
        const mood = body.querySelector('[data-profile-mood]');
        name?.addEventListener('input', () => {
          const hero = body.querySelector('.msgr-hero-name');
          if (hero) hero.textContent = name.value.trim() || 'P00RIJA';
        });
        name?.addEventListener('change', () => {
          const source = el('chatProfileName');
          if (!source) return;
          source.value = name.value.trim();
          source.dispatchEvent(new Event('input', { bubbles: true }));
          el('chatSaveProfileBtn')?.click();
          syncProfileViews();
        });
        name?.addEventListener('keydown', (event) => { if (event.key === 'Enter') name.blur(); });
        mood?.addEventListener('change', () => saveMood(mood.value));
        mood?.addEventListener('keydown', (event) => { if (event.key === 'Enter') mood.blur(); });
      },
    }],
  });

  /* The pixel companion: on or off, and which one. Off used to be a one-way door —
     the toast said "turn it back on from the profile settings", and there was no
     such switch in them. */
  function companionGroup() {
    if (typeof petsAreOff !== 'function' || typeof CHAT_PETS === 'undefined') return '';
    const off = petsAreOff();
    const current = CHAT_PETS.find((pet) => pet.id === currentPetId());
    const rows = [switchRow({ icon: 'fa-paw', tile: '#ff9500', label: t('همدم پیکسلی', 'Pixel companion'), on: !off, fn: (on) => { if (on === petsAreOff()) togglePets(); refresh(); } })];
    if (!off) {
      rows.push(row({ icon: 'fa-shuffle', tile: '#af52de', label: t('همدم دیگر', 'Another companion'), value: current ? t(current.fa, current.en) : '', fn: () => {
        const at = CHAT_PETS.findIndex((pet) => pet.id === currentPetId());
        setPet(CHAT_PETS[(at + 1) % CHAT_PETS.length].id);
        refresh();
      } }));
    }
    return group(t('همدم', 'Companion'), rows, t('در کارت بالای تنظیمات کنار عکس شما می‌ایستد؛ خاموش که باشد، به‌جایش کپی شناسهٔ شما می‌آید.', 'It stands beside your picture on the card at the top of Settings; when it is off, a copy-your-id button takes its place.'));
  }

  function saveMood(value) {
    try {
      if (typeof chatState !== 'object') return;
      const next = String(value || '').trim().slice(0, 40);
      if (next === String(chatState.profile?.mood || '')) return;
      chatState.profile = { ...chatState.profile, mood: next, updatedAt: new Date().toISOString() };
      saveEncrypted(CHAT_PROFILE_STORAGE_KEY, chatState.profile);
      if (typeof renderMoodChip === 'function') renderMoodChip();
      if (typeof broadcastHello === 'function') broadcastHello();
      if (typeof announceProfileToContacts === 'function') announceProfileToContacts();
    } catch (error) { console.warn('[settings] status not saved', error); }
  }

  function copyText(value) {
    try {
      navigator.clipboard?.writeText(value);
      app()?.showNotification?.(t('کپی شد.', 'Copied.'), 'success');
    } catch (_error) { /* no clipboard */ }
  }

  /* -- devices -- */
  /* The list of devices is drawn by the chat when its own section opens
     (renderDevicesCard); this page is that section, so it asks for the draw,
     and tells the chat it is the open one so a device coming or going redraws
     it. */
  definePage('devices', {
    title: () => t('دستگاه‌های من', 'My devices'),
    blocks: [{ legacy: () => paneNodes('devices'), wrap: true }],
    onBuild: () => { try { chatState.settingsPane = 'devices'; renderDevicesCard(); } catch (_error) { /* the chat is not up yet */ } },
  });

  /* -- notifications and sounds -- */

  /* A row of small buttons side by side, each one pressing a control the app
     already has. A button for something that is not on offer (nothing custom to
     delete) is left out. */
  function buttonsRow(items) {
    const shown = items.filter((item) => item && item.on !== false);
    if (!shown.length) return '';
    return `<div class="msgr-row msgr-actions-row no-tile">${shown.map((item) => `<button type="button" class="msgr-pill${item.danger ? ' is-danger' : ''}" data-a="${act(item.fn)}">${item.icon ? `<i class="fas ${item.icon}" aria-hidden="true"></i>` : ''}<span>${esc(item.label)}</span></button>`).join('')}</div>`;
  }
  const visible = (id) => { const node = el(id); return Boolean(node) && !node.closest('.hidden') && !node.hidden; };

  definePage('notifications', {
    title: () => t('اعلان‌ها و صداها', 'Notifications and sounds'),
    blocks: [{
      native: () => {
        const permission = textOf('notificationPermissionHint');
        const pushHint = textOf('pushStatusHint');
        return group(t('اعلان‌ها', 'Notifications'), [
          toggle({ icon: 'fa-bell', tile: '#ff3b30', label: t('نمایش اعلان‌ها', 'Show notifications'), source: 'notificationsToggle' }),
        ], permission)
          + group(t('اعلان در پس‌زمینه', 'Background notifications'), [
            toggle({ icon: 'fa-moon', tile: '#5e5ce6', label: t('اعلان وقتی برنامه بسته است', 'Notify while the app is closed'), source: 'pushBackgroundToggle' }),
            visible('pushTtlSelect') ? choice({ icon: 'fa-hourglass-half', tile: '#8e8e93', label: t('حذف خودکار اشتراک پس از', 'Remove the subscription after'), source: 'pushTtlSelect' }) : '',
          ], pushHint)
          + group(t('محتوای اعلان', 'What a notification says'), [
            toggle({ icon: 'fa-user', tile: '#ff9f0a', label: t('نمایش نام فرستنده', 'Show the sender\'s name'), source: 'chatNoticeShowSender' }),
            toggle({ icon: 'fa-message', tile: '#30b0c7', label: t('نمایش متن پیام یا نوع رسانه', 'Show the message or the kind of media'), source: 'chatNoticeShowPreview' }),
          ], [hintOf('chatNoticeShowSender'), hintOf('chatNoticeShowPreview')].filter(Boolean).join(' '))
          + group(t('زنگ تماس', 'Call ringtone'), [
            choice({ icon: 'fa-phone-volume', tile: '#34c759', label: t('صدا', 'Sound'), source: 'chatRingtoneSelect' }),
            buttonsRow([
              { label: t('تست', 'Test'), icon: 'fa-play', fn: press('chatTestRingtoneBtn') },
              { label: t('صدای دلخواه', 'Custom sound'), icon: 'fa-file-audio', fn: press('chatImportRingtoneBtn') },
              { label: t('حذف', 'Remove'), icon: 'fa-trash', danger: true, on: visible('chatDeleteRingtoneBtn'), fn: press('chatDeleteRingtoneBtn') },
            ]),
          ])
          + group(t('صدای پیام', 'Message sound'), [
            choice({ icon: 'fa-message', tile: '#0a84ff', label: t('صدا', 'Sound'), source: 'chatMessageToneSelect' }),
            buttonsRow([
              { label: t('تست', 'Test'), icon: 'fa-play', fn: press('chatTestMessageToneBtn') },
              { label: t('صدای دلخواه', 'Custom sound'), icon: 'fa-file-audio', fn: press('chatImportMessageToneBtn') },
              { label: t('حذف', 'Remove'), icon: 'fa-trash', danger: true, on: visible('chatDeleteMessageToneBtn'), fn: press('chatDeleteMessageToneBtn') },
            ]),
          ]);
      },
    }, { header: () => (visible('unifiedPushCard') ? t('اعلان با UnifiedPush', 'UnifiedPush') : ''), legacy: () => (visible('unifiedPushCard') ? cardOf('upState') : []) }],
  });

  /* -- privacy and security: the lock, the password, biometrics -- */
  definePage('privacy', {
    title: () => t('حریم خصوصی و امنیت', 'Privacy and security'),
    blocks: [
      {
        native: () => {
          const api = lockApi();
          const state = api?.state?.() || {};
          const passkeyOn = !/نشده|not enabled|disabled|غیرفعال/i.test(textOf('passkeyStatusText'));
          const twofaOn = el('2faStatus')?.getAttribute('data-i18n') !== 'disabled' && !/غیرفعال|disabled/i.test(textOf('2faStatus'));
          const onoff = (v) => (v ? t('روشن', 'On') : t('خاموش', 'Off'));
          return group(t('قفل', 'Lock'), [
            toggle({ icon: 'fa-clock', tile: '#8e8e93', label: t('قفل خودکار', 'Auto-lock'), source: 'autoLockToggle' }),
            choice({ icon: 'fa-hourglass-half', tile: '#8e8e93', label: t('قفل شدن پس از', 'Lock after'), source: 'autoLockTime' }),
            toggle({ icon: 'fa-eye-slash', tile: '#5e5ce6', label: t('پنهان‌کردن صفحه هنگام جابه‌جایی', 'Hide the screen when switching apps'), source: 'screenGuardToggle' }),
          ], t('برنامه با رمز اصلی‌تان باز می‌شود. قفل خودکار آن را بعد از مدتی دوباره می‌بندد.', 'The app opens with your master password. Auto-lock closes it again after a while.'))
            + group(t('باز کردن قفل', 'Unlocking'), [
              row({ icon: 'fa-fingerprint', tile: '#0a84ff', label: t('بایومتریک / Passkey', 'Biometrics / passkey'), value: onoff(passkeyOn), arrow: true, fn: () => { global.togglePasskeyQuickUnlock?.(); setTimeout(refresh, 600); } }),
              row({ icon: 'fa-shield-halved', tile: '#34c759', label: t('تأیید دو مرحله‌ای', 'Two-step verification'), value: onoff(twofaOn), arrow: true, fn: () => { global.toggle2FA?.(); setTimeout(refresh, 600); } }),
            ])
            + group(t('رمز اصلی', 'Master password'), [
              row({ icon: 'fa-key', tile: '#ff9500', label: t('تغییر رمز اصلی', 'Change master password'), go: 'password' }),
              row({ icon: 'fa-circle-question', tile: '#8e8e93', label: t('سؤال‌های بازیابی', 'Recovery questions'), go: 'recovery' }),
            ])
            /* A second password that opens the decoy profile. It erases nothing
               (js/vault-profiles.js), so it is not drawn as destructive and its
               name never says "erase" — somebody under duress who believed it
               wiped the phone would be badly misled. */
            + group(t('پروفایل طعمه', 'Decoy profile'), [
              row({ icon: 'fa-user-secret', tile: '#5e5ce6', label: t('رمز پروفایل طعمه', 'Decoy profile password'), row: 'decoy', go: 'panic' }),
            ], t('این رمز در صفحهٔ ورود یک پروفایل طعمهٔ کامل باز می‌کند. داده‌های اصلی دست‌نخورده می‌مانند و چیزی پاک نمی‌شود.',
              'Entered at the login screen, this password opens a complete decoy profile. Your real data is left untouched; nothing is erased.'))
            /* The real erase, on its own and in red. resetAppSettings asks twice
               (a confirmation, then a typed word) before emergencyWipe runs. */
            + group(t('منطقهٔ خطر', 'Danger zone'), [
              row({ icon: 'fa-biohazard', tile: '#ff3b30', label: t('پاک کردن همه‌چیز در این دستگاه', 'Erase everything on this device'), row: 'erase-all', danger: true, fn: () => global.resetAppSettings?.() }),
            ], t('هویت، پیام‌ها، مخاطبان، فایل‌ها، کلیدها و تنظیمات برای همیشه پاک می‌شوند و از رله خواسته می‌شود صندوق این حساب را حذف کند. دو بار پرسیده می‌شود.',
              'The identity, messages, contacts, files, keys and settings are erased for good, and the relay is asked to delete this account\'s mailbox. You are asked twice.'));
        },
      },
      {
        native: () => group(t('پیام‌ها', 'Messages'), [
          toggle({ icon: 'fa-check-double', tile: '#0a84ff', label: t('ارسال تأیید خواندن', 'Send read receipts'), source: 'chatSendReceipts' }),
          offered('chatLinkPreviews') ? toggle({ icon: 'fa-link', tile: '#32ade6', label: t('پیش‌نمایش پیوند', 'Link previews'), source: 'chatLinkPreviews' }) : '',
        ], [hintOf('chatSendReceipts'), offered('chatLinkPreviews') ? hintOf('chatLinkPreviews') : ''].filter(Boolean).join(' ')),
      },
      {
        native: () => group(t('فایل‌ها', 'Files'), [
          toggle({ icon: 'fa-eraser', tile: '#ff9500', label: t('حذف متادیتا هنگام ارسال فایل', 'Strip metadata when sending a file'), source: 'chatStripMetadataToggle' }),
          toggle({ icon: 'fa-image', tile: '#34c759', label: t('پیشنهاد تبدیل عکس‌های HEIC به JPEG', 'Offer to convert HEIC photos to JPEG'), source: 'chatConvertHeicToggle' }),
        ], [hintOf('chatStripMetadataToggle'), hintOf('chatConvertHeicToggle')].filter(Boolean).join(' ')),
      },
    ],
  });

  /* A form page in the settings' own rows (roadmap 4.1): the app's real
     inputs, selects and buttons are MOVED into inset-grouped rows, not copied,
     so they keep their ids, their listeners, the virtual keyboard and the eye
     that shows a password. Built once; the nodes then stay where they are.

       groups: [{ header, footer, rows: [{ label, id, vk, eye }] }]
       action: the id of the button that submits, drawn as the page's primary
       button; extra: more buttons, drawn under it. */
  const realForms = new Map();
  /* A label is a pair [Persian, English], said in the language of the page at
     each draw: the nodes are built once, the words are not. */
  const say = (pair) => (Array.isArray(pair) ? t(pair[0], pair[1]) : String(pair || ''));
  function realForm({ groups, action, extra = [] }) {
    /* Once per page: a redraw asks again, and must get the same nodes back,
       with their words in the language now in force. */
    const kept = realForms.get(action);
    if (kept) {
      kept.labels.forEach(([node, pair]) => { node.textContent = say(pair); });
      return kept.nodes;
    }
    const labels = [];
    const out = [];
    for (const spec of groups) {
      const head = document.createElement('div');
      head.className = 'msgr-group-head';
      head.textContent = say(spec.header);
      labels.push([head, spec.header]);
      const box = document.createElement('div');
      box.className = 'msgr-group';
      for (const field of spec.rows) {
        const input = el(field.id);
        if (!input) continue;
        const rowNode = document.createElement('label');
        rowNode.className = `msgr-row msgr-field-row msgr-real-row no-tile${input.tagName === 'SELECT' ? ' is-select' : ''}`;
        if (field.label) {
          const label = document.createElement('span');
          label.className = 'msgr-field-label';
          label.textContent = say(field.label);
          labels.push([label, field.label]);
          rowNode.appendChild(label);
        }
        /* Its old look (a grey plate, a border, padding for an icon inside)
           belongs to the old card; in a row it is plain text, as Settings is. */
        input.className = 'msgr-input';
        if (input.type === 'password' || input.dataset.ltr) input.dir = 'ltr';
        rowNode.appendChild(input);
        /* The small buttons that sat beside the field (keyboard, eye) come too. */
        const tools = [];
        if (field.vk) tools.push(...document.querySelectorAll(`button[onclick*="toggleVirtualKeyboard('${field.id}')"]`));
        if (field.eye) tools.push(...document.querySelectorAll(`button[onclick*="togglePasswordVisibility('${field.id}'"]`));
        for (const tool of tools) {
          tool.className = 'msgr-field-tool';
          rowNode.appendChild(tool);
        }
        box.appendChild(rowNode);
      }
      if (!box.children.length) continue;
      if (spec.header) out.push(head);
      out.push(box);
      if (spec.footer) {
        const foot = document.createElement('p');
        foot.className = 'msgr-group-foot';
        foot.textContent = say(spec.footer);
        labels.push([foot, spec.footer]);
        out.push(foot);
      }
    }
    const actions = document.createElement('div');
    actions.className = 'msgr-btns msgr-real-actions';
    for (const [index, id] of [action, ...extra].entries()) {
      const button = typeof id === 'string' ? (el(id) || document.querySelector(id)) : id;
      if (!button) continue;
      button.className = `tg-btn is-wide${index === 0 ? ' is-primary' : ''}`;
      actions.appendChild(button);
    }
    if (actions.children.length) out.push(actions);
    if (out.length) realForms.set(action, { nodes: out, labels });
    return out;
  }

  definePage('password', {
    title: () => t('تغییر رمز اصلی', 'Change master password'),
    blocks: [{ form: true, legacy: () => realForm({
      groups: [
        { header: ['رمز فعلی', 'Current password'], rows: [{ label: ['رمز فعلی', 'Current'], id: 'currentPassword', vk: true }] },
        { header: ['رمز تازه', 'New password'], rows: [
          { label: ['رمز تازه', 'New'], id: 'newPassword', vk: true },
          { label: ['تکرار', 'Again'], id: 'confirmNewPassword', vk: true },
        ], footer: ['همهٔ داده‌های این دستگاه با رمز تازه دوباره رمز می‌شوند. رمز را جایی امن نگه دارید: بدون آن چیزی باز نمی‌شود.', 'Everything on this device is encrypted again under the new password. Keep it somewhere safe: nothing opens without it.'] },
      ],
      action: '#changePasswordSection button[onclick^="changeMasterPassword"]',
    }) }],
  });
  definePage('recovery', {
    title: () => t('سؤال‌های بازیابی', 'Recovery questions'),
    blocks: [{ form: true, legacy: () => realForm({
      groups: [
        { header: ['رمز فعلی', 'Current password'], rows: [{ label: ['رمز فعلی', 'Current'], id: 'settingsSecurityPassword', vk: true }] },
        { header: ['سؤال ۱', 'Question 1'], rows: [{ id: 'settingsSecQ1' }, { label: ['پاسخ', 'Answer'], id: 'settingsSecA1' }] },
        { header: ['سؤال ۲', 'Question 2'], rows: [{ id: 'settingsSecQ2' }, { label: ['پاسخ', 'Answer'], id: 'settingsSecA2' }] },
        { header: ['سؤال ۳', 'Question 3'], rows: [{ id: 'settingsSecQ3' }, { label: ['پاسخ', 'Answer'], id: 'settingsSecA3' }],
          footer: ['اگر رمز اصلی فراموش شود، با این سه پاسخ می‌شود آن را عوض کرد. سه سؤال متفاوت انتخاب کنید.', 'If the master password is forgotten, these three answers can change it. Choose three different questions.'] },
      ],
      action: '#changeSecurityQuestionsSection button[onclick^="changeSecurityQuestions"]',
    }) }],
    /* The questions are filled in as the old card did when it was opened
       (showChangeSecurityQuestions opens it, so it is closed first). */
    onBuild: () => {
      /* Only when the lists are still empty: a redraw while somebody is typing
         an answer must not clear it. */
      if ((el('settingsSecQ1')?.options.length || 0) > 1) return;
      try { el('changeSecurityQuestionsSection')?.classList.add('hidden'); global.showChangeSecurityQuestions?.(); } catch (_error) { /* not unlocked */ }
    },
  });
  definePage('panic', {
    title: () => t('رمز پروفایل طعمه', 'Decoy profile password'),
    blocks: [{ form: true, legacy: () => realForm({
      groups: [{ header: ['رمز طعمه', 'Decoy password'], rows: [{ label: ['رمز تازه', 'New'], id: 'panicPasswordInput_dz', eye: true }],
        footer: ['این رمز در صفحهٔ ورود یک پروفایل طعمهٔ کامل باز می‌کند. داده‌های اصلی دست‌نخورده می‌مانند و چیزی پاک نمی‌شود.', 'Entered at the login screen, this password opens a complete decoy profile. Your real data is left untouched; nothing is erased.'] }],
      action: 'button[onclick^="setPanicPassword(\'panicPasswordInput_dz\')"]',
    }) }],
  });

  /* -- data and storage -- */
  definePage('data', {
    title: () => t('داده و حافظه', 'Data and storage'),
    blocks: [
      {
        native: () => {
          /* The sizes are counted when asked for, and written in the language then. */
          try { global.renderStorageCard?.(); } catch (_error) { /* the chat is not up yet */ }
          const stats = [...document.querySelectorAll('#chatStorageStats .chat-storage-row')].map((rowNode) => `<div class="msgr-row no-tile msgr-stat"><span class="msgr-row-label">${esc(rowNode.querySelector('.chat-storage-label')?.textContent.trim() || '')}</span><span class="msgr-row-value">${esc((rowNode.querySelector('.chat-storage-value')?.textContent || '').trim())}</span></div>`);
          const note = (el('chatStorageCard')?.querySelector('.chat-storage-note-quiet')?.textContent || '').trim();
          return group(t('حافظهٔ رمزنگاری‌شده', 'Encrypted storage'), stats, t('فایل‌ها، پیام‌های صوتی و استیکرها با AES-256-GCM روی همین دستگاه رمز و ذخیره می‌شوند؛ کلید با رمز اصلی محافظت می‌شود و هرگز از دستگاه خارج نمی‌شود.', 'Files, voice messages and stickers are encrypted with AES-256-GCM on this device. The key is protected by your master password and never leaves it.'))
            + group(t('دانلود خودکار', 'Automatic download'), [
              choice({ icon: 'fa-cloud-arrow-down', tile: '#0a84ff', label: t('دانلود خودکار تا حجم', 'Download automatically up to'), source: 'chatAutoDownloadLimit' }),
            ], note)
            + group(t('آزاد کردن فضا', 'Free up space'), [
              row({ icon: 'fa-clock-rotate-left', tile: '#ff9500', label: t('پاک‌سازی قدیمی‌تر از ۳۰ روز', 'Clear older than 30 days'), fn: press('chatClearOldMediaBtn') }),
              row({ icon: 'fa-photo-film', tile: '#ff3b30', label: t('پاک‌سازی همهٔ رسانه‌ها', 'Clear all media'), danger: true, fn: press('chatClearAllMediaBtn') }),
              row({ icon: 'fa-face-smile', tile: '#ff3b30', label: t('حذف همهٔ پک‌های استیکر', 'Delete all sticker packs'), danger: true, fn: press('chatClearStickersBtn') }),
            ])
            + group(t('گفتگوها', 'Chats'), [
              row({ icon: 'fa-file-export', tile: '#34c759', label: t('برون‌ریزی گفتگوها', 'Export chats'), fn: press('chatExportChatsBtn') }),
              row({ icon: 'fa-file-import', tile: '#ff9500', label: t('درون‌ریزی گفتگوها', 'Import chats'), fn: press('chatImportChatsBtn') }),
              row({ icon: 'fa-eraser', tile: '#ff3b30', label: t('پاک‌سازی کل تاریخچه', 'Clear all history'), danger: true, fn: press('chatWipeHistoryBtn') }),
            ])
            + group(t('فایل‌ها و پشتیبان', 'Files and backup'), [
              row({ icon: 'fa-folder-open', tile: '#ff9500', label: t('مدیریت فایل‌های محلی', 'Local files'), fn: press('chatFileManagerToggle') }),
              row({ icon: 'fa-face-grin', tile: '#af52de', label: t('مدیریت پک‌های استیکر', 'Manage sticker packs'), fn: () => el('chatStickerPacksCard')?.querySelector('button')?.click() }),
              row({ icon: 'fa-folder-tree', tile: '#34c759', label: t('مدیریت فایل‌ها', 'File manager'), arrow: true, fn: () => PoorijaMessenger.openRow('vault') }),
              row({ icon: 'fa-right-left', tile: '#5e5ce6', label: t('مهاجرت و پشتیبان', 'Migration and backup'), arrow: true, fn: () => PoorijaMessenger.openRow('migration') }),
            ]);
        },
        after: (holder) => {
          /* The quota and the counts arrive after the page is first drawn: draw once more, a moment later. */
          if (Date.now() - Number(holder.dataset.last || 0) < 3000) return;
          holder.dataset.last = String(Date.now());
          setTimeout(() => { if (!holder.closest('[hidden]')) refresh(); }, 800);
        },
      },
      { legacy: () => [el('chatFileManager')].filter(Boolean), wrap: true },
    ],
  });

  /* -- appearance -- */
  definePage('appearance', {
    title: () => t('ظاهر', 'Appearance'),
    blocks: [
      /* What a change does, in view while it is made: the live preview of the chat card, first and kept in sight. */
      { legacy: () => [el('chatLivePreview')].filter(Boolean) },
      {
        native: () => {
          const dark = document.documentElement.classList.contains('dark');
          const auto = readAuto();
          const mark = (on) => (on ? '<i class="fas fa-check msgr-check" aria-hidden="true"></i>' : '');
          const themeRow = (label, icon, on, fn) => `<button type="button" class="msgr-row no-tile" data-a="${act(fn)}"><span class="msgr-row-label">${esc(label)}</span>${mark(on)}</button>`;
          const currentTheme = app()?.state?.settings?.theme || 'light';
          const paletteRow = (id, persian, english) => `<button type="button" class="msgr-row no-tile" data-a="${act(() => { writeAuto(false); global.setTheme?.(id); refresh(); })}" data-theme-choice="${id}" aria-pressed="${currentTheme === id}"><span class="msgr-row-label"><i class="msgr-theme-dot" aria-hidden="true"></i>${esc(t(persian, english))}</span>${mark(currentTheme === id)}</button>`;
          const px = parseFloat(el('settingFontSize')?.value) || parseFloat(getComputedStyle(document.body).fontSize) || 16;
          const pct = Math.round((px / 16) * 100);
          const slider = `<div class="msgr-row no-tile msgr-slider-row"><span class="msgr-row-label">${esc(t('اندازهٔ نوشتار', 'Text size'))}</span><span class="msgr-row-value" data-size-out dir="ltr">${pct}%</span><input type="range" min="80" max="140" step="1" value="${pct}" data-textsize aria-label="${esc(t('اندازهٔ نوشتار', 'Text size'))}"></div>`;
          return group(t('پوسته', 'Theme'), [
            themeRow(t('روشن', 'Light'), 'fa-sun', !auto && !dark, () => { writeAuto(false); global.setTheme?.('light'); refresh(); }),
            themeRow(t('تیره', 'Dark'), 'fa-moon', !auto && dark, () => { writeAuto(false); global.setTheme?.('dark'); refresh(); }),
            themeRow(t('خودکار (مثل سیستم)', 'Automatic (follow the system)'), 'fa-circle-half-stroke', auto, () => { writeAuto(true); applyAuto(); refresh(); }),
          ])
          + group(t('تم‌های رنگی', 'Color themes'), [
            paletteRow('ocean', 'اقیانوس', 'Ocean'),
            paletteRow('forest', 'جنگل', 'Forest'),
            paletteRow('aurora', 'شفق قطبی', 'Aurora'),
            paletteRow('sunset', 'غروب', 'Sunset'),
            paletteRow('nord', 'شمال', 'Nord'),
            paletteRow('solarized', 'آفتابی', 'Solarized'),
            paletteRow('pastel', 'پاستل', 'Pastel'),
          ], t('هفت پالت تازه با حفظ کنتراست متن و حالت گفتگو.', 'Seven new palettes with readable text and conversation states.'))
          + group(t('نوشتار', 'Text'), [slider,
            choice({ icon: 'fa-font', tile: '#32ade6', label: t('فونت فارسی', 'Persian font'), source: 'settingFontFa', fonts: true }),
            choice({ icon: 'fa-font', tile: '#5e5ce6', label: t('فونت انگلیسی', 'English font'), source: 'settingFontEn', fonts: true }),
          ], t('فونت و اندازه در همهٔ برنامه اعمال می‌شود.', 'The font and size apply across the app.'))
          + group(t('نوار پایین', 'Tab bar'), [
            switchRow({ icon: 'fa-tower-broadcast', tile: '#30b0c7', label: t('نمایش «محلی» در نوار', 'Show Local in the tab bar'), on: Boolean(global.PoorijaMessenger?.localInBar?.()), fn: (on) => { global.PoorijaMessenger?.setBarTab?.('local', on); } }),
          ], t('«محلی» همیشه در تنظیمات هست؛ اینجا می‌توانید آن را به نوار هم اضافه کنید.', 'Local is always in Settings; here you can add it to the bar as well.'));
        },
      },
      { header: () => t('ظاهر گفتگو', 'Chat appearance'), legacy: () => paneNodes('appearance'), wrap: true },
    ],
  });

  /* -- language -- */
  definePage('language', {
    title: () => t('زبان', 'Language'),
    blocks: [{
      native: () => {
        const mark = (on) => (on ? '<i class="fas fa-check msgr-check" aria-hidden="true"></i>' : '');
        const pick = (want) => () => { if ((want === 'fa') !== fa()) global.switchLanguage?.(); };
        return group('', [
          `<button type="button" class="msgr-row no-tile" data-a="${act(pick('fa'))}"><span class="msgr-row-label">فارسی</span><span class="msgr-row-value">Persian</span>${mark(fa())}</button>`,
          `<button type="button" class="msgr-row no-tile" data-a="${act(pick('en'))}"><span class="msgr-row-label">English</span><span class="msgr-row-value">انگلیسی</span>${mark(!fa())}</button>`,
        ]);
      },
    }],
  });

  /* -- server and connection --
     What is a switch on the old page is a row here; the fields (the relay's
     address, its fingerprint, the proxy, TURN) are the page's own nodes moved
     in; the five buttons that sat in a grid are rows. The calls and the
     messages have their own places: a switch for video is not about a server. */
  const nodesOf = (...ids) => ids.map((id) => el(id)).filter(Boolean);
  const labelOf = (id) => { const label = el(id)?.previousElementSibling; return label && label.tagName === 'LABEL' ? label : null; };
  definePage('connection', {
    title: () => t('سرور و اتصال', 'Server and connection'),
    blocks: [
      {
        /* The state of the connection, on the page about the connection. It is
           drawn from the same values the header pill reads, and the page is
           drawn again when they change (see startLive), so it is the live
           state and not the state at the moment the page was opened. */
        native: () => {
          const cs = chatSt();
          const tone = cs?.connectionState || 'offline';
          const status = textOf('chatConnectionStatus') || t('عدم اتصال', 'Disconnected');
          const contacts = (cs?.peers || []).filter((peer) => !peer.type && peer.status === 'online').length;
          const relay = (cs?.profile?.serverUrl || el('chatServerUrl')?.value || '').trim();
          const stat = (label, value, live) => `<div class="msgr-row no-tile msgr-stat"><span class="msgr-row-label">${esc(label)}</span><span class="msgr-row-value${live ? ' msgr-hc-status' : ''}"${live ? ` data-tone="${esc(tone)}"` : ''}>${live ? '<i class="msgr-hc-dot"></i>' : ''}<span${live ? '' : ' dir="auto"'}>${esc(value)}</span></span></div>`;
          return group(t('وضعیت', 'Status'), [
            stat(t('اتصال', 'Connection'), status, true),
            relay ? stat(t('سرور', 'Server'), relay.replace(/^https?:\/\//, ''), false) : '',
            stat(t('مخاطبان آنلاین', 'Contacts online'), String(contacts), false),
          ]);
        },
      },
      {
        native: () => {
          /* The relay's fingerprint row lives in the old pane, which is always
             out of sight; asking whether it is visible on screen was always
             no, and the fingerprint disappeared from Settings. What counts is
             the row's own state, drawn fresh here. */
          if (typeof global.renderRelayIdentityRow === 'function') global.renderRelayIdentityRow();
          const identityRow = el('chatRelayIdentityRow');
          const identityShown = Boolean(identityRow && !identityRow.classList.contains('hidden') && textOf('chatRelayIdentityValue'));
          const changed = identityShown && identityRow.classList.contains('is-changed');
          const acceptOn = identityShown && changed && !el('chatRelayIdentityAcceptBtn')?.classList.contains('hidden');
          const proxyShown = visible('chatProxyUrl');
          return group(t('اتصال', 'Connection'), [
            toggle({ icon: 'fa-plug', tile: '#0a84ff', label: t('اتصال خودکار', 'Connect automatically'), source: 'chatAutoConnect' }),
            toggle({ icon: 'fa-globe', tile: '#5e5ce6', label: t('ارتباط بین رله‌ها', 'Cross-relay communication'), source: 'chatCrossRelayComm' }),
            toggle({ icon: 'fa-server', tile: '#8e8e93', label: t('رلهٔ مهمان از همین خانواده', 'Guest relay of the same family'), source: 'chatUseGuestRelays' }),
            toggle({ icon: 'fa-wifi', tile: '#32ade6', label: t('شناسایی محلی', 'Local discovery'), source: 'chatAutoDiscovery' }),
            toggle({ icon: 'fa-hourglass-half', tile: '#ff9500', label: t('شمارش معکوس تعلیق', 'Suspension countdown'), source: 'chatShowSuspensionCountdown' }),
          ], hintOf('chatCrossRelayComm'))
            + group(t('سرور', 'Server'), [
              field({ label: t('آدرس رله', 'Relay address'), source: 'chatServerUrl', type: 'url', ltr: true }),
              identityShown ? `<div class="msgr-row no-tile msgr-print${changed ? ' is-warning' : ''}"><span class="msgr-row-label">${esc(textOf('chatRelayIdentityTitle') || t('اثر انگشت رله', 'Relay fingerprint'))}</span><code class="msgr-code" dir="ltr">${esc(textOf('chatRelayIdentityValue'))}</code></div>` : '',
              acceptOn ? row({ icon: 'fa-shield-halved', tile: '#ff9500', label: t('پذیرفتن هویت جدید', 'Accept the new identity'), fn: () => { chatState.relayPinPromptOpen = false; global.promptRelayPinChange?.(); } }) : '',
              proxyShown ? field({ label: t('پراکسی', 'Proxy'), source: 'chatProxyUrl', ltr: true }) : '',
              proxyShown ? row({ icon: 'fa-floppy-disk', tile: '#34c759', label: t('ذخیره و راه‌اندازی دوباره', 'Save and restart'), fn: press('chatProxySaveBtn') }) : '',
            ], identityShown ? textOf('chatRelayIdentityNote') : '');
        },
      },
      /* The relay family (the operator's signed list, its key, when it was last
         checked) and the best-relay choice (automatic, suggest only, off; each
         relay measured from here; move here). Both are cards the chat already
         draws and keeps up to date under their own ids; they are moved in, and
         drawn once more as the page opens so what they show is current. Each
         hides itself when there is nothing to show (no family, one relay). */
      {
        header: () => (visible('chatRelayFamily') ? t('خانوادهٔ رله‌ها', 'Relay family') : ''),
        legacy: () => {
          if (typeof global.renderRelayFamily === 'function') global.renderRelayFamily();
          return [el('chatRelayFamily')].filter(Boolean);
        },
      },
      {
        header: () => (visible('chatRelayChoice') ? t('بهترین سرور', 'Best relay') : ''),
        legacy: () => {
          if (typeof global.renderRelayChoice === 'function') global.renderRelayChoice();
          return [el('chatRelayChoice')].filter(Boolean);
        },
      },
      {
        native: () => group(t('تماس', 'Calls'), [
          toggle({ icon: 'fa-video', tile: '#34c759', label: t('تماس تصویری', 'Video calls'), source: 'chatAllowVideo' }),
          switchRow({ icon: 'fa-code-compare', tile: '#0a84ff', label: t('آینه‌ای کردن تصویر خودم', 'Mirror my own picture'), on: chatSt()?.profile?.mirrorSelfVideo !== false, fn: (on) => { global.setMirrorSelfDefault?.(on); refresh(); } }),
          toggle({ icon: 'fa-wave-square', tile: '#af52de', label: t('حذف نویز پس‌زمینه', 'Background noise removal'), source: 'chatCallNoiseToggle' }),
          toggle({ icon: 'fa-tower-broadcast', tile: '#8e8e93', label: t('STUN عمومی (Google / Twilio)', 'Public STUN (Google / Twilio)'), source: 'chatPublicStun' }),
        ], hintOf('chatCallNoiseToggle'))
          + group(t('سرور TURN', 'TURN server'), [
            field({ label: t('آدرس', 'Address'), source: 'chatTurnUrl', ltr: true }),
            field({ label: t('نام کاربری', 'Username'), source: 'chatTurnUsername', ltr: true }),
            field({ label: t('رمز', 'Password'), source: 'chatTurnCredential', type: 'password', ltr: true }),
          ], t('برای کاربران بیرون از شبکه، TURN باید دامنه/IP قابل دسترس عمومی باشد.', 'For people outside your network the TURN server needs a public address.')),
      },
      {
        native: () => buttons(t('عملیات', 'Actions'), [
          button({ icon: 'fa-link', label: t('اتصال', 'Connect'), kind: 'primary', wide: true, fn: press('chatConnectBtn') }),
          button({ icon: 'fa-rotate', label: t('اتصال دوباره', 'Reconnect'), fn: press('chatReconnectBtn') }),
          button({ icon: 'fa-magnifying-glass-location', label: t('جستجوی محلی', 'Discover local'), fn: press('chatDiscoverLocalBtn') }),
          button({ icon: 'fa-file-export', label: t('برون‌ریزی پیکربندی', 'Export config'), fn: press('chatConfigExportBtn') }),
          button({ icon: 'fa-file-import', label: t('درون‌ریزی پیکربندی', 'Import config'), fn: press('chatConfigImportBtn') }),
        ], t('فایل پیکربندی با رمزی که خودتان تعیین می‌کنید رمز می‌شود؛ گیرنده باید همان رمز را وارد کند.', 'The config file is encrypted with a password you choose; whoever imports it types the same one.'))
          + buttons(t('عیب‌یابی', 'Diagnostics'), [
            button({ icon: 'fa-stethoscope', label: t('گزارش وضعیت چت', 'Chat status report'), wide: true, fn: press('chatDiagBtn') }),
            button({ icon: 'fa-broom', label: t('پاک‌سازی مخاطبین بی‌استفاده', 'Remove unused contacts'), kind: 'danger', wide: true, fn: press('chatPruneContactsBtn') }),
          ]),
      },
      { legacy: () => [el('chatDiagBody')].filter(Boolean), wrap: true },
    ],
  });

  /* ---- where legacy nodes come from -------------------------------------- */

  /* The chat built its settings as panes (appearance, notifications, ...). The
     panes are emptied into the page that wants them; the nodes keep their ids
     and their listeners. */
  function paneNodes(id) {
    const pane = document.querySelector(`.chat-settings-tabpanel[data-settings-pane="${id}"]`);
    return pane ? [...pane.childNodes].filter((node) => node.nodeType === 1) : [];
  }
  /* The card a control sits in. */
  function cardOf(controlId) {
    const node = el(controlId);
    const card = node?.closest('.glass, .chat-storage-card');
    return card ? [card] : [];
  }

  /* ---- the frame --------------------------------------------------------- */

  function pageEl(id) { return host?.querySelector(`[data-msgr-page="${id}"]`); }

  function build(id, { live = false } = {}) {
    let section = pageEl(id);
    const def = PAGES[id];
    if (!def) return null;
    if (!section) {
      section = document.createElement('section');
      section.className = 'msgr-page';
      section.dataset.msgrPage = id;
      section.hidden = true;
      section.innerHTML = '<div class="msgr-page-body"></div>';
      def.blocks.forEach((block, index) => {
        const holder = document.createElement('div');
        holder.className = block.form ? 'msgr-block msgr-real' : (block.legacy ? 'msgr-block msgr-legacy' : 'msgr-block');
        holder.dataset.block = String(index);
        section.firstElementChild.appendChild(holder);
      });
      host.appendChild(section);
    }
    const holders = section.querySelectorAll('.msgr-block');
    def.blocks.forEach((block, index) => {
      const holder = holders[index];
      if (block.native) {
        /* Drawn again only when what it says has changed. The action ids in the
           markup are new on every call, so they are left out of the comparison —
           and the ids a skipped call made are thrown away, because nothing on
           the page holds them (the buttons keep the ids of the last real draw).
           This is what lets a page be refreshed on a timer without a flicker,
           without losing a half-pressed button, and without filling the
           registry above with ids nobody will ever click. */
        const seqBefore = actionSeq;
        const html = block.native();
        const base = html.replace(/data-(a|sw)="\d+"/g, 'data-$1');
        /* `state` is for a block whose after() depends on something outside the
           markup — the nodes it moves in arrive later than the first draw, and
           the chat can move them out again; a draw that said the same would
           never be followed by the move. It is read before the draw (to compare)
           and after it (to remember what the draw left). */
        const stateNow = block.state ? block.state(holder) : '';
        if (holder.dataset.drawn !== undefined && holder.__base === base && holder.__state === stateNow) {
          for (let id = seqBefore + 1; id <= actionSeq; id += 1) actions.delete(String(id));
          return;
        }
        holder.dataset.drawn = '1';
        holder.innerHTML = html;
        block.after?.(holder);
        holder.__base = base;
        holder.__state = block.state ? block.state(holder) : '';
      } else if (block.legacy && !live) {
        const nodes = block.legacy();
        let into = holder;
        if (block.wrap) {
          into = holder.querySelector(':scope > .msgr-legacy-card');
          if (!into) { into = document.createElement('div'); into.className = 'msgr-legacy-card'; holder.appendChild(into); }
        }
        for (const node of nodes) { if (node.parentNode !== into) into.appendChild(node); }
        if (block.wrap && !into.children.length) into.hidden = true; else if (block.wrap) into.hidden = false;
        const header = block.header?.();
        let head = holder.querySelector(':scope > .msgr-group-head');
        if (header) {
          if (!head) { head = document.createElement('div'); head.className = 'msgr-group-head'; holder.prepend(head); }
          head.textContent = header;
        }
      }
    });
    /* A moved card loses the heading it had: the page names it. */
    section.querySelectorAll('.msgr-legacy > .glass > h3:first-child, .msgr-legacy > .chat-storage-card > h4:first-child').forEach((h) => { h.hidden = true; });
    section.querySelectorAll('.msgr-legacy .glass').forEach((card) => card.classList.add('msgr-plain'));
    /* A timed redraw (startLive) leaves the moved-in legacy cards and the
       page's own set-up alone: they update themselves, and redrawing them
       twice a second would throw away what a finger is on. */
    if (!live) def.onBuild?.(section);
    return section;
  }

  function refresh() {
    const id = stack[stack.length - 1];
    if (id === 'choice') return;
    const section = pageEl(id);
    if (!section || section.hidden) return;
    const keepScroll = scroller()?.scrollTop;
    build(id);
    if (keepScroll != null && scroller()) scroller().scrollTop = keepScroll;
    syncBound(section);
  }

  /* The element that actually scrolls the Settings pages. It is not
     #content-settings (that one grows to fit its pages and never scrolls) but
     whichever ancestor has overflow — on the app's shell, <main>. Resetting the
     wrong one is why a page opened scrolled to wherever the last one ended. */
  function scroller() {
    let node = host || document.getElementById('content-settings');
    while (node && node !== document.body && node !== document.documentElement) {
      const overflow = getComputedStyle(node).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }
  /* Where each page was scrolled to when it was left, so going back lands where
     you were and going forward starts at the top. */
  const scrollMemory = new Map();
  function rememberScroll() {
    const current = stack[stack.length - 1];
    const sc = scroller();
    if (current && sc) scrollMemory.set(current, sc.scrollTop);
  }
  function settleScroll(top) {
    const sc = scroller();
    if (!sc) return;
    sc.scrollTop = top;
    /* The page has only just been unhidden and may still be laying out (its
       entrance animation runs for a moment), so the first assignment can be
       clamped to a height that is not final. */
    window.requestAnimationFrame(() => { sc.scrollTop = top; });
    window.setTimeout(() => { sc.scrollTop = top; }, 260);
  }

  function show(id, direction, restoreTop = 0) {
    try { if (id !== 'devices' && chatState.settingsPane === 'devices') chatState.settingsPane = ''; } catch (_error) { /* the chat is not up yet */ }
    host.querySelectorAll('.msgr-page').forEach((section) => {
      const on = section.dataset.msgrPage === id;
      if (on && section.hidden) {
        section.hidden = false;
        section.classList.remove('is-pop', 'is-push');
        void section.offsetWidth;
        section.classList.add(direction === 'back' ? 'is-pop' : 'is-push');
      }
      if (!on) section.hidden = true;
    });
    settleScroll(direction === 'back' ? restoreTop : 0);
  }

  function open(id) {
    if (!host) return;
    if (id === 'choice') return;
    const section = build(id);
    if (!section) return;
    if (stack[stack.length - 1] !== id) { rememberScroll(); stack.push(id); }
    show(id, 'push');
    syncBound(section);
    notify();
  }

  function back() {
    if (stack.length <= 1) return false;
    stack.pop();
    const id = stack[stack.length - 1];
    if (id === 'choice') { stack.pop(); }
    const target = stack[stack.length - 1];
    build(target);
    show(target, 'back', scrollMemory.get(target) || 0);
    notify();
    return true;
  }

  function reset() {
    if (!host) return;
    stack.length = 0;
    stack.push('root');
    scrollMemory.clear();
    build('root');
    show('root', 'back');
    notify();
  }

  function notify() {
    try { global.PoorijaMessenger?.sync?.(); } catch (_error) { /* shell not up yet */ }
  }

  function currentTitle() {
    const id = stack[stack.length - 1];
    if (id === 'choice') return choiceTitle;
    return PAGES[id]?.title?.() || '';
  }

  /* ---- choosing a value ------------------------------------------------------ */

  let choiceTitle = '';
  function openChoice(o) {
    const source = el(o.source);
    if (!source || !host) return;
    choiceTitle = o.label;
    let section = pageEl('choice');
    if (!section) {
      section = document.createElement('section');
      section.className = 'msgr-page';
      section.dataset.msgrPage = 'choice';
      section.hidden = true;
      section.innerHTML = '<div class="msgr-page-body"><div class="msgr-block"></div></div>';
      host.appendChild(section);
    }
    const items = [...source.options].map((option) => {
      const on = option.value === source.value;
      const label = option.textContent.replace(/\s*\(.*?\)\s*$/, '');
      const style = o.fonts ? ` style="font-family:${esc(option.value)}"` : '';
      return `<button type="button" class="msgr-row no-tile" data-a="${act(() => { source.value = option.value; source.dispatchEvent(new Event('change', { bubbles: true })); back(); setTimeout(refresh, 50); })}"><span class="msgr-row-label"${style}>${esc(label)}</span>${on ? '<i class="fas fa-check msgr-check" aria-hidden="true"></i>' : ''}</button>`;
    });
    section.querySelector('.msgr-block').innerHTML = `<div class="msgr-group">${items.join('')}</div>`;
    rememberScroll();
    stack.push('choice');
    show('choice', 'push');
    notify();
  }

  /* ---- switches and fields that mirror a control ------------------------------ */

  function syncBound(section) {
    section.querySelectorAll('input[data-bind]').forEach((input) => {
      const source = el(input.dataset.bind.replace(/^#/, ''));
      if (source) input.checked = Boolean(source.checked);
    });
  }

  function wire() {
    host.addEventListener('click', (event) => {
      const button = event.target.closest('[data-a]');
      if (!button || !host.contains(button)) return;
      const fn = actions.get(button.getAttribute('data-a'));
      if (fn) { event.preventDefault(); fn(event); }
    });
    const toSource = (event, type) => {
      const input = event.target.closest('input[data-field]');
      if (!input) return false;
      const source = el(input.dataset.field);
      if (!source) return true;
      source.value = input.value;
      source.dispatchEvent(new Event(type, { bubbles: true }));
      return true;
    };
    host.addEventListener('input', (event) => {
      if (toSource(event, 'input')) return;
      const range = event.target.closest('input[data-textsize]');
      if (!range) return;
      const px = Math.round(16 * (Number(range.value) / 100) * 10) / 10;
      const select = el('settingFontSize');
      if (select) {
        const value = `${px}px`;
        if (![...select.options].some((option) => option.value === value)) {
          const extra = document.createElement('option');
          extra.value = value;
          extra.textContent = value;
          select.appendChild(extra);
        }
        select.value = value;
        global.applyAppearanceSettings?.();
      }
      const out = range.closest('.msgr-slider-row')?.querySelector('[data-size-out]');
      if (out) out.textContent = `${range.value}%`;
    });
    host.addEventListener('change', (event) => {
      if (toSource(event, 'change')) return;
      const own = event.target.closest('input[data-sw]');
      if (own) { const fn = actions.get(own.getAttribute('data-sw')); if (fn) fn(own.checked); return; }
      const input = event.target.closest('input[data-bind]');
      if (!input) return;
      const source = el(input.dataset.bind.replace(/^#/, ''));
      if (!source) return;
      source.checked = input.checked;
      source.dispatchEvent(new Event('change', { bubbles: true }));
      setTimeout(refresh, 50);
    });
  }

  /* ---- the page you are looking at follows the app --------------------------- */

  /* A page was drawn when it was opened and again on a language switch, so a
     status on it — connected or not, how many devices are online, what the
     vault holds — said what was true at that moment and stayed there until you
     went to another page and back. It is drawn again now whenever the app says
     something changed (poorija:chat-live) and, as a net for everything that
     says nothing, a few times a second while the page is on screen. A draw that
     would change nothing is skipped (see build), so this costs a string
     comparison. Never while a field has the keyboard: redrawing under a
     half-typed word takes the caret away. */
  function typingHere() {
    const active = document.activeElement;
    return Boolean(active && host && host.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)
      && active.type !== 'checkbox' && active.type !== 'radio');
  }
  function liveRefresh() {
    if (!host || document.hidden) return;
    if ((app()?.state?.activeTab) !== 'settings') return;
    if (typingHere()) return;
    const sel = global.getSelection?.();
    if (sel && !sel.isCollapsed && host.contains(sel.anchorNode)) return;
    const id = stack[stack.length - 1];
    const section = id && id !== 'choice' ? pageEl(id) : null;
    if (!section || section.hidden) return;
    /* The storage page counts what is in the databases every time it is drawn,
       which is not something to do twice a second. */
    if (id === 'data' && Date.now() - liveDataAt < 8000) return;
    if (id === 'data') liveDataAt = Date.now();
    const sc = scroller();
    const top = sc ? sc.scrollTop : 0;
    build(id, { live: true });
    syncBound(section);
    if (sc && sc.scrollTop !== top) sc.scrollTop = top;
  }
  let liveTimer = 0;
  let liveDataAt = 0;
  let liveTick = 0;
  function startLive() {
    const kick = () => {
      window.clearTimeout(liveTick);
      liveTick = window.setTimeout(liveRefresh, 120);
    };
    global.addEventListener('poorija:chat-live', kick);
    if (!liveTimer) liveTimer = window.setInterval(liveRefresh, 1500);
  }

  /* ---- theme: light, dark, a named palette, or what the system says ------------- */

  const AUTO_KEY = 'poorija_theme_auto';
  function readAuto() { try { return localStorage.getItem(AUTO_KEY) === '1'; } catch (_error) { return false; } }
  function writeAuto(on) { try { localStorage.setItem(AUTO_KEY, on ? '1' : '0'); } catch (_error) { /* private mode */ } }
  function applyAuto() {
    if (!readAuto() || typeof global.matchMedia !== 'function') return;
    global.setTheme?.(global.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }

  /* ---- starting ----------------------------------------------------------------- */

  /* The old tab's cards that belong to no page: the algorithms of the encryption
     suite, the order of its tabs, its desktop shell. Parked, not deleted. */
  function park() {
    const settings = el('content-settings');
    if (!settings) return;
    let parking = el('msgrParked');
    if (!parking) {
      parking = document.createElement('div');
      parking.id = 'msgrParked';
      parking.hidden = true;
      parking.setAttribute('aria-hidden', 'true');
      settings.appendChild(parking);
    }
    [...settings.querySelectorAll(':scope > .max-w-4xl > .glass, :scope > .max-w-4xl > div')].forEach((card) => {
      if (card.id === 'msgrSettingsList' || card.contains(host)) return;
      parking.appendChild(card);
    });
  }

  function init() {
    const settings = el('content-settings');
    if (!settings || host) return;
    host = document.createElement('div');
    host.id = 'msgrPages';
    host.className = 'msgr-pages';
    /* The list the shell used to draw is this page's root now; its id stays. */
    const old = el('msgrSettingsList');
    settings.prepend(host);
    wire();
    build('root');
    host.querySelector('[data-msgr-page="root"]').hidden = false;
    if (old) old.id = 'msgrSettingsListLegacy';
    host.querySelector('[data-msgr-page="root"] .msgr-page-body')?.setAttribute('id', 'msgrSettingsList');
    /* The legacy cards go into pages when the page is first opened; whatever
       nothing opens is parked so the tab shows only the list. */
    setTimeout(() => {
      Object.keys(PAGES).forEach((id) => { if (id !== 'root') build(id); });
      park();
      host.querySelectorAll('.msgr-page').forEach((s) => { if (s.dataset.msgrPage !== 'root') s.hidden = true; });
    }, 0);
    global.addEventListener('poorija:language-changed', () => { Object.keys(PAGES).forEach((id) => { if (pageEl(id)) build(id); }); refresh(); notify(); });
    global.addEventListener('poorija:tab-switched', () => { if ((app()?.state?.activeTab) === 'settings') refresh(); });
    startLive();
    if (typeof global.matchMedia === 'function') global.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyAuto);
    applyAuto();
    wireLiveProfile();
    notify();
  }

  /* Put the pages back as a history entry had them: the stack as it was, the
     last of it on screen (the browser's back and forward, js/nav-history.js). */
  function restore(wanted) {
    if (!host) return;
    const ids = (Array.isArray(wanted) ? wanted : ['root']).filter((id) => id === 'root' || PAGES[id]);
    if (!ids.length || ids[0] !== 'root') ids.unshift('root');
    const same = ids.length === stack.length && ids.every((id, i) => id === stack[i]);
    if (same) return;
    const deeper = ids.length > stack.length;
    stack.length = 0;
    ids.forEach((id) => stack.push(id));
    const top = stack[stack.length - 1];
    build(top);
    show(top, deeper ? 'push' : 'back', deeper ? 0 : (scrollMemory.get(top) || 0));
    notify();
  }

  global.PoorijaSettingsPages = {
    open, back, reset, refresh, restore,
    stack: () => stack.slice(),
    depth: () => stack.length - 1,
    title: currentTitle,
    current: () => stack[stack.length - 1],
    pages: () => Object.keys(PAGES),
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 0));
  else setTimeout(init, 0);
})(typeof globalThis !== 'undefined' ? globalThis : this);
