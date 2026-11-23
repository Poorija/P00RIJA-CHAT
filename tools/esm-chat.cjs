#!/usr/bin/env node
/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* The chat's scripts as ES modules (roadmap 2.1).

   js/chat/NN-*.js were classic scripts sharing one global scope: about two
   thousand top-level functions and bindings, called from every other file,
   from inline handlers in index.html, from js/app.js, and by name from every
   end-to-end suite (and some suites replace a function by assigning
   window.name). A module has a scope of its own, so each file, made a module,
   publishes its top-level names on globalThis as live accessors:

     get  reads the module's own binding, so a value it later changes is seen;
     set  writes the module's own binding (a let, a function), so assigning
          window.name, or a bare name from another file, changes what this
          file's own code calls — exactly as one shared global did.

   Names from other files resolve, from inside a module, through the global
   object, so no file needs an import to see another; the order the page loads
   them in (and therefore what exists when a file's top level runs) is the
   order it was. What changes: modules are strict. This tool reports, before
   anything is written, what strict mode would break: a top-level `this`, an
   assignment to a name declared nowhere (a sloppy-mode implicit global), and
   anything that does not parse as a module (with, octal, duplicate parameters).

     node tools/esm-chat.cjs            report
     node tools/esm-chat.cjs --write    rewrite js/chat/NN-*.js and index.html */
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'js', 'chat');
const write = process.argv.includes('--write');
const MARK = '/* ---- published to globalThis (roadmap 2.1, tools/esm-chat.cjs) ---- */';
const files = fs.readdirSync(DIR).filter((n) => /^\d{2}-.*\.js$/.test(n)).sort();

/* What a browser window already has: an assignment to one of these is not an
   implicit global. */
const WINDOW_NAMES = new Set(['location', 'name', 'status', 'onload', 'onerror', 'onbeforeunload', 'document', 'navigator', 'history', 'localStorage', 'sessionStorage', 'console', 'onmessage', 'onresize', 'onfocus', 'onblur', 'onpopstate', 'onhashchange', 'onunload', 'onstorage', 'onkeydown', 'onkeyup', 'onclick']);

function topLevelNames(ast) {
  const names = [];
  for (const node of ast.program.body) {
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') names.push({ name: node.id.name, kind: node.type === 'ClassDeclaration' ? 'class' : 'function' });
    else if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations) {
        const ids = [];
        const collect = (pattern) => {
          if (!pattern) return;
          if (pattern.type === 'Identifier') ids.push(pattern.name);
          else if (pattern.type === 'ObjectPattern') pattern.properties.forEach((p) => collect(p.type === 'RestElement' ? p.argument : p.value));
          else if (pattern.type === 'ArrayPattern') pattern.elements.forEach((e) => collect(e && e.type === 'RestElement' ? e.argument : e));
          else if (pattern.type === 'AssignmentPattern') collect(pattern.left);
        };
        collect(decl.id);
        for (const id of ids) names.push({ name: id, kind: node.kind });
      }
    }
  }
  return names;
}

const parsed = files.map((file) => {
  const source = fs.readFileSync(path.join(DIR, file), 'utf8');
  const body = source.includes(MARK) ? source.slice(0, source.indexOf(MARK)).replace(/\s+$/, '\n') : source;
  const ast = parser.parse(body, { sourceType: 'script', errorRecovery: false });
  return { file, source, body, ast, names: topLevelNames(ast) };
});
const declaredAnywhere = new Set(parsed.flatMap((p) => p.names.map((n) => n.name)));

/* Names the other classic scripts of the page declare (js/*.js), and what the
   page itself declares inline: assigning one of those from a module is fine. */
const classic = fs.readdirSync(path.join(ROOT, 'js')).filter((n) => n.endsWith('.js'));
for (const file of classic) {
  try {
    const ast = parser.parse(fs.readFileSync(path.join(ROOT, 'js', file), 'utf8'), { sourceType: 'script', errorRecovery: true });
    for (const n of topLevelNames(ast)) declaredAnywhere.add(n.name);
  } catch (_error) { /* a classic file that does not parse is someone else's report */ }
}

const problems = [];
for (const p of parsed) {
  try {
    parser.parse(p.body, { sourceType: 'module', errorRecovery: false });
  } catch (error) {
    problems.push(`${p.file}: does not parse as a module: ${error.message}`);
  }
  traverse(p.ast, {
    ThisExpression(pathThis) {
      if (!pathThis.getFunctionParent() && !pathThis.findParent((x) => x.isClassBody())) problems.push(`${p.file}:${pathThis.node.loc.start.line}: top-level \`this\` (window in a script, undefined in a module)`);
    },
    /* Parses as a module and throws when it runs: arguments.callee/.caller,
       and a function's .caller or .arguments. */
    MemberExpression(pathMember) {
      const { object, property } = pathMember.node;
      const prop = property.type === 'Identifier' ? property.name : '';
      if (object.type === 'Identifier' && object.name === 'arguments' && (prop === 'callee' || prop === 'caller')) problems.push(`${p.file}:${pathMember.node.loc.start.line}: arguments.${prop} (a TypeError in strict mode)`);
    },
    AssignmentExpression(pathAssign) {
      const left = pathAssign.node.left;
      if (left.type !== 'Identifier') return;
      if (pathAssign.scope.hasBinding(left.name, true)) return;
      if (declaredAnywhere.has(left.name) || WINDOW_NAMES.has(left.name)) return;
      problems.push(`${p.file}:${left.loc.start.line}: assigns ${left.name}, declared nowhere (an implicit global, an error in a module)`);
    },
  });
}

const total = parsed.reduce((n, p) => n + p.names.length, 0);
console.log(`${parsed.length} chat scripts, ${total} top-level names to publish`);
if (problems.length) {
  console.log(`\n${problems.length} thing(s) strict mode would break:\n  ${problems.slice(0, 60).join('\n  ')}`);
  if (write) process.exit(1);
}

if (write && !problems.length) {
  for (const p of parsed) {
    const entries = p.names.map(({ name, kind }) => {
      const setter = kind === 'const' || kind === 'class'
        ? `set() { throw new TypeError('Assignment to constant variable ${name}.'); }`
        : `set(value) { ${name} = value; }`;
      return `  ${JSON.stringify(name)}: { get() { return ${name}; }, ${setter}, configurable: true },`;
    });
    const footer = entries.length ? `\n${MARK}\nObject.defineProperties(globalThis, {\n${entries.join('\n')}\n});\n` : `\n${MARK}\n`;
    fs.writeFileSync(path.join(DIR, p.file), p.body + footer);
  }
  /* index.html: each chat script loads as a module, in the same place. */
  const htmlPath = path.join(ROOT, 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  let changed = 0;
  html = html.replace(/<script defer src="(js\/chat\/\d{2}-[^"]+)"><\/script>/g, (_m, src) => { changed += 1; return `<script type="module" src="${src}"></script>`; });
  fs.writeFileSync(htmlPath, html);
  console.log(`rewrote ${parsed.length} scripts and ${changed} script tags`);
}
