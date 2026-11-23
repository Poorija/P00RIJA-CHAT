#!/usr/bin/env node
/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text.
 */

/* Translations nothing asks for.
 *
 * js/app.js carries one table of strings per language, and most of each was
 * written for tools this app no longer has. A string is asked for by its key:
 * from the page (`data-i18n="key"`, and the -title, -placeholder and
 * -aria-label forms of it), or from a script (`getTranslatedText('key')`,
 * `t.key`, a `labelKey: 'key'`). So a key is in use if the WORD appears
 * anywhere outside the tables themselves — in index.html, or in any script,
 * js/app.js included. That is generous: a key that shares its name with an
 * unrelated variable is kept. It errs toward keeping.
 *
 * A key must go from every language or from none, so the two tables stay the
 * same shape.
 *
 *   node tools/prune-translations.cjs            report
 *   node tools/prune-translations.cjs --write    remove
 */
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const FILE = 'js/app.js';
const source = read(FILE);
const ast = parser.parse(source, { sourceType: 'script', ranges: true });

const declaration = ast.program.body
  .filter((node) => node.type === 'VariableDeclaration')
  .flatMap((node) => node.declarations)
  .find((d) => d.id.name === 'translations' && d.init && d.init.type === 'ObjectExpression');
if (!declaration) { console.error('No `translations` table found in js/app.js.'); process.exit(1); }

const tables = declaration.init.properties.filter((p) => p.value && p.value.type === 'ObjectExpression');
const keyOf = (property) => (property.key ? (property.key.name || property.key.value) : null);

/* Every word outside the tables. */
const words = new Set();
const add = (text) => { for (const word of text.match(/[A-Za-z_$][\w$]*/g) || []) words.add(word); };
add(source.slice(0, declaration.init.start));
add(source.slice(declaration.init.end));
add(read('index.html'));
const scripts = [...read('index.html').matchAll(/<script[^>]*\ssrc="(js\/[^"?]+)/g)].map((m) => m[1]);
for (const file of scripts) if (file !== FILE) add(read(file));

const unused = new Set();
for (const table of tables) for (const property of table.value.properties) {
  const key = keyOf(property);
  if (key && !words.has(key)) unused.add(key);
}
/* In use in one language's table only by being a word there does not count,
   but a key missing from one table and present in another is left alone. */
const cuts = [];
let total = 0;
for (const table of tables) {
  const properties = table.value.properties;
  total += properties.length;
  for (const property of properties) if (unused.has(keyOf(property))) cuts.push({ start: property.start, end: property.end });
}
const bytes = cuts.reduce((sum, cut) => sum + (cut.end - cut.start), 0);
console.log(`\n  ${tables.length} table(s), ${total} entries; ${unused.size} key(s) nothing asks for, ${cuts.length} entries, ${Math.round(bytes / 1024)} KB\n`);

if (process.argv.includes('--write')) {
  let out = source;
  for (const cut of cuts.sort((a, b) => b.start - a.start)) {
    let end = cut.end;
    while (out[end] === ' ' || out[end] === '\t') end += 1;
    if (out[end] === ',') end += 1;
    while (out[end] === ' ' || out[end] === '\t') end += 1;
    if (out[end] === '\r') end += 1;
    if (out[end] === '\n') end += 1;
    out = out.slice(0, cut.start) + out.slice(end);
  }
  fs.writeFileSync(path.join(ROOT, FILE), out);
  console.log('  removed.\n');
}
