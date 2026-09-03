import Database from 'better-sqlite3';
import fs from 'fs-extra';
import path from 'path';

// Override point for tests: GOODREADS_DB_PATH redirects all storage to an
// isolated database file so unit tests never touch the real goodreads.db.
const DB_PATH = process.env.GOODREADS_DB_PATH || path.join(process.cwd(), 'goodreads.db');
const BACKUP_DIR = path.join(process.cwd(), 'backups');
const KEEP_BACKUPS = 7;

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('busy_timeout = 30000');
    initSchema(_db);
  }
  return _db;
}

export function backupDb(): void {
  const db = getDb();
  fs.ensureDirSync(BACKUP_DIR);

  const today = new Date().toISOString().slice(0, 10);
  const dest = path.join(BACKUP_DIR, `goodreads.db.${today}`);

  // Use SQLite's backup API for a consistent snapshot (safe during writes)
  db.backup(dest).then(() => {
    rotateBackups();
  }).catch((err: any) => {
    console.error(`Backup failed: ${err.message}`);
  });
}

export function backupDbSync(): void {
  const db = getDb();
  fs.ensureDirSync(BACKUP_DIR);

  const today = new Date().toISOString().slice(0, 10);
  const dest = path.join(BACKUP_DIR, `goodreads.db.${today}`);

  // Synchronous: copy the main db + WAL for a consistent snapshot
  fs.copySync(DB_PATH, dest);
  const wal = DB_PATH + '-wal';
  const shm = DB_PATH + '-shm';
  if (fs.existsSync(wal)) fs.copySync(wal, dest + '-wal');
  if (fs.existsSync(shm)) fs.copySync(shm, dest + '-shm');

  rotateBackups();
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
    work_id TEXT
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

    CREATE INDEX IF NOT EXISTS idx_genre_tag_xref_tag ON genre_tag_xref(tag_name);
    CREATE INDEX IF NOT EXISTS idx_tag_books_position ON tag_books(tag_name, position);
    CREATE INDEX IF NOT EXISTS idx_books_ratings ON books(ratings DESC);
    CREATE INDEX IF NOT EXISTS idx_books_author ON books(author);
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
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
