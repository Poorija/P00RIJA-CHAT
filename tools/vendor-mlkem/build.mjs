/* node tools/vendor-mlkem/build.mjs (after `npm ci` in this folder)
 *
 * Writes vendor/mlkem/mlkem.bundle.min.js and the licences of what is in it.
 * The output is committed, like every other file in vendor/: the app runs
 * offline and from a native shell, so nothing is fetched at run time. */
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../../vendor/mlkem');
await mkdir(out, { recursive: true });

await build({
  entryPoints: [path.join(here, 'entry.mjs')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020', 'safari15'],
  legalComments: 'none',
  outfile: path.join(out, 'mlkem.bundle.min.js'),
  logLevel: 'info',
});

const sections = [];
for (const name of ['@noble/post-quantum', '@noble/hashes', '@noble/curves', '@noble/ciphers']) {
  const dir = path.join(here, 'node_modules', name);
  let meta;
  try { meta = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')); } catch { continue; }
  let text = '';
  for (const file of ['LICENSE', 'LICENSE.md', 'license']) {
    try { text = await readFile(path.join(dir, file), 'utf8'); break; } catch { /* next */ }
  }
  sections.push(`## ${name} ${meta.version}\n\n${text.trim()}\n`);
}
await writeFile(path.join(out, 'LICENSES.md'),
  `# What is in mlkem.bundle.min.js\n\nBuilt by tools/vendor-mlkem/build.mjs. Only ML-KEM-768 and what it needs are in the bundle; the licences of every package it was built from are below.\n\n${sections.join('\n')}`);
console.log('wrote vendor/mlkem');
