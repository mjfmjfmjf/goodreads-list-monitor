import Database from 'better-sqlite3';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import { constants } from 'node:fs';
import { isDbLockError } from './utils.js';

// Override point for tests: GOODREADS_DB_PATH redirects all storage to an
// isolated database file so unit tests never touch the real goodreads.db.
const DB_PATH = process.env.GOODREADS_DB_PATH || path.join(process.cwd(), 'goodreads.db');
const BACKUP_DIR = path.join(process.cwd(), 'backups');
const KEEP_BACKUPS = 7;

let _db: Database.Database | null = null;

// ── Database-lock observability ─────────────────────────────────────
// Multiple processes share goodreads.db (scrapers, the server, one-off CLIs).
// Under WAL a reader or writer can transiently hit SQLITE_BUSY; when it happens
// we want as much context as possible: where it happened, who this process is,
// what the DB/WAL state looks like, and which OTHER processes recently held
// long write transactions (the likely lockers).

// A write transaction left open longer than busy_timeout (30s) will cause other
// processes to hit "database is locked". We log on the locker side too.
const LONG_TRANSACTION_MS = 30_000;
// Transactions longer than this are recorded in the cross-process registry.
const REGISTRY_MIN_MS = 2_000;
const REGISTRY_PATH = path.join(os.tmpdir(), 'goodreads-db-lock-registry.json');
const REGISTRY_MAX_AGE_MS = 5 * 60_000;
const REGISTRY_MAX_ENTRIES = 20;

// Concurrent crawlers share goodreads.db; under WAL a write can transiently hit
// SQLITE_BUSY while another process finishes a transaction. All our writes are
// idempotent upserts, so retry (busy_timeout already blocks ~30s inside each
// attempt) instead of killing the whole run on the first lock.
const LOCK_RETRY_ATTEMPTS = 3;
const LOCK_RETRY_DELAY_MS = parseInt(process.env.GOODREADS_LOCK_RETRY_DELAY_MS || '2000', 10) || 2000;
// Overridable so unit tests can exercise lock contention without 30s waits.
const BUSY_TIMEOUT_MS = parseInt(process.env.GOODREADS_BUSY_TIMEOUT_MS || '30000', 10) || 30000;

// Synchronous sleep (the better-sqlite3 transaction/statement wrappers are
// sync; we cannot await here).
function blockSleep(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* ignore — retry immediately on platforms without Atomics.wait */
  }
}

// Under WAL, SQLITE_BUSY_SNAPSHOT means our connection's snapshot is stale
// (another writer committed and the WAL advanced). busy_timeout does NOT help
// — it only applies to lock contention, not snapshot staleness. The fix is to
// checkpoint the WAL (advancing it), so our next attempt gets a fresh snapshot.
function forceCheckpoint(db: Database.Database): void {
  try {
    db.pragma('wal_checkpoint(PASSIVE)');
  } catch {
    // PASSIVE is best-effort — it yields if other writers are active.
  }
}

const CMDLINE = process.argv.slice(1).join(' ') || process.title;

interface RegistryTx { startTs: number; endTs: number; ms: number; site: string; }
interface RegistryEntry { argv: string; txs: RegistryTx[]; updatedAt: number; }

function readRegistry(): Record<string, RegistryEntry> {
  try {
    return fs.readJsonSync(REGISTRY_PATH);
  } catch {
    return {};
  }
}

function writeRegistry(registry: Record<string, RegistryEntry>): void {
  try {
    const now = Date.now();
    // Prune stale entries before persisting to keep the file small.
    for (const pidKey of Object.keys(registry)) {
      if (now - registry[pidKey].updatedAt > REGISTRY_MAX_AGE_MS) delete registry[pidKey];
    }
    fs.writeJsonSync(REGISTRY_PATH, registry, { spaces: 0 });
  } catch {
    // Registry is best-effort observability; never fail the caller on it.
  }
}

