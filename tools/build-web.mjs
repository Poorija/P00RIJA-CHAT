#!/usr/bin/env node
/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* The production web root, built (roadmap 2.1): `npm run build:web` writes
   dist/web/, a complete copy of what nginx serves, with the page's hundred-odd
   scripts made into a handful of files named by their content.

     - The ES modules (js/crypto/*-bridge.js and everything they import) are
       bundled by Vite into ONE module: aad, identity, the ratchet, the key log,
       Sender Keys and SFrame are each in it once.
     - The classic scripts (js/*.js, js/chat/NN-*.js, vendor) share one global
       scope and run in document order. A run of them is joined into one file
       in that order, keeping how each was loaded: deferred ones (and the
       module, which runs in the same ordered queue) are grouped across the
       page, since they run after it is parsed; scripts that run where they
       stand are joined only with their immediate neighbours, so nothing runs
       earlier than the page under it exists.
     - index.html names the built files; sw.js precaches them; the rest of the
       tree (css, fonts, assets, vendor, the worklets) is copied as it is.

   The source tree stays what is developed and tested; this is what can be
   served. tests/e2e/webbuild.mjs runs the app from dist/web. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { transform } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.POORIJA_WEB_OUT ? path.resolve(process.env.POORIJA_WEB_OUT) : path.join(ROOT, 'dist', 'web');
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const TAG = /<script\b([^>]*)\bsrc="([^"?]+)(?:\?[^"]*)?"([^>]*)><\/script>/g;
const tags = [];
for (const match of html.matchAll(TAG)) {
  const attrs = `${match[1]} ${match[3]}`;
  const kind = /type="module"/.test(attrs) ? 'module' : /\bdefer\b/.test(attrs) ? 'defer' : 'sync';
  tags.push({ start: match.index, end: match.index + match[0].length, src: match[2], kind, text: match[0] });
}
if (!tags.length) throw new Error('index.html names no scripts');

/* Groups. Deferred and module scripts run in one queue, in document order,
   after parsing: a run of deferred scripts not broken by a module is one file,
   placed where its first member stood. Synchronous scripts group only while
   nothing but white space lies between them. */
const groups = [];
for (let i = 0; i < tags.length; i += 1) {
  const tag = tags[i];
  const last = groups[groups.length - 1];
  const prev = tags[i - 1];
  const adjacent = prev && html.slice(prev.end, tag.start).trim() === '';
  if (last && last.kind === tag.kind && tag.kind === 'defer') { last.members.push(tag); continue; }
  if (last && last.kind === tag.kind && tag.kind === 'module') { last.members.push(tag); continue; }
  if (last && last.kind === 'sync' && tag.kind === 'sync' && adjacent) { last.members.push(tag); continue; }
  groups.push({ kind: tag.kind, members: [tag] });
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'build'), { recursive: true });

/* The module groups, through Vite: a virtual entry importing each bridge in
   the order the page had them. */
