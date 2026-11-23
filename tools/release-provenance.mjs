#!/usr/bin/env node
/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* What a release is, written down so anyone can check it (roadmap 5.2).
 *
 *   node tools/release-provenance.mjs write  [ref] [--images]   release/provenance/<version>.json (+ .sig when the key is here)
 *   node tools/release-provenance.mjs verify <version>
 *
 * The file names the commit and tree the release was cut from, its version and
 * build tag, and the SHA-256 of every file in that tree; with --images, also
 * the digest of each server image (linux/amd64) as tools/verify-build.sh
 * builds it twice and finds it the same — what a rebuild must give. It is computed from
 * git objects, not the working directory, so the same ref gives the same file
 * on any machine. Signed with the release key (ssh-keygen -Y, namespace
 * "p00rija-release"), whose public half is .github/allowed_signers.
 *
 * verify recomputes the file from the tag's tree, compares it byte for byte
 * with the one published, checks the signature, and checks the tag's own
 * signature (git tag -v). Anything off and it says what, and exits 1. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'release', 'provenance');
const SIGNERS = path.join(ROOT, '.github', 'allowed_signers');
const KEY = path.join(os.homedir(), '.ssh', 'p00rija_release_signing');
const NAMESPACE = 'p00rija-release';
const git = (...args) => execFileSync('git', args, { cwd: ROOT, maxBuffer: 1 << 30 });

function manifest(ref) {
  const commit = git('rev-parse', `${ref}^{commit}`).toString().trim();
  const tree = git('rev-parse', `${ref}^{tree}`).toString().trim();
  const pkg = JSON.parse(git('show', `${commit}:package.json`).toString());
  const files = {};
  const list = git('ls-tree', '-r', '-z', '--full-tree', commit).toString().split('\0').filter(Boolean);
  for (const line of list) {
    const [meta, file] = line.split('\t');
    const [, type, object] = meta.split(' ');
    if (type !== 'blob') continue;
    files[file] = createHash('sha256').update(git('cat-file', 'blob', object)).digest('hex');
  }
  const sorted = Object.fromEntries(Object.keys(files).sort().map((key) => [key, files[key]]));
  return {
    format: 'p00rija-release-provenance/1',
    product: 'P00RIJA Chat',
    version: pkg.version,
    buildTag: pkg.buildTag,
    commit,
    tree,
    committedAt: git('show', '-s', '--format=%cI', commit).toString().trim(),
    fileCount: Object.keys(sorted).length,
    files: sorted,
  };
}
const serialise = (value) => `${JSON.stringify(value, null, 2)}\n`;

function sign(file) {
  if (!fs.existsSync(KEY)) { console.log(`  not signed: no release key at ${KEY}`); return false; }
  execFileSync('ssh-keygen', ['-Y', 'sign', '-q', '-f', KEY, '-n', NAMESPACE, file]);
  return true;
}
function verifySignature(file) {
  try {
    execFileSync('ssh-keygen', ['-Y', 'verify', '-f', SIGNERS, '-I', 'p00rija@tutamail.com', '-n', NAMESPACE, '-s', `${file}.sig`], { input: fs.readFileSync(file), stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch (_error) {
    return false;
  }
}

const argv = process.argv.slice(2);
const withImages = argv.includes('--images');
const [mode = 'write', arg] = argv.filter((value) => value !== '--images');
function imageDigests(ref) {
  const out = execFileSync('bash', [path.join(ROOT, 'tools', 'verify-build.sh'), ref], { cwd: ROOT, maxBuffer: 1 << 24 }).toString();
  const images = {};
  for (const match of out.matchAll(/^\s+ok\s+(\S+)\s+image\s+(sha256:[0-9a-f]{64})$/gm)) images[match[1]] = match[2];
  if (!Object.keys(images).length) throw new Error(`verify-build gave no digests:\n${out}`);
  return { platform: 'linux/amd64', reproducible: true, ...images };
}
if (mode === 'write') {
  const data = manifest(arg || 'HEAD');
  if (withImages) data.images = imageDigests(arg || 'HEAD');
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${data.version}.json`);
  fs.writeFileSync(file, serialise(data));
  console.log(`wrote ${path.relative(ROOT, file)}: ${data.version} (${data.buildTag}), ${data.commit.slice(0, 7)}, ${data.fileCount} files`);
  if (sign(file)) console.log(`signed ${path.relative(ROOT, file)}.sig`);
} else if (mode === 'verify') {
  if (!arg) { console.error('usage: verify <version>'); process.exit(2); }
  const file = path.join(DIR, `${arg}.json`);
  const problems = [];
  if (!fs.existsSync(file)) problems.push(`no ${path.relative(ROOT, file)}`);
  else {
    const published = fs.readFileSync(file, 'utf8');
    const claimed = JSON.parse(published);
    let again = '';
    try {
      const recomputed = manifest(claimed.commit);
      /* Image digests are checked by rebuilding (tools/verify-build.sh), which
         takes minutes; here they are carried over and covered by the signature. */
      if (claimed.images) recomputed.images = claimed.images;
      again = serialise(recomputed);
    } catch (error) { problems.push(`commit ${claimed.commit} is not in this repository`); }
    if (again && again !== published) problems.push('the files at that commit do not match the published list');
    if (!fs.existsSync(`${file}.sig`)) problems.push('no signature');
    else if (!verifySignature(file)) problems.push('the signature does not verify with .github/allowed_signers');
    const tag = `v${claimed.version}`;
    try {
      const tagged = git('rev-parse', `${tag}^{commit}`).toString().trim();
      if (tagged !== claimed.commit) problems.push(`tag ${tag} points at ${tagged.slice(0, 7)}, not ${claimed.commit.slice(0, 7)}`);
      execFileSync('git', ['-c', 'gpg.format=ssh', '-c', `gpg.ssh.allowedSignersFile=${SIGNERS}`, 'tag', '-v', tag], { cwd: ROOT, stdio: 'pipe' });
    } catch (_error) {
      problems.push(`tag ${tag} is missing or its signature does not verify`);
    }
  }
  if (problems.length) { console.log(`✗ ${arg}:\n  ${problems.join('\n  ')}`); process.exit(1); }
  console.log(`✓ ${arg}: the tag, the file list and both signatures check out`);
} else {
  console.error('usage: release-provenance.mjs write [ref] | verify <version>');
  process.exit(2);
}
