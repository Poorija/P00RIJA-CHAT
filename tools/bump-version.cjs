#!/usr/bin/env node
/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Moves every file that names the version to a new one, and touches nothing
 * else in them.
 *
 *   node tools/bump-version.cjs 2.20.0 chat-v37
 *
 * It replaces the old number everywhere it is written as THIS app's version.
 * A plain search-and-replace is not that: it once rewrote the version of
 * security-framework-sys in src-tauri/Cargo.lock, a crate that happened to be
 * at 2.17.0 when the app moved from 2.16.8 to 2.17.0, and every native build
 * after that asked for a crate that does not exist. So Cargo.lock is changed
 * only inside the block of the p00rija-chat package, and package-lock.json only
 * at its two places for the root package.
 * Run `node tools/check-versions.cjs` after it. */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const [next, nextBuild] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const old = pkg.version;
const oldBuild = pkg.buildTag;
if (!/^\d+\.\d+\.\d+$/.test(next || '') || !/^chat-v\d+$/.test(nextBuild || '')) {
  console.error('usage: node tools/bump-version.cjs 2.20.0 chat-v37');
  process.exit(2);
}
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const write = (file, text) => fs.writeFileSync(path.join(ROOT, file), text);
/* Boundary-safe: 2.20.2 is a prefix of 2.20.22 (and chat-v4 of chat-v40), and a plain
   replace turned the new number into 2.20.222. The old one counts only where it
   stands alone, not as the start of a longer number. */
const alone = (value) => new RegExp(`(?<![0-9.])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`, 'g');
const everywhere = (text) => text
  .replace(alone(`${old}-${oldBuild}`), `${next}-${nextBuild}`)
  .replace(alone(`build ${oldBuild}`), `build ${nextBuild}`)
  .replace(alone(oldBuild), nextBuild)
  .replace(alone(old), next);
/* Files that are about this app and nothing else. */
for (const file of ['INSTALL-LINUX-SERVER.md', 'index.html', 'README.md', 'HANDOFF.md', 'package.json', 'standalone-relay/package.json', 'sw.js',
  'config/relay-overrides.json', 'js/app.js', 'src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json']) {
  if (fs.existsSync(path.join(ROOT, file))) write(file, everywhere(read(file)));
}
/* The generated iOS project, if there is one. */
for (const file of ['src-tauri/gen/apple/project.yml', 'src-tauri/gen/apple/p00rija-chat_iOS/Info.plist']) {
  if (fs.existsSync(path.join(ROOT, file))) write(file, everywhere(read(file)));
}
/* Cargo.lock: the p00rija-chat block only. */
{
  const lock = read('src-tauri/Cargo.lock');
  const out = lock.replace(/(\[\[package\]\]\nname = "p00rija-chat"\nversion = ")[^"]+(")/, `$1${next}$2`);
  if (out === lock && !lock.includes(`name = "p00rija-chat"\nversion = "${next}"`)) { console.error('Cargo.lock: the p00rija-chat block was not found'); process.exit(1); }
  write('src-tauri/Cargo.lock', out);
}
/* package-lock.json: the root's two places. */
{
  const lock = JSON.parse(read('package-lock.json'));
  lock.version = next;
  if (lock.packages && lock.packages['']) lock.packages[''].version = next;
  write('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`);
}
console.log(`${old} (${oldBuild}) -> ${next} (${nextBuild})`);
