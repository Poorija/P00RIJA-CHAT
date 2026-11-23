#!/usr/bin/env node
/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text.
 */

/* Builds css/chat-ui.css from the sources in css/ui/.
 *
 * WHY THERE IS A BUILD STEP FOR A STYLESHEET
 * ------------------------------------------
 * css/styles.css came with the app this chat was cut out of: 28,000 lines,
 * more than six thousand of them !important, and the same selector set again
 * and again further down to win the previous argument. A redesign cannot be
 * written against that by specificity — each new rule would need to be a
 * little louder than the last.
 *
 * A cascade layer settles it once. Among !important declarations, those in a
 * layer beat those that are not in one, whatever their specificity or order.
 * So the sources in css/ui/ are written plainly, and this turns them into a
 * single @layer with every declaration !important:
 *
 *     the sources            what is built
 *     color: red;            color: red !important;
 *     transform: x !normal;  transform: x;          (left to the script)
 *
 * `!normal` is for the few properties the page's scripts set inline (a swipe,
 * a drag, a sliding indicator): an inline style loses to an !important rule,
 * which would freeze them.
 *
 *   node tools/build-ui-css.cjs           writes css/chat-ui.css
 *   node tools/build-ui-css.cjs --check   fails if the file is out of date
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'css', 'ui');
const OUT = path.join(ROOT, 'css', 'chat-ui.css');

function stripComments(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += ch; i += 1;
      while (i < text.length && text[i] !== quote) { if (text[i] === '\\') { out += text[i]; i += 1; } out += text[i]; i += 1; }
      out += quote;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += ch;
  }
  return out;
}

/* Splits `a; b(c;d); e` on top-level semicolons only: a data: URL holds one. */
function splitDeclarations(body) {
  const parts = []; let depth = 0; let quote = ''; let current = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) { current += ch; if (ch === '\\') { current += body[i + 1] || ''; i += 1; } else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ';' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function declaration(raw) {
  const text = raw.trim();
  if (!text) return '';
  const colon = text.indexOf(':');
  if (colon < 0) throw new Error(`not a declaration: ${text.slice(0, 60)}`);
  let value = text.slice(colon + 1).trim();
  const prop = text.slice(0, colon).trim();
  if (/!normal\s*$/i.test(value)) return `${prop}: ${value.replace(/\s*!normal\s*$/i, '')};`;
  if (/!important\s*$/i.test(value)) return `${prop}: ${value};`;
  return `${prop}: ${value} !important;`;
}

/* Reads blocks at one level. `inKeyframes` keeps declarations as they are:
   !important inside @keyframes is ignored by the browser, so it would only
   make the animation silently not run. */
function transform(text, inKeyframes) {
  let out = ''; let i = 0;
  while (i < text.length) {
    const open = (() => { let depth = 0; let quote = ''; for (let j = i; j < text.length; j += 1) { const ch = text[j]; if (quote) { if (ch === '\\') j += 1; else if (ch === quote) quote = ''; continue; } if (ch === '"' || ch === "'") quote = ch; else if (ch === '(') depth += 1; else if (ch === ')') depth -= 1; else if (ch === '{' && depth === 0) return j; else if (ch === ';' && depth === 0) return -2 - j; } return -1; })();
    if (open === -1) { out += text.slice(i); break; }
    if (open <= -2) { const end = -2 - open; out += `${text.slice(i, end + 1).trim()}\n`; i = end + 1; continue; } // @import / @charset
    const head = text.slice(i, open).trim();
    let depth = 1; let j = open + 1; let quote = '';
    for (; j < text.length && depth; j += 1) {
      const ch = text[j];
      if (quote) { if (ch === '\\') j += 1; else if (ch === quote) quote = ''; continue; }
      if (ch === '"' || ch === "'") quote = ch; else if (ch === '(') { /* url(...) may hold braces in data: URIs only inside quotes */ } else if (ch === '{') depth += 1; else if (ch === '}') depth -= 1;
    }
    const inner = text.slice(open + 1, j - 1);
    if (/^@(media|supports|container|layer)\b/i.test(head)) out += `${head} {\n${transform(inner, false)}}\n`;
    else if (/^@(-webkit-)?keyframes\b/i.test(head)) out += `${head} {\n${inner.trim()}\n}\n`;
    else if (/^@font-face\b/i.test(head)) out += `${head} {\n${inner.trim()}\n}\n`;
    else if (inKeyframes) out += `${head} {\n${inner.trim()}\n}\n`;
    else out += `${head} {\n${splitDeclarations(inner).map(declaration).filter(Boolean).map((line) => `  ${line}`).join('\n')}\n}\n`;
    i = j;
  }
  return out;
}

function build() {
  const files = fs.readdirSync(SRC).filter((name) => name.endsWith('.css')).sort();
  const header = `/*
 * P00RIJA Chat — GENERATED by tools/build-ui-css.cjs from css/ui/*.css.
 * Edit the sources, not this file. Every declaration is !important inside one
 * cascade layer, which is what lets it win over css/styles.css: see the tool.
 */
`;
  const body = files.map((name) => `/* ---- ${name} ---- */\n${transform(stripComments(fs.readFileSync(path.join(SRC, name), 'utf8')), false)}`).join('\n');
  return `${header}@layer chat-ui {\n${body}}\n`;
}

const built = build();
if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== built) { console.error('css/chat-ui.css is out of date: run `node tools/build-ui-css.cjs`.'); process.exit(1); }
  console.log('css/chat-ui.css is up to date.');
} else {
  fs.writeFileSync(OUT, built);
  console.log(`wrote css/chat-ui.css (${built.length} bytes from ${fs.readdirSync(SRC).filter((n) => n.endsWith('.css')).length} sources)`);
}
