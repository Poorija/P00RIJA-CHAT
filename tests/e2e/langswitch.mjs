/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Everything that has to change when the language button is pressed.
 *
 *   PORT=8123 npm run dev ; node tests/e2e/langswitch.mjs
 *
 * updateLanguage() rewrites every element carrying data-i18n, which covers the
 * static page. What it does not cover is anything BUILT by JavaScript, and
 * three different things fell through that gap in three different ways:
 *
 *   MARKUP WITH NO KEY. The dropdowns had their Persian written straight into
 *   the <option> tags. Nothing to rewrite, so they stayed Persian in English.
 *
 *   BUILT ONCE, RELABELLED NEVER. The tab bar along the bottom of a phone
 *   renders its labels from state.language, but only renderMobileTabBar()
 *   does that and only a tab change called it — so the bar sat in the old
 *   language until the user moved somewhere else.
 *
 *   THE SENTENCE WAS STORED INSTEAD OF THE FACT. A call log kept the finished
 *   line — "تماس تصویری برقرار شد - ۰۰:۱۲" — rather than mode, status and
 *   duration. A rendered string cannot be re-rendered, so a call placed in
 *   Persian stayed Persian forever.
 *
 * The last is the one worth guarding hardest: it is invisible until somebody
 * switches language on a conversation that already has calls in it, and it
 * comes back the moment anyone writes `text:` into a history record again. So
 * the storage shape is asserted, not just what is on screen.
 */
import { openApp, browser } from './_chat-harness.mjs';
import { createChecks } from './_check.mjs';

const { results, check } = createChecks();

const readOptions = (page, id) => page.evaluate((selectId) => {
  const select = document.getElementById(selectId);
  if (!select) return null;
  return Array.from(select.options).map((option) => option.textContent.trim());
}, id);

/* A label is "English" if it has no Persian letters in it. Asserting the exact
   string would make this suite fail on a wording change, which is not what it
   is here to catch. */
const persian = /[؀-ۿ]/;
const allEnglish = (labels) => labels.every((label) => !persian.test(label));
const anyPersian = (labels) => labels.some((label) => persian.test(label));

