/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* The three states a sent message goes through, and the colour of the third.
 *
 * Part of the P00RIJA end-to-end suite. See tests/e2e/README.md.
 *
 *   one tick    the message left this device
 *   two ticks   it reached the other one, which has not looked at it
 *   two ticks,  the reader opened the thread and the message was on screen
 *   in colour
 *
 * The state machine was already right when this was written; the colours were
 * not painted at all, because `.chat-message-bubble.chat-message-outgoing *`
 * sets `color: inherit !important` on everything inside the outgoing bubble
 * and !important outranks specificity. Every state rendered the same white, so
 * delivered and read were distinguishable only by counting glyphs. That is
 * what the colour half of this suite exists to keep fixed.
 *
 * The theme walk is the other half: the read colour is the theme's accent, and
 * a bubble ranges from a pale #dbeafe to a full #ff00ff, so a colour that is
 * legible on one theme can vanish on another. Each theme is checked against
 * its OWN bubble at the 3:1 non-text contrast bar. */
import { openApp, identity, importIdentity, openFirstChat, waitFor, browser } from './_chat-harness.mjs';
import { createChecks } from './_check.mjs';

const { results, check } = createChecks({ entry: (n, ok) => ({ n, ok }) });

const A = await openApp('SENDER');
const B = await openApp('RECEIVER');
await importIdentity(A, await identity(B));
await importIdentity(B, await identity(A));
await A.waitForTimeout(2500);
await openFirstChat(A);
await openFirstChat(B);
await A.waitForTimeout(1500);

const lastTick = (p) => p.evaluate(() => {
  const el = [...document.querySelectorAll('#chatMessages [data-chat-message-status]')].pop();
  if (!el) return null;
  return {
    label: el.textContent.trim(),
    cls: [...el.classList].filter((c) => c.startsWith('is-')).join(' '),
    color: getComputedStyle(el).color,
    insideBubble: Boolean(el.closest('.chat-message-bubble')),
  };
});
const settles = (p, want) => waitFor(p, (w) => {
  const el = [...document.querySelectorAll('#chatMessages [data-chat-message-status]')].pop();
  return Boolean(el && el.classList.contains(w));
}, { timeoutMs: 25000, arg: want });

console.log('\n===== one tick, then two, while the reader is looking elsewhere =====');
/* The receiver looks away on purpose. Measured on a page that is staring at
   the thread, "arrived but not read" is a state that never exists for long
   enough to see, and the suite would only ever prove the jump to read. */
await B.evaluate(() => window.switchTab('encrypt'));
await B.waitForTimeout(800);
await A.fill('#chatComposer', 'tick probe');
await A.press('#chatComposer', 'Enter');

const delivered = await settles(A, 'is-delivered') && await lastTick(A);
console.log('  ' + JSON.stringify(delivered));
check('the sender reaches two ticks while the reader is on another tab', Boolean(delivered), delivered?.cls);
check('two ticks is the glyph, not one', delivered?.label === '✓✓', delivered?.label);
check('and it did not skip delivered to land on read', delivered?.cls === 'is-delivered', delivered?.cls);

console.log('\n===== the reader opens the thread =====');
await B.evaluate(() => window.switchTab('chat'));
await B.waitForTimeout(600);
await B.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
const seen = await settles(A, 'is-seen') && await lastTick(A);
console.log('  ' + JSON.stringify(seen));
check('the sender moves to the read state', Boolean(seen), seen?.cls);
check('still two ticks', seen?.label === '✓✓', seen?.label);
check('the colour changed when it did', Boolean(seen) && seen.color !== delivered?.color,
  `${delivered?.color} -> ${seen?.color}`);
check('the status glyph really is inside the outgoing bubble', seen?.insideBubble === true,
  'if this ever goes false the !important note above can be revisited');

console.log('\n===== one message, one notice =====');
/* The count the user reported as wrong. The page raises its own toast for
   anything that lands while it is on screen; the service worker raises a
   system banner for anything that lands while it is not. Two notices for one
   message is what happens when both fire, which is why the worker checks for a
   focused window first (tests/e2e/swnotify.mjs holds that half). This half is
   the page's: one arrival, one toast, and no second one from a message the
   relay also queued and replayed. */
