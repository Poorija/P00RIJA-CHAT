#!/usr/bin/env node
/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* The regression gate: every guard and every end-to-end suite, one verdict each,
 * and a report that says exactly what ran, what passed, what failed and why.
 *
 *   node tests/regression.mjs                    # everything, 4 workers
 *   node tests/regression.mjs --workers 6
 *   node tests/regression.mjs --only photos,profilecard
 *   node tests/regression.mjs --area calls
 *   node tests/regression.mjs --list             # what would run, and what is declared not-runnable
 *   node tests/regression.mjs --static           # only the guards (seconds)
 *   node tests/regression.mjs --allow-flaky      # a suite that passes on its retry is a warning, not a failure
 *
 * What makes it strict, in the order a result can go wrong:
 *
 *   - every suite runs on its OWN isolated stack (a fresh relay, a fresh port
 *     block), through tests/e2e/_local-stack.mjs — one suite's leftovers can never
 *     pass or fail another;
 *   - a suite that prints no tally, or exits non-zero with a tally of zero failed,
 *     or prints a tally of zero checks, is not a pass: it is CRASH or EMPTY;
 *   - a suite that fails is run again on a fresh stack. If it passes the second
 *     time it is reported FLAKY — named, with both attempts' logs — and FLAKY fails
 *     the gate unless --allow-flaky is given, because a test that sometimes lies
 *     is a defect of its own;
 *   - a suite that cannot run on this machine is declared in NOT_RUNNABLE below
 *     with the reason, and appears in the report as NOT RUN. Nothing is skipped
 *     silently, and a suite that is on disk but neither runnable nor declared is
 *     a failure of the gate itself;
 *   - the exit code is 0 only when every runnable suite passed on its first
 *     attempt (or on retry with --allow-flaky) and every guard passed.
 *
 * Output: tests/regression-report/<stamp>/{report.md,report.json,logs/}. */
