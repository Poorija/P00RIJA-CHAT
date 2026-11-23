/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* The second password says what it does, and the real erase stands apart.
 *
 * The password set on the `panic` page opens a decoy profile and erases
 * nothing (js/vault-profiles.js; tests/e2e/emergency.mjs proves the behaviour).
 * Its row, its page and its card said "emergency erase password" and promised
 * that "all local data is wiped immediately". Somebody under duress who
 * believed that would think their data was gone when it was not. This suite
 * reads every place those words live, in both languages, and checks that:
 *
 *   - no string about that password promises a wipe;
 *   - each says it opens a decoy profile and leaves the real data alone;
 *   - erasing everything is a separate, red row in its own Danger zone group,
 *     and it still asks twice before it erases anything;
 *   - the card on the decoy page holds the decoy password and nothing that
 *     erases (the old card carried the full-reset button beside it).
 *
 * It fails on the 2.5.0 tree, where every one of those strings said "erase". */

import { openApp, browser } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
import { createChecks } from './_check.mjs';

const { results, check } = createChecks({ entry: (name, ok, detail) => ({ name, ok, detail }) });
const stacks = await startTwoStacks();

/* The old names of this password, and the old promise. A sentence that says
   "nothing is erased" or points to the Danger zone for a real erase is fine;
   what must not come back is a name that calls it an emergency/panic/erase
   password, or a line that says entering it wipes the device. */
const WIPE = /\b(panic|emergency|duress)\b|erase password|wiped immediately|data is wiped|اضطراری|بلافاصله پاک|پاک شده و|رمز پاک‌سازی/i;
/* Words that say what really happens. */
const DECOY = { en: /decoy/i, fa: /طعمه/ };
const KEEPS = { en: /(nothing is erased|leaves? (your )?real data|untouched|is not erased)/i, fa: /(پاک نمی‌شود|دست‌نخورده|دست نمی‌خورد)/ };

