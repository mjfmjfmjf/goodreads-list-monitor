import Database from 'better-sqlite3';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
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
      try {
        return run(...args);
      } catch (err) {
        if (isDbLockError(err)) logDatabaseLock('db.transaction write', err);
        throw err;
      } finally {
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
      }
    }) as any;
    return wrapped;
  }) as any;
}

// Wrap every prepared statement so a SQLITE_BUSY (read or write) is logged with
// the SQL that caused it. Cheap on the success path (one extra call + no-throw).
function wrapStatements(db: Database.Database): void {
  const origPrepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const stmt = origPrepare(sql);
    const sqlSnippet = String(sql).replace(/\n+/g, ' ').slice(0, 120);
    for (const method of ['get', 'all', 'run', 'iterate'] as const) {
      const orig = (stmt as any)[method]?.bind(stmt);
      if (typeof orig !== 'function') continue;
      (stmt as any)[method] = (...args: any[]) => {
        try {
          return orig(...args);
        } catch (err) {
          if (isDbLockError(err)) logDatabaseLock(`prepare: ${sqlSnippet}`, err);
          throw err;
        }
      };
    }
    return stmt;
  }) as any;
}

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('busy_timeout = 30000');
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

  // The SQLite backup API refuses to overwrite an existing destination, so
  // clear any same-day file first (safe: a fresh snapshot replaces it).
  fs.removeSync(dest);
  fs.removeSync(dest + '-wal');
  fs.removeSync(dest + '-shm');

  // Use SQLite's backup API for a consistent snapshot (safe during writes,
  // replays WAL state; the resulting file is self-contained, no -wal/-shm).
  return db.backup(dest).then(() => {
    rotateBackups();
  });
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

  // One-time backfill: probable page counts for tags that were scraped before
  // scrapeShelfBooks began persisting the shelf's real last page.
  const tagStatsEmpty = (db.prepare('SELECT COUNT(*) AS c FROM tag_stats').get() as any).c === 0;
  if (tagStatsEmpty) {
    db.exec(TAG_PAGE_ESTIMATE_BACKFILL_SQL);
  }
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
