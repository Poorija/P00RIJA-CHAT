#!/usr/bin/env node
/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text.
 */

/* Top-level functions nothing can reach.
 *
 * This app was cut out of a larger one, and the page lost twenty tools whose
 * code is still in the scripts. A function is dead when no path leads to it:
 * not from a statement that runs when the script loads, not from the page's
 * own handlers, not from another script, and not from a function that is
 * itself alive.
 *
 * HOW IT DECIDES
 *
 * Each script in the list is parsed, and its top level is split into function
 * declarations and everything else. "Everything else" runs at load, so every
 * name it mentions is alive. Then, from those, outward: a live function keeps
 * alive every name it mentions, until nothing new is found.
 *
 * "Mentions" is deliberately generous, because the scripts are classic ones
 * sharing one global scope and a wrong deletion is a ReferenceError at some
 * click nobody tests:
 *
 *   - any identifier in the body, whatever it turns out to refer to — except
 *     the key of an object entry, and a property read off something other
 *     than the global object, neither of which can be a global function;
 *   - inside a string or a template: any word followed by `(`, since handlers
 *     are written into markup as text (`onclick="doThing()"`), and a string
 *     that is nothing but one name, since `window[name]` is looked up that way;
 *   - in index.html: the same, read from the handler attributes and the inline
 *     scripts — not from the page's text, where "encrypt" is only a word;
 *   - any word in the service worker and in the tests, which reach into the
 *     page by name;
 *   - in the object the app publishes as window.PoorijaApp: an entry only if
 *     something outside js/app.js asks for it by that name. Publishing a
 *     function is not a use of it.
 *
 * So what it reports is what survives all of that. It errs toward keeping.
 *
 *   node tools/dead-code.cjs                 report, per file
 *   node tools/dead-code.cjs --list          and name every dead function
 *   node tools/dead-code.cjs --write         delete them, and the comment
 *                                            that sat directly on each
 *
 * Only function declarations are removed. A top-level `const x = make()` may
 * exist for what make() does, which reading the name does not tell you.
 */
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const args = new Set(process.argv.slice(2));

/* The scripts the page loads, in the order it loads them. All of them share
   one scope, so they are analysed as one program. */
const scripts = [...read('index.html').matchAll(/<script[^>]*\ssrc="(js\/[^"?]+)/g)].map((m) => m[1]);

const GLOBALS = new Set(['window', 'globalThis', 'global', 'self']);
const WORD = /[A-Za-z_$][\w$]*/g;
const wordsOf = (text) => new Set(String(text).match(WORD) || []);

/* The names a piece of text can call: `name(`, or the whole text being a name. */
const CALL = /([A-Za-z_$][\w$]*)\s*\(/g;
const callsIn = (text) => {
  const found = new Set();
  const value = String(text);
  for (const match of value.matchAll(CALL)) found.add(match[1]);
  if (/^[A-Za-z_$][\w$]*$/.test(value)) found.add(value);
  return found;
};

/* Everything outside the analysed scripts that can name a function. */
const outside = new Set();
const addWords = (text) => { for (const word of wordsOf(text)) outside.add(word); };
/* The page: its handler attributes and its inline scripts. */
const html = read('index.html');
for (const match of html.matchAll(/\son[a-z]+="([^"]*)"/g)) addWords(match[1]);
for (const match of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)) addWords(match[1]);
addWords(read('sw.js'));
for (const dir of ['tests/e2e']) {
  for (const file of fs.readdirSync(path.join(ROOT, dir))) {
    if (/\.(mjs|cjs|js)$/.test(file)) addWords(read(`${dir}/${file}`));
  }
}