let moduleIndex = 0;
for (const group of groups.filter((g) => g.kind === 'module')) {
  moduleIndex += 1;
  const entry = path.join(OUT, `.entry-${moduleIndex}.mjs`);
  fs.writeFileSync(entry, group.members.map((tag) => `import ${JSON.stringify(path.join(ROOT, tag.src))};`).join('\n') + '\n');
  const result = await build({
    configFile: false,
    logLevel: 'warn',
    root: ROOT,
    build: {
      write: false,
      minify: true,
      sourcemap: false,
      target: 'es2022',
      modulePreload: false,
      rollupOptions: { input: entry, output: { format: 'es', entryFileNames: 'x.js' }, preserveEntrySignatures: 'strict' },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output);
  const chunk = outputs.find((o) => o.type === 'chunk' && o.isEntry);
  if (!chunk || outputs.filter((o) => o.type === 'chunk').length !== 1) throw new Error('the module group did not bundle into one file');
  const name = `crypto-${hash(chunk.code)}.js`;
  fs.writeFileSync(path.join(OUT, 'build', name), chunk.code);
  fs.rmSync(entry);
  group.out = `build/${name}`;
}

/* The classic groups: joined in order. Each piece ends with a newline and a
   semicolon-free separator comment, so no file's last statement runs into the
   next file's first. */
for (const group of groups.filter((g) => g.kind !== 'module')) {
  if (group.members.length === 1 && group.members[0].src.startsWith('vendor/')) {
    group.out = group.members[0].src;
    continue;
  }
  /* Each file is minified on its own and then joined, so one file's last statement
     cannot run into the next one's first. Whitespace and syntax only: these are
     classic scripts that share one global scope, and a top-level name (a function
     the markup or another file calls) must stay what it is called — renaming
     identifiers is for modules, and the module bundle has it. */
  const pieces = [];
  for (const tag of group.members) {
    const source = fs.readFileSync(path.join(ROOT, tag.src), 'utf8');
    const small = await transform(source, { loader: 'js', minifyWhitespace: true, minifySyntax: true, minifyIdentifiers: false, legalComments: 'none', charset: 'utf8', target: 'es2022' });
    pieces.push(`/* ${tag.src} */\n${small.code.trim()}\n;\n`);
  }
  const code = pieces.join('');
  const name = `${group.kind === 'defer' ? 'app' : 'boot'}-${hash(code)}.js`;
  fs.writeFileSync(path.join(OUT, 'build', name), code);
  group.out = `build/${name}`;
}

/* index.html: each group's first tag becomes the built file's; the others go. */
let page = '';
let at = 0;
for (const group of groups) {
  const first = group.members[0];
  for (const tag of group.members) {
    page += html.slice(at, tag.start);
    if (tag === first) {
      const attrs = group.kind === 'module' ? ' type="module"' : group.kind === 'defer' ? ' defer' : '';
      page += `<script${attrs} src="${group.out}"></script>`;
    }
    at = tag.end;
  }
}
page += html.slice(at);
fs.writeFileSync(path.join(OUT, 'index.html'), page);

/* Everything else the page uses, as it is. */
const copy = (rel) => {
  const from = path.join(ROOT, rel);
  if (!fs.existsSync(from)) return;
  fs.cpSync(from, path.join(OUT, rel), { recursive: true });
};
for (const rel of ['css', 'fonts', 'assets', 'vendor', 'manifest.webmanifest', 'monitor-client.html', 'js/chat/sfu-worklet.js']) copy(rel);
/* Scripts the page loads later by name (worklets, workers, lazy modules)
   are kept at their paths too. */
for (const rel of fs.readdirSync(path.join(ROOT, 'js')).filter((n) => /worker|worklet/i.test(n))) copy(path.join('js', rel));

/* sw.js: the same worker, precaching the built files instead of the sources. */
let sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const listStart = sw.indexOf('const CORE_ASSETS = [');
const listEnd = sw.indexOf('];', listStart);
if (listStart < 0 || listEnd < 0) throw new Error('sw.js has no CORE_ASSETS list');
const built = groups.map((g) => `  './${g.out}',`).filter((line, i, all) => all.indexOf(line) === i);
/* The entry before the insertion point may be the list's last and carry no comma
   (it did not, and the worker the build wrote was a syntax error: it could never
   register, so a server serving this build would have had no offline use at all). */
const head = sw.slice(0, listEnd).replace(/([^,\s])\s*$/, '$1,\n');
sw = head + built.join('\n') + '\n' + sw.slice(listEnd);
/* Every list in the worker names source scripts one by one; in the build they
   are in the bundles. */
sw = sw.split('\n').filter((line) => {
  const m = line.match(/^\s*'\.\/(js\/[^']+\.js)',\s*$/);
  return !m || m[1] === 'js/chat/sfu-worklet.js';
}).join('\n');
fs.writeFileSync(path.join(OUT, 'sw.js'), sw);

const before = tags.length;
const after = groups.length;
const bytes = fs.readdirSync(path.join(OUT, 'build')).reduce((n, f) => n + fs.statSync(path.join(OUT, 'build', f)).size, 0);
console.log(`dist/web: ${before} script tags became ${after} (${groups.filter((g) => g.kind === 'module').length} module bundle), ${(bytes / 1e6).toFixed(2)} MB of built script`);