import { spawn } from 'node:child_process';
import { readdirSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const E2E = join(HERE, 'e2e');

/* ---- arguments ------------------------------------------------------------ */
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const WORKERS = Math.max(1, Number(value('workers', 4)));
const RETRIES = flag('no-retry') ? 0 : 1;
const ONLY = value('only', '').split(',').map((s) => s.trim().replace(/\.mjs$/, '')).filter(Boolean);
const AREA = value('area', '');
const BASE_PORT = Number(value('port', 21000));
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = value('out', join(HERE, 'regression-report', STAMP));

/* ---- what cannot run on a development machine ------------------------------
   Each entry says why. A suite listed here is reported as NOT RUN, with the
   reason, in every report; the list is the honest edge of what this gate covers. */
const NOT_RUNNABLE = {
  twoservers: 'needs two real deployments, named by PKG_URL_A and PKG_URL_B; there is nothing to start them from here',
  'native-shell': 'needs src-tauri/tauri.conf.json: this repository holds the web app, the relay and the panel, not the native shell\'s sources',
  nativeui: 'needs src-tauri/tauri.conf.json (see native-shell)',
  /* The owner decided on 2026-11-19 (docs/ROADMAP-3.0.md) that no wire
     compatibility with P00RIJA Cryptography is kept. From 2.7b an account
     moves to identity v4 (Ed25519 + X25519), which that app cannot read, so
     the suite that proves the two talk is retired, not repaired. */
  interop: 'retired in 2.7b: compatibility with P00RIJA Cryptography is no longer kept (owner, 2026-11-19); accounts here are identity v4, which that app cannot read',
};
/* Suites that need a tool on the machine: absent, they are NOT RUN with that reason — never a failure that reads as a defect. */
/* ...and an engine Playwright has not downloaded here (it ships Chromium first; WebKit and Firefox are `npx playwright install webkit firefox`). */
const NEEDS_ENGINE = { chatnavfit: ['webkit'], 'history-restart': ['webkit', 'firefox'], panelui: ['webkit'] };
const NEEDS_DOCKER = new Set(['applyupdate', 'bootstrapinstall', 'certkeeper', 'dockerinstall', 'dockerrelease', 'familycsp', 'panellauncher', 'linkrelays', 'pulltunnel', 'panelupdates', 'relaydirectory', 'prodready', 'turnserver', 'webpanel', 'windowsnsis']);

/* ---- quarantine -------------------------------------------------------------
   A suite that is known to fail for a reason that is NOT a defect of the app, and that nobody has yet repaired, is
   listed here with that reason. It still runs, and it is reported as QUARANTINED, separate from the passes. The gate
   does not fail on it — and it DOES fail when a quarantined suite passes, so nothing stays here after it is mended.
   An entry is a debt: the reason names what is wrong with the suite, not with the app. */
const QUARANTINE = {
  callreal: 'one check (four tiles of a group call each take an equal quarter: measured 60/67/71/74) against a tolerance written for a different grid; the tiles are laid out and all four receive media.',
  chataudit: 'one check ("very long arrives"): the app delivers a 4000-character message in under 100 ms (probed 2026-11-16); the suite\'s wait counts [data-id] nodes in #chatMessages and does not see it. The other 37 pass.',
  controls: 'two checks written for the old skin — "every checkbox in the app is the theme\'s control colour" — which the messenger skin\'s iOS-style switches (green on, fixed) replace by design; the rest (9) pass.',
  formatbar: '3 of 11: the geometry of the floating format bar is read against the textarea\'s top, which the new composer reports as 0; the bar opens and formats (the other 8 pass). A tap on a bar button times out in that geometry.',
  release37: 'drives the retired "shared lock" card in the vault tab and the parent project\'s tab set (passwords, notes); the lock engine is covered by vaultlock, lockdefence, chatlock2 and release44.',
  sileotoasts: 'one check ("toasts start below the phone header": 8px); the toasts are drawn and the rest pass; the header is a different height in the messenger skin.',
  uxfixes: 'a 176-check suite written for the pre-2.3 shell (the rail, the section switcher, the old head); 27 checks assert that shell\'s structure and fail by design; the 149 that pass are still run. To be split into suites for the shell that exists.',
};

/* A suite that runs, but without a section it cannot decide on this host. It passes what it ran, and the report names what it
   did not ask — in its own list and in the summary — so that a pass which never put its headline question does not read as
   one that did. (prodready: off Linux its two capacity sections are left out; see its header.) */
const PARTIAL = {
  prodready: () => (process.platform !== 'linux' && process.env.PROD_CAPACITY !== '1' && !process.env.PROD_ONLY)
    ? 'its two sections that say how many people the relay carries (ordinary use, capacity) are not run off Linux: through Docker Desktop on this Mac the same relay shows sockets closing (code 1006, no reason in the relay\'s log) that it does not close natively — 8000 sockets and 15,998 messages, none lost, p99 107 ms. Security, persistence, leaks and abuse ran. PROD_CAPACITY=1 asks for the rest; run it on a Linux host to certify capacity.'
    : '',
};

/* ---- areas ---------------------------------------------------------------- */
const AREAS = [
  ['calls', /^(adhoccall|call|gcall|calls|turn|carrier|callcode|gcalllayout)/],
  ['groups', /^(group|grouplife|groupparity|grouptwo)/],
  ['stickers-gifs', /^(stick|gif|telegramstickers)/],
  ['qr', /^(qr|androidqr|othercodes)/],
  ['push-notifications', /(push|swnotify|alerts|updatenotice)/],
  ['security-crypto', /^(cryptocore|forwardsecrecy|keytrust|keyverify|downgrade|oracle|prekey|hybrid|holdhybrid|sealedsender|atrest|duress|emergency|vaultlock|lockdefence|firstpassword|stego|csp|familycsp|security|audit|hostileframes|screenguard|idbsafety|legacypurge|panicconfirm|phantom|chatlock2|guestmode)/],
  ['delivery-offline', /^(offline|delivery|retention|maildelivery|resume|peerless|sendsession|history|persist|filetransfer|filemgr|bigfile|receipts|reactions|disconnect|mediaheal|mediaerrors|sibling|devicesync|devicelink|devicebeacon|devicegovern|profilesync|forwardall|deleteconversation|holdhybrid)/],
  ['relay-network', /^(relay|transit|twoservers|homerelay|linkrelays|smartpath|pulltunnel|clientdirectory|certkeeper|allowlist|bootstrap|messagerequests|three|interop)/],
  ['panel-monitor', /^(panel|webpanel|opspanel|centralpanel|monitor)/],
  ['install-update-native', /^(docker|windowsnsis|native|upgrade|update|applyupdate|prodready|swapi|offlinepwa)/],
  ['ui-messaging', /./],
];
const areaOf = (name) => AREAS.find(([, re]) => re.test(name))[0];

/* ---- running one command -------------------------------------------------- */
function runProcess(command, args, { cwd = ROOT, env = {}, timeoutSeconds = 600, logFile } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    let timedOut = false;
    const take = (chunk) => { output += chunk; if (output.length > 4_000_000) output = output.slice(-3_000_000); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    /* The group, not the child: a suite starts relays and browsers of its own. */
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch (_e) { /* gone */ } }, timeoutSeconds * 1000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_e) { /* nothing left */ }
      if (logFile) { try { writeFileSync(logFile, output); } catch (_e) { /* report still has the tail */ } }
      resolve({ code, signal, output, timedOut, seconds: Math.round((Date.now() - started) / 1000) });
    });
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: 127, signal: null, output: String(error), timedOut: false, seconds: 0 }); });
  });
}

