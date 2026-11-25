/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Every control of index.html that has an action, pressed, runs it.
 *
 * The buttons and switches of the page used to carry their code as onclick and
 * onchange attributes; they carry data-on-click / data-on-change now and
 * js/inline-actions.js binds them (the policy refuses code written into a page).
 * A control that lost its binding is a dead button with no error, and 111
 * different actions are too many for the other suites to press by chance — this
 * presses each of them once.
 *
 *   node tests/e2e/_local-stack.mjs inlineactions
 *
 * The globals an action calls are replaced by recorders for the press, so
 * nothing destructive (the panic button, the reset) actually runs; what is
 * checked is that the control reaches the function it names. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createChecks } from './_check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { results, check } = createChecks({ maxDetail: 300, entry: (_name, ok) => Boolean(ok) });
const source = fs.readFileSync(path.join(ROOT, 'js', 'inline-actions.js'), 'utf8');
/* id -> the global functions its body calls first. */
const names = {};
for (const match of source.matchAll(/^\s{2}(a\d+)\(event\) \{ (.*) \},$/gm)) {
  const called = [...match[2].matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[2]).filter((name) => !['function', 'if', 'for', 'while', 'switch', 'catch', 'return'].includes(name));
  names[match[1]] = called;
}

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message.slice(0, 160)));
  await page.goto(`${process.env.PKG_URL || 'http://localhost:8123'}/index.html`, { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  const outcome = await page.evaluate((table) => {
    const missed = [];
    let pressed = 0;
    let skipped = 0;
    const seen = new Set();
    document.querySelectorAll('[data-on-click], [data-on-change]').forEach((element) => {
      const kind = element.hasAttribute('data-on-click') ? 'click' : 'change';
      const id = element.getAttribute(`data-on-${kind}`);
      const called = (table[id] || []).filter((name) => !/^(document|window|event)$/.test(name));
      if (!called.length) { skipped += 1; return; }
      if (element.disabled) { skipped += 1; return; }
      const calls = [];
      const originals = {};
      called.forEach((name) => { originals[name] = window[name]; window[name] = (...args) => { calls.push(name); return undefined; }; });
      try {
        element.dispatchEvent(new Event(kind, { bubbles: true, cancelable: true }));
      } finally {
        called.forEach((name) => { window[name] = originals[name]; });
      }
      pressed += 1;
      if (!calls.includes(called[0])) missed.push(`${element.id || element.tagName}:${id}->${called[0]}`);
      seen.add(id);
    });
    return { missed, pressed, skipped, distinct: seen.size };
  }, names);
  check('the page has the controls', outcome.pressed > 100, JSON.stringify({ pressed: outcome.pressed, skipped: outcome.skipped }));
  check('every control reaches the function it names', outcome.missed.length === 0, outcome.missed.slice(0, 8).join(' '));
  check('most of the distinct actions were pressed', outcome.distinct >= 90, `${outcome.distinct} of ${Object.keys(names).length}`);
  check('and nothing threw', errors.length === 0, errors.slice(0, 3).join(' | '));
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n===== ${failed} failed of ${results.length} =====`);
  process.exitCode = failed ? 1 : 0;
} finally {
  await browser.close();
}
