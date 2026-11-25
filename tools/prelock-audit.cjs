/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Which poorija_* keys does the app touch while it is still locked?
 *
 * Any key read before unlock and written after it (or the reverse) now lands
 * in two different places, because the storage redirection only points at a
 * profile once one is open. That is a whole class of bug, not one bug, so it
 * is worth enumerating rather than fixing case by case. */
const parser = require('@babel/parser');
const fs = require('fs');

const files = ['js/app.js', ...fs.readdirSync('js/chat').filter(f=>f.endsWith('.js')).map(f=>'js/chat/'+f)];

/* Functions that only ever run before a profile is open. */
const PRE_UNLOCK = new Set([
  'checkFirstVisit','selectLanguage','unlockApp','unlockWithPasskey','showLockTimer',
  'showResetPassword','initSecQuestionsUI','verifySecurityAnswers','legacyVerifyMasterPassword',
  'openVaultForUnlock','loadTheme','applyTheme','syncLockScreenLayout','initTheme',
  'getInstallationSecret','showDesktopBiometricPromptIfNeeded','syncPwaRuntimeState'
]);

const hits = new Map();   // key -> Set of enclosing function names

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const ast = parser.parse(src, { sourceType: 'script', errorRecovery: true });
  const stack = [];
  const walk = (node) => {
    if (!node || typeof node.type !== 'string') return;
    const named = (node.type === 'FunctionDeclaration' && node.id) ? node.id.name : null;
    if (named) stack.push(named);

    if (node.type === 'CallExpression' &&
        node.callee?.type === 'MemberExpression' &&
        node.callee.object?.name === 'localStorage' &&
        ['getItem','setItem','removeItem'].includes(node.callee.property?.name)) {
      const arg = node.arguments[0];
      let key = null;
      if (arg?.type === 'StringLiteral') key = arg.value;
      else if (arg?.type === 'Identifier') key = '<' + arg.name + '>';
      if (key && (key.startsWith('poorija_') || key.startsWith('<'))) {
        const fn = stack[stack.length - 1] || '<top level>';
        if (!hits.has(key)) hits.set(key, new Set());
        hits.get(key).add(fn);
      }
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
    if (named) stack.pop();
  };
  walk(ast.program);
}

/* What the vault redirects and what it leaves where it is. A key touched on both
   sides of the unlock is only safe if it is on GLOBAL_KEYS (js/vault-profiles.js):
   there it is the same key before and after, and it is meant to be — the lock
   screen reads it. One that is not would be namespaced after the unlock and read
   un-namespaced before it, which is the bug this tool was written to find. */
const vaultSource = fs.readFileSync('js/vault-profiles.js', 'utf8');
const globalBlock = /const GLOBAL_KEYS = new Set\(\[([\s\S]*?)\]\);/.exec(vaultSource)?.[1] || '';
const globalKeys = new Set([...globalBlock.matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]));
console.log('=== keys touched from a pre-unlock code path ===');
let risky = 0;
const unclassified = [];
for (const [key, fns] of [...hits].sort()) {
  const pre = [...fns].filter(f => PRE_UNLOCK.has(f) || f === '<top level>');
  if (pre.length) {
    const post = [...fns].filter(f => !PRE_UNLOCK.has(f) && f !== '<top level>');
    const flag = post.length ? '  BOTH SIDES' : '';
    console.log(`  ${key.padEnd(38)} pre: ${pre.join(', ')}${flag}`);
    if (post.length) {
      console.log(`  ${''.padEnd(38)} post: ${post.slice(0,4).join(', ')}`);
      risky++;
      const classified = globalKeys.has(key) || key === '<key>';
      console.log(`  ${''.padEnd(38)} ${classified ? 'device-level by design (on GLOBAL_KEYS; the lock screen reads it)' : 'NOT ON GLOBAL_KEYS'}`);
      if (!classified) unclassified.push(key);
    }
  }
}
console.log(`\n  ${risky} key(s) are touched on BOTH sides of unlock; ${risky - unclassified.length} are device-level by design.`);
if (unclassified.length) {
  console.log(`  NOT classified: ${unclassified.join(', ')} — add each to GLOBAL_KEYS (js/vault-profiles.js) if the lock screen reads it, or keep it out of code that runs before the unlock.`);
  process.exit(1);
}