// Record that THIS process ran a transaction lasting `ms` at call site `site`.
function recordLongTransaction(ms: number, site: string): void {
  if (ms < REGISTRY_MIN_MS) return;
  const registry = readRegistry();
  const entry = registry[String(process.pid)] || { argv: CMDLINE, txs: [], updatedAt: Date.now() };
  entry.txs = [...entry.txs, { startTs: Date.now() - ms, endTs: Date.now(), ms, site }].slice(-REGISTRY_MAX_ENTRIES);
  entry.updatedAt = Date.now();
  registry[String(process.pid)] = entry;
  writeRegistry(registry);
}

// Rich dump of the DB-lock situation when a SQLITE_BUSY fires.
function logDatabaseLock(context: string, err: any, opts: { busyTimeout?: number | string; waitedMs?: number } = {}): void {
  const nowIso = new Date().toISOString();
  let walSize = 'n/a';
  try {
    const walPath = DB_PATH + '-wal';
    if (fs.existsSync(walPath)) {
      walSize = `${(fs.statSync(walPath).size / 1024 / 1024).toFixed(1)} MB`;
    }
  } catch { /* ignore */ }

  console.error(chalk.red.bold(`\n🔒 Database lock (SQLITE_BUSY) [${nowIso}]`));
  console.error(chalk.red(`   context : ${context}`));
  console.error(chalk.red(`   error   : ${String((err as any)?.code || '')} ${String((err as any)?.message || err)}`));
  console.error(chalk.red(`   pid/cmd : ${process.pid}  ${CMDLINE}`));
  console.error(chalk.red(`   db      : ${DB_PATH}`));
  console.error(chalk.red(`   wal-jrn : journal_mode=wal  busy_timeout=${opts.busyTimeout ?? 'n/a'}  wal_file=${walSize}`));
  if (typeof opts.waitedMs === 'number') {
    const hint = opts.waitedMs < 50 && Number(opts.busyTimeout) > 0
      ? '  ⚠️  busy handler was NOT invoked (not ordinary write-lock contention)'
      : '';
    console.error(chalk.red(`   waited  : ${opts.waitedMs}ms before this error${hint}`));
  }

  const site = new Error().stack?.split('\n').slice(2, 8).join('\n') || '';
  if (site) console.error(chalk.red(`   at      :\n${site.split('\n').map(l => `        ${l.trim()}`).join('\n')}`));

  // Who else recently held long write transactions (the likely lockers)?
  const registry = readRegistry();
  const others = Object.entries(registry).filter(([pidKey]) => pidKey !== String(process.pid));
  if (others.length > 0) {
    console.error(chalk.yellow(`   other processes with recent long write transactions (>${REGISTRY_MIN_MS / 1000}s):`));
    for (const [pidKey, entry] of others) {
      const longest = entry.txs.reduce<RegistryTx | null>((best, t) => (best && best.ms >= t.ms ? best : t), null);
      console.error(chalk.yellow(`     - pid ${pidKey} (${entry.argv}):`));
      for (const t of entry.txs.slice(-5)) {
        const endedAgo = Math.max(0, (Date.now() - t.endTs) / 1000).toFixed(0);
        console.error(chalk.yellow(`         ${t.ms.toFixed(0).padStart(6)}ms  ended ${endedAgo}s ago  at ${t.site}`));
      }
    }
  } else {
    console.error(chalk.gray(`   (no other processes have recently recorded long write transactions — the lock may be held by an un-instrumented/old process)`));
  }
}

