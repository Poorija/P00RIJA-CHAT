/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Every screen, in both languages, at every size, in every theme, measured.
 *
 * The other suites each know one feature. This one knows none of them: it opens
 * every tab, every page of Settings, a conversation with a message in it and the
 * sheets above it, and on each state it asks the page the same questions, the ones
 * whose answer is a defect wherever it comes up:
 *
 *   errors     nothing in the console, no uncaught exception, no failed request;
 *   overflow   the page does not scroll sideways and nothing straddles the edge of
 *              the screen outside a scroller;
 *   clipped    text is not cut off by its own box unless it ends in an ellipsis;
 *   targets    every button, link and field is at least 24px in both directions
 *              (WCAG 2.2, 2.5.8) — Telegram's own are 44;
 *   names      every button, link and field has a name a screen reader can say;
 *   overlap    no two controls sit on top of each other;
 *   raw        no "undefined", "NaN", "[object Object]" or an untranslated key;
 *   images     no picture that failed to load;
 *   ids        no id used twice;
 *   contrast   text against its background is at least 3:1 (the plain-wrong line;
 *              4.5:1 is reported, not enforced, until the palette is done);
 *   language   a Persian screen has no run of English words and an English screen
 *              no Persian (reported, not enforced: names and messages are the
 *              user's own).
 *
 *   node tests/e2e/sweep.mjs                 # all of it
 *   SWEEP_QUICK=1 node tests/e2e/sweep.mjs   # 390px, two themes
 *   SWEEP_REPORT=1 node tests/e2e/sweep.mjs  # print every finding and do not fail
 */
import { openApp, identity, importIdentity, browser, waitFor } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
import { createChecks } from './_check.mjs';

const { results, check } = createChecks({ maxDetail: 1400, entry: (_name, ok) => Boolean(ok) });
const REPORT = Boolean(process.env.SWEEP_REPORT);
/* Set from a measured run; see the ratchet near the end. */
const CONTRAST_LOW_CEILING = 2; /* 2026-11-21, 2.13 tree: 8 left after the device id, badges, sticker panel and danger buttons, then the light theme's red (#dc2626, 4.43:1 on --bg) and Pastel's tint went darker; a margin of 2 for a place that reads at 4.4-4.5 on one size. 110 before 2.13's first pass, 383 on 2026-11-16 */
const QUICK = Boolean(process.env.SWEEP_QUICK);
const decode = (card) => JSON.parse(Buffer.from(card.replace('poorija-chat-v1:', ''), 'base64').toString('utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const VIEWPORTS = QUICK ? [[390, 844]] : [[320, 640], [390, 844], [430, 932], [768, 1024], [1280, 800]];
const THEMES = QUICK ? ['dark', 'light'] : ['dark', 'light', 'midnight', 'pastel', 'neon', 'dracula', 'nord', 'solarized', 'cyberpunk', 'ocean', 'forest', 'aurora', 'sunset', 'linen', 'obsidian'];
const LANGS = ['en', 'fa'];
const PAGES = ['root', 'me', 'devices', 'notifications', 'privacy', 'password', 'recovery', 'panic', 'data', 'appearance', 'language', 'connection', 'clocks'];

/* ---- the questions, asked inside the page ---------------------------------- */
function audit([lang, screen]) {
  const found = [];
  const vw = window.innerWidth;
  const describe = (el) => {
    if (!el || !el.tagName) return '';
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).map((c) => `.${c}`).join('') : '';
    const label = (el.getAttribute?.('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    return `${el.tagName.toLowerCase()}${id}${cls}${label ? ` "${label}"` : ''}`;
  };
  const add = (kind, el, detail = '') => found.push({ kind, at: describe(el), detail: String(detail).slice(0, 160) });
  const shown = (el) => { try { return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); } catch (_e) { return el.offsetParent !== null; } };
  const rectOf = (el) => el.getBoundingClientRect();
  /* Inside something that scrolls or clips on purpose. */
  const containedByScroller = (el) => {
    for (let n = el.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.overflowX !== 'visible') return true;
    }
    return false;
  };
  /* Transformed ancestors park panels off-screen on purpose. */
  const parked = (el) => {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const t = getComputedStyle(n).transform;
      if (t && t !== 'none') { const r = rectOf(n); if (r.left >= vw - 1 || r.right <= 1) return true; }
    }
    return false;
  };

  if (document.documentElement.scrollWidth > vw + 1) add('overflow', document.documentElement, `page is ${document.documentElement.scrollWidth}px wide in ${vw}px`);

  const all = [...document.querySelectorAll('body *')].filter((el) => !['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'HEAD', 'TEMPLATE', 'NOSCRIPT', 'PATH', 'G', 'DEFS', 'RECT', 'CIRCLE', 'LINE', 'POLYLINE', 'POLYGON'].includes(el.tagName.toUpperCase()));
  const visible = all.filter((el) => shown(el) && (() => { const r = rectOf(el); return r.width > 0 && r.height > 0; })());

  /* straddling the edge of the screen */
  for (const el of visible) {
    const r = rectOf(el);
    const straddles = (r.right > vw + 1 && r.left < vw - 4) || (r.left < -1 && r.right > 4);
    if (straddles && !containedByScroller(el) && !parked(el) && getComputedStyle(el).position !== 'fixed' && !el.closest('.msgr-lens')) { /* the tab bar's moving highlight is mid-slide, by design */
      if (el.children.length === 0 || /^(BUTTON|A|INPUT|IMG|SVG|SPAN|P|H[1-6]|LABEL)$/.test(el.tagName)) add('overflow', el, `${Math.round(r.left)}..${Math.round(r.right)} in ${vw}`);
    }
  }

  /* text cut off by its own box */
  for (const el of visible) {
    const cs = getComputedStyle(el);
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    if (cs.overflowX !== 'visible' && el.scrollWidth - el.clientWidth > 1 && cs.textOverflow !== 'ellipsis' && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && cs.whiteSpace === 'nowrap') add('clipped', el, `${el.scrollWidth} > ${el.clientWidth}`);
    if (cs.overflowY === 'hidden' && el.scrollHeight - el.clientHeight > 2 && !cs.webkitLineClamp?.match?.(/\d/) && cs.webkitLineClamp === 'none' && cs.textOverflow !== 'ellipsis' && cs.maxHeight === 'none' && cs.height !== 'auto') add('clipped', el, `y ${el.scrollHeight} > ${el.clientHeight}`);
  }

  /* controls: size, name, overlap */
  const controls = visible.filter((el) => el.matches('button, a[href], [role="button"], input:not([type="hidden"]), select, textarea, summary, [tabindex="0"]'));
  const nameOf = (el) => {
    const direct = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('placeholder') || '';
    if (direct.trim()) return direct.trim();
    if (el.getAttribute('aria-labelledby')) { const t = el.getAttribute('aria-labelledby').split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim(); if (t) return t; }
    if (el.labels && el.labels.length) { const t = [...el.labels].map((l) => l.textContent).join(' ').trim(); if (t) return t; }
    const text = (el.textContent || '').trim(); if (text) return text;
    const img = el.querySelector('img[alt]'); if (img?.alt.trim()) return img.alt.trim();
    if (el.value && /^(button|submit|reset)$/.test(el.type)) return el.value;
    return '';
  };
  for (const el of controls) {
    const r = rectOf(el);
    const cs = getComputedStyle(el);
    const checkable = el.matches('input[type="checkbox"], input[type="radio"], input[type="file"], input[type="range"]');
    const inline = cs.display.startsWith('inline') && el.tagName === 'A' && el.parentElement && (el.parentElement.textContent || '').trim().length > (el.textContent || '').trim().length + 3;
    if (!checkable && !inline && Math.min(r.width, r.height) < 24 && !parked(el)) add('targets', el, `${Math.round(r.width)}x${Math.round(r.height)}`);
    if (!nameOf(el) && !(checkable && el.closest('label')) && !parked(el)) add('names', el, el.outerHTML.slice(0, 90));
  }
  for (let i = 0; i < controls.length; i += 1) {
    for (let j = i + 1; j < controls.length; j += 1) {
      const a = controls[i]; const b = controls[j];
      if (a.contains(b) || b.contains(a)) continue;
      if (a.closest('label') && a.closest('label') === b.closest('label')) continue;
      /* a popup, a sheet or a dialog sits over the page on purpose: what is under it is covered by design */
      if (/^(thread-menu|thread-plus|thread-stickers|settings:identity)$/.test(screen)) continue;
      /* the floating tab bar is drawn over the end of a scrolling list on purpose */
      if (a.closest('.mobile-tab-bar, .mobile-tab-btn, #mobileTabBar') || b.closest('.mobile-tab-bar, .mobile-tab-btn, #mobileTabBar')) continue;
      /* a button that lives inside a field (show password, virtual keyboard) is inside it on purpose */
      const inField = (field, button) => /^(INPUT|TEXTAREA|SELECT)$/.test(field.tagName) && button.tagName === 'BUTTON' && (() => { const f = rectOf(field); const r = rectOf(button); return r.left >= f.left - 1 && r.right <= f.right + 1 && r.top >= f.top - 1 && r.bottom <= f.bottom + 1; })();
      if (inField(a, b) || inField(b, a)) continue;
      const ra = rectOf(a); const rb = rectOf(b);
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w <= 0 || h <= 0) continue;
      const smaller = Math.min(ra.width * ra.height, rb.width * rb.height);
      if (smaller > 0 && (w * h) / smaller > 0.3 && !parked(a) && !parked(b)) {
        /* the one painted on top must be the one that gets the tap: a covered control is the defect */
        add('overlap', a, `with ${describe(b)}`);
      }
    }
  }

  /* raw values and untranslated keys, in text a person reads */
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const texts = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (!parent || /^(SCRIPT|STYLE|TEXTAREA|OPTION|NOSCRIPT)$/.test(parent.tagName) || !shown(parent)) continue;
    const text = n.textContent.trim();
    if (text) texts.push({ text, parent });
  }
  for (const { text, parent } of texts) {
    if (/(^|[\s(])(undefined|NaN|\[object Object\]|null)([\s).,:]|$)/.test(text)) add('raw', parent, text);
    if (/^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+$/.test(text) && !parent.closest('.chat-message, [data-user-content], code, pre')) add('raw', parent, `key? ${text}`);
  }
  const seen = new Set();
  for (const el of document.querySelectorAll('[id]')) { if (seen.has(el.id)) add('ids', el, el.id); seen.add(el.id); }
  for (const img of document.querySelectorAll('img')) if (shown(img) && img.complete && img.naturalWidth === 0 && img.getAttribute('src')) add('images', img, img.getAttribute('src').slice(0, 60));

  /* contrast */
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[,\s/]+/).filter(Boolean).map(parseFloat); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const over = (top, under) => { const a = top.a + under.a * (1 - top.a); if (!a) return { r: 0, g: 0, b: 0, a: 0 }; return { r: (top.r * top.a + under.r * under.a * (1 - top.a)) / a, g: (top.g * top.a + under.g * under.a * (1 - top.a)) / a, b: (top.b * top.a + under.b * under.a * (1 - top.a)) / a, a }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const backdrop = (el) => {
    const layers = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (const layer of layers.reverse()) base = over(layer, base);
    return base;
  };
  const reportedContrast = new Set();
  for (const { text, parent } of texts) {
    const r = rectOf(parent);
    if (r.right < 0 || r.left > vw || r.width < 2 || r.height < 2 || parked(parent)) continue;
    /* the delivery ticks are drawn as a shape painted in the text colour: the glyph itself is not meant to be read */
    if (parent.closest('.chat-msg-status')) continue;
    /* a pulsing line ("typing…") is measured at the quiet end of its animation: it is at full strength half the time */
    if (parent.closest('.animate-pulse')) continue;
    /* a disabled control is exempt from the contrast rule (WCAG 1.4.3): it is meant to look unavailable */
    if (parent.closest('button:disabled, [disabled], [aria-disabled="true"]')) continue;
    const cs = getComputedStyle(parent);
    const fg0 = parse(cs.color); const bg = backdrop(parent);
    if (!fg0 || !bg) continue;
    let opacity = 1; for (let n = parent; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity);
    const fg = over({ ...fg0, a: fg0.a * opacity }, bg);
    const L1 = lum(fg); const L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const key = `${describe(parent)}|${text.slice(0, 16)}`;
    if (ratio < 4.5 && !reportedContrast.has(key)) {
      reportedContrast.add(key);
      add(ratio < 3 ? 'contrast' : 'contrast-low', parent, `${ratio.toFixed(2)} "${text.slice(0, 24)}"`);
    }
  }

  /* language */
  for (const { text, parent } of texts) {
    /* what is the PERSON's (their messages, names and status), the names of the languages themselves, and the clocks' city names are not the interface's words */
    if (parent.closest('#chatMessages .chat-message-text, .chat-message-reply, .chat-thread-title, .chat-peer-card, [data-user-content], .msgr-hc-name, .msgr-hero-name, .msgr-hc-mood, input, textarea, code, pre, .msgr-avatar, #chatProfileClocks, .chat-clock-box-name')) continue;
    if (screen === 'settings:language') continue;
    /* The app's own name is a name, in Latin script on a Persian screen as it is on the icon (the welcome panel's eyebrow, in capitals). */
    if (lang === 'fa' && /[A-Za-z]{3,}\s+[A-Za-z]{3,}/.test(text.replace(/P00RIJA\s+CHAT/gi, '')) && !/[؀-ۿ]/.test(text)) add('language', parent, text);
    if (lang === 'en' && /[؀-ۿ]/.test(text)) add('language', parent, text);
  }
  return found;
}

/* ---- the run ---------------------------------------------------------------- */
const stacks = await startTwoStacks();
const everything = [];
const consoleLines = [];
try {
  const phone = (w, h) => ({ viewport: { width: w, height: h }, isMobile: w < 768, hasTouch: w < 768, deviceScaleFactor: 2 });
  const A = await openApp('SWEEP', { origin: stacks.a.url, relay: stacks.a.url, context: phone(390, 844) });
  const B = await openApp('PEER', { origin: stacks.a.url, relay: stacks.a.url });
  const cards = { A: await identity(A), B: await identity(B) };
  const fp = { A: decode(cards.A).fingerprint, B: decode(cards.B).fingerprint };
  await importIdentity(A, cards.B);
  await importIdentity(B, cards.A);
  const openThread = (page, key) => page.evaluate(async (k) => {
    const peer = findPeerByAnyKey(k);
    chatState.activeConversationId = getConversationKey(peer);
    chatState.activePeerClientId = peer.clientId || '';
    renderPeers(); renderActivePeer(); renderMessages(); updateChatShellMode?.();
    await new Promise((r) => setTimeout(r, 400));
  }, key);
  const closeThread = (page) => page.evaluate(() => { chatState.activeConversationId = ''; chatState.activePeerClientId = ''; renderActivePeer(); renderMessages(); updateChatShellMode?.(); });
  await openThread(A, fp.B); await openThread(B, fp.A);
  await A.evaluate(() => { const b = document.getElementById('chatComposer'); b.value = 'See you at six'; b.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('chatSendMessageBtn').click(); });
  await waitFor(B, () => Object.values(chatState.history).flat().some((e) => e.text === 'See you at six' && e.direction === 'in'), { timeoutMs: 60000 });
  await B.evaluate(() => { const b = document.getElementById('chatComposer'); b.value = 'یک پیام فارسی برای آزمایش — ساعت شش می‌بینمت'; b.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('chatSendMessageBtn').click(); });
  await sleep(1500);

  A.on('console', (m) => { if (m.type() === 'error') consoleLines.push(`console.error: ${m.text().slice(0, 200)}`); });
  A.on('pageerror', (e) => consoleLines.push(`pageerror: ${String(e.message).slice(0, 200)}`));
  A.on('requestfailed', (r) => { const u = r.url(); if (!/\/(favicon|chat-signal)/.test(u) && !/ERR_ABORTED/.test(r.failure()?.errorText || '')) consoleLines.push(`requestfailed: ${u.slice(0, 120)} ${r.failure()?.errorText}`); });
  A.on('response', (r) => { if (r.status() >= 400 && !/\/(favicon|chat-signal)/.test(r.url()) && r.url().startsWith(stacks.a.url)) consoleLines.push(`http ${r.status()}: ${r.url().slice(0, 120)}`); });

  const screens = [
    ['chats', async () => { await closeThread(A); await A.evaluate(() => window.PoorijaMessenger.go('chats')); }],
    ['thread', async () => { await A.evaluate(() => window.PoorijaMessenger.go('chats')); await openThread(A, fp.B); }],
    ['thread-menu', async () => { await openThread(A, fp.B); await A.evaluate(() => document.getElementById('chatThreadMenuBtn')?.click()); }],
    ['thread-plus', async () => { await openThread(A, fp.B); await A.evaluate(() => document.getElementById('chatComposerPlusBtn')?.click()); }],
    ['thread-stickers', async () => { await openThread(A, fp.B); await A.evaluate(() => document.getElementById('chatStickerBtn')?.click()); }],
    ['calls', async () => { await closeThread(A); await A.evaluate(() => window.PoorijaMessenger.go('calls')); }],
    ['groups', async () => { await closeThread(A); await A.evaluate(() => window.PoorijaMessenger.go('groups')); }],
    ['local', async () => { await closeThread(A); await A.evaluate(() => window.PoorijaMessenger.go('local')); }],
    ...PAGES.map((id) => [`settings:${id}`, async () => { await closeThread(A); await A.evaluate((page) => { window.PoorijaMessenger.go('settings'); window.PoorijaSettingsPages.reset(); if (page !== 'root') window.PoorijaSettingsPages.open(page); }, id); }]),
    ['settings:identity', async () => { await closeThread(A); await A.evaluate(() => { window.PoorijaMessenger.go('settings'); window.PoorijaSettingsPages.reset(); document.querySelector('.msgr-hc-btn')?.click(); }); }],
  ];
  /* Every state starts from the page and nothing over it: a modal, a dialog, a sheet or a menu left open by the state
     before would be audited as part of the next one. */
  const dismiss = async () => {
    for (let round = 0; round < 5; round += 1) {
      const open = await A.evaluate(() => {
        let closed = 0;
        const click = (selector) => document.querySelectorAll(selector).forEach((node) => { if (node.checkVisibility?.()) { node.click(); closed += 1; } });
        click('.poorija-dialog-backdrop.is-open .poorija-dialog-cancel');
        click('[data-chat-modal-close]');
        click('.pc.is-open [data-pc="cancel"]');
        click('#chatFullSheet .chat-sheet-close');
        for (const id of ['chatThreadMenuBtn', 'chatComposerPlusBtn']) { const b = document.getElementById(id); if (b && b.getAttribute('aria-expanded') === 'true') { b.click(); closed += 1; } }
        return closed;
      }).catch(() => 0);
      /* Never Escape: pressed twice it is the app's panic gesture (everything on the device is erased), which asks first, and this sweep once set that dialog off on every screen. */
      await sleep(150);
      if (!open) break;
    }
  };
  const visit = async (label, lang, theme, [w, h]) => {
    for (const [name, go] of screens) {
      try { await go(); } catch (error) { everything.push({ label, screen: name, kind: 'navigation', at: '', detail: String(error.message).slice(0, 120) }); continue; }
      await sleep(350);
      /* Finish what is animating before it is measured: a screen that is fading in is read at 40% opacity, and the same
         screen read a frame later is not — the count of low-contrast places differed by 70 between two identical runs. */
      await A.evaluate(() => document.getAnimations().forEach((animation) => { try { animation.finish(); } catch (_error) { /* an infinite one (a pulse) cannot be finished */ } })).catch(() => {});
      await sleep(120);
      /* A dialog nobody asked for is a finding of its own, and it would be audited as part of the screen under it. */
      const stray = await A.evaluate(() => document.querySelector('.poorija-dialog-backdrop.is-open .poorija-dialog-message')?.textContent?.trim() || '').catch(() => '');
      if (stray) everything.push({ label, screen: name, kind: 'dialog-open', at: 'poorija-dialog', detail: stray.slice(0, 100) });
      const findings = await A.evaluate(audit, [lang, name]).catch((error) => [{ kind: 'audit-crash', at: '', detail: String(error.message).slice(0, 120) }]);
      for (const f of findings) everything.push({ label: `${label}`, screen: name, ...f });
      await dismiss();
    }
  };

  for (const lang of LANGS) {
    await A.evaluate((l) => { if (PoorijaApp.state.language !== l) window.switchLanguage(); }, lang);
    await sleep(600);
    for (const theme of THEMES) {
      await A.evaluate((t) => setTheme(t), theme);
      const sizes = theme === 'dark' || theme === 'light' ? VIEWPORTS : [[390, 844]];
      for (const size of sizes) {
        await A.setViewportSize({ width: size[0], height: size[1] });
        await sleep(300);
        await visit(`${lang}/${theme}/${size[0]}x${size[1]}`, lang, theme, size);
      }
    }
  }
  await A.evaluate(() => setTheme('dark'));
  await A.setViewportSize({ width: 390, height: 844 });

  /* ---- verdict: group by kind and by place, so a defect that shows on forty screens is one line ---- */
  const HARD = ['dialog-open', 'language', 'overflow', 'clipped', 'targets', 'names', 'overlap', 'raw', 'images', 'ids', 'contrast', 'navigation', 'audit-crash'];
  const group = (kind) => {
    const byPlace = new Map();
    for (const f of everything.filter((x) => x.kind === kind)) {
      const key = `${f.screen} ▸ ${f.at}${f.detail ? ` ▸ ${f.detail}` : ''}`;
      const entry = byPlace.get(key) || { count: 0, where: new Set() };
      entry.count += 1; entry.where.add(f.label);
      byPlace.set(key, entry);
    }
    return [...byPlace.entries()].map(([key, v]) => `${key}  [${v.count}× e.g. ${[...v.where].slice(0, 2).join(', ')}]`);
  };
  console.log(`\n  states audited: ${LANGS.length} languages x ${THEMES.length} themes (full size set on dark and light), ${screens.length} screens each`);
  /* Text between 3:1 and 4.5:1 is not enforced yet — the palette is a design decision, and most of it is the iOS red,
     orange and blue on a grey cell — but it is COUNTED, and the count may only go down. Measured 2026-11-16 after the
     first round of fixes: CONTRAST_LOW_CEILING (383) distinct (screen, element, text) places across every language, theme
     and size. A new low-contrast text is a new failure; fixing some lowers the number to set here. */
  const lowPlaces = group('contrast-low').length;
  check(`contrast-low: the count of places between 3:1 and 4.5:1 does not grow (${lowPlaces}, ceiling ${CONTRAST_LOW_CEILING})`, REPORT || lowPlaces <= CONTRAST_LOW_CEILING, `${lowPlaces}`);
  for (const kind of [...HARD, 'contrast-low']) {
    const lines = group(kind);
    if (!lines.length) { if (HARD.includes(kind)) check(`${kind}: none on any screen, language, theme or size`, true); continue; }
    console.log(`\n  ${kind}: ${lines.length} distinct`);
    lines.slice(0, REPORT ? 400 : 14).forEach((l) => console.log(`     ${l}`));
    if (HARD.includes(kind)) check(`${kind}: none on any screen, language, theme or size`, REPORT, `${lines.length} distinct — ${lines.slice(0, 6).join(' | ')}`);
  }
  const errors = [...new Set(consoleLines)];
  console.log(`\n  console/page/network: ${errors.length} distinct`);
  errors.slice(0, 30).forEach((l) => console.log(`     ${l}`));
  check('no console error, uncaught exception or failed request across the whole sweep', REPORT || errors.length === 0, errors.slice(0, 5).join(' | '));
} catch (error) {
  check('the suite ran to the end', false, error?.stack || String(error));
} finally {
  await stacks.stop?.();
  await browser?.close?.().catch(() => {});
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n===== ${failed} failed of ${results.length} =====`);
process.exit(failed ? 1 : 0);