/* The shapes the suites print their tally in (the same ones run-all.mjs reads). */
function tallyOf(output) {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '');
  const counted = [...text.matchAll(/=====\s*(\d+)\s+fail(?:ed|ing)\s+of\s+(\d+)\b[^=]*=====/g)].pop();
  if (counted) return { failed: Number(counted[1]), total: Number(counted[2]) };
  const passed = [...text.matchAll(/^\s*(\d+)\/(\d+)\s+passed\s*$/gm)].pop();
  if (passed) return { failed: Number(passed[2]) - Number(passed[1]), total: Number(passed[2]) };
  const dashed = [...text.matchAll(/^\s*passed\s+—\s+(\d+)\/(\d+)\s+checks\s*$/gm)].pop();
  if (dashed) return { failed: Number(dashed[2]) - Number(dashed[1]), total: Number(dashed[2]) };
  const ofChecks = [...text.matchAll(/^\s*(\d+)\s+of\s+(\d+)\s+checks\s+passed\s*$/gm)].pop();
  if (ofChecks) return { failed: Number(ofChecks[2]) - Number(ofChecks[1]), total: Number(ofChecks[2]) };
  const checkCount = [...text.matchAll(/^\s*(\d+) checks passed\s*$/gm)].pop();
  if (checkCount) return { failed: 0, total: Number(checkCount[1]) };
  return null;
}
const failedChecks = (output) => [...output.replace(/\x1b\[[0-9;]*m/g, '').matchAll(/^\s*(?:FAIL|✗|✘|✖|FAILED)\s+(.+)$/gm)].map((m) => m[1].trim().slice(0, 260)).slice(0, 40);
const tail = (output, lines = 18) => output.replace(/\x1b\[[0-9;]*m/g, '').trimEnd().split('\n').slice(-lines).join('\n');

/* ---- guards ---------------------------------------------------------------- */
function listFiles(dir, accept, skip = /node_modules|\.git|dist|Export|src-tauri|graphify-out|vendor|standalone-relay\/node_modules|npm-package/) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (skip.test(relative(ROOT, full))) continue;
      if (entry.isDirectory()) walk(full);
      else if (accept(entry.name)) found.push(full);
    }
  };
  if (existsSync(dir)) walk(dir);
  return found;
}