function instrumentTransactions(db: Database.Database): void {
  const origTransaction = db.transaction.bind(db);
  db.transaction = ((fn: (() => any) | Function) => {
    const run = origTransaction(fn as any);
    const wrapped = ((...args: any[]) => {
      const start = Date.now();
      for (let attempt = 1; attempt <= LOCK_RETRY_ATTEMPTS; attempt++) {
        try {
          const value = run(...args);
          const elapsed = Date.now() - start;
          if (elapsed > LONG_TRANSACTION_MS) {
            console.warn(
              chalk.yellow(
                `[lock] write transaction (PID ${process.pid}) held ${(elapsed / 1000).toFixed(1)}s — ` +
                `longer than the ${LONG_TRANSACTION_MS / 1000}s busy_timeout; other processes can hit "database is locked".`
              )
            );
          }
          recordLongTransaction(elapsed, 'db.transaction');
          return value;
        } catch (err) {
          if (isDbLockError(err) && attempt < LOCK_RETRY_ATTEMPTS) {
            // The transaction rollback is clean; the (idempotent) body is safe
            // to replay after the lock clears.
            const errCode = String((err as any)?.code || '');
            if (errCode === 'SQLITE_BUSY_SNAPSHOT') {
              console.warn(chalk.yellow(`[lock] SQLITE_BUSY_SNAPSHOT on write transaction — checkpointing WAL, retrying (attempt ${attempt}/${LOCK_RETRY_ATTEMPTS})`));
              forceCheckpoint(db);
            } else {
              console.warn(chalk.yellow(`[lock] SQLITE_BUSY on write transaction — retrying (attempt ${attempt}/${LOCK_RETRY_ATTEMPTS})`));
            }
            blockSleep(LOCK_RETRY_DELAY_MS);
            continue;
          }
          if (isDbLockError(err)) logDatabaseLock('db.transaction write', err);
          throw err;
        }
      }
      throw new Error('unreachable');
    }) as any;
    return wrapped;
  }) as any;
}

// Wrap every prepared statement so a SQLITE_BUSY (read or write) is logged with
// the SQL that caused it. Cheap on the success path (one extra call + no-throw).
// A statement run OUTSIDE a transaction is retried (autocommit — safe to
// replay); inside a transaction it is left for the transaction wrapper, since
// the abort/rollback happens there.
function wrapStatements(db: Database.Database): void {
  const origPrepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const stmt = origPrepare(sql);
    const sqlSnippet = String(sql).replace(/\n+/g, ' ').slice(0, 120);
    for (const method of ['get', 'all', 'run', 'iterate'] as const) {
      const orig = (stmt as any)[method]?.bind(stmt);
      if (typeof orig !== 'function') continue;
      (stmt as any)[method] = (...args: any[]) => {
        for (let attempt = 1; attempt <= LOCK_RETRY_ATTEMPTS; attempt++) {
          try {
            return orig(...args);
          } catch (err) {
            if (isDbLockError(err) && !db.inTransaction && attempt < LOCK_RETRY_ATTEMPTS) {
              const errCode = String((err as any)?.code || '');
              if (errCode === 'SQLITE_BUSY_SNAPSHOT') {
                console.warn(chalk.yellow(`[lock] SQLITE_BUSY_SNAPSHOT on ${method} "${sqlSnippet}" — checkpointing WAL, retrying (attempt ${attempt}/${LOCK_RETRY_ATTEMPTS})`));
                forceCheckpoint(db);
              } else {
                console.warn(chalk.yellow(`[lock] SQLITE_BUSY on ${method} "${sqlSnippet}" — retrying (attempt ${attempt}/${LOCK_RETRY_ATTEMPTS})`));
              }
              blockSleep(LOCK_RETRY_DELAY_MS);
              continue;
            }
            if (isDbLockError(err)) logDatabaseLock(`prepare: ${sqlSnippet}`, err);
            throw err;
          }
        }
        throw new Error('unreachable');
      };
    }
    return stmt;
  }) as any;
}

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // WAL + synchronous=NORMAL: commits are memory-only (no per-commit fsync),
    // so single-statement autocommit writes are sub-ms and no transaction
    // batching is needed. Crash-consistent; on power loss the last handful of
    // uncheckpointed commits may be lost (re-scraped later — this is a cache).
    // Cap the WAL so checkpoint-on-COMMIT stays short.
    _db.pragma('synchronous = NORMAL');
    _db.pragma('wal_autocheckpoint = 1000');
    _db.pragma('journal_size_limit = 33554432');
    instrumentTransactions(_db);
    wrapStatements(_db);
    try {
      initSchema(_db);
    } catch (err) {
      // initSchema may run long migrations (e.g. a first_seen backfill over the
      // whole books table). If it throws mid-way (a transient SQLITE_BUSY, say),
      // the connection is half-migrated; drop it so the next getDb() starts
      // fresh instead of serving requests against a missing column.
      _db.close();
      _db = null;
      throw err;
    }
  }
  return _db;
}