const noticeCount = await B.evaluate(async () => {
  const seen = [];
  const original = window.PoorijaApp?.showNotification;
  window.PoorijaApp.showNotification = (message, kind, options) => { seen.push({ message: String(message), key: options && options.key ? String(options.key) : '' }); return original?.(message, kind, options); };
  window.switchTab('encrypt');                       // look away, so the toast is the notice
  await new Promise((r) => setTimeout(r, 400));
  window.__noticeProbe = seen;
  return true;
});
void noticeCount;
for (const text of ['one', 'two', 'three']) {
  await A.fill('#chatComposer', `notice ${text}`);
  await A.press('#chatComposer', 'Enter');
  await A.waitForTimeout(900);
}
await B.waitForTimeout(2500);
/* An arrival is announced once, and the announcements of one conversation are
   ONE toast that counts (they share a key; js/chat/23-export-import.js): the
   first says what the message says, the next ones say how many. */
const notices = await B.evaluate(() => {
  const list = window.__noticeProbe || [];
  const arrivals = list.filter((entry) => entry.key);
  return { all: list.map((entry) => entry.message), arrivals: arrivals.map((entry) => entry.message), keys: [...new Set(arrivals.map((entry) => entry.key))] };
});
console.log('  ' + JSON.stringify(notices.arrivals));
check('three messages raise three announcements, not six', notices.arrivals.length === 3,
  `${notices.arrivals.length} toasts for 3 messages`);
check('which are one toast of the conversation, counting up', notices.keys.length === 1 && /notice one|\d+ messages/.test(notices.arrivals[0] || '') && /[34] messages/.test(notices.arrivals[2] || ''),
  notices.arrivals.join(' | '));
const landed = await B.evaluate(() => {
  const key = Object.keys(chatState.history || {})[0];
  return (chatState.history[key] || []).filter((e) => /^notice /.test(e.text || '')).length;
});
check('and lands in the thread once each, not twice', landed === 3, `${landed} entries`);
await B.evaluate(() => window.switchTab('chat'));
await B.waitForTimeout(500);

console.log('\n===== a retried message does not roll the read tick back =====');
/* The sender resending after a lost receipt is the ordinary case appendHistory's
   duplicate-merge exists for, and it used to demote the entry: its private copy
   of the status ladder had no rung for 'seen', so 'seen' ranked 0 — below every
   other state — and the merge preferred the older, lower status. */
/* The chat parts are classic scripts sharing one realm, so chatState and
   appendHistory are reachable by their bare names from here. */
const replayed = await A.evaluate(() => {
  const key = Object.keys(chatState.history || {})
    .find((k) => (chatState.history[k] || []).some((e) => e.direction === 'out'));
  if (!key) return { error: 'no outgoing message to replay' };
  const entry = [...chatState.history[key]].reverse().find((e) => e.direction === 'out');
  const before = entry.status;
  appendHistory(key, {
    id: entry.id, direction: 'out', type: 'text', text: entry.text, status: 'delivered',
    createdAt: entry.createdAt,
  });
  const after = (chatState.history[key] || []).find((e) => e.id === entry.id)?.status;
  return { before, after, ladder: chatStatusRank('seen'), rungs: { ...CHAT_STATUS_RANK } };
});
console.log('  ' + JSON.stringify(replayed));
check('the ladder knows what read means', replayed.ladder === 5, String(replayed.ladder));
check('replaying the message leaves it read rather than demoting it to delivered',
  replayed.after === replayed.before, `${replayed.before} -> ${replayed.after}`);

console.log('\n===== every theme, against its own bubble =====');
const THEMES = ['light','dark','pastel','midnight','neon','dracula','nord','solarized',
  'cyberpunk','ocean','forest','aurora','sunset','linen','obsidian'];