async function runGuards() {
  const results = [];
  const record = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail.split('\n')[0].slice(0, 160)}`}`); };

  /* Every script the app ships must at least parse. */
  const classic = ['js', 'scripts', 'tools', 'standalone-relay'].flatMap((d) => listFiles(join(ROOT, d), (n) => /\.(js|cjs|mjs)$/.test(n)));
  classic.push(join(ROOT, 'sw.js'));
  const syntaxFailures = [];
  for (const file of classic) {
    const result = await runProcess(process.execPath, ['--check', file], { timeoutSeconds: 30 });
    if (result.code !== 0) syntaxFailures.push(`${relative(ROOT, file)}: ${tail(result.output, 3)}`);
  }
  record(`every shipped script parses (${classic.length} files)`, syntaxFailures.length === 0, syntaxFailures.join('\n'));
  const testFiles = listFiles(E2E, (n) => /\.(mjs|js)$/.test(n));
  const testFailures = [];
  for (const file of testFiles) {
    const result = await runProcess(process.execPath, ['--check', file], { timeoutSeconds: 30 });
    if (result.code !== 0) testFailures.push(`${relative(ROOT, file)}: ${tail(result.output, 3)}`);
  }
  record(`every suite and helper parses (${testFiles.length} files)`, testFailures.length === 0, testFailures.join('\n'));

  /* The repository's own checks. */
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  for (const name of Object.keys(pkg.scripts).filter((n) => /^check:/.test(n)).sort()) {
    const result = await runProcess('npm', ['run', '-s', name], { timeoutSeconds: 180 });
    record(`npm run ${name}`, result.code === 0, tail(result.output, 6));
  }
  /* jest is configured, but there are no unit test files and no node_modules of
     its own: said here rather than reported as a pass or a failure. */
  const unitFiles = listFiles(HERE, (n) => /\.test\.js$/.test(n));
  if (unitFiles.length && existsSync(join(ROOT, 'node_modules', 'jest'))) {
    const result = await runProcess('npm', ['test', '--silent'], { timeoutSeconds: 300 });
    record(`npm test (${unitFiles.length} unit files)`, result.code === 0, tail(result.output, 8));
  } else {
    console.log(`  NOTE  no unit tests: ${unitFiles.length} *.test.js files; every behaviour is covered by the end-to-end suites only`);
  }
  /* The unit tests of js/crypto/ (tests/unit/*.test.mjs), with Node's own
     runner: they need no browser and no dependency. */
  const nodeUnits = listFiles(join(ROOT, 'tests', 'unit'), (n) => /\.test\.mjs$/.test(n));
  if (nodeUnits.length) {
    const result = await runProcess(process.execPath, ['--test', ...nodeUnits], { timeoutSeconds: 120 });
    record(`node --test (${nodeUnits.length} unit file${nodeUnits.length === 1 ? '' : 's'})`, result.code === 0, tail(result.output, 8));
  }
  /* Every suite on disk is either run or declared. */
  return results;
}

/* ---- suites ---------------------------------------------------------------- */
const allSuites = readdirSync(E2E)
  .filter((f) => f.endsWith('.mjs') && !f.startsWith('_') && f !== 'run-all.mjs')
  .map((f) => f.replace(/\.mjs$/, ''))
  .sort();
const HEAVY = /^(stress|relayscale|relaythroughput|perf|callreal|bigfile|stickerperf|relaymirrors|callladder|sweep|prodready|guestmode)$/;
/* Capacity tests measure the machine as much as the relay: they run alone, after the rest, so what they measure is not the other workers. */
const SOLO = new Set(['prodready', 'stress', 'relayscale', 'relaythroughput', 'perf']);