export function backupDb(): Promise<void> {
  const db = getDb();
  fs.ensureDirSync(BACKUP_DIR);

  const today = new Date().toISOString().slice(0, 10);
  const dest = path.join(BACKUP_DIR, `goodreads.db.${today}`);

  // The snapshot APIs refuse to overwrite an existing destination, so clear
  // any same-day file first (safe: a fresh snapshot replaces it). Also drop a
  // stale rollback journal from an interrupted prior attempt — leaving an
  // orphaned -journal would make the next open run a hot-journal recovery
  // against the fresh destination.
  fs.removeSync(dest);
  fs.removeSync(dest + '-wal');
  fs.removeSync(dest + '-shm');
  fs.removeSync(dest + '-journal');

  console.log(chalk.gray('   Backing up database...'));
  const started = Date.now();
  lastCloneMs = null;

  // Fast path: fold the WAL into the main file (wal_checkpoint(TRUNCATE)) and
  // copy-on-write clone the result. This turns the multi-GB snapshot into a
  // near-instant APFS clone (same trick PostgreSQL uses for file snapshots)
  // instead of SQLite re-reading the whole file under live crawler I/O.
  // TRUNCATE can't complete while another connection holds a read mark, so
  // fall back to the consistent backup API in that case.
  return tryCheckpointAndClone(db, dest).then((cloned) => {
    if (cloned) return;
    // Use SQLite's backup API for a consistent snapshot (safe during writes,
    // replays WAL state; the resulting file is self-contained, no -wal/-shm).
    // A copy of the whole (several-GB) DB takes real time; report progress so
    // a running backup is never mistaken for a hang.
    let lastDecile = -1;
    return db.backup(dest, {
      progress: (info) => {
        const pct = info.totalPages === 0 ? 100 : Math.floor(((info.totalPages - info.remainingPages) / info.totalPages) * 100);
        const decile = Math.floor(pct / 10) * 10;
        if (decile > lastDecile) {
          lastDecile = decile;
          console.log(chalk.gray(`   Backup in progress: ${decile}%...`));
        }
        return 100;
      }
    });
  }).then(() => {
    rotateBackups();
    const how = lastCloneMs !== null ? 'cloned' : 'backed up';
    console.log(chalk.gray(`   Snapshot ${how} in ${((Date.now() - started) / 1000).toFixed(1)}s.`));
  });
}

let lastCloneMs: number | null = null;

export interface CheckpointRow {
  busy: number;
  log: number;
  checkpointed: number;
}

// A TRUNCATE checkpoint counts as complete when nothing resisted the reclaim
// (busy === 0) and every WAL frame made it into the main file.
export function checkpointCompleted(row: CheckpointRow): boolean {
  return row.busy === 0 && (row.log === 0 || row.checkpointed === row.log);
}

