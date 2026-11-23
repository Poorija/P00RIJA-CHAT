/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* The card at the top of Settings, and the pixel companion.
 *
 *   - three modules in a row, none taller than the picture: the world clocks, the
 *     picture, the companion — the clocks on the left of the picture and the companion
 *     on the right, in Persian as in English;
 *   - the clocks stand one under the other inside their tile, your own time first and
 *     then each city, every line centred in the tile, and nothing in the tile is cut off
 *     or runs out of it, at the widths phones come in; a city whose day is not yours
 *     has one letter in front of its time (T or Y; ف or د);
 *   - turning the companion off is not a one-way door: the Profile page has a switch
 *     that brings it back (the toast said it did, and no such switch existed), and
 *     another that chooses which one;
 *   - the Identity door has the card glyph it always had.
 *
 *   node tests/e2e/profilecard.mjs
 */
import { openApp, browser } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
import { createChecks } from './_check.mjs';

const { results, check } = createChecks({ maxDetail: 300, entry: (_name, ok) => Boolean(ok) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const layout = (page) => page.evaluate(() => {
  const box = (selector) => { const node = document.querySelector(selector); if (!node) return null; const r = node.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
  return { pet: box('.msgr-hc-pet'), avatar: box('.msgr-hc-avatar'), clocks: box('.msgr-hc-clocks #chatProfileClocks'), dir: document.documentElement.dir, door: { icon: Boolean(document.querySelector('.msgr-hc-btn i.fa-id-card')), svg: Boolean(document.querySelector('.msgr-hc-btn svg')) } };
});
/* What the clock tile holds: each row's box, where its text really is (a range, not the box,
   which can be wider than its text), and whether anything is cut off or runs out of the tile. */
const tile = (page) => page.evaluate(() => {
  const node = document.querySelector('.msgr-hc-clocks #chatProfileClocks');
  if (!node) return null;
  const box = node.getBoundingClientRect();
  const rtl = document.documentElement.dir === 'rtl';
  const textRect = (el) => { const range = document.createRange(); const text = [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim()); if (!text) return el.getBoundingClientRect(); range.selectNodeContents(text); return range.getBoundingClientRect(); };
  const rows = [...node.querySelectorAll('.chat-clock-line, .chat-clock-box')].map((row) => { const r = row.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), cls: row.className }; });
  const times = [...node.querySelectorAll('.chat-clock-time, .chat-clock-box-time')];
  const markers = [...node.querySelectorAll('.chat-clock-box-date')];
  /* A text's own rectangle is its font's ascent and descent, a pixel or so taller than its line: a pixel and a half of tolerance up and down, none sideways. */
  const inTile = (r) => r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.top >= box.top - 1.5 && r.bottom <= box.bottom + 1.5;
  const outside = [...times.map((n) => [n, textRect(n)]), ...markers.map((n) => [n, n.getBoundingClientRect()])].filter(([, r]) => !inTile(r)).map(([n]) => n.textContent.trim());
  const centre = (r) => (r.left + r.right) / 2;
  /* A line cut with an ellipsis is as wide as its box and centred in it by construction; what is measured is the lines that fit. */
  const centred = [...node.querySelectorAll('.chat-clock-time, .chat-clock-box-time, .chat-clock-box-name, .chat-clock-dates')].filter((n) => n.scrollWidth - n.clientWidth <= 0).map((n) => Math.abs(centre(textRect(n)) - centre(box)));
  return {
    h: Math.round(box.height), top: Math.round(box.top), bottom: Math.round(box.bottom), rows, outside,
    offCentre: Math.round(Math.max(...centred) * 10) / 10,
    /* a pixel of a glyph's own box below its line is not a cut */ overflowY: node.scrollHeight - node.clientHeight, count: node.dataset.rows,
    dates: node.querySelector('.chat-clock-dates')?.textContent.trim() || '',
    radius: getComputedStyle(node).borderTopLeftRadius, doors: getComputedStyle(document.querySelector('.msgr-hc-btn')).borderTopLeftRadius,
    markers: markers.map((m) => { const mr = m.getBoundingClientRect(); const tr = textRect(m.parentElement); const hit = document.elementFromPoint((mr.left + mr.right) / 2, (mr.top + mr.bottom) / 2); return { text: m.firstChild?.textContent.trim() || m.textContent.trim(), seen: hit === m || m.contains(hit), inFront: rtl ? mr.left >= tr.right - 0.5 : mr.right <= tr.left + 0.5, overlap: Math.round(Math.max(0, Math.min(mr.right, tr.right) - Math.max(mr.left, tr.left))) }; }),
  };
});
const goSettings = async (page) => {
  await page.evaluate(() => { window.PoorijaMessenger.go('settings'); window.PoorijaSettingsPages.reset(); });
  await sleep(900);
};

const stacks = await startTwoStacks();
try {
  const A = await openApp('A', { origin: stacks.a.url, relay: stacks.a.url });
  const B = await openApp('B', { origin: stacks.a.url, relay: stacks.a.url });
  await sleep(1500);
  await goSettings(A);
  await goSettings(B);

  console.log('\n===== the row =====');
  const en = await layout(A);
  console.log('  ' + JSON.stringify(en));
  check('the clocks, the picture and the companion are one height, the picture\'s', en.pet && en.avatar && en.clocks && en.clocks.h === en.avatar.h && en.pet.h === en.avatar.h && en.avatar.h >= 80, JSON.stringify(en));
  check('the clocks are left of the picture and the companion right of it', en.dir === 'ltr' && en.clocks.r <= en.avatar.l && en.avatar.r <= en.pet.l + 1 && en.clocks.t === en.avatar.t, JSON.stringify(en));
  const companionDrawn = await A.evaluate(() => { const svg = document.querySelector('.msgr-hc-pet #chatPet svg'); const r = svg?.getBoundingClientRect(); return { svg: Boolean(svg), w: Math.round(r?.width || 0) }; });
  check('the companion is drawn at that size, not a corner thumbnail', companionDrawn.svg && companionDrawn.w >= 80, JSON.stringify(companionDrawn));

  await A.evaluate(() => window.switchLanguage());
  await sleep(900);
  await goSettings(A);
  const fa = await layout(A);
  check('in Persian the sides stay where they are: the clocks on the left, the companion on the right', fa.dir === 'rtl' && fa.clocks.r <= fa.avatar.l && fa.avatar.r <= fa.pet.l + 1, JSON.stringify(fa));
  await A.evaluate(() => window.switchLanguage());
  await sleep(900);

  console.log('\n===== the clocks, one under the other =====');
  /* Your own time alone, then with one city, then with two — and a city across the date line, so a day marker shows. */
  const across = await A.evaluate(() => {
    const day = (zone) => { const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).split('-').map(Number); return Date.UTC(y, m - 1, d); };
    const here = day(undefined);
    return ['Pacific/Kiritimati', 'Pacific/Pago_Pago'].find((zone) => day(zone) !== here) || '';
  });
  /* The one-city shape is a city on another day, so the day letter is on show at every width whatever the hour (Tokyo was tomorrow only some of the day, and a tile that broke only then passed at lunch time). */
  const shapes = [[], [{ tz: across, label: across.split('/')[1].replace('_', ' ') }], [{ tz: 'America/Los_Angeles', label: 'Los Angeles' }, { tz: across, label: across.split('/')[1].replace('_', ' ') }]];
  for (const width of [390, 360, 320]) {
    await A.setViewportSize({ width, height: 900 });
    for (const [index, cities] of shapes.entries()) {
      await A.evaluate((list) => saveClocks(list), cities);
      await goSettings(A);
      const got = await tile(A);
      const stacked = got.rows.length === 1 + cities.length && got.rows.every((row, i) => i === 0 || row.top >= got.rows[i - 1].bottom - 1);
      const level = got.h === en.avatar.h && got.top === (await layout(A)).avatar.t;
      check(`${width}px, ${cities.length} cities: your time first and then each city, one under the other, in a tile as tall as the picture`, stacked && level && got.count === String(1 + cities.length), JSON.stringify(got));
      check(`${width}px, ${cities.length} cities: nothing in the tile is cut off or runs out of it`, got.outside.length === 0 && got.overflowY <= 1, JSON.stringify(got));
      check(`${width}px, ${cities.length} cities: every line is centred in the tile`, got.offCentre <= 2.5, `${got.offCentre}px off`);
      check(`${width}px, ${cities.length} cities: your own line has both calendars, Persian and Gregorian, on one line and in one script`, got.dates.split('·').length === 2 && got.dates.split('·').every((part) => /\d|[۰-۹]/.test(part)) && !(/[A-Za-z]/.test(got.dates) && /[\u0600-\u06FF]/.test(got.dates)), JSON.stringify(got.dates));
      check(`${width}px, ${cities.length} cities: the tile has the doors' corner, and it is a small one`, got.radius === got.doors && parseFloat(got.radius) <= 10, `${got.radius} vs ${got.doors}`);
      if (index === 2) check(`${width}px: a city on another day has one letter in front of its time, and it is really painted (not clipped away)`, got.markers.length === 1 && /^[TY]$/.test(got.markers[0].text) && got.markers[0].inFront && got.markers[0].overlap === 0 && got.markers[0].seen, JSON.stringify(got.markers));
    }
  }
  /* The same, in Persian: the letter is ف or د, in front of the time on the reading side (the right). */
  await A.setViewportSize({ width: 390, height: 900 });
  await A.evaluate(() => window.switchLanguage());
  await A.evaluate((list) => saveClocks(list), shapes[2]);
  await sleep(500);
  await goSettings(A);
  const persian = await tile(A);
  check('in Persian the day letter is ف or د, in front of the time on the right, with the time centred', persian.markers.length === 1 && /^[فد]$/.test(persian.markers[0].text) && persian.markers[0].inFront && persian.markers[0].overlap === 0 && persian.markers[0].seen && persian.offCentre <= 2.5 && persian.outside.length === 0, JSON.stringify(persian));
  await A.evaluate(() => window.switchLanguage());
  await sleep(500);
  await A.setViewportSize({ width: 430, height: 932 });
  await A.evaluate(() => saveClocks([]));
  await goSettings(A);

  console.log('\n===== the Identity door =====');
  check('the Identity door has the card glyph it always had, not a drawing of the key', en.door.icon === true && en.door.svg === false, JSON.stringify(en.door));

  console.log('\n===== the companion, off and on again =====');
  await A.evaluate(() => { if (!petsAreOff()) togglePets(); });
  await goSettings(A);
  const off = await A.evaluate(() => ({ off: petsAreOff(), chip: document.querySelector('.msgr-hc-pet .chat-pet.is-identity') ? (() => { const r = document.querySelector('.msgr-hc-pet .chat-pet').getBoundingClientRect(); return Math.round(r.width); })() : 0 }));
  check('off, the slot holds the copy-your-id button at the same size', off.off && off.chip >= 80, JSON.stringify(off));
  await A.evaluate(() => { window.PoorijaSettingsPages.open('me'); });
  await sleep(800);
  const row = await A.evaluate(() => {
    const switches = [...document.querySelectorAll('.msgr-page:not([hidden]) .msgr-switch-row')];
    const mine = switches.find((r) => /companion|همدم/i.test(r.textContent));
    return { found: Boolean(mine), on: mine?.querySelector('input')?.checked ?? null };
  });
  check('the Profile page has the switch for it, and it says off', row.found && row.on === false, JSON.stringify(row));
  await A.evaluate(() => {
    const mine = [...document.querySelectorAll('.msgr-page:not([hidden]) .msgr-switch-row')].find((r) => /companion|همدم/i.test(r.textContent));
    const input = mine.querySelector('input'); input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(800);
  const back = await A.evaluate(() => ({ off: petsAreOff(), another: Boolean([...document.querySelectorAll('.msgr-page:not([hidden]) .msgr-row')].find((r) => /another companion|همدم دیگر/i.test(r.textContent))) }));
  check('turned on there, the companion is back, and the page offers another', back.off === false && back.another === true, JSON.stringify(back));
  await goSettings(A);
  const returned = await A.evaluate(() => Boolean(document.querySelector('.msgr-hc-pet #chatPet svg')));
  check('and it stands in its place on the card again', returned);
} catch (error) {
  check('the suite ran to the end', false, error?.stack || String(error));
} finally {
  await stacks.stop?.();
  await browser?.close?.().catch(() => {});
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n===== ${failed} failed of ${results.length} =====`);
process.exit(failed ? 1 : 0);
