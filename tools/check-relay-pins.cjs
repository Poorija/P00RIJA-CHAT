#!/usr/bin/env node
/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* The relay image installs config/relay-overrides.json's dependencies, pinned
   to exact versions, from config/relay-lock.json with npm ci (roadmap 5.2).
   The repository and the running server can still disagree without anything
   saying so: the repository's node_modules is a different install.
   That is not hypothetical: an audit found ws upgraded to 8.21.3 here and
   still pinned at 8.20.0 there — a HIGH advisory reachable through the
   WebSocket frames the relay reads from untrusted clients all day. The fix
   lived in the repository and never reached a server.
   This makes the drift loud, checks the lock still says what the pins say,
   and that the image installs from the lock. Run before deploying.

     node tools/check-relay-pins.cjs                check
     node tools/check-relay-pins.cjs --update-lock  rewrite config/relay-lock.json from the pins */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const dockerfile = fs.readFileSync(path.join(ROOT, 'config', 'Dockerfile.chat-signal'), 'utf8');
const relayPackagePath = path.join(ROOT, 'config', 'relay-overrides.json');
const lockPath = path.join(ROOT, 'config', 'relay-lock.json');
const relayPackage = JSON.parse(fs.readFileSync(relayPackagePath, 'utf8'));
const pinned = new Map(Object.entries(relayPackage.dependencies || {}));
if (!pinned.size) {
  console.error('  config/relay-overrides.json names no dependencies');
  process.exit(1);
}

if (process.argv.includes('--update-lock')) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-lock-'));
  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ ...relayPackage, version: '0.0.0' }, null, 2));
  execFileSync('npm', ['install', '--package-lock-only', '--omit=dev', '--ignore-scripts'], { cwd: work, stdio: 'inherit' });
  fs.copyFileSync(path.join(work, 'package-lock.json'), lockPath);
  fs.rmSync(work, { recursive: true, force: true });
  console.log('  wrote config/relay-lock.json');
}

let bad = 0;
for (const [name, want] of pinned) {
  let have;
  try {
    have = require(path.join(ROOT, 'node_modules', name, 'package.json')).version;
  } catch (error) {
    console.log(`  ${name.padEnd(12)} pinned ${want}, not installed here — cannot compare`);
    continue;
  }
  const agree = have === want;
  if (!agree) bad += 1;
  console.log(`  ${agree ? 'ok  ' : 'DRIFT'} ${name.padEnd(12)} image ${want.padEnd(10)} repo ${have}`);
}

/* The lock fixes what is under the pins, so it must say the same about the
   pins themselves, and the image must install from it. */
let lock = null;
try { lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch (_error) { /* reported below */ }
if (!lock) {
  console.error('  config/relay-lock.json is missing or not JSON; run with --update-lock');
  bad += 1;
} else {
  for (const [name, want] of pinned) {
    const locked = lock.packages?.[`node_modules/${name}`]?.version;
    const declared = lock.packages?.['']?.dependencies?.[name];
    const agree = locked === want && declared === want;
    if (!agree) bad += 1;
    console.log(`  ${agree ? 'ok  ' : 'DRIFT'} ${`lock ${name}`.padEnd(12)} lock ${String(locked || 'absent').padEnd(10)} pin ${want}`);
  }
}
if (!/^COPY config\/relay-lock\.json \.\/package-lock\.json$/m.test(dockerfile) || !/^RUN npm ci\b/m.test(dockerfile)) {
  console.error('  config/Dockerfile.chat-signal does not install with npm ci from config/relay-lock.json');
  bad += 1;
}

/* Overrides drift the same way pins do, and more quietly: a transitive package
   three levels under peer is nobody's idea of a dependency they own. The
   repository fixes it in package.json; the image can only see the copy the
   Dockerfile brings along. If the two stop agreeing, the repository is clean
   and the running relay is not. */
const repoOverrides = require(path.join(ROOT, 'package.json')).overrides || {};
let overridesFile = {};
try {
  overridesFile = require(path.join(ROOT, 'config', 'relay-overrides.json')).overrides || {};
} catch (error) {
  if (Object.keys(repoOverrides).length) {
    console.error('  package.json has overrides but config/relay-overrides.json is missing.');
    bad += 1;
  }
}
for (const [name, want] of Object.entries(repoOverrides)) {
  const agree = overridesFile[name] === want;
  if (!agree) bad += 1;
  console.log(`  ${agree ? 'ok  ' : 'DRIFT'} ${`override ${name}`.padEnd(12)} image ${String(overridesFile[name] || 'absent').padEnd(10)} repo ${want}`);
}
if (!dockerfile.includes('relay-overrides.json') && Object.keys(repoOverrides).length) {
  console.error('  config/relay-overrides.json is never COPYed, so npm never reads it.');
  bad += 1;
}

/* The OTHER relay. config/Dockerfile.chat-signal installs exact versions from
   a lock, so the server the project runs is reproducible. standalone-relay —
   the copy handed to somebody self-hosting — had caret ranges, no lockfile, and
   a plain `npm install --production`, so its build resolved to whatever was
   newest that day. It had already drifted: ws ^8.20.0 against the 8.21.3 the
   production relay pins. Two relays running the same server.js should not be
   running different libraries underneath it. */
const standalonePath = path.join(ROOT, 'standalone-relay', 'package.json');
if (fs.existsSync(standalonePath)) {
  console.log('');
  const standalone = require(standalonePath).dependencies || {};
  for (const [name, want] of pinned) {
    const declared = standalone[name];
    if (declared === undefined) continue;
    const agree = declared === want;
    if (!agree) bad += 1;
    console.log(`  ${agree ? 'ok  ' : 'DRIFT'} standalone ${name.padEnd(10)} declares ${String(declared).padEnd(10)} image pins ${want}`);
  }
  for (const [name, declared] of Object.entries(standalone)) {
    if (/^[\^~]|\*|\s-\s|x/i.test(String(declared))) {
      console.error(`  RANGE standalone ${name} is "${declared}" — a range, so its image is not reproducible.`);
      bad += 1;
    }
  }
}

if (bad) {
  console.error(`\n  ${bad} relay dependency pin(s) disagree (config/relay-overrides.json, config/relay-lock.json, node_modules, standalone-relay).`);
  console.error('  The server runs what config/relay-overrides.json and its lock say, so fix those before deploying.');
  process.exit(1);
}
console.log(`  ${pinned.size + Object.keys(repoOverrides).length} relay dependency pin(s) agree with the repository`);