// Returns true when a clean TRUNCATE checkpoint + CoW clone produced the
// snapshot; false means the caller should fall back to the backup API.
function tryCheckpointAndClone(db: Database.Database, dest: string): Promise<boolean> {
  try {
    const rows = db.pragma('wal_checkpoint(TRUNCATE)') as unknown as CheckpointRow[];
    const row = rows[0];
    if (!row || !checkpointCompleted(row)) {
      console.log(chalk.gray(`   WAL busy (${row?.busy ?? 'unknown'} unreclaimable pages); using backup API...`));
      return Promise.resolve(false);
    }
    try {
      // COPYFILE_FICLONE = clonefile(2): copy-on-write, instant.
      fs.copyFileSync(DB_PATH, dest, constants.COPYFILE_FICLONE);
    } catch {
      // APFS clone unavailable (e.g. non-macOS); a plain copy is still
      // consistent because the WAL is empty at this instant.
      fs.copyFileSync(DB_PATH, dest);
    }
    lastCloneMs = Date.now();
    return Promise.resolve(true);
  } catch (err) {
    console.log(chalk.gray('   Checkpoint failed; using backup API...'));
    return Promise.resolve(false);
  }
}

function rotateBackups(): void {
  if (!fs.existsSync(BACKUP_DIR)) return;
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('goodreads.db.'))
    .sort();
  while (files.length > KEEP_BACKUPS) {
    const oldest = files.shift()!;
    fs.removeSync(path.join(BACKUP_DIR, oldest));
    // Also remove associated WAL/SHM copies
    fs.removeSync(path.join(BACKUP_DIR, oldest + '-wal'));
    fs.removeSync(path.join(BACKUP_DIR, oldest + '-shm'));
  }
}

