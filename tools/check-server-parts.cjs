#!/usr/bin/env node
/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* The relay's parts (roadmap 2.3) stay what they were split to be: every
   file in scripts/server/ is in ORDER and every name in ORDER is a file, the
   joined text parses as one program, and no part grows past the ceiling
   without saying so here. */
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'scripts', 'server');
const CEILING = 900;
const problems = [];
const order = fs.readFileSync(path.join(DIR, 'ORDER'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
const files = fs.readdirSync(DIR).filter((n) => n.endsWith('.js')).sort();
for (const name of files) if (!order.includes(name)) problems.push(`${name} is in scripts/server/ but not in ORDER`);
for (const name of order) if (!files.includes(name)) problems.push(`ORDER names ${name}, which is not there`);
if (new Set(order).size !== order.length) problems.push('ORDER names a part twice');
for (const name of files) {
  const lines = fs.readFileSync(path.join(DIR, name), 'utf8').split('\n').length;
  if (lines > CEILING) problems.push(`${name} is ${lines} lines, past the ${CEILING} ceiling: split it`);
}
try {
  parser.parse(require(path.join(ROOT, 'scripts', 'server-main.js')).joinParts().code, { sourceType: 'script' });
} catch (error) {
  problems.push(`the joined relay does not parse: ${error.message}`);
}
if (problems.length) {
  console.log(`\n  ${problems.join('\n  ')}\n`);
  process.exit(1);
}
console.log(`\n  ${files.length} relay parts, in order, none past ${CEILING} lines, joined into one program that parses\n`);
