#!/usr/bin/env node
/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Legacy CSS that nothing can match (roadmap 2.5).

   css/styles.css was written for the encryption suite this app was cut from,
   and carries rules for pages, tools and controls that no longer exist. A rule
   is dead when a class or id it needs appears nowhere in what can put it on
   the page: index.html, monitor-client.html, every script under js/ and
   scripts/lib/monitor-*.js. A selector list loses its dead selectors; a rule
   with none left goes.

   Conservative on purpose. A name is taken as alive when it appears anywhere
   as text, and also when the part of it before its last hyphen appears right
   before a template or concatenation (`chat-tile-${kind}`, 'is-' + state): a
   class made at run time must not lose its style. Attribute, pseudo and
   element selectors are never judged dead.

     node tools/prune-css.cjs css/styles.css            report
     node tools/prune-css.cjs css/styles.css --write    rewrite the file */
const fs = require('fs');
const path = require('path');
const postcss = require('postcss');
const selectorParser = require('postcss-selector-parser');

const ROOT = path.resolve(__dirname, '..');
const target = path.resolve(ROOT, process.argv[2] || 'css/styles.css');
const write = process.argv.includes('--write');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|cjs|html)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const sources = [
  path.join(ROOT, 'index.html'),
  path.join(ROOT, 'monitor-client.html'),
  ...walk(path.join(ROOT, 'js')),
  ...fs.readdirSync(path.join(ROOT, 'scripts', 'lib')).filter((n) => /^monitor-/.test(n)).map((n) => path.join(ROOT, 'scripts', 'lib', n)),
].filter((f) => fs.existsSync(f));
const corpus = sources.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

const aliveCache = new Map();
function alive(name) {
  if (aliveCache.has(name)) return aliveCache.get(name);
  let ok = corpus.includes(name);
  if (!ok) {
    /* A prefix completed at run time. */
    for (let cut = name.lastIndexOf('-'); cut > 0 && !ok; cut = name.lastIndexOf('-', cut - 1)) {
      const stem = name.slice(0, cut + 1);
      if (new RegExp(`${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\$\\{|['"\`]\\s*\\+)`).test(corpus)) ok = true;
    }
  }
  aliveCache.set(name, ok);
  return ok;
}

/* A selector is dead when one class or id it requires is dead. Anything inside
   :not(), :is(), :where() or :has() is not counted (those can match without). */
function selectorDead(selector) {
  let dead = false;
  selectorParser((root) => {
    root.walk((node) => {
      if (dead) return;
      let parent = node.parent;
      while (parent) {
        if (parent.type === 'pseudo' && /^:(not|is|where|has|-moz-any|-webkit-any)$/i.test(parent.value)) return;
        parent = parent.parent;
      }
      if ((node.type === 'class' || node.type === 'id') && !alive(node.value)) dead = true;
    });
  }).processSync(selector);
  return dead;
}

const css = fs.readFileSync(target, 'utf8');
const root = postcss.parse(css, { from: target });
let rulesRemoved = 0;
let selectorsRemoved = 0;
let linesBefore = css.split('\n').length;
root.walkRules((rule) => {
  if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return;
  const list = rule.selectors;
  const keep = list.filter((s) => !selectorDead(s));
  if (!keep.length) { rule.remove(); rulesRemoved += 1; selectorsRemoved += list.length; return; }
  if (keep.length !== list.length) { selectorsRemoved += list.length - keep.length; rule.selectors = keep; }
});
/* At-rules left empty (a media query whose rules all went). */
root.walkAtRules((at) => { if (at.nodes && !at.nodes.length) at.remove(); });
const out = root.toString();
const linesAfter = out.split('\n').length;
console.log(`${path.relative(ROOT, target)}: ${rulesRemoved} rule(s) and ${selectorsRemoved} selector(s) nothing can match; ${linesBefore} -> ${linesAfter} lines`);
if (write) fs.writeFileSync(target, out);
