#!/usr/bin/env node
/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Takes the code out of index.html so the Content-Security-Policy can refuse
 * code that is written into a page (script-src without 'unsafe-inline').
 *
 *   node tools/extract-inline.cjs          report
 *   node tools/extract-inline.cjs --write  rewrite index.html, write js/inline-actions.js
 *
 * What it moves:
 *   - every onclick="…" and onchange="…" attribute becomes data-on-click="aN" /
 *     data-on-change="aN", and the code of each becomes a function of
 *     js/inline-actions.js, bound to its element exactly where the attribute
 *     was (an event listener on the element, so what stops propagation, and
 *     when, is as it was). `this` is the element, `event` the event, and a
 *     handler that returns false still cancels the default action.
 *   - the two inline <script> blocks become js/boot-shell.js and
 *     js/boot-fonts.js, loaded in the same place, so they run when they did.
 *   - a preload link that turned itself into a stylesheet by onload does it
 *     from the script instead.
 * It is idempotent: a page with none left is left alone. */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const write = process.argv.includes('--write');
const file = path.join(ROOT, 'index.html');
let html = fs.readFileSync(file, 'utf8');
const unescape = (text) => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const tag = /(\d+\.\d+\.\d+-chat-v\d+)/.exec(html)?.[1] || '';

/* 1. inline scripts */
const scripts = [];
html = html.replace(/<script>\n([\s\S]*?)<\/script>/g, (whole, body) => {
  const names = ['boot-shell.js', 'boot-fonts.js'];
  const name = names[scripts.length];
  if (!name) return whole;
  scripts.push({ name, body });
  return `<script src="js/${name}?v=${tag}"></script>`;
});

/* 2. handlers */
const actions = [];
const byBody = new Map();
let count = 0;
html = html.replace(/\son(click|change)="([^"]*)"/g, (whole, kind, raw) => {
  const body = unescape(raw).trim();
  if (!byBody.has(body)) { byBody.set(body, `a${byBody.size + 1}`); actions.push([byBody.get(body), body]); }
  count += 1;
  return ` data-on-${kind}="${byBody.get(body)}"`;
});

/* 3. the stylesheet that loads itself */
html = html.replace(/ onload="this\.onload=null;this\.rel='stylesheet'"/g, ' data-as-stylesheet="1"');

console.log(`${scripts.length} inline script(s), ${count} handlers in ${actions.length} distinct functions`);
if (!write) process.exit(0);

const header = `/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */
`;
for (const script of scripts) fs.writeFileSync(path.join(ROOT, 'js', script.name), `${header}\n${script.body.replace(/\s+$/, '')}\n`);
const functions = actions.map(([name, body]) => `  ${name}(event) { ${body.replace(/;?\s*$/, ';')} },`).join('\n');
fs.writeFileSync(path.join(ROOT, 'js', 'inline-actions.js'), `${header}
/* What index.html's buttons and switches do, as code of this file.
 *
 * They were onclick="…" and onchange="…" attributes, which a policy that refuses
 * code written into a page (script-src without 'unsafe-inline') cannot allow.
 * tools/extract-inline.cjs moved each one here and left data-on-click / data-on-change
 * on the element; they are bound below, to the element itself. A function is
 * resolved by name when it is pressed, from the global scope, as the attribute was.
 *
 * Markup the app writes later (a list it draws) has no attribute to move: it
 * carries data-call="name" data-args='[…]' and is handled at the end of this file. */
(function () {
  'use strict';
  var ACTIONS = {
${functions}
  };

  function run(element, event, id) {
    var action = ACTIONS[id];
    if (!action) return;
    var result = action.call(element, event);
    if (result === false) event.preventDefault();
  }
  ['click', 'change'].forEach(function (kind) {
    document.querySelectorAll('[data-on-' + kind + ']').forEach(function (element) {
      element.addEventListener(kind, function (event) { run(element, event, element.getAttribute('data-on-' + kind)); });
    });
  });
  document.querySelectorAll('link[data-as-stylesheet]').forEach(function (link) { link.rel = 'stylesheet'; });

  /* Markup drawn at run time: a function of the app, by name, with arguments. Only
     names listed here can be called, so a piece of markup that carries somebody
     else's text cannot name anything else. */
  var CALLS = ['moveTabOrder', 'viewPassword', 'copyPassword', 'deletePassword', 'switchTab', 'moveMobileTabBarItem', 'toggleMobileTabBarItem'];
  function delegated(kind) {
    return function (event) {
      var element = event.target && event.target.closest ? event.target.closest('[data-call-' + kind + ']') : null;
      if (!element || element.disabled) return;
      var name = element.getAttribute('data-call-' + kind);
      if (CALLS.indexOf(name) < 0 || typeof window[name] !== 'function') return;
      var args = [];
      try { args = JSON.parse(element.getAttribute('data-args') || '[]'); } catch (error) { return; }
      window[name].apply(window, Array.isArray(args) ? args : []);
    };
  }
  document.addEventListener('click', delegated('click'));
  document.addEventListener('change', delegated('change'));
})();
`);
fs.writeFileSync(file, html);
console.log('wrote js/inline-actions.js, ' + scripts.map((s) => `js/${s.name}`).join(', ') + ', and rewrote index.html');
