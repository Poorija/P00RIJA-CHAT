/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* What can be checked about the shipped files without a browser, said once.
 *
 * index.html
 *   - no id is used twice (getElementById answers with the first and the second
 *     control is dead, with no error);
 *   - every <label for> and aria-labelledby/-describedby names an id that exists;
 *   - every <img> has an alt; every target="_blank" link has rel="noopener";
 *   - inline event handlers and inline <script> blocks do not grow: the policy still
 *     allows them (script-src has 'unsafe-inline', which an injected script would use
 *     too), so they work — they are counted, and the count may only go down, until
 *     they are replaced by listeners and the policy can drop 'unsafe-inline';
 *   - every local script, stylesheet and icon it names exists.
 * the manifest
 *   - parses, names the fields an installable app needs, and every icon exists with
 *     the size it claims.
 * the documents
 *   - every relative link in every Markdown file resolves;
 *   - every `npm run X`, `node tests/e2e/X.mjs`, `bash scripts/X` and `docs/X.md`
 *     they tell a reader to run exists.
 *
 *   node tests/e2e/sourceaudit.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChecks } from './_check.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(root, rel));
const { results, check } = createChecks({ maxDetail: 900, entry: (_name, ok) => Boolean(ok) });
const list = (items, n = 15) => `${items.length}: ${items.slice(0, n).join(' | ')}${items.length > n ? ' | …' : ''}`;

