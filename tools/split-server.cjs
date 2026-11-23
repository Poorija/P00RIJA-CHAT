#!/usr/bin/env node
/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Splits the relay's one file into ordered parts under scripts/server/
   (roadmap 2.3), the way tools/split-chat.cjs once split js/chat.js.

   The relay is one scope: some four hundred top-level functions and bindings,
   reached from everywhere, a few dozen of them reassigned from far away. Made
   into modules at one stroke, every one of those references is a chance to
   break a live relay. So the parts stay one scope: scripts/server.js joins
   them in order and compiles them as one module, with a source map, so a
   stack trace names the part and its line. A part becomes a real module when
   it is lifted out on its own, with its own tests, later.

   Cuts fall only between top-level statements, before the comment that
   introduces a section where there is one, so no statement is ever split and
   every part starts with what it is about. A part is kept under MAX_LINES
   unless a single statement is longer than that on its own.

     node tools/split-server.cjs SOURCE      writes scripts/server/NN-name.js
*/
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');

const ROOT = path.resolve(__dirname, '..');
const SRC = process.argv[2] || path.join(ROOT, 'scripts', 'server.js');
const OUT = path.join(ROOT, 'scripts', 'server');
const MAX_LINES = 800;
const MIN_LINES = 250;

const source = fs.readFileSync(SRC, 'utf8');
const ast = parser.parse(source, { sourceType: 'script', attachComment: true });

/* Where each top-level statement may be cut before: the start of the first
   line of its leading comments, or of the statement. */
const lineStarts = [0];
for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') lineStarts.push(i + 1);
const lineOf = (offset) => {
  let lo = 0; let hi = lineStarts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1; }
  return lo;
};
const body = ast.program.body;
const cuts = body.map((node, index) => {
  const leading = node.leadingComments || [];
  /* A comment that belongs to the statement before (on its last line) is not
     this one's. */
  const prevEnd = index ? body[index - 1].end : 0;
  const own = leading.filter((c) => c.start >= prevEnd && lineOf(c.start) > lineOf(prevEnd));
  const start = own.length ? own[0].start : node.start;
  const line = lineOf(start);
  const banner = own.find((c) => /^\*?\s*(=|-){4,}/.test(c.value) || /^\s*-{2,} /.test(c.value) || /\n\s*\*\s*[A-Z][^\n]{3,}\n\s*\*\s*-{6,}/.test(c.value));
  return { index, line, banner: Boolean(banner), title: titleOf(banner || own[0], node) };
});

function titleOf(comment, node) {
  const text = comment ? comment.value : '';
  const lines = text.split('\n').map((l) => l.replace(/^\s*\*?\s?/, '').trim()).filter((l) => l && !/^[-=*]{4,}$/.test(l));
  let title = (lines[0] || '').replace(/^[-=\s]+|[-=\s]+$/g, '').replace(/\(.*?\)/g, '');
  if (!title) title = node.id?.name || node.declarations?.[0]?.id?.name || node.expression?.callee?.object?.name || 'part';
  return title;
}
const slug = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 4).join('-') || 'part';

const totalLines = lineStarts.length;
const parts = [];
let from = 0;
let fromTitle = 'boot';
for (let k = 1; k < cuts.length; k += 1) {
  const cut = cuts[k];
  const size = cut.line - from;
  const nextSize = (k + 1 < cuts.length ? cuts[k + 1].line : totalLines) - from;
  const atBanner = cut.banner && size >= MIN_LINES;
  const mustCut = nextSize > MAX_LINES && size >= 1;
  if (atBanner || mustCut) {
    parts.push({ from, to: cut.line, title: fromTitle });
    from = cut.line;
    fromTitle = cut.title;
  }
}
parts.push({ from, to: totalLines, title: fromTitle });

const lines = source.split('\n');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const names = [];
parts.forEach((part, i) => {
  const name = `${String(i + 1).padStart(2, '0')}-${slug(part.title)}.js`;
  names.push(name);
  const text = lines.slice(part.from, part.to).join('\n');
  fs.writeFileSync(path.join(OUT, name), text + (i === parts.length - 1 ? '' : '\n'));
});
/* The order is the order: the loader reads this, not the directory. */
fs.writeFileSync(path.join(OUT, 'ORDER'), `${names.join('\n')}\n`);
const sizes = parts.map((p) => p.to - p.from);
console.log(`${parts.length} parts, largest ${Math.max(...sizes)} lines, smallest ${Math.min(...sizes)}`);
