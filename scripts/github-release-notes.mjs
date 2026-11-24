#!/usr/bin/env node
/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* The notes of a GitHub release, in full: what to download for which machine,
 * how to check it, how to install it, what the release changed — and everything
 * every earlier release changed, from the first.
 *
 *   node scripts/github-release-notes.mjs [Export/GitHub]
 *
 * Written to <dir>/RELEASE-NOTES.md, next to the files it describes. The hashes
 * in the table are read from SHA256SUMS.txt there (scripts/github-release-files.sh),
 * so a file that is not in the release is not in the table. Nothing in it names
 * a server, a key or an account.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.resolve(process.argv[2] || path.join(ROOT, 'Export', 'GitHub'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const sums = new Map();
const sumsFile = path.join(DIR, 'SHA256SUMS.txt');
if (fs.existsSync(sumsFile)) {
  for (const line of fs.readFileSync(sumsFile, 'utf8').split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m) sums.set(m[2], m[1]);
  }
}
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((n) => n !== 'RELEASE-NOTES.md' && n !== 'SHA256SUMS.txt') : [];
const find = (re) => files.find((n) => re.test(n));
const rows = [
  ['macOS', 'Apple silicon (M1 and later)', find(/_aarch64\.dmg$/), 'Open the .dmg, drag the app to Applications. First launch: right-click → Open.'],
  ['macOS', 'Intel', find(/_x64\.dmg$/), 'As above.'],
  ['macOS', '**Universal** (Intel + Apple silicon)', find(/_universal\.dmg$/), 'One file for both. The app’s updater keeps a universal install on the universal file.'],
  ['Windows', 'x64 (Intel / AMD)', find(/_x64-setup\.exe$/), 'Run the installer. SmartScreen: More info → Run anyway.'],
  ['Windows', 'ARM64', find(/_arm64-setup\.exe$/), 'As above.'],
  ['Linux', 'Debian / Ubuntu, x86-64', find(/_amd64\.deb$/), '`sudo apt install ./FILE.deb`'],
  ['Linux', 'Debian / Ubuntu, ARM64', find(/_arm64\.deb$/), '`sudo apt install ./FILE.deb`'],
  ['Linux', 'Fedora / RHEL / openSUSE, x86-64', find(/\.x86_64\.rpm$/), '`sudo dnf install ./FILE.rpm`'],
  ['Linux', 'Fedora / RHEL / openSUSE, ARM64', find(/\.aarch64\.rpm$/), '`sudo dnf install ./FILE.rpm`'],
  ['Linux', 'AppImage, x86-64 (any distribution)', find(/_amd64\.AppImage$/), '`chmod +x FILE.AppImage && ./FILE.AppImage`'],
  ['Linux', 'AppImage, ARM64', find(/_aarch64\.AppImage$/), 'As above.'],
  ['Linux', 'Arch / Manjaro, x86-64', find(/-x86_64\.pkg\.tar\.zst$/), '`sudo pacman -U FILE`'],
  ['Linux', 'Arch, ARM64', find(/-aarch64\.pkg\.tar\.zst$/), '`sudo pacman -U FILE`'],
  ['Linux', 'Portable archive, x86-64', find(/-linux-x86_64\.tar\.gz$/), 'Unpack anywhere and run; nothing is installed.'],
  ['Linux', 'Portable archive, ARM64', find(/-linux-aarch64\.tar\.gz$/), 'As above.'],
  ['Android', 'Universal APK (every phone)', find(/-universal\.apk$/), 'Allow installs from this source, open the file.'],
  ['Android', 'arm64 APK (every current phone, smaller)', find(/-arm64\.apk$/), 'As above.'],
  ['Android', 'App bundle (.aab)', find(/\.aab$/), 'For stores and bundletool; not for installing directly.'],
  ['iOS', 'Xcode project, to sign with your own Apple identity', find(/-iOS-project\.zip$/), 'Not a ready app: README-SIGNING.txt inside says how to build and sign it.'],
  ['Source', 'The exact tree these were built from', find(/-source\.tar\.gz$/), 'Read it, rebuild it, compare.'],
].filter((row) => row[2]);

const table = rows
  .map(([os, kind, name, how]) => `| ${os} | ${kind} | \`${name}\` | \`${(sums.get(name) || '').slice(0, 16) || '—'}…\` | ${how} |`)
  .join('\n');

let history = '';
const log = path.join(ROOT, 'RELEASE-NOTES.md');
if (fs.existsSync(log)) {
  /* Every release, newest first, as the project's own log has them; each
     release heading is lowered one level so the history sits under one title. */
  history = fs.readFileSync(log, 'utf8')
    .replace(/^# (P00RIJA Chat [^\n]*)$/gm, '## $1')
    .replace(/^## (?!P00RIJA Chat)/gm, '### ');
}

const text = `# P00RIJA Chat ${version}

End-to-end encrypted chat, voice and video calls and groups, through a server you run
yourself. This release carries the native apps — macOS, Windows, Linux, Android — and
the project to sign for iOS. The web app needs none of them: it installs from your
server's address ([README](https://github.com/Poorija/P00RIJA-CHAT#readme)).

## Which file

| OS | Machine | File | SHA-256 (start) | Install |
|---|---|---|---|---|
${table}

The native apps tell which of these is theirs when they look for an update: a
**universal** Mac install is offered the universal file, an Apple silicon one its own;
Windows and Linux get the same installer type and architecture they were installed from.

## Checking a download

\`SHA256SUMS.txt\` lists the SHA-256 of every file in this release. Compare before you open one:

\`\`\`bash
# macOS / Linux, in the folder you downloaded into
shasum -a 256 -c SHA256SUMS.txt --ignore-missing      # or: sha256sum -c SHA256SUMS.txt --ignore-missing
\`\`\`

\`\`\`powershell
# Windows
Get-FileHash .\\FILE -Algorithm SHA256      # compare with the line for FILE in SHA256SUMS.txt
\`\`\`

GitHub renames a space to a dot when a file is uploaded, and the list uses the names as
they are on this page. The installers are **not signed** with a publisher certificate
(macOS, Windows) or a store key: that is why the first launch asks you to confirm, and
why the checksums and the source archive are here.

## Updating

**Settings → About me** has *Check for updates* and a switch for checking when the app
opens (on by default for the native apps, never in the browser). It asks GitHub for the
latest version number and sends nothing about you; if a newer release exists it
downloads the right file for this machine, checks it against \`SHA256SUMS.txt\` and offers
to open the installer. It never installs by itself.

## Security

The protocol is written down in \`docs/PROTOCOL.md\` and \`docs/SPEC.md\`.
**It has not had an independent security audit.** Report a weakness by e-mail
(\`SECURITY.md\`), not in a public issue.

## License

AGPL-3.0-only. Run a modified version as a network service and its users are entitled to
your source (section 13).

---

# Everything that changed, from the first release to ${version}

${history}
`;
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(path.join(DIR, 'RELEASE-NOTES.md'), text);
console.log(`wrote ${path.relative(ROOT, path.join(DIR, 'RELEASE-NOTES.md'))}: ${rows.length} files, ${history.split('\n').length} lines of history`);