try {
  const page = await openApp('DECOY', { origin: stacks.a.url, relay: stacks.a.url,
    context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } });

  for (const lang of ['en', 'fa']) {
    await page.evaluate((want) => {
      if (PoorijaApp.state.language !== want) switchLanguage();
      PoorijaSettingsPages.reset();
      PoorijaMessenger.go('settings');
      PoorijaSettingsPages.open('privacy');
    }, lang);
    await page.waitForTimeout(400);

    const privacy = await page.evaluate(() => {
      const section = document.querySelector('[data-msgr-page="privacy"]');
      const rows = [...section.querySelectorAll('.msgr-row')].map((node) => ({
        label: node.querySelector('.msgr-row-label')?.textContent.trim() || '',
        danger: node.classList.contains('is-danger'),
        row: node.dataset.msgrRow || '',
      }));
      const heads = [...section.querySelectorAll('.msgr-group-head')].map((node) => node.textContent.trim());
      const foots = [...section.querySelectorAll('.msgr-group-foot')].map((node) => node.textContent.trim());
      return { rows, heads, foots };
    });
    const decoyRow = privacy.rows.find((r) => r.row === 'decoy');
    check(`${lang}: the privacy page has a decoy-password row`, Boolean(decoyRow), JSON.stringify(privacy.rows.map((r) => r.label)));
    check(`${lang}: that row is named for a decoy, not for erasing`,
      decoyRow && DECOY[lang].test(decoyRow.label) && !WIPE.test(decoyRow.label), decoyRow?.label);
    check(`${lang}: that row is not drawn as a destructive action`, decoyRow && !decoyRow.danger);
    const eraseRow = privacy.rows.find((r) => r.row === 'erase-all');
    check(`${lang}: erasing everything is its own row`, Boolean(eraseRow), JSON.stringify(privacy.rows.map((r) => r.label)));
    check(`${lang}: and that row is red`, eraseRow?.danger === true);
    const dangerHead = lang === 'fa' ? /منطقهٔ? خطر/ : /danger zone/i;
    check(`${lang}: under a Danger zone heading`, privacy.heads.some((h) => dangerHead.test(h)), JSON.stringify(privacy.heads));
    check(`${lang}: the decoy group's footnote says the real data is kept`,
      privacy.foots.some((f) => DECOY[lang].test(f) && KEEPS[lang].test(f)), JSON.stringify(privacy.foots));

    await page.evaluate(() => PoorijaSettingsPages.open('panic'));
    await page.waitForTimeout(400);
    const decoyPage = await page.evaluate(() => {
      const section = document.querySelector('[data-msgr-page="panic"]');
      const visible = (node) => node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
      const texts = [...section.querySelectorAll('h1,h2,h3,h4,p,button,label,span')]
        .filter(visible).map((node) => node.textContent.trim()).filter(Boolean);
      const input = section.querySelector('#panicPasswordInput_dz');
      return {
        title: PoorijaSettingsPages.title(),
        texts,
        placeholder: input?.getAttribute('placeholder') || '',
        hasInput: visible(input),
        hasReset: [...section.querySelectorAll('button')].some((b) => visible(b) && /resetAppSettings/.test(b.getAttribute('onclick') || '')),
      };
    });
    check(`${lang}: the page title names a decoy`, DECOY[lang].test(decoyPage.title) && !WIPE.test(decoyPage.title), decoyPage.title);
    check(`${lang}: the password field is on the page`, decoyPage.hasInput);
    check(`${lang}: its placeholder does not say erase`, decoyPage.placeholder && !WIPE.test(decoyPage.placeholder), decoyPage.placeholder);
    const promises = decoyPage.texts.filter((s) => WIPE.test(s));
    check(`${lang}: nothing on the page promises a wipe`, promises.length === 0, JSON.stringify(promises));
    check(`${lang}: the page says the real data is left alone`, decoyPage.texts.some((s) => KEEPS[lang].test(s)), JSON.stringify(decoyPage.texts));
    check(`${lang}: the full-reset button is not on the decoy page`, decoyPage.hasReset === false);
  }

  /* The Danger zone row still asks before it erases: the first dialog opens,
     Cancel closes it, and the install is untouched. */
  await page.evaluate(() => { PoorijaSettingsPages.reset(); PoorijaSettingsPages.open('privacy'); });
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => localStorage.length);
  await page.evaluate(() => document.querySelector('[data-msgr-page="privacy"] [data-msgr-row="erase-all"]').click());
  await page.waitForTimeout(400);
  const asked = await page.evaluate(() => {
    const dialog = document.querySelector('.poorija-dialog');
    const open = Boolean(dialog) && dialog.getClientRects().length > 0;
    const text = document.querySelector('.poorija-dialog-message')?.textContent || '';
    document.querySelector('.poorija-dialog-cancel')?.click();
    return { open, text };
  });
  check('the erase row asks first', asked.open, asked.text.slice(0, 80));
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({ items: localStorage.length, identity: Boolean(chatState.identity?.fingerprint) }));
  check('cancelling erases nothing', after.items === before && after.identity === true, JSON.stringify({ before, after }));

  /* The lock screen's button does erase; its name says so and calls it what it is. */
  const lockButton = await page.evaluate(() => {
    const node = document.querySelector('#lockScreen .panic-button');
    return { title: node?.getAttribute('title') || '', label: node?.getAttribute('aria-label') || '' };
  });
  check('the lock screen\'s erase button is named for erasing, without the old "panic" word',
    /erase|پاک کردن همه/i.test(lockButton.label) && !/panic/i.test(lockButton.label + lockButton.title), JSON.stringify(lockButton));

  /* The language tables themselves, so a later edit cannot bring the old line back. */
  const strings = await page.evaluate(() => {
    const pick = (lang) => {
      /* `translations` is a top-level const of js/app.js: one shared global scope, not a window property. */
      const table = (typeof translations !== 'undefined' ? translations[lang] : null) || {};
      return { desc: table.panicDesc || '', title: table.duressPanicMode || '', save: table.savePanicPassword || '', placeholder: table.panicPasswordPlaceholder || '' };
    };
    return { en: pick('en'), fa: pick('fa') };
  });
  for (const lang of ['en', 'fa']) {
    const s = strings[lang];
    check(`${lang}: the language table no longer promises a wipe`,
      s.desc && !WIPE.test(`${s.desc} ${s.title} ${s.save} ${s.placeholder}`), JSON.stringify(s));
  }

  check('no script error', page.__errors.length === 0, page.__errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await stacks.stop();
}
const failed = results.filter((result) => !result.ok);
console.log(`\n===== ${failed.length} failed of ${results.length} =====`);
failed.forEach((result) => console.log(`  FAIL ${result.name}${result.detail ? ` — ${result.detail}` : ''}`));
process.exit(failed.length ? 1 : 0);