const themed = await A.evaluate(async (themes) => {
  /* .chat-msg-status carries `transition: color 0.18s`, and a colour caught
     mid-transition computes to an INTERPOLATED oklab() triple, not to the
     rgb() the theme actually declares. Parsing that with an rgb() parser turns
     a mint into rgb(1,0,0). Switching a theme is not an animation worth
     measuring, so the transition is taken away for the walk and put back after
     it, which makes every reading the settled value by construction. */
  const freeze = document.createElement('style');
  freeze.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
  document.head.appendChild(freeze);
  /* rgb() counts 0-255, color(srgb ...) counts 0-1. Reading one with the
     other's scale is the other way this measurement has been wrong. */
  const px = (value) => {
    const text = String(value).trim();
    const nums = (text.match(/-?[\d.]+(?:e-?\d+)?/g) || []).map(Number);
    const scale = /^color\(/.test(text) ? 255 : 1;
    if (!/^(rgba?\(|color\()/.test(text)) return null;   // never guess at a form we do not know
    return nums.slice(0, 3).map((c) => Math.round(Math.min(255, Math.max(0, c * scale))));
  };
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const out = [];
  for (const name of themes) {
    window.setTheme(name);
    await new Promise((r) => setTimeout(r, 220));
    const el = [...document.querySelectorAll('#chatMessages [data-chat-message-status].is-seen')].pop();
    const bubble = el?.closest('.chat-message-bubble');
    if (!el || !bubble) { out.push({ name, error: 'no read tick on screen' }); continue; }
    const tick = px(getComputedStyle(el).color);
    const back = px(getComputedStyle(bubble).backgroundColor);
    const plain = px(getComputedStyle(bubble).color);
    if (!tick || !back || !plain) {
      out.push({ name, error: `unreadable colour: ${getComputedStyle(el).color}` });
      continue;
    }
    out.push({
      name,
      tick: `rgb(${tick})`,
      bubble: `rgb(${back})`,
      contrast: Number(ratio(tick, back).toFixed(2)),
      grey: Math.max(...tick) - Math.min(...tick) < 30,
      differs: String(tick) !== String(plain),
    });
  }
  window.setTheme('dark');
  freeze.remove();
  return out;
}, THEMES);
themed.forEach((o) => console.log(o.error
  ? `  ${o.name.padEnd(10)} ${o.error}`
  : `  ${o.name.padEnd(10)} ${o.tick.padEnd(20)} on ${o.bubble.padEnd(20)} ${String(o.contrast).padStart(6)}:1`));
const good = themed.filter((o) => !o.error);
check('every theme has a read tick on screen', good.length === THEMES.length, `${good.length}/${THEMES.length}`);
check('none of them paints it the same colour as the delivered tick',
  good.every((o) => o.differs), good.filter((o) => !o.differs).map((o) => o.name).join(', ') || 'all differ');
check('each stays legible on its own bubble (>= 3:1)',
  good.every((o) => o.contrast >= 3),
  good.filter((o) => o.contrast < 3).map((o) => `${o.name} ${o.contrast}`).join(', ') || `worst ${Math.min(...good.map((o) => o.contrast))}`);
check('and none of them is a grey', good.every((o) => !o.grey),
  good.filter((o) => o.grey).map((o) => o.name).join(', ') || 'all chromatic');
/* Since the messenger skin (2.3) the read tick is chosen against its own bubble, and a single colour could not serve a
   light bubble and a dark one. The plain light and dark themes share one colour each; since 2.5 the themes that bring
   a palette of their own (Ocean, Forest, Aurora, Sunset, Nord, Solarized, Pastel) bring a tick colour of their own
   too, so "exactly two colours" is no longer the rule. What is kept is the part that matters: no colour is used on a
   light bubble and on a dark one, both kinds of bubble are there, and (above) each tick is legible on its own bubble. */
const relative = (rgb) => {
  const [r, g, b] = String(rgb).match(/\d+/g).map(Number).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const sidesOf = new Map();
good.forEach((o) => sidesOf.set(o.tick, new Set([...(sidesOf.get(o.tick) || []), relative(o.bubble) > 0.4 ? 'light bubble' : 'dark bubble'])));
const kinds = new Set([...sidesOf.values()].flatMap((set) => [...set]));
check('the tick has one colour for a light bubble and another for a dark one, never one for both',
  kinds.size === 2 && [...sidesOf.values()].every((set) => set.size === 1),
  [...sidesOf.entries()].map(([colour, set]) => `${colour}: ${[...set].join('+')}`).join(' | '));

const failed = results.filter((r) => !r.ok).length;
console.log(`\n===== ${failed} failed of ${results.length} =====`);
await browser.close();
process.exit(failed ? 1 : 0);
