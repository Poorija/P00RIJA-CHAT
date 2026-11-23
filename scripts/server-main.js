/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

'use strict';

/* The relay, in parts (roadmap 2.3).

   scripts/server/ holds the relay as ordered parts, none over about 800
   lines, listed in scripts/server/ORDER. They are one program with one scope
   — some four hundred functions and bindings reached from everywhere — so
   they are joined in that order and compiled as a single CommonJS module
   whose filename is scripts/server.js (so __dirname, require and every path
   built from them are what they always were). An inline source map points
   each line back to its part: a stack trace says `scripts/server/26-wsserver.js:412`,
   not a line in a file nobody has. */

const fs = require('fs');
const path = require('path');
const Module = require('module');

const DIR = path.join(__dirname, 'server');
const VLQ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function vlq(n) {
  let v = n < 0 ? ((-n) << 1) | 1 : n << 1;
  let out = '';
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v) digit |= 32;
    out += VLQ[digit];
  } while (v);
  return out;
}

function joinParts() {
  const order = fs.readFileSync(path.join(DIR, 'ORDER'), 'utf8').split('\n').map((name) => name.trim()).filter(Boolean);
  if (!order.length) throw new Error('scripts/server/ORDER lists no parts');
  const pieces = [];
  const mappings = [];
  let prevSource = 0;
  let prevLine = 0;
  order.forEach((name, sourceIndex) => {
    if (!/^\d{2}-[a-z0-9-]+\.js$/.test(name)) throw new Error(`scripts/server/ORDER names ${name}, which is not a part`);
    const text = fs.readFileSync(path.join(DIR, name), 'utf8');
    const lines = text.split('\n');
    /* A part ends with a newline (but the last); the join adds nothing. */
    if (lines[lines.length - 1] === '' && sourceIndex < order.length - 1) lines.pop();
    lines.forEach((_line, lineIndex) => {
      mappings.push(`A${vlq(sourceIndex - prevSource)}${vlq(lineIndex - prevLine)}A`);
      prevSource = sourceIndex;
      prevLine = lineIndex;
    });
    pieces.push(lines.join('\n'));
  });
  const map = { version: 3, sources: order.map((name) => path.join(DIR, name)), names: [], mappings: mappings.join(';') };
  return { code: pieces.join('\n'), map };
}

function run(filename) {
  const { code, map } = joinParts();
  if (typeof process.setSourceMapsEnabled === 'function') process.setSourceMapsEnabled(true);
  const relay = new Module(filename, module.parent || module);
  relay.filename = filename;
  relay.paths = Module._nodeModulePaths(path.dirname(filename));
  require.cache[filename] = relay;
  relay._compile(`${code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}\n`, filename);
  relay.loaded = true;
  return relay.exports;
}

module.exports = { run, joinParts };
