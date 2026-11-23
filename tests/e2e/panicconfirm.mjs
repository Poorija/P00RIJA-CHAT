/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Two presses of Escape in half a second ask before they erase anything.
 *
 * They used to erase it: a keydown handler at the end of js/app.js called the
 * emergency wipe on a double Escape, anywhere, signed in or not, with no
 * question. Escape is the key every menu, sheet and dialog in this app closes
 * on, so closing two layers quickly was enough to lose the identity, the
 * history, the contacts and the files, and to ask the relay to forget the
 * account's mailbox. This plays the person who pressed it twice by accident.
 *
 *   QUIET      one press, or two more than half a second apart, does nothing;
 *   ASKS       two quick presses open a question and erase nothing yet;
 *   BACKS OUT  Escape or Cancel closes the question, the data is all still
 *              there, and pressing Escape twice with the question open does not
 *              open a second one or answer the first;
 *   ERASES     only the confirming button erases, and then it is the same wipe:
 *              no identity, no vault, no history after the reload.
 *
 * Run it with no stack up: it starts its own.   node tests/e2e/panicconfirm.mjs */

import { openApp, identity, browser } from './_chat-harness.mjs';
import { startTwoStacks } from './_two-stacks.mjs';
import { settle } from './_settle.mjs';

const results = [];
const check = (n, ok, d = '') => {
  results.push({ n, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + String(d).slice(0, 220) : ''}`);
};
const section = (title) => console.log(`\n===== ${title} =====`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const asking = (page) => page.evaluate(() => {
  const backdrop = document.querySelector('.poorija-dialog-backdrop');
  const open = Boolean(backdrop) && !backdrop.classList.contains('hidden');
  return { open, count: document.querySelectorAll('.poorija-dialog-backdrop:not(.hidden)').length, title: open ? backdrop.querySelector('.poorija-dialog-title')?.textContent || '' : '', message: open ? backdrop.querySelector('.poorija-dialog-message')?.textContent || '' : '' };
});
const state = (page) => page.evaluate(() => ({
  identity: window.PoorijaChat?.identityFingerprint?.() || '',
  stored: Boolean(localStorage.getItem('poorija_chat_identity')),
  keys: localStorage.length,
  vault: Boolean(localStorage.getItem('poorija_vault')),
}));
const twice = async (page, gap = 80) => { await page.keyboard.press('Escape'); await sleep(gap); await page.keyboard.press('Escape'); };

const stacks = await startTwoStacks({ waitForLink: false });
try {
  const A = await openApp('SARA', { origin: stacks.a.url, relay: stacks.a.url });
  let navigations = 0;
  A.on('framenavigated', (frame) => { if (frame === A.mainFrame()) navigations += 1; });
  await sleep(1500);
  const before = await state(A);
  navigations = 0;
  check('the account has an identity, a vault and stored data to lose', Boolean(before.identity) && before.stored && before.vault && before.keys > 3, JSON.stringify(before));

  section('quiet');
  await A.keyboard.press('Escape');
  await sleep(900);
  check('one press asks nothing', (await asking(A)).open === false);
  await twice(A, 700);
  await sleep(900);
  check('two presses more than half a second apart ask nothing', (await asking(A)).open === false);

  section('asks');
  await twice(A, 80);
  await sleep(1500);
  const q = await asking(A);
  const mid = await state(A);
  check('two quick presses open a question', q.open === true, JSON.stringify(q));
  check('and erase nothing yet: same identity, same keys, no reload', mid.identity === before.identity && mid.stored && mid.vault && mid.keys >= before.keys && navigations === 0, `${JSON.stringify(mid)} navigations ${navigations}`);
  check('the question says what it is about', /erase|delete|wipe|everything|پاک/i.test(q.title + ' ' + q.message), `${q.title} / ${q.message}`);

  section('backs out');
  await twice(A, 80);
  await sleep(1500);
  const afterEsc = await asking(A);
  const afterEscState = await state(A);
  check('Escape twice with the question open closes it', afterEsc.open === false, JSON.stringify(afterEsc));
  check('and does not open a second one or answer the first', afterEsc.count === 0 && afterEscState.identity === before.identity && afterEscState.stored && navigations === 0, JSON.stringify(afterEscState));

  await twice(A, 80);
  await sleep(1200);
  check('asked again', (await asking(A)).open === true);
  await A.click('.poorija-dialog-backdrop:not(.hidden) .poorija-dialog-cancel');
  await sleep(1500);
  const afterCancel = await state(A);
  check('Cancel closes it', (await asking(A)).open === false);
  check('and everything is still there', afterCancel.identity === before.identity && afterCancel.stored && afterCancel.vault && navigations === 0, JSON.stringify(afterCancel));

  section('erases');
  await twice(A, 80);
  await sleep(1200);
  check('asked a third time', (await asking(A)).open === true);
  const ok = await A.evaluate(() => {
    const button = document.querySelector('.poorija-dialog-backdrop:not(.hidden) .poorija-dialog-ok');
    return { danger: Boolean(button?.classList.contains('is-danger')), label: button?.textContent || '' };
  });
  check('the confirming button is drawn as the dangerous one', ok.danger === true, JSON.stringify(ok));
  await A.click('.poorija-dialog-backdrop:not(.hidden) .poorija-dialog-ok');
  await sleep(6000);
  await settle(A);
  /* The new install opens its own, empty databases at first run, so what must be
     true is that nothing is IN them, not that they are not there. */
  const gone = await A.evaluate(async () => {
    const keys = Object.keys(localStorage);
    const names = (await indexedDB.databases?.() || []).map((d) => d.name);
    let records = 0;
    for (const name of names) {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      for (const store of [...db.objectStoreNames]) {
        records += await new Promise((resolve, reject) => { const r = db.transaction(store).objectStore(store).count(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      }
      db.close();
    }
    return {
      sensitive: keys.filter((k) => /identity|session_keys|prekey|history|contacts|master|vault|calls|spaces|drafts/i.test(k)),
      dbs: names, records,
      onSetup: Boolean(document.getElementById('initialSetup') && !document.getElementById('initialSetup').classList.contains('hidden')),
    };
  });
  check('only the confirming button erases: nothing of the old install is left', gone.sensitive.length === 0, gone.sensitive.join(', ') || 'no identity, vault, history or key data');
  check('no database holds a record and the app is back at first run', gone.records === 0 && gone.onSetup === true, JSON.stringify(gone));

  section('nothing threw');
  check('no script error', (A.__errors || []).length === 0, (A.__errors || []).slice(0, 3).join(' | '));
} finally {
  await browser.close();
  await stacks.stop();
}
const bad = results.filter((r) => !r.ok);
console.log(`\n===== ${bad.length} failed of ${results.length} =====`);
process.exit(bad.length ? 1 : 0);
