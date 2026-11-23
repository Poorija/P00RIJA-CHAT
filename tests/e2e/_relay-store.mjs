/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

/* Reading the relay's mailboxes from a test.

   The relay keeps one file per recipient under a `mailboxes/` directory rather
   than one file for the whole server - a write then costs one person's queue
   instead of every queued message on the relay. Several suites read that store
   directly as evidence, so they read it through here and there is one place to
   change if the layout moves again.

   The single-file form is still understood, because a store written by an
   older relay is imported on first boot and a fixture may still be staged in
   that shape. */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/* Since 2.10 the relay keeps all of this in one SQLite database, state.db,
   beside the stores (scripts/lib/state-db.js): table kv(store, key, value),
   a row per recipient for the per-person stores, key '' for a whole-file one.
   Read here first; the files are the fallback for a relay run with
   CHAT_STATE_DB=off, or one older than 2.10. Opened read-only, a fresh handle
   each call: the relay holds the WAL, and a reader sees every committed row. */
export function stateDbFor(storePath) {
  return process.env.CHAT_STATE_DB_PATH || path.join(path.dirname(storePath), 'state.db');
}
function withDb(file, fn) {
  if (!fs.existsSync(file)) return undefined;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}
/* Every row of one store in a relay's database, as { key: value }; undefined
   when there is no database. `dir` is the relay's data directory. */
export function readStateStore(dir, store) {
  return withDb(path.join(dir, 'state.db'), (db) => {
    const out = {};
    for (const row of db.prepare('SELECT key, value FROM kv WHERE store = ?').all(store)) {
      try { out[row.key] = JSON.parse(row.value); } catch (_error) { /* unreadable reads as absent */ }
    }
    return out;
  });
}
/* Every store of a relay's database, as { store: { key: value } }. */
export function readAllStores(dir) {
  return withDb(path.join(dir, 'state.db'), (db) => {
    const out = {};
    for (const row of db.prepare('SELECT store, key, value FROM kv').all()) {
      (out[row.store] ||= {})[row.key] = row.value;
    }
    return out;
  }) || {};
}
/* One row: a per-person store by fingerprint, a whole-file store with key ''. */
export function readStateRow(dir, store, key = '') {
  const all = readStateStore(dir, store);
  return all ? all[key] : undefined;
}
/* What a test wants to know about a relay's store, wherever the relay keeps
   it: the database when there is one, else the file. */
export function readStoreFile(dir, store, file, key = '') {
  const fromDb = readStateRow(dir, store, key);
  if (fromDb !== undefined) return fromDb;
  try { return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch (_error) { return undefined; }
}

export function mailboxDirFor(storePath) {
  return path.join(path.dirname(storePath), 'mailboxes');
}

/* Every mailbox, as { fingerprint: [envelope, ...] }. */
export function readMailboxes(storePath) {
  const fromDb = withDb(stateDbFor(storePath), (db) => {
    const out = {};
    for (const row of db.prepare("SELECT key, value FROM kv WHERE store = 'mailbox'").all()) {
      try {
        const items = JSON.parse(row.value);
        if (Array.isArray(items) && items.length) out[row.key] = items;
      } catch (_error) { /* an unreadable mailbox reads as absent */ }
    }
    return out;
  });
  if (fromDb) return fromDb;
  const dir = mailboxDirFor(storePath);
  if (fs.existsSync(dir)) {
    const out = {};
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const items = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (Array.isArray(items) && items.length) out[name.slice(0, -5)] = items;
      } catch (_error) { /* an unreadable mailbox reads as absent */ }
    }
    return out;
  }
  try { return JSON.parse(fs.readFileSync(storePath, 'utf8')) || {}; } catch (_error) { return {}; }
}

/* Replace the whole store. Used to stage a fixture or to clear one out. With a
   database, the rows; a running relay keeps what it holds in memory and
   writes it back, so a fixture is staged before the relay starts or through
   its own API. */
export function writeMailboxes(storePath, boxes) {
  const file = stateDbFor(storePath);
  if (fs.existsSync(file)) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file);
    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare("DELETE FROM kv WHERE store = 'mailbox'").run();
      const put = db.prepare("INSERT INTO kv (store, key, value, updated_at) VALUES ('mailbox', ?, ?, ?)");
      for (const [fingerprint, items] of Object.entries(boxes || {})) {
        if (Array.isArray(items) && items.length) put.run(fingerprint, JSON.stringify(items), Date.now());
      }
      db.exec('COMMIT');
    } finally { db.close(); }
    return;
  }
  const dir = mailboxDirFor(storePath);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.json')) fs.unlinkSync(path.join(dir, name));
  }
  for (const [fingerprint, items] of Object.entries(boxes || {})) {
    if (!Array.isArray(items) || !items.length) continue;
    fs.writeFileSync(path.join(dir, `${fingerprint}.json`), JSON.stringify(items));
  }
}

export function countEnvelopes(storePath) {
  return Object.values(readMailboxes(storePath)).reduce((sum, items) => sum + items.length, 0);
}