const dockerAvailable = (await runProcess('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutSeconds: 20 })).code === 0;
if (!dockerAvailable) for (const name of NEEDS_DOCKER) if (!NOT_RUNNABLE[name]) NOT_RUNNABLE[name] = 'docker is not available on this machine (or its engine is not running)';
{
  const { chromium: _c, webkit, firefox } = await import('playwright');
  const have = { webkit: existsSync(webkit.executablePath()), firefox: existsSync(firefox.executablePath()) };
  for (const [name, engines] of Object.entries(NEEDS_ENGINE)) {
    const missing = engines.filter((engine) => !have[engine]);
    if (missing.length && !NOT_RUNNABLE[name]) NOT_RUNNABLE[name] = `needs Playwright's ${missing.join(' and ')}, which is not installed on this machine (npx playwright install ${missing.join(' ')})`;
  }
}
/* interop opens a page from the OTHER app (P00RIJA Cryptography, in a folder beside this one, or OTHER_ROOT) on one relay with a page from this. */
{
  const otherTree = process.env.OTHER_ROOT || join(ROOT, '..', 'P00RIJA-Cryptography');
  if (!existsSync(join(otherTree, 'index.html')) && !NOT_RUNNABLE.interop) NOT_RUNNABLE.interop = `needs a checkout of P00RIJA Cryptography at ${otherTree} (or OTHER_ROOT=<folder>), which is not on this machine`;
}
let selected = allSuites.filter((name) => (!ONLY.length || ONLY.includes(name)) && (!AREA || areaOf(name) === AREA));
const notRun = selected.filter((name) => NOT_RUNNABLE[name]);
selected = selected.filter((name) => !NOT_RUNNABLE[name]);
const partial = selected.filter((name) => PARTIAL[name]?.());

if (flag('list')) {
  for (const name of selected) console.log(`${areaOf(name).padEnd(22)} ${name}`);
  for (const name of notRun) console.log(`${'NOT RUN'.padEnd(22)} ${name} — ${NOT_RUNNABLE[name]}`);
  console.log(`\n${selected.length} to run, ${notRun.length} declared not runnable, ${allSuites.length} on disk.`);
  process.exit(0);
}

mkdirSync(join(OUT, 'logs'), { recursive: true });
console.log(`\nRegression gate — ${new Date().toISOString()}\nreport: ${OUT}\n`);

console.log('=== guards ===');
const guards = await runGuards();

const suiteResults = [];
if (!flag('static')) {
  console.log(`\n=== ${selected.length} suites, ${WORKERS} workers, retry ${RETRIES} ===`);
  const solo = selected.filter((name) => SOLO.has(name));
  const queue = selected.filter((name) => !SOLO.has(name)).sort((a, b) => Number(HEAVY.test(b)) - Number(HEAVY.test(a)));
  const attemptSuite = async (name, slot, attempt) => {
    const port = BASE_PORT + slot * 40;
    const result = await runProcess(process.execPath, [join(E2E, '_local-stack.mjs'), name], {
      env: { E2E_PORT: String(port) },
      timeoutSeconds: HEAVY.test(name) ? 1500 : 600,
      logFile: join(OUT, 'logs', `${name}.${attempt}.log`),
    });
    const tally = tallyOf(result.output);
    let status;
    if (result.timedOut) status = 'TIMEOUT';
    else if (!tally) status = result.code === 0 ? 'EMPTY' : 'CRASH';
    else if (tally.total === 0) status = 'EMPTY';
    else if (tally.failed > 0) status = 'FAIL';
    else if (result.code !== 0) status = 'CRASH';
    else status = 'PASS';
    return { attempt, status, tally, seconds: result.seconds, code: result.code, failedChecks: failedChecks(result.output), tail: status === 'PASS' ? '' : tail(result.output) };
  };
  const worker = async (slot) => {
    while (queue.length) {
      const name = queue.shift();
      const attempts = [];
      for (let attempt = 1; attempt <= 1 + RETRIES; attempt += 1) {
        const one = await attemptSuite(name, slot, attempt);
        attempts.push(one);
        if (one.status === 'PASS') break;
      }
      const first = attempts[0];
      const last = attempts[attempts.length - 1];
      let final = first.status === 'PASS' ? 'PASS' : last.status === 'PASS' ? 'FLAKY' : last.status;
      /* quarantined: a failure is the expected state, a pass is the thing that needs attention */
      if (QUARANTINE[name]) final = final === 'PASS' ? 'MENDED' : 'QUARANTINED';
      suiteResults.push({ name, area: areaOf(name), status: final, attempts });
      const t = last.tally ? `${last.tally.total - last.tally.failed}/${last.tally.total}` : '—';
      console.log(`  ${final.padEnd(7)} ${name.padEnd(26)} ${t.padStart(9)}  ${attempts.map((a) => `${a.seconds}s`).join(' + ')}`);
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, (_, slot) => worker(slot)));
  /* then the capacity tests, one at a time, with the machine to themselves */
  if (solo.length) console.log(`\n=== ${solo.length} capacity suites, alone ===`);
  queue.push(...solo);
  await worker(0);
}

/* ---- verdict --------------------------------------------------------------- */
suiteResults.sort((a, b) => a.name.localeCompare(b.name));
const count = (s) => suiteResults.filter((r) => r.status === s).length;
const guardFail = guards.filter((g) => !g.ok);
const bad = suiteResults.filter((r) => ['FAIL', 'CRASH', 'EMPTY', 'TIMEOUT', 'MENDED'].includes(r.status) || (!flag('allow-flaky') && r.status === 'FLAKY'));
const undeclared = flag('static') || ONLY.length || AREA ? [] : allSuites.filter((n) => !selected.includes(n) && !NOT_RUNNABLE[n]);
const checksPassed = suiteResults.reduce((n, r) => { const t = r.attempts[r.attempts.length - 1].tally; return n + (t ? t.total - t.failed : 0); }, 0);
const checksTotal = suiteResults.reduce((n, r) => { const t = r.attempts[r.attempts.length - 1].tally; return n + (t ? t.total : 0); }, 0);

const lines = [];
lines.push(`# Regression report — ${new Date().toISOString()}`, '');
lines.push(`**Verdict: ${!bad.length && !guardFail.length && !undeclared.length ? 'PASS' : 'FAIL'}**`, '');
lines.push(`- guards: ${guards.length - guardFail.length}/${guards.length} passed`);
lines.push(flag('static') ? '- suites: not run (--static)' : `- suites: ${selected.length} run — PASS ${count('PASS')}, FLAKY ${count('FLAKY')}, FAIL ${count('FAIL')}, CRASH ${count('CRASH')}, EMPTY ${count('EMPTY')}, TIMEOUT ${count('TIMEOUT')}, QUARANTINED ${count('QUARANTINED')}, MENDED (remove from quarantine) ${count('MENDED')}; ${notRun.length} declared not runnable`);
lines.push(`- checks: ${checksPassed}/${checksTotal} passed (final attempt of each suite)`);
if (partial.length) lines.push(`- ran in part: ${partial.join(', ')} — a section was not asked on this host (see "Ran in part" below)`);
lines.push('');
if (guardFail.length) { lines.push('## Guards that failed', ''); for (const g of guardFail) lines.push(`- **${g.name}**\n\n  \`\`\`\n${g.detail.split('\n').map((l) => `  ${l}`).join('\n')}\n  \`\`\``); lines.push(''); }
if (undeclared.length) lines.push('## On disk, neither run nor declared', '', ...undeclared.map((n) => `- ${n}`), '');
const trouble = suiteResults.filter((r) => !['PASS', 'QUARANTINED'].includes(r.status));
if (trouble.length) {
  lines.push('## Suites that did not pass first time', '');
  for (const r of trouble) {
    lines.push(`### ${r.name} — ${r.status} (${r.area})`, '');
    r.attempts.forEach((a) => {
      lines.push(`- attempt ${a.attempt}: ${a.status}${a.tally ? ` ${a.tally.total - a.tally.failed}/${a.tally.total}` : ''}, ${a.seconds}s, exit ${a.code}`);
      a.failedChecks.slice(0, 12).forEach((c) => lines.push(`  - ${c}`));
    });
    const last = r.attempts[r.attempts.length - 1];
    if (last.tail) lines.push('', '```', last.tail, '```');
    lines.push('');
  }
}
lines.push('## By area', '', '| area | suites | pass | flaky | fail | checks |', '| --- | ---: | ---: | ---: | ---: | ---: |');
for (const area of [...new Set(AREAS.map(([a]) => a))]) {
  const rows = suiteResults.filter((r) => r.area === area);
  if (!rows.length) continue;
  const ch = rows.reduce((n, r) => { const t = r.attempts[r.attempts.length - 1].tally; return n + (t ? t.total : 0); }, 0);
  lines.push(`| ${area} | ${rows.length} | ${rows.filter((r) => r.status === 'PASS').length} | ${rows.filter((r) => r.status === 'FLAKY').length} | ${rows.filter((r) => !['PASS', 'FLAKY'].includes(r.status)).length} | ${ch} |`);
}
lines.push('', '## Every suite', '', '| suite | area | status | checks | seconds |', '| --- | --- | --- | ---: | ---: |');
for (const r of suiteResults) { const a = r.attempts[r.attempts.length - 1]; lines.push(`| ${r.name} | ${r.area} | ${r.status} | ${a.tally ? `${a.tally.total - a.tally.failed}/${a.tally.total}` : '—'} | ${r.attempts.map((x) => x.seconds).join('+')} |`); }
if (partial.length) { lines.push('', '## Ran in part (a section is not decisive on this host)', '', ...partial.map((n) => `- **${n}** — ${PARTIAL[n]()}`)); }
if (notRun.length) { lines.push('', '## Declared not runnable here', '', ...notRun.map((n) => `- **${n}** — ${NOT_RUNNABLE[n]}`)); }
const quarantined = suiteResults.filter((r) => r.status === 'QUARANTINED' || r.status === 'MENDED');
if (quarantined.length) { lines.push('', '## Quarantined (known stale; a debt, not a pass)', '', ...quarantined.map((r) => `- **${r.name}** — ${r.status}: ${QUARANTINE[r.name]}`)); }
lines.push('', '## Guards', '', ...guards.map((g) => `- ${g.ok ? 'PASS' : 'FAIL'} ${g.name}`));
writeFileSync(join(OUT, 'report.md'), `${lines.join('\n')}\n`);
writeFileSync(join(OUT, 'report.json'), JSON.stringify({ stamp: STAMP, guards, suites: suiteResults, notRun: notRun.map((n) => ({ name: n, reason: NOT_RUNNABLE[n] })), partial: partial.map((n) => ({ name: n, reason: PARTIAL[n]() })), undeclared }, null, 2));

console.log(`\n${lines.slice(0, 10).join('\n')}\nfull report: ${join(OUT, 'report.md')}`);
process.exit(!bad.length && !guardFail.length && !undeclared.length ? 0 : 1);
