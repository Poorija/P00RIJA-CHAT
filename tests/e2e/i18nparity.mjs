/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* The two language tables, read as source (no browser).
 *
 * applyTranslations skips a key it cannot find, so a key missing from one table
 * leaves the other language's words (or the hard-coded markup) on screen with no
 * error anywhere. An object literal also lets a key be written twice: the second
 * silently wins. Both are defects that only show on a screen nobody opened in
 * that language. This reads js/app.js and index.html and says exactly which keys:
 *
 *   - are in one table and not the other;
 *   - are written twice in one table, with different words;
 *   - are named by a data-i18n* attribute in index.html and are in neither table
 *     (or only one);
 *   - hold an empty string;
 *   - hold the other language's script (Persian words in the English table, a line
 *     of English words in the Persian one), which is an untranslated copy.
 *
 *   node tests/e2e/i18nparity.mjs
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createChecks } from './_check.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const app = fs.readFileSync(`${root}js/app.js`, 'utf8');
const html = fs.readFileSync(`${root}index.html`, 'utf8');
const { results, check } = createChecks({ maxDetail: 700, entry: (_name, ok) => Boolean(ok) });

/* Entries of one table, with the line they are on, found by scanning the source:
   a key, a colon and a string. Nested objects are not used in the tables. */
function tableOf(startMarker, endMarker) {
  const from = app.indexOf(startMarker);
  const to = app.indexOf(endMarker, from + startMarker.length);
  if (from < 0) throw new Error(`no ${startMarker}`);
  const body = app.slice(from, to < 0 ? undefined : to);
  const baseLine = app.slice(0, from).split('\n').length;
  const entries = [];
  const re = /^\s*([A-Za-z_$][\w$]*|'[^']+'|"[^"]+")\s*:\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)\s*,?\s*$/gm;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const key = m[1].replace(/^['"]|['"]$/g, '');
    const value = m[2].slice(1, -1);
    entries.push({ key, value, line: baseLine + body.slice(0, m.index).split('\n').length - 1 });
  }
  return entries;
}
const fa = tableOf('const translations = {\nfa: {', '\nen: {');
const enStart = app.indexOf('\nen: {', app.indexOf('const translations = {'));
const faEnd = enStart;
const en = (() => {
  const from = enStart;
  /* the English table ends at the first top-level "},\n};" after it */
  const end = app.indexOf('\n};', from);
  const body = app.slice(from, end);
  const baseLine = app.slice(0, from).split('\n').length;
  const entries = [];
  const re = /^\s*([A-Za-z_$][\w$]*|'[^']+'|"[^"]+")\s*:\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)\s*,?\s*$/gm;
  for (let m = re.exec(body); m; m = re.exec(body)) entries.push({ key: m[1].replace(/^['"]|['"]$/g, ''), value: m[2].slice(1, -1), line: baseLine + body.slice(0, m.index).split('\n').length - 1 });
  return entries;
})();
void faEnd;

const keysOf = (entries) => new Set(entries.map((e) => e.key));
const faKeys = keysOf(fa);
const enKeys = keysOf(en);
console.log(`  Persian table: ${fa.length} entries, ${faKeys.size} keys; English table: ${en.length} entries, ${enKeys.size} keys`);

const list = (items, n = 25) => `${items.length}: ${items.slice(0, n).join(', ')}${items.length > n ? ', …' : ''}`;
const onlyFa = [...faKeys].filter((k) => !enKeys.has(k));
const onlyEn = [...enKeys].filter((k) => !faKeys.has(k));
check('every Persian key has an English one', onlyFa.length === 0, `missing in English — ${list(onlyFa)}`);
check('every English key has a Persian one', onlyEn.length === 0, `missing in Persian — ${list(onlyEn)}`);

const duplicates = (entries, name) => {
  const seen = new Map();
  const out = [];
  for (const e of entries) {
    if (seen.has(e.key) && seen.get(e.key).value !== e.value) out.push(`${e.key} (${name} lines ${seen.get(e.key).line} and ${e.line}: "${seen.get(e.key).value.slice(0, 24)}" then "${e.value.slice(0, 24)}")`);
    if (!seen.has(e.key)) seen.set(e.key, e);
  }
  return out;
};
const dupFa = duplicates(fa, 'fa');
const dupEn = duplicates(en, 'en');
check('no Persian key is written twice with different words (the second would silently win)', dupFa.length === 0, list(dupFa, 12));
check('no English key is written twice with different words', dupEn.length === 0, list(dupEn, 12));

const attrs = [...html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((m) => m[1]);
const used = [...new Set(attrs)];
const undefinedBoth = used.filter((k) => !faKeys.has(k) && !enKeys.has(k));
const undefinedOne = used.filter((k) => faKeys.has(k) !== enKeys.has(k));
check('every key index.html names with data-i18n* is in a table', undefinedBoth.length === 0, list(undefinedBoth));
check('and in both of them', undefinedOne.length === 0, list(undefinedOne));

const empty = [...fa.map((e) => ({ ...e, t: 'fa' })), ...en.map((e) => ({ ...e, t: 'en' }))].filter((e) => !e.value.trim()).map((e) => `${e.t}:${e.key}`);
check('no entry is an empty string', empty.length === 0, list(empty));

const persianIn = en.filter((e) => /[؀-ۿ]/.test(e.value)).map((e) => `${e.key} (line ${e.line})`);
check('the English table holds no Persian words', persianIn.length === 0, list(persianIn));
const latinRun = fa.filter((e) => /[A-Za-z]{3,}\s+[A-Za-z]{3,}\s+[A-Za-z]{3,}/.test(e.value) && !/[؀-ۿ]/.test(e.value) && !/^(https?:|[A-Za-z0-9 .:/_-]+$)/.test(e.value.replace(/\s+/g, ' ')) ).map((e) => `${e.key} (line ${e.line})`);
check('the Persian table holds no sentence left in English', latinRun.length === 0, list(latinRun));

const failed = results.filter((ok) => !ok).length;
console.log(`\n===== ${failed} failed of ${results.length} =====`);
process.exit(failed ? 1 : 0);
