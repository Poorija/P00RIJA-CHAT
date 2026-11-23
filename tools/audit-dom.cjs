#!/usr/bin/env node
/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Static cross-check between the markup and the code that drives it.
 *
 * Three classes of defect that no end-to-end test reliably catches, because a
 * missing element makes an optional-chained call quietly do nothing:
 *
 *   1. getElementById('x') where nothing in index.html has id="x"
 *   2. duplicate ids — the second one is unreachable through getElementById
 *   3. data-i18n keys with no entry in either translations table
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const ids = [];
for (const m of html.matchAll(/\bid="([^"]+)"/g)) ids.push(m[1]);
const idSet = new Set(ids);
const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);

/* Ids created at runtime rather than written in the markup. Listing them is
   better than widening the regex: a name that stops being generated should
   show up here as an unused exemption, not disappear into a loose pattern. */
const RUNTIME = /^(chatMsg|chatPeer|gcall|call-|tmp|poorija-|toast|sheet-|qr-)/;

const jsFiles = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'vendor') walk(full); }
    else if (entry.name.endsWith('.js')) jsFiles.push(full);
  }
};
walk(path.join(ROOT, 'js'));

/* Two legitimate reasons an id is absent from index.html, both of which have
   to be recognised or the report is mostly noise:
     - lazy creation: `let x = getElementById('a'); if (!x) { …create… }`
     - runtime markup: the id appears inside a template string this file writes
   Anything left over is a read of an element that nothing ever makes. */
const missing = new Map();
const built = new Set();
for (const file of jsFiles) {
  const source = fs.readFileSync(file, 'utf8');
  for (const m of source.matchAll(/\bid=["']([A-Za-z][\w-]*)["']/g)) built.add(m[1]);
  for (const m of source.matchAll(/\.id\s*=\s*['"]([A-Za-z][\w-]*)['"]/g)) built.add(m[1]);
}
for (const file of jsFiles) {
  const source = fs.readFileSync(file, 'utf8');
  for (const m of source.matchAll(/(let|const|var)?\s*(\w+)?\s*=?\s*document\.getElementById\(\s*['"]([A-Za-z][\w-]*)['"]\s*\)/g)) {
    const id = m[3];
    if (idSet.has(id) || RUNTIME.test(id) || built.has(id)) continue;
    /* `let x = getElementById(...)` is the lazy-create opening move; `const`
       and a bare call are not, because neither can be reassigned to a freshly
       created element. */
    if (m[1] === 'let') continue;
    const line = source.slice(0, m.index).split('\n').length;
    if (!missing.has(id)) missing.set(id, []);
    missing.get(id).push(`${path.relative(ROOT, file)}:${line}`);
  }
}

/* Translations: both tables live in js/app.js as object literals. */
const app = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
const keysIn = (from, to) => {
  const slice = app.slice(from, to);
  return new Set(Array.from(slice.matchAll(/^\s*([A-Za-z][\w]*)\s*:/gm)).map((m) => m[1]));
};
/* Past the opening brace, not at it: starting on `fa: {` made the line itself
   match the key pattern, so each table was reported as holding a key with its
   own name and every run ended with two findings that were the tool looking at
   itself. The same slip lived in audit-i18n.cjs. */
const faStart = app.indexOf('fa: {') + 'fa: {'.length;
const enStart = app.indexOf('en: {', faStart);
const enBody = enStart + 'en: {'.length;
const enEnd = app.indexOf('\n};', enStart);
const fa = keysIn(faStart, enStart);
const en = keysIn(enBody, enEnd);

const i18nUsed = new Set();
for (const m of html.matchAll(/data-i18n(?:-title|-placeholder|-aria-label)?="([^"]+)"/g)) i18nUsed.add(m[1]);

const missingFa = [...i18nUsed].filter((k) => !fa.has(k)).sort();
const missingEn = [...i18nUsed].filter((k) => !en.has(k)).sort();
const onlyFa = [...fa].filter((k) => !en.has(k)).sort();
const onlyEn = [...en].filter((k) => !fa.has(k)).sort();

console.log(`ids in index.html: ${idSet.size} unique, ${ids.length} total`);
console.log(`i18n keys: fa ${fa.size}, en ${en.size}, used in markup ${i18nUsed.size}`);

const report = (title, rows) => {
  console.log(`\n== ${title}: ${rows.length} ==`);
  rows.slice(0, 40).forEach((row) => console.log('   ' + row));
  if (rows.length > 40) console.log(`   … and ${rows.length - 40} more`);
};

/* The tools that were cut out of this app (file and text encryption, secret
   sharing, Argon2, the password manager and the rest) left their code behind in
   js/app.js and js/advanced-crypto.js; it names elements that are no longer in
   the page and is only reached from the tools that are gone. Those ids are in
   tools/audit-dom.removed.txt and are reported as leftovers, not as findings:
   the list is what is still to be cut, and shrinks as it is. An id that is
   missing and NOT in the list is still a finding. */
const removedPath = path.join(ROOT, 'tools', 'audit-dom.removed.txt');
const removedIds = new Set(fs.existsSync(removedPath)
  ? fs.readFileSync(removedPath, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
  : []);
if (process.argv.includes('--print-missing')) { console.log([...missing.keys()].sort().join('\n')); process.exit(0); }
const leftovers = [...missing.keys()].filter((id) => removedIds.has(id));
for (const id of leftovers) missing.delete(id);
const stale = [...removedIds].filter((id) => !missing.has(id) && !leftovers.includes(id));

report('duplicate ids in index.html', [...new Set(duplicates)]);
report('getElementById targets that do not exist in the markup',
  [...missing.entries()].map(([id, where]) => `${id}  <- ${where.slice(0, 3).join(', ')}`));
console.log(`\n   ${leftovers.length} more are known leftovers of the cut tools (tools/audit-dom.removed.txt)` + (stale.length ? `; ${stale.length} listed there are gone from the code and can be taken off the list: ${stale.slice(0, 6).join(', ')}` : ''));
report('data-i18n keys missing from the Persian table', missingFa);
report('data-i18n keys missing from the English table', missingEn);
report('keys present in Persian but not English', onlyFa);
report('keys present in English but not Persian', onlyEn);

const total = new Set(duplicates).size + missing.size + missingFa.length + missingEn.length;
console.log(`\n${total} finding(s) that need a decision`);

/* Findings are reported by the exit code as well as on screen, so a script can
   gate on this without parsing the output. Grepping the last line was the first
   attempt and each tool ends differently — a guard that misreads a clean run as
   a failure is a guard people learn to skip. */
if (total) process.exitCode = 1;
