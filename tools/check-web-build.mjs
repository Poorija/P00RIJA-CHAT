#!/usr/bin/env node
/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* The built web root (roadmap 2.1, tools/build-web.mjs) stays buildable and
   whole: it is built into a scratch directory, every file index.html and sw.js
   name is there, the classic bundles parse as scripts and the module bundle as
   a module, and every function the classic scripts declare at the top is in a
   bundle (none lost between the source tree and the build). */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const parser = require('@babel/parser');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* A scratch directory: never the dist/web a running suite may be serving. */
const OUT = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'poorija-web-'));
const problems = [];
execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build-web.mjs')], { cwd: ROOT, stdio: 'pipe', env: { ...process.env, POORIJA_WEB_OUT: OUT } });
const html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
const named = [...html.matchAll(/<script\b[^>]*\bsrc="([^"?]+)/g)].map((m) => m[1]);
for (const rel of named) if (!fs.existsSync(path.join(OUT, rel))) problems.push(`index.html names ${rel}, which the build did not write`);
const sw = fs.readFileSync(path.join(OUT, 'sw.js'), 'utf8');
/* The worker is a script of its own, and a syntax error in it is a worker that can never register. */
try { parser.parse(sw, { sourceType: 'script', errorRecovery: false }); } catch (error) { problems.push(`sw.js does not parse: ${error.message}`); }
for (const m of sw.matchAll(/^\s*'\.\/([^'?#]+\.[a-z0-9]+)',\s*$/gim)) if (!fs.existsSync(path.join(OUT, m[1]))) problems.push(`sw.js precaches ${m[1]}, which is not in the build`);
let joined = '';
for (const rel of named.filter((r) => r.startsWith('build/'))) {
  const code = fs.readFileSync(path.join(OUT, rel), 'utf8');
  try { parser.parse(code, { sourceType: /crypto-/.test(rel) ? 'module' : 'script', errorRecovery: false }); } catch (error) { problems.push(`${rel} does not parse: ${error.message}`); }
  joined += code;
}
const srcHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
for (const rel of [...srcHtml.matchAll(/<script\b[^>]*\bdefer\b[^>]*\bsrc="(js\/[^"?]+)/g)].map((m) => m[1])) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const m of code.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
    if (!joined.includes(`function ${m[1]}(`)) problems.push(`${rel}: function ${m[1]} is not in any bundle`);
  }
}
fs.rmSync(OUT, { recursive: true, force: true });
if (problems.length) { console.log(`\n  ${problems.slice(0, 20).join('\n  ')}\n`); process.exit(1); }
console.log(`\n  dist/web builds: ${named.length} scripts named, all present and parsing; nothing of the source lost\n`);