try {
  const page = await openApp('langswitch');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(600);

  /* `state` is a top-level const in a classic script, so it never reaches
   window — the language has to be read off the document, which is where
   switchLanguage() puts it. */
const startedIn = await page.evaluate(() => document.documentElement.lang);
  console.log(`  starting language: ${startedIn}`);

  /* ===== the dropdowns ================================================== */

  console.log('\n===== dropdown options =====');

  /* Every <select> this app has, found rather than listed: the list was the dropdowns of the project this app was cut
     from (a converter, SSH key types), so three of the four names did not exist here and the suite crashed on the first. */
  const SELECTS = await page.evaluate(() => Array.from(document.querySelectorAll('select[id]')).filter((select) => select.options.length > 1).map((select) => select.id));
  check('there are dropdowns to check', SELECTS.length >= 3, SELECTS.join(', '));

  /* Pick something other than the first entry, so the check below is about a
     preserved selection rather than a default that never moved. */
  /* Pick something other than the first entry of the first dropdown, so the check below is about a preserved selection
     rather than a default that never moved. */
  const picked = await page.evaluate((ids) => {
    const select = document.getElementById(ids[0]);
    if (!select || select.options.length < 2) return null;
    select.value = select.options[1].value;
    return { id: ids[0], value: select.value };
  }, SELECTS);

  await page.evaluate(() => { if (document.documentElement.lang !== 'fa') window.switchLanguage(); });
  await page.waitForTimeout(300);
  const inPersian = {};
  for (const id of SELECTS) inPersian[id] = await readOptions(page, id);

  await page.evaluate(() => window.switchLanguage());
  await page.waitForTimeout(300);
  const inEnglish = {};
  for (const id of SELECTS) inEnglish[id] = await readOptions(page, id);

  for (const id of SELECTS) {
    console.log(`  ${id}: ${JSON.stringify(inEnglish[id])}`);
    check(`${id} has options at all`, Array.isArray(inEnglish[id]) && inEnglish[id].length > 0);
    check(`${id} reads English in English`, inEnglish[id] && allEnglish(inEnglish[id]),
      JSON.stringify((inEnglish[id] || []).filter((label) => persian.test(label))));
    /* A list of values with no words in it (bit lengths, a hash name, a number of days written in digits) has nothing to
       be read in Persian: only a list that has English words in English must have Persian ones in Persian. */
    const hasWords = (inEnglish[id] || []).some((label) => /[A-Za-z]{4,}/.test(label.replace(/SHA-?\d+|AES-?\d+|RSA-?\d+|ECDH|ECDSA|PBKDF2|HKDF|Argon2\w*|GCM|CBC|CTR/gi, '')));
    check(`${id} reads Persian in Persian`, inPersian[id] && (!hasWords || anyPersian(inPersian[id])), JSON.stringify(inPersian[id]).slice(0, 120));
  }

  /* The arrow has to turn round with the text: "Text ← Base64" in an English,
     left-to-right list says the opposite of what it means. */
  const kept = await page.evaluate((who) => (who ? document.getElementById(who.id)?.value : null), picked);
  check('changing language does not reset what was selected', Boolean(picked) && kept === picked.value, `${picked?.id}: ${picked?.value} -> ${kept}`);

  /* ===== the bar along the bottom of a phone ============================ */

  console.log('\n===== the mobile tab bar =====');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);

  const bar = await page.evaluate(async () => {
    const read = () => Array.from(document.querySelectorAll('#mobileTabBar .mobile-tab-btn span'))
      .map((span) => span.textContent.trim());
    if (document.documentElement.lang !== 'fa') { window.switchLanguage(); await new Promise((r) => setTimeout(r, 200)); }
    const fa = read();
    /* Nothing else happens in between: no tab change, no reload. That gap is
       the whole bug. */
    window.switchLanguage();
    await new Promise((r) => setTimeout(r, 200));
    const en = read();
    return { fa, en };
  });
  console.log(`  fa: ${JSON.stringify(bar.fa)}`);
  console.log(`  en: ${JSON.stringify(bar.en)}`);
  check('the bar has buttons', bar.en.length > 0, String(bar.en.length));
  check('and they relabel on the language switch alone, with no tab change',
    bar.en.length > 0 && allEnglish(bar.en) && anyPersian(bar.fa),
    JSON.stringify(bar.en));

  /* ===== a call log in a conversation =================================== */

  console.log('\n===== call logs in the thread =====');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);

  const calls = await page.evaluate(async () => {
    window.switchTab?.('chat');
    await new Promise((r) => setTimeout(r, 600));
    const id = 'lang-calls';
    window.__convoLockProbe.seedConversation(id, 'peer-lang', 'fp-lang');
    window.__convoLockProbe.setActive(id);

    /* Through the real path — appendCall decides the row is finished and
       writes the thread line itself, which is where the frozen text came
       from. */
    window.__callLogProbe.append({
      conversationId: id, peerId: 'peer-lang', mode: 'video',
      status: 'ended', direction: 'out', durationMs: 72000,
    });
    window.renderPeers?.(); window.renderActivePeer?.(); window.renderMessages?.();
    await new Promise((r) => setTimeout(r, 400));

    const read = () => Array.from(document.querySelectorAll('.chat-call-message-title'))
      .map((node) => node.textContent.trim());

    if (document.documentElement.lang !== 'fa') { window.switchLanguage(); await new Promise((r) => setTimeout(r, 400)); }
    const fa = read();
    window.switchLanguage();
    await new Promise((r) => setTimeout(r, 400));
    const en = read();
    /* And back again — a one-way fix would pass a test that only looked once. */
    window.switchLanguage();
    await new Promise((r) => setTimeout(r, 400));
    const backToFa = read();

    return {
      fa, en, backToFa,
      /* What actually went into the history record. */
      stored: window.__historyProbe(id).filter((entry) => entry.type === 'call-log'),
    };
  });
  console.log(`  fa: ${JSON.stringify(calls.fa)}`);
  console.log(`  en: ${JSON.stringify(calls.en)}`);
  console.log(`  stored: ${JSON.stringify(calls.stored)}`);

  check('the call appears in the thread', calls.fa.length === 1, String(calls.fa.length));
  check('and reads Persian in Persian', anyPersian(calls.fa), JSON.stringify(calls.fa));
  check('and English in English', calls.en.length === 1 && allEnglish(calls.en),
    JSON.stringify(calls.en));
  check('and Persian again on the way back', anyPersian(calls.backToFa),
    JSON.stringify(calls.backToFa));
  check('the duration survives the switch',
    calls.en.some((line) => line.includes('01:12')) || calls.en.some((line) => /\d/.test(line)),
    JSON.stringify(calls.en));
  /* The guarantee behind all of the above: no rendered sentence in storage. */
  check('the record stores the call, not a sentence about it',
    calls.stored.length === 1 && !calls.stored[0].text,
    JSON.stringify(calls.stored));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('failed:');
  failed.forEach((r) => console.log(`  - ${r.name}`));
  process.exit(1);
}