// Backfill probable page counts for tags already scraped into tag_books,
// BEFORE any live scrape recorded a measured last page:
//   - shelves that yielded <= 1200 books (fewer than a full 24-25 page scan)
//     are treated as fully served, so the last harvested position is reliable:
//     estimate = round-up(MAX(position) / 50).
//   - shelves whose harvest was pinned at ~25 pages (a probable lie) get a
//     guess from the genre index instead: round-up(member_count / 50).
// Shared between db.ts (runs it once at init when tag_stats is empty) and
// storage.ts (exposed so tests/gap runs can re-run it on fixtures).
export const TAG_PAGE_ESTIMATE_BACKFILL_SQL = `
  INSERT INTO tag_stats (tag_name, estimate_page, estimate_source, updated)
  SELECT
    t.tag_name,
    CASE
      WHEN COUNT(*) <= 1200 THEN (MAX(t.position) + 49) / 50
      WHEN COALESCE(g.member_count, 0) > 0 THEN (g.member_count + 49) / 50
      ELSE NULL
    END,
    CASE
      WHEN COUNT(*) <= 1200 THEN 'harvest-derived'
      WHEN COALESCE(g.member_count, 0) > 0 THEN 'member-count-guess'
      ELSE NULL
    END,
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  FROM tag_books t
  LEFT JOIN genres g ON g.name = t.tag_name
  GROUP BY t.tag_name
  HAVING COUNT(*) <= 1200 OR COALESCE(g.member_count, 0) > 0
  ON CONFLICT(tag_name) DO UPDATE SET
    estimate_page = excluded.estimate_page,
    estimate_source = excluded.estimate_source,
    updated = excluded.updated
`;

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      author_id TEXT,
      ratings INTEGER DEFAULT 0,
      avg_rating REAL,
      published TEXT,
      pages INTEGER,
      series_pos REAL,
      genres TEXT,
      last_updated TEXT NOT NULL,
      tags TEXT,
      requires_auth INTEGER DEFAULT 0,
    is_bad INTEGER DEFAULT 0,
    fail_count INTEGER DEFAULT 0,
    work_id TEXT,
    first_seen TEXT
  );

    CREATE TABLE IF NOT EXISTS authors (
      name TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      slug TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      average_rating REAL,
      num_ratings INTEGER DEFAULT 0,
      num_reviews INTEGER DEFAULT 0,
      num_shelves INTEGER DEFAULT 0,
      first_seen TEXT
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lists (
      list_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      last_count INTEGER DEFAULT 0,
      seen_book_ids TEXT,
      ingested INTEGER DEFAULT 0,
      discovery_page INTEGER,
      url TEXT
    );

    CREATE TABLE IF NOT EXISTS tag_books (
      tag_name TEXT NOT NULL,
      book_id TEXT NOT NULL,
      position INTEGER,
      shelved INTEGER,
      harvested_at TEXT NOT NULL,
      PRIMARY KEY (tag_name, book_id)
    );

    CREATE TABLE IF NOT EXISTS author_scrape_failures (
      author_id TEXT PRIMARY KEY,
      fail_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS genres (
      name TEXT PRIMARY KEY,
      member_count INTEGER DEFAULT 0,
      first_seen TEXT NOT NULL,
      last_updated TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS genre_tag_xref (
      genre_name TEXT NOT NULL,
      tag_name   TEXT NOT NULL,
      kind       TEXT NOT NULL DEFAULT 'exact',
      PRIMARY KEY (genre_name, tag_name)
    );

    CREATE TABLE IF NOT EXISTS tag_stats (
      tag_name TEXT PRIMARY KEY,
      last_page_seen INTEGER,
      estimate_page INTEGER,
      estimate_source TEXT,
      updated TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS list_scrapes (
      list_id TEXT PRIMARY KEY,
      list_name TEXT,
      first_scraped TEXT NOT NULL,
      last_scraped TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS browser_scrape (
      book_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      http INTEGER,
      bytes INTEGER,
      elapsed_ms INTEGER,
      scraped_at TEXT NOT NULL,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS book_page (
      book_id TEXT PRIMARY KEY,
      publisher TEXT,
      isbn13 TEXT,
      isbn10 TEXT,
      asin TEXT,
      format TEXT,
      language TEXT,
      description TEXT,
      series TEXT,
      reviews_count TEXT,
      ratings_dist TEXT,
      currently_reading INTEGER,
      to_read INTEGER,
      editions_count INTEGER,
      scraped_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_genre_tag_xref_tag ON genre_tag_xref(tag_name);
    CREATE INDEX IF NOT EXISTS idx_tag_books_position ON tag_books(tag_name, position);
    CREATE INDEX IF NOT EXISTS idx_books_ratings ON books(ratings DESC);
    CREATE INDEX IF NOT EXISTS idx_books_author ON books(author);
    CREATE INDEX IF NOT EXISTS idx_books_first_seen ON books(first_seen);
    CREATE INDEX IF NOT EXISTS idx_books_work_id ON books(work_id);
    CREATE INDEX IF NOT EXISTS idx_authors_num_ratings ON authors(num_ratings DESC);
    CREATE INDEX IF NOT EXISTS idx_authors_num_shelves ON authors(num_shelves DESC);
  `);

  // Migrations for databases created before a column existed.
  const bookCols = db.prepare('PRAGMA table_info(books)').all() as any[];
  if (!bookCols.some((c: any) => c.name === 'work_id')) {
    db.exec('ALTER TABLE books ADD COLUMN work_id TEXT');
  }
  const authorCols = db.prepare('PRAGMA table_info(authors)').all() as any[];
  if (!authorCols.some((c: any) => c.name === 'catalog_pages')) {
    db.exec('ALTER TABLE authors ADD COLUMN catalog_pages INTEGER');
  }
  if (!authorCols.some((c: any) => c.name === 'fail_count')) {
    db.exec('ALTER TABLE authors ADD COLUMN fail_count INTEGER DEFAULT 0');
  }
  if (!authorCols.some((c: any) => c.name === 'last_error')) {
    db.exec('ALTER TABLE authors ADD COLUMN last_error TEXT');
  }
  if (!authorCols.some((c: any) => c.name === 'first_seen')) {
    // Capture when we first saw an author. Existing rows predate the column,
    // so backfill them with the day before their last_seen as a close proxy.
    db.exec('ALTER TABLE authors ADD COLUMN first_seen TEXT');
    db.exec(`
      UPDATE authors
      SET first_seen = strftime('%Y-%m-%dT%H:%M:%S', datetime(last_seen, '-1 day'))
      WHERE first_seen IS NULL AND last_seen IS NOT NULL
    `);
  }
  const tagCols = db.prepare('PRAGMA table_info(tag_books)').all() as any[];
  if (!tagCols.some((c: any) => c.name === 'shelved')) {
    db.exec('ALTER TABLE tag_books ADD COLUMN shelved INTEGER');
  }
  const booksCols = db.prepare('PRAGMA table_info(books)').all() as any[];
  if (!booksCols.some((c: any) => c.name === 'first_seen')) {
    // Capture when we first added a book. Existing rows predate the column,
    // so backfill them with the day before their last_updated as a close proxy.
    db.exec('ALTER TABLE books ADD COLUMN first_seen TEXT');
    db.exec(`
      UPDATE books
      SET first_seen = strftime('%Y-%m-%dT%H:%M:%S', datetime(last_updated, '-1 day'))
      WHERE first_seen IS NULL AND last_updated IS NOT NULL
    `);
  }
  const repCols = db.prepare('PRAGMA table_info(books)').all() as any[];
  if (!repCols.some((c: any) => c.name === 'is_work_rep')) {
    // Materialize the de-duplicated "representative edition" of each work: one
    // row per distinct work_id (the highest-ratings edition, lowest id on ties)
    // so queries can count each work exactly once without DISTINCT work_id.
    db.exec('ALTER TABLE books ADD COLUMN is_work_rep INTEGER NOT NULL DEFAULT 0');
    recomputeWorkReps(db);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_books_is_work_rep ON books(is_work_rep) WHERE is_work_rep = 1');

  // One-time backfill: probable page counts for tags that were scraped before
  // scrapeShelfBooks began persisting the shelf's real last page.
  const tagStatsEmpty = (db.prepare('SELECT COUNT(*) AS c FROM tag_stats').get() as any).c === 0;
  if (tagStatsEmpty) {
    db.exec(TAG_PAGE_ESTIMATE_BACKFILL_SQL);
  }
}

// ── Work-representative de-dup (books.is_work_rep) ──────────────────
// books has one row per edition; editions share work_id. is_work_rep marks the
// single "representative" row of each distinct work (highest ratings, lowest
// id on tie) so consumers can count each work exactly once. Rows without a
// work_id never become representatives. Derived data: a full recompute is
// cheap (one UPDATE over the table), and the single-work variant keeps the
// live upsert paths fresh without touching other works' rows.

// Recompute is_work_rep for the whole table (migration backfill, offline
// imports). Single UPDATE, no transaction.
export function recomputeWorkReps(db: Database.Database = getDb()): void {
  db.prepare(`
    UPDATE books
    SET is_work_rep = CASE WHEN id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY work_id
          ORDER BY ratings DESC, CAST(id AS INTEGER) ASC
        ) AS rn
        FROM books
        WHERE work_id IS NOT NULL AND work_id != ''
      )
      WHERE rn = 1
    ) THEN 1 ELSE 0 END
  `).run();
}

const REFRESH_WORK_REP_SQL = `
  UPDATE books
  SET is_work_rep = (id = (
    SELECT b2.id FROM books b2
    WHERE b2.work_id = @workId
    ORDER BY b2.ratings DESC, CAST(b2.id AS INTEGER) ASC
    LIMIT 1
  ))
  WHERE work_id = @workId AND work_id IS NOT NULL AND work_id != ''
`;

// Keep one work's representative flag current after a book row for that work
// is inserted or updated. Idempotent, indexed by work_id, single statement.
export function refreshWorkRep(db: Database.Database = getDb(), workId: string): void {
  if (!workId) return;
  db.prepare(REFRESH_WORK_REP_SQL).run({ workId });
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
