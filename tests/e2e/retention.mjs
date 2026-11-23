/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* The retention rules, exercised directly against the relay's own store.
 *
 *   node tests/e2e/retention.mjs
 *
 * No browser: this is about what the server keeps and throws away, and the
 * fastest honest way to test "eight days old" is to write a mailbox with an
 * eight-day-old timestamp and start the relay on it.
 *
 * The rules under test:
 *   text   — kept until collected, however long that takes
 *   media  — dropped after seven days, or when the mailbox passes its quota
 *   log    — one note per dropped item, kept thirty days, then gone
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { createChecks } from './_check.mjs';
import { readMailboxes, readStoreFile } from './_relay-store.mjs';

const { results, check } = createChecks();

const DAY = 24 * 60 * 60 * 1000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poorija-retention-'));
const storePath = path.join(dir, 'offline-messages.json');
const logPath = path.join(dir, 'expiry-log.json');
const RECIPIENT = 'a'.repeat(64);

const envelope = (kind, ageDays, bytes = 64) => ({
  type: 'relay',
  relayId: `${kind}-${ageDays}-${Math.random().toString(36).slice(2, 8)}`,
  fromClientId: 'sender-client',
  fromFingerprint: 'b'.repeat(64),
  payload: {
    type: 'offline-chat',
    class: kind,
    seal: 'x'.repeat(512),
    message: { type: kind === 'media' ? 'file-start' : 'text', payload: { iv: [], cipher: 'y'.repeat(bytes) } },
  },
  queuedAt: new Date(Date.now() - ageDays * DAY).toISOString(),
});

fs.writeFileSync(storePath, JSON.stringify({
  [RECIPIENT]: [
    envelope('text', 40),           // ancient text: must survive
    envelope('text', 0),
    envelope('media', 8),           // over the seven-day line: must go
    envelope('media', 1),           // recent: must survive
  ],
}, null, 2));

console.log('\n===== what the relay keeps =====');
console.log(`  store: ${storePath}`);

const relay = spawn(process.execPath, [path.resolve('scripts/server.js')], {
  env: {
    ...process.env,
    // The relay reads CHAT_SIGNAL_PORT / CHAT_PRESENCE_PORT, not PORT — with
    // the wrong names it binds 9000 and collides with a relay already running.
    CHAT_SIGNAL_PORT: '9310',
    CHAT_PRESENCE_PORT: '9311',
    MONITOR_PASSWORD: 'retention-harness-password',
    TURN_PASSWORD: 'retention-harness',
    CHAT_OFFLINE_STORE_PATH: storePath,
    /* Its own mailboxes (see relayscale.mjs): an isolated stack's CHAT_OFFLINE_STORE_DIR is inherited otherwise. */
    CHAT_OFFLINE_STORE_DIR: path.join(path.dirname(storePath), 'mailboxes'),
    CHAT_PUSH_STORE_PATH: path.join(path.dirname(storePath), 'push.json'),
    CHAT_POLICY_STORE_PATH: path.join(path.dirname(storePath), 'policy.json'),
    CHAT_SELF_DESTRUCT_STORE_PATH: path.join(path.dirname(storePath), 'self-destruct.json'),
    CHAT_DIRECTORY_PATH: path.join(path.dirname(storePath), 'relay-directory.json'),
    CHAT_TRANSIT_PEERS_STORE: path.join(path.dirname(storePath), 'transit-peers.json'),
    CHAT_BOOTSTRAP_PORT: '9319',
    CHAT_EXPIRY_LOG_PATH: logPath,
    // Sweep straight away rather than waiting a quarter of an hour.
    CHAT_RETENTION_SWEEP_MS: '1000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const relayOut = [];
relay.stdout.on('data', (d) => relayOut.push(String(d)));
relay.stderr.on('data', (d) => relayOut.push(String(d)));

await new Promise((resolve) => setTimeout(resolve, 6000));

/* The relay keeps one file per mailbox now, so a write costs one recipient's
   queue instead of the whole server's. The fixture above is still written as
   the old single file on purpose - that also exercises the one-time import. */
/* Since 2.10 the relay imports that file into its database (state.db) and
   keeps the mailboxes and the expiry log there. */
const readStore = () => readMailboxes(storePath);
const readLog = () => readStoreFile(path.dirname(logPath), 'expiry-log', path.basename(logPath)) || [];

const mailbox = readStore()[RECIPIENT] || [];
const kinds = mailbox.map((item) => `${item.payload.class}@${Math.round((Date.now() - Date.parse(item.queuedAt)) / DAY)}d`);
console.log('  remaining: ' + JSON.stringify(kinds));

const texts = mailbox.filter((i) => i.payload.class === 'text');
const media = mailbox.filter((i) => i.payload.class === 'media');

check('text is kept no matter how old it is', texts.length === 2, `${texts.length} text item(s)`);
check('media past seven days is gone', media.length === 1, `${media.length} media item(s)`);
check('media inside the window is untouched',
  media.every((i) => (Date.now() - Date.parse(i.queuedAt)) < 7 * DAY), JSON.stringify(kinds));

const log = readLog();
console.log('  log: ' + JSON.stringify(log.map((e) => `${e.class}/${e.reason}`)));
check('the expiry left a note behind', log.length === 1 && log[0].class === 'media' && log[0].reason === 'retention',
  JSON.stringify(log[0] || null));
check('the note says who it was from, and nothing about the body',
  Boolean(log[0]?.from) && !JSON.stringify(log[0] || {}).includes('cipher'),
  Object.keys(log[0] || {}).join(','));
check('the note is not marked delivered until the recipient connects',
  log[0]?.delivered === false, String(log[0]?.delivered));

relay.kill('SIGTERM');
await new Promise((resolve) => setTimeout(resolve, 500));

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log('\n  relay output:\n' + relayOut.join('').split('\n').slice(-12).map((l) => '    ' + l).join('\n'));
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n===== ${failed.length} failed of ${results.length} =====`);
process.exit(failed.length ? 1 : 0);
