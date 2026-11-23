/*
 * P00RIJA Chat — end-to-end encrypted messenger.
 * Copyright (C) 2026 Poorija <p00rija@tutamail.com>
 *
 * Licensed under the GNU Affero General Public License, version 3 only.
 * See LICENSE for the full text. Section 13 matters here: run a modified
 * version as a network service and its users are entitled to your source.
 */

'use strict';

/* The relay's state in one SQLite database (roadmap 2.4, release 2.10).

   Until now every store was a JSON file, and a store with an entry per person
   (mailboxes, beacons, copies held for sibling devices, rosters) was a
   directory of them. Each write rewrote the whole file through a temp file, an
   fsync and a rename: correct, and the reason a busy mailbox cost time in
   proportion to everything already in it. Thousands of small files are also
   what a backup, a restore and a disk-full have to deal with one by one.

   Now it is one file, `state.db`, in WAL mode through Node's own `node:sqlite`
   (no native addon to build into the image). Every store is a table of
   key -> JSON value, and a store kept per person is that table with one row
   per person, so writing one person's queue writes one row. The shapes the
   server holds in memory do not change: this replaces the files under them,
   nothing above.

   What is in it:
     kv(store, key, value, updated_at)   every store, one row per key
   A whole-file store (the policy, the push subscriptions, the expiry log,
   ...) is one row with key ''. A per-person store is one row per fingerprint.

   The first time a store is used, what the old files hold for it is imported
   in one transaction, and the files are left where they are, each renamed
   with `.imported` (inside a directory, file by file): nothing is deleted, and
   going back a release means renaming them back (docs: INSTALL-LINUX-SERVER). A database that cannot be
   opened is not silently replaced: the relay says so and falls back to the
   files for that run. */

const fs = require('fs');
const path = require('path');

let sqlite = null;
try {
  /* node:sqlite prints an experimental warning on some versions; the warning
     is about API stability, which this file pins down by using only the
     synchronous core (DatabaseSync, prepare, run, get, all). */
  sqlite = require('node:sqlite');
} catch (_error) {
  sqlite = null;
}

const SCHEMA_VERSION = 1;

function openStateDb(file, { log = console } = {}) {
  if (!sqlite?.DatabaseSync) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fresh = !fs.existsSync(file);
  let db;
  try {
    db = new sqlite.DatabaseSync(file);
  } catch (error) {
    log.error?.(`[State] ${file} could not be opened: ${/** @type {Error} */ (error).message}`);
    return null;
  }
  try {
    return prepare(db, file, fresh, log);
  } catch (error) {
    /* A file that opens but is not a database, or is locked by another
       process past the busy timeout: said loudly, and the relay keeps its
       state in the JSON files for this run rather than refusing to start. */
    log.error?.(`[State] ${file} could not be used (${/** @type {Error} */ (error).message}); this run keeps state in JSON files.`);
    try { db.close(); } catch (_error) { /* already */ }
    return null;
  }
}

/* The write-ahead log and the shared-memory file hold the same rows as the
   database, so they get its mode, whatever the process umask is. */
function harden(file) {
  for (const name of [file, `${file}-wal`, `${file}-shm`]) {
    try { fs.chmodSync(name, 0o600); } catch (_error) { /* not there yet, or no modes */ }
  }
}