const units = [];          /* { file, name|null, start, end, refs:Set } */
const published = [];
const unpublished = [];
for (const file of scripts) {
  const source = read(file);
  let ast;
  try {
    ast = parser.parse(source, { sourceType: 'script', errorRecovery: false, ranges: true, attachComment: true });
  } catch (error) {
    console.error(`${file}: could not be parsed (${error.message}); nothing in it is touched.`);
    units.push({ file, name: null, refs: wordsOf(source), start: 0, end: 0 });
    continue;
  }
  const refsOf = (node) => {
    const refs = new Set();
    traverse(node, {
      noScope: true,
      Identifier(p) {
        const parent = p.parent;
        /* `{ startEncryption: '…' }` names a key, not the function: the
           translation tables are two thousand lines of exactly that. */
        if (parent.type === 'ObjectProperty' && parent.key === p.node && !parent.computed && !parent.shorthand) return;
        /* `thing.name` reaches a global function only through the global
           object itself. */
        if ((parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && parent.property === p.node && !parent.computed) {
          const object = parent.object;
          if (!(object.type === 'Identifier' && GLOBALS.has(object.name))) return;
        }
        refs.add(p.node.name);
      },
      StringLiteral(p) { for (const w of callsIn(p.node.value)) refs.add(w); },
      TemplateElement(p) { for (const w of callsIn(p.node.value.raw)) refs.add(w); },
    }, undefined, {});
    return refs;
  };
  for (const node of ast.program.body) {
    /* traverse needs a File or Program at the top; wrap the one statement. */
    const wrapped = { type: 'File', program: { type: 'Program', body: [node], directives: [], sourceType: 'script' } };
    if (node.type === 'FunctionDeclaration' && node.id) {
      const refs = refsOf(wrapped);
      refs.delete(node.id.name);          /* naming itself does not keep it alive */
      /* A comment directly on the function goes with it. */
      const lead = (node.leadingComments || []).filter((c) => /^\s*$/.test(source.slice(c.end, node.start)) || true);
      let start = node.start;
      for (let i = lead.length - 1; i >= 0; i -= 1) {
        const between = source.slice(lead[i].end, start);
        if (/^[ \t]*\r?\n?[ \t]*$/.test(between)) start = lead[i].start; else break;
      }
      units.push({ file, name: node.id.name, start, end: node.end, refs });
    } else if (file === 'js/app.js' && node.type === 'ExpressionStatement' && node.expression.type === 'AssignmentExpression'
      && source.slice(node.expression.left.start, node.expression.left.end) === 'window.PoorijaApp'
      && node.expression.right.type === 'ObjectExpression') {
      /* Held back: which entries count is decided once every other file has
         been read (see `published` below). */
      published.push({ file, node, source });
    } else {
      units.push({ file, name: null, refs: refsOf(wrapped), start: node.start, end: node.end });
    }
  }
}

/* window.PoorijaApp: an entry is a use only if another file asks for it. */
const elsewhere = new Set(outside);
for (const file of scripts) if (file !== 'js/app.js') for (const word of wordsOf(read(file))) elsewhere.add(word);
for (const { file, node, source } of published) {
  const refs = new Set();
  for (const property of node.expression.right.properties) {
    const key = property.key ? (property.key.name || property.key.value) : null;
    if (!key || elsewhere.has(key)) for (const word of wordsOf(source.slice(property.start, property.end))) refs.add(word);
    else unpublished.push(key);
  }
  units.push({ file, name: null, refs, start: node.start, end: node.end });
}

/* A name declared twice (the last script to load wins) is kept whole: which
   one is alive depends on load order, which this does not model. */
const counts = new Map();
for (const unit of units) if (unit.name) counts.set(unit.name, (counts.get(unit.name) || 0) + 1);

const alive = new Set(outside);
const queue = [];
for (const unit of units) if (!unit.name) queue.push(unit);
const byName = new Map();
for (const unit of units) if (unit.name) { if (!byName.has(unit.name)) byName.set(unit.name, []); byName.get(unit.name).push(unit); }
for (const name of outside) for (const unit of byName.get(name) || []) queue.push(unit);
const seen = new Set();
/* For --why: the unit through which each function was first found alive. */
const reason = new Map();
while (queue.length) {
  const unit = queue.pop();
  if (seen.has(unit)) continue;
  seen.add(unit);
  for (const ref of unit.refs) {
    if (alive.has(ref) && !byName.has(ref)) continue;
    alive.add(ref);
    for (const next of byName.get(ref) || []) if (!seen.has(next)) { if (!reason.has(next)) reason.set(next, unit); queue.push(next); }
  }
}

const dead = units.filter((unit) => unit.name && !seen.has(unit) && counts.get(unit.name) === 1);
const perFile = new Map();
for (const unit of dead) { if (!perFile.has(unit.file)) perFile.set(unit.file, []); perFile.get(unit.file).push(unit); }

let totalChars = 0;
console.log('\n  top-level functions nothing reaches\n');
for (const file of scripts) {
  const list = perFile.get(file) || [];
  if (!list.length) continue;
  const all = units.filter((unit) => unit.file === file && unit.name).length;
  const chars = list.reduce((sum, unit) => sum + (unit.end - unit.start), 0);
  totalChars += chars;
  console.log(`  ${String(list.length).padStart(4)} of ${String(all).padStart(4)}  ${String(Math.round(chars / 1024)).padStart(5)} KB  ${file}`);
  if (args.has('--list')) console.log('        ' + list.map((unit) => unit.name).join(' '));
}
console.log(`\n  ${dead.length} function(s), ${Math.round(totalChars / 1024)} KB of source`);
console.log(`  ${unpublished.length} entr${unpublished.length === 1 ? 'y' : 'ies'} of window.PoorijaApp nothing outside js/app.js asks for\n`);
if (args.has('--list') && unpublished.length) console.log('        ' + unpublished.join(' ') + '\n');

/* --why NAME: the chain that keeps a function alive, back to what runs at load. */
const whyAt = process.argv.indexOf('--why');
if (whyAt > 0) {
  const lineOf = (unit) => read(unit.file).slice(0, unit.start).split('\n').length;
  for (const name of process.argv.slice(whyAt + 1)) {
    const unit = (byName.get(name) || [])[0];
    if (!unit) { console.log(`  ${name}: not a top-level function`); continue; }
    if (!seen.has(unit)) { console.log(`  ${name}: dead`); continue; }
    const chain = [];
    for (let at = unit; at; at = reason.get(at)) { chain.push(at.name ? at.name : `<top level, ${at.file}:${lineOf(at)}>`); if (!at.name) break; }
    if (chain.length === 1) chain.push(outside.has(name) ? '<named in the page, the service worker or a test>' : '<unknown>');
    console.log('  ' + chain.join('  <-  '));
  }
  console.log('');
}

if (args.has('--write')) {
  for (const [file, list] of perFile) {
    let source = read(file);
    /* An entry of window.PoorijaApp that publishes a function being removed
       has to go with it: `{ thing, }` is a reference, and a reference to a
       name that no longer exists stops the whole script at that line. Done
       first, while the offsets of the functions are still those of this text. */
    const gone = new Set(list.map((unit) => unit.name));
    const entries = [];
    for (const { file: where, node } of published) {
      if (where !== file) continue;
      for (const property of node.expression.right.properties) {
        const value = property.value || property.argument;
        if (value && value.type === 'Identifier' && gone.has(value.name)) entries.push({ start: property.start, end: property.end });
      }
    }
    for (const entry of entries.sort((x, y) => y.start - x.start)) {
      let end = entry.end;
      while (source[end] === ' ' || source[end] === '\t') end += 1;
      if (source[end] === ',') end += 1;
      while (source[end] === ' ' || source[end] === '\t') end += 1;
      if (source[end] === '\r') end += 1;
      if (source[end] === '\n') end += 1;
      source = source.slice(0, entry.start) + source.slice(end);
    }
    for (const unit of list.sort((a, b) => b.start - a.start)) {
      /* Take the line break that followed it too, so no blank run is left. */
      let end = unit.end;
      while (source[end] === ' ' || source[end] === '\t') end += 1;
      if (source[end] === '\r') end += 1;
      if (source[end] === '\n') end += 1;
      source = source.slice(0, unit.start) + source.slice(end);
    }
    fs.writeFileSync(path.join(ROOT, file), source);
  }
  console.log(`  removed. Run it again: a function only these called is dead now.\n`);
}
