#!/usr/bin/env node
/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text.
 */

/* Cuts the threads that hold the removed tools' code in place.
 *
 * tools/dead-code.cjs removes what nothing reaches. Most of the removed
 * tools' code IS still reached: switchTab() has a branch per tab, the unlock
 * and the language switch redraw every panel, and each of those calls keeps a
 * whole tool's worth of functions alive behind it. The panels are gone from
 * the page, so every one of those calls now draws into nothing.
 *
 * This takes out exactly two shapes, wherever they are in the scripts:
 *
 *   1. a statement that is nothing but a call to one of the functions in
 *      ENTRY below — the functions that draw or load a removed tool;
 *   2. an `if` with no `else` whose test compares a tab name to the id of a
 *      removed tab (`if (tabName === 'passwords') …`);
 *   3. `window.name = name;` for one of those functions — publishing it is
 *      not a use of it;
 *   4. `later('passwords', load, 40)`: the unlock's deferred load of a tab,
 *      by the removed tab's name.
 *
 * Nothing else is touched, and nothing is deleted here except those
 * statements: the functions they called are left for dead-code.cjs, which
 * removes them only once nothing else reaches them either.
 *
 *   node tools/cut-removed-tools.cjs            report
 *   node tools/cut-removed-tools.cjs --write    cut
 */
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const write = process.argv.includes('--write');

/* The tabs the page no longer has. */
const REMOVED_TABS = new Set(['encrypt', 'decrypt', 'textencrypt', 'selfdestruct', 'stego', 'passwords', 'wizard', 'share', 'notes',
  'signatures', 'keys', 'sshkeys', 'voice', 'metadata', 'shredder', 'hash', 'qrbridge', 'authenticator', 'inspector', 'convert']);

/* Functions whose whole job is to draw, load or arrange one of those tools.
   Each was read before it went on this list: none of them changes anything
   the chat reads. */
const ENTRY = new Set([
  'renderKeysList', 'renderKeysDropdown', 'renderPasswords', 'loadPasswords',
  'renderSecureNotes', 'loadSecureNotes', 'loadShareHistory', 'loadSignatureHistory',
  'toggleKeyMethod', 'toggleSharePayloadType', 'toggleSignatureMode', 'toggleVerifySignatureMode',
  'syncShredderDesktopUi', 'syncEncryptAdvancedSettingsState', 'initMetadataPage', 'initVoicePage',
  /* What arrived from outside for a removed tool: a file opened with the app
     (it went to Decrypt), something shared to it (it went to Secure Share).
     The manifest no longer registers the app for either. */
  'syncSecureShareOpenUi', 'consumePendingLaunchFiles', 'consumeShareTargetPayloadFromCache', 'consumePendingSharedPayload',
]);

const scripts = [...read('index.html').matchAll(/<script[^>]*\ssrc="(js\/[^"?]+)/g)].map((m) => m[1]);
let total = 0;
for (const file of scripts) {
  const source = read(file);
  let ast;
  try { ast = parser.parse(source, { sourceType: 'script', ranges: true }); } catch (error) { continue; }
  const cuts = [];
  const isTabTest = (test) => test.type === 'BinaryExpression' && (test.operator === '===' || test.operator === '==')
    && [test.left, test.right].some((side) => side.type === 'StringLiteral' && REMOVED_TABS.has(side.value))
    && [test.left, test.right].some((side) => /(tabName|activeTab|\btab)$/.test(source.slice(side.start, side.end)));
  traverse(ast, {
    IfStatement(p) {
      if (p.node.alternate || !isTabTest(p.node.test)) return;
      cuts.push({ start: p.node.start, end: p.node.end, lone: p.parent.type !== 'BlockStatement' && p.parent.type !== 'Program', what: source.slice(p.node.test.start, p.node.test.end) });
      p.skip();
    },
    ExpressionStatement(p) {
      const call = p.node.expression;
      const lone = p.parent.type !== 'BlockStatement' && p.parent.type !== 'Program';
      if (call.type === 'AssignmentExpression' && call.right.type === 'Identifier' && ENTRY.has(call.right.name)
        && /^window\.[A-Za-z_$][\w$]*$/.test(source.slice(call.left.start, call.left.end))) {
        cuts.push({ start: p.node.start, end: p.node.end, lone, what: `window.${call.right.name} =` });
        return;
      }
      if (call.type === 'CallExpression' && call.callee.type === 'Identifier' && call.callee.name === 'later'
        && call.arguments[0] && call.arguments[0].type === 'StringLiteral' && REMOVED_TABS.has(call.arguments[0].value)) {
        cuts.push({ start: p.node.start, end: p.node.end, lone, what: `later('${call.arguments[0].value}')` });
        return;
      }
      if (call.type !== 'CallExpression' || call.callee.type !== 'Identifier' || !ENTRY.has(call.callee.name)) return;
      /* Inside the function of the same name it would be recursion, and a
         function on the list is on its way out whole. */
      const owner = p.getFunctionParent();
      if (owner && owner.node.id && ENTRY.has(owner.node.id.name)) return;
      cuts.push({ start: p.node.start, end: p.node.end, lone: p.parent.type !== 'BlockStatement' && p.parent.type !== 'Program', what: `${call.callee.name}()` });
    },
  });
  if (!cuts.length) continue;
  total += cuts.length;
  console.log(`  ${String(cuts.length).padStart(3)}  ${file}`);
  const tally = new Map();
  for (const cut of cuts) tally.set(cut.what, (tally.get(cut.what) || 0) + 1);
  console.log('       ' + [...tally].map(([what, n]) => (n > 1 ? `${what} ×${n}` : what)).join(', '));
  if (!write) continue;
  let out = source;
  for (const cut of cuts.sort((a, b) => b.start - a.start)) {
    if (cut.lone) {
      /* The only statement of an `if (…)` or a loop written without braces:
         it has to leave a statement behind, or the next line becomes the body. */
      out = out.slice(0, cut.start) + ';' + out.slice(cut.end);
      continue;
    }
    let start = cut.start;
    while (start > 0 && (out[start - 1] === ' ' || out[start - 1] === '\t')) start -= 1;
    let end = cut.end;
    while (out[end] === ' ' || out[end] === '\t') end += 1;
    if (out[end] === '\r') end += 1;
    if (out[end] === '\n' && (start === 0 || out[start - 1] === '\n')) end += 1; else start = cut.start;
    out = out.slice(0, start) + out.slice(end);
  }
  fs.writeFileSync(path.join(ROOT, file), out);
}
console.log(`\n  ${total} statement(s)${write ? ' cut' : ''}\n`);