function prepare(db, file, fresh, log) {
  harden(file);
  db.exec('PRAGMA journal_mode = WAL');
  /* NORMAL in WAL: a commit is durable once the WAL is synced at checkpoint;
     a power cut can lose the last commits but never corrupts the file. The
     mailbox write already waited up to a second before reaching disk. */
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  harden(file);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS kv (
    store TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (store, key)
  ) WITHOUT ROWID`);
  const version = db.prepare('SELECT value FROM meta WHERE name = ?').get('schema');
  if (!version) db.prepare('INSERT INTO meta (name, value) VALUES (?, ?)').run('schema', String(SCHEMA_VERSION));
  else if (Number(version.value) > SCHEMA_VERSION) {
    log.error?.(`[State] ${file} is schema ${version.value}, newer than this relay (${SCHEMA_VERSION}); not used.`);
    db.close();
    return null;
  }

  const statements = {
    get: db.prepare('SELECT value FROM kv WHERE store = ? AND key = ?'),
    put: db.prepare(`INSERT INTO kv (store, key, value, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (store, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`),
    del: db.prepare('DELETE FROM kv WHERE store = ? AND key = ?'),
    keys: db.prepare('SELECT key FROM kv WHERE store = ? ORDER BY key'),
    all: db.prepare('SELECT key, value FROM kv WHERE store = ? ORDER BY key'),
    clear: db.prepare('DELETE FROM kv WHERE store = ?'),
    sizes: db.prepare('SELECT key, length(value) AS size FROM kv WHERE store = ?'),
    count: db.prepare('SELECT store, count(*) AS rows, sum(length(value)) AS bytes FROM kv GROUP BY store'),
    metaGet: db.prepare('SELECT value FROM meta WHERE name = ?'),
    metaPut: db.prepare('INSERT INTO meta (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value'),
  };
  let depth = 0;
  function transaction(fn) {
    if (depth > 0) return fn();
    db.exec('BEGIN IMMEDIATE');
    depth += 1;
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_error) { /* already rolled back */ }
      throw error;
    } finally {
      depth -= 1;
    }
  }
  const parse = (row) => {
    if (!row) return undefined;
    try { return JSON.parse(row.value); } catch (_error) { return undefined; }
  };

  const api = {
    file,
    fresh,
    get(store, key = '') { return parse(statements.get.get(store, String(key))); },
    has(store, key = '') { return Boolean(statements.get.get(store, String(key))); },
    put(store, key, value) {
      statements.put.run(store, String(key ?? ''), JSON.stringify(value), Date.now());
    },
    delete(store, key = '') { statements.del.run(store, String(key)); },
    keys(store) { return statements.keys.all(store).map((row) => row.key); },
    entries(store) {
      const out = [];
      for (const row of statements.all.all(store)) {
        const value = parse(row);
        if (value !== undefined) out.push([row.key, value]);
      }
      return out;
    },
    sizes(store) { return statements.sizes.all(store).map((row) => [row.key, Number(row.size) || 0]); },
    clear(store) { statements.clear.run(store); },
    /* Replace a whole per-person store with `map` in one transaction: rows not
       in it are removed. What the sweeps and the shutdown call. */
    replaceAll(store, map) {
      transaction(() => {
        const live = new Set();
        for (const [key, value] of map) {
          live.add(String(key));
          statements.put.run(store, String(key), JSON.stringify(value), Date.now());
        }
        for (const row of statements.keys.all(store)) if (!live.has(row.key)) statements.del.run(store, row.key);
      });
    },
    transaction,
    meta(name, value) {
      if (value === undefined) return statements.metaGet.get(name)?.value;
      statements.metaPut.run(name, String(value));
      return value;
    },
    stats() {
      const stores = {};
      for (const row of statements.count.all()) stores[row.store] = { rows: Number(row.rows), bytes: Number(row.bytes) || 0 };
      let fileBytes = 0;
      try { fileBytes = fs.statSync(file).size; } catch (_error) { /* not yet */ }
      let walBytes = 0;
      try { walBytes = fs.statSync(`${file}-wal`).size; } catch (_error) { /* none */ }
      return { file, schema: SCHEMA_VERSION, fileBytes, walBytes, stores };
    },
    /* Folds the write-ahead log into the database file and syncs it: after
       this, what was committed survives a power cut. */
    checkpoint() { try { db.exec('PRAGMA wal_checkpoint(FULL)'); return true; } catch (_error) { return false; } },
    /* A consistent copy of the whole database in one file, whatever is being
       written meanwhile (what a backup takes; three files copied one after
       another while the relay runs are not one state). */
    snapshot(target) {
      try { fs.unlinkSync(target); } catch (_error) { /* none */ }
      db.prepare('VACUUM INTO ?').run(target);
      try { fs.chmodSync(target, 0o600); } catch (_error) { /* no modes */ }
      return target;
    },
    close() {
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (_error) { /* busy */ }
      try { db.close(); } catch (_error) { /* already */ }
    },
  };
  return api;
}

/* ---- the one-time import -------------------------------------------------- */

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_error) { return undefined; }
}

/* Brings one store's old files in, once (meta `imported:<store>`), the first
   time the store is used. Store by store rather than all at start, because the
   server learns its paths as it goes; each import is its own transaction.
     { file }                     a whole-file store: one row, key ''
     { file, shape: fn }          the same, its value reshaped first
     { dir, key: fn(name) }       a directory of `<key>.json`: a row each
   A file read is renamed with `.imported` only after the commit, never before,
   so a crash in the middle leaves the files whole and the import runs again. */
function adopt(db, store, source, { log = console } = {}) {
  if (!db || !source) return 0;
  const flag = `imported:${store}`;
  if (db.meta(flag)) return 0;
  const done = [];
  let count = 0;
  db.transaction(() => {
    if (source.file) {
      if (fs.existsSync(source.file)) {
        const value = readJson(source.file);
        if (value === undefined) {
          log.warn?.(`[State] ${path.basename(source.file)} is not readable JSON; left as it is.`);
        } else {
          const shaped = source.shape ? source.shape(value) : value;
          if (shaped !== undefined && !db.has(store, '')) db.put(store, '', shaped);
          count += 1;
          done.push(source.file);
        }
      }
    }
    if (source.dir) {
      let names = [];
      try { names = fs.readdirSync(source.dir); } catch (_error) { names = []; }
      for (const name of names) {
        if (!name.endsWith('.json') || name.startsWith('.')) continue;
        const key = source.key ? source.key(name.slice(0, -5)) : name.slice(0, -5);
        if (!key) continue;
        const full = path.join(source.dir, name);
        const value = readJson(full);
        if (value === undefined) {
          log.warn?.(`[State] ${store}/${name} is not readable JSON; left as it is.`);
          continue;
        }
        if (!db.has(store, key)) db.put(store, key, value);
        count += 1;
        /* File by file, not the directory: a directory may hold things this
           relay still keeps as files (rosters/copies, *.identity). */
        done.push(full);
      }
    }
    db.meta(flag, new Date().toISOString());
  });
  /* With synchronous=NORMAL a commit is durable at the next checkpoint. The
     old files are renamed only once the rows are on disk for certain, so a
     power cut between the two can never leave both gone. */
  if (done.length && !db.checkpoint()) {
    log.warn?.(`[State] ${store}: imported, but the checkpoint did not run; the old files are kept as they are for now.`);
    return count;
  }
  for (const target of done) {
    try { fs.renameSync(target, `${target}.imported`); } catch (error) {
      log.warn?.(`[State] ${target} imported but could not be renamed: ${/** @type {Error} */ (error).message}`);
    }
  }
  if (count) log.log?.(`[State] ${store}: imported ${count} record(s) from the old files into ${path.basename(db.file)}.`);
  return count;
}

module.exports = { openStateDb, adopt, available: () => Boolean(sqlite?.DatabaseSync), SCHEMA_VERSION };