/* ---- index.html ---- */
const html = read('index.html');
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const seen = new Set(); const dup = new Set();
for (const id of ids) { if (seen.has(id)) dup.add(id); seen.add(id); }
check('index.html: no id is used twice', dup.size === 0, list([...dup]));
const idSet = new Set(ids);
const dangling = [];
for (const m of html.matchAll(/<label[^>]*\sfor="([^"]+)"/g)) if (!idSet.has(m[1])) dangling.push(`label for=${m[1]}`);
for (const m of html.matchAll(/aria-(?:labelledby|describedby|controls)="([^"]+)"/g)) for (const id of m[1].split(/\s+/)) if (id && !idSet.has(id)) dangling.push(`${m[0].split('=')[0]}=${id}`);
check('index.html: every label for / aria-labelledby / -describedby / -controls names an id that exists', dangling.length === 0, list(dangling));
const noAlt = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]).filter((tag) => !/\salt=/.test(tag)).map((t) => t.slice(0, 80));
check('index.html: every <img> has an alt', noAlt.length === 0, list(noAlt));
const noRel = [...html.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)].map((m) => m[0]).filter((tag) => !/rel="[^"]*noopener/.test(tag)).map((t) => t.slice(0, 80));
check('index.html: every target="_blank" link has rel="noopener"', noRel.length === 0, list(noRel));
/* Known debt, measured 2026-11-16: 139 handlers and 3 inline script blocks. The ratchet only moves down. */
const INLINE_HANDLER_CEILING = 139;
const INLINE_SCRIPT_CEILING = 3;
const inlineHandlers = [...html.matchAll(/\s(on(?:click|change|input|submit|load|error|keydown|keyup|focus|blur|mouseover|touchstart))=["']/gi)].map((m) => m[1]);
check(`index.html: inline event handlers do not grow (${inlineHandlers.length}, ceiling ${INLINE_HANDLER_CEILING})`, inlineHandlers.length <= INLINE_HANDLER_CEILING, `${inlineHandlers.length}`);
const inlineScripts = [...html.matchAll(/<script\b(?![^>]*\ssrc=)[^>]*>/gi)].length;
check(`index.html: inline <script> blocks do not grow (${inlineScripts}, ceiling ${INLINE_SCRIPT_CEILING})`, inlineScripts <= INLINE_SCRIPT_CEILING, `${inlineScripts}`);
const devStatic = read('scripts/dev-static.js');
const scriptSrc = (devStatic.match(/"script-src ([^"]+)"/) || [])[1] || '';
console.log(`  NOTE  the policy served is: script-src ${scriptSrc} — ${/unsafe-inline/.test(scriptSrc) ? "'unsafe-inline' is present (the known debt above)" : 'no unsafe-inline'}`);
const missingLocal = [];
for (const m of html.matchAll(/(?:src|href)="([^"#?]+)(?:[?#][^"]*)?"/g)) {
  const target = m[1];
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//') || target === '/' || target.startsWith('#')) continue;
  if (!exists(target.replace(/^\//, ''))) missingLocal.push(target);
}
check('index.html: every local script, stylesheet, image and icon it names exists', missingLocal.length === 0, list([...new Set(missingLocal)]));

/* ---- manifest ---- */
let manifest = null;
try { manifest = JSON.parse(read('manifest.webmanifest')); } catch (error) { check('manifest.webmanifest parses', false, String(error)); }
if (manifest) {
  const need = ['name', 'short_name', 'start_url', 'display', 'icons', 'theme_color', 'background_color'];
  const lacking = need.filter((k) => !manifest[k] || (Array.isArray(manifest[k]) && !manifest[k].length));
  check('manifest: names, start_url, display, theme and background colours and icons are all there', lacking.length === 0, list(lacking));
  const iconProblems = [];
  for (const icon of manifest.icons || []) {
    const rel = String(icon.src).replace(/^\.?\//, '');
    if (!exists(rel)) { iconProblems.push(`${icon.src} missing`); continue; }
    if (/\.png$/i.test(rel) && /^\d+x\d+$/.test(icon.sizes || '')) {
      const buf = fs.readFileSync(path.join(root, rel));
      const w = buf.readUInt32BE(16); const h = buf.readUInt32BE(20);
      if (`${w}x${h}` !== icon.sizes) iconProblems.push(`${icon.src} is ${w}x${h}, says ${icon.sizes}`);
    }
  }
  check('manifest: every icon exists and is the size it says', iconProblems.length === 0, list(iconProblems));
  check('manifest: there is a 192 and a 512 icon, and a maskable one', ['192x192', '512x512'].every((s) => (manifest.icons || []).some((i) => i.sizes === s)) && (manifest.icons || []).some((i) => /maskable/.test(i.purpose || '')), JSON.stringify((manifest.icons || []).map((i) => `${i.sizes} ${i.purpose || ''}`)));
}

/* ---- documents ---- */
const markdown = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (/(^|\/)(node_modules|\.git|dist|Export|src-tauri|graphify-out|vendor|npm-package|regression-report)(\/|$)/.test(rel)) continue;
    if (entry.isDirectory()) walk(rel); else if (/\.md$/.test(entry.name)) markdown.push(rel);
  }
};
walk('.');
const brokenLinks = [];
const brokenCommands = [];
const pkg = JSON.parse(read('package.json'));
for (const rel of markdown) {
  const text = read(rel);
  const dir = path.dirname(rel);
  const withoutCode = text.replace(/```[\s\S]*?```/g, (block) => block.replace(/\[[^\]]*\]\([^)]*\)/g, ''));
  for (const m of withoutCode.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|#|data:|tel:)/.test(target)) continue;
    const clean = decodeURIComponent(target.split('#')[0].split('?')[0]);
    if (!clean) continue;
    if (!fs.existsSync(path.join(root, dir, clean)) && !exists(clean.replace(/^\//, ''))) brokenLinks.push(`${rel} -> ${target}`);
  }
  /* a line that installs and builds a vendored package (npm ci && npm run build in tools/vendor-*) is about that package's scripts, not this one's */
  for (const line of text.split('\n')) { if (/npm ci|vendor-/.test(line)) continue; for (const m of line.matchAll(/npm run ([a-z0-9:_-]+)/gi)) if (!pkg.scripts[m[1]]) brokenCommands.push(`${rel}: npm run ${m[1]}`); }
  for (const m of text.matchAll(/node (tests\/e2e\/[A-Za-z0-9_.-]+\.mjs)/g)) if (!exists(m[1])) brokenCommands.push(`${rel}: node ${m[1]}`);
  for (const m of text.matchAll(/(?:bash|sh) (scripts\/[A-Za-z0-9_.-]+\.sh)/g)) if (!exists(m[1])) brokenCommands.push(`${rel}: ${m[0]}`);
}
check(`documents: every relative link in ${markdown.length} Markdown files resolves`, brokenLinks.length === 0, list([...new Set(brokenLinks)]));
check('documents: every npm script, suite and shell script they tell a reader to run exists', brokenCommands.length === 0, list([...new Set(brokenCommands)]));

const failed = results.filter((ok) => !ok).length;
console.log(`\n===== ${failed} failed of ${results.length} =====`);
process.exit(failed ? 1 : 0);
