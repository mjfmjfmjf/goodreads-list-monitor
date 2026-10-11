import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { ledgerMigrate, authorColumns } from './authorLedgerMigrate.ts';
import { AUTHOR_FAIL_LIMIT } from './storage.ts';

let dir: string;
let db: Database.Database;

// Pre-§4 shape: authors carries fail_count/last_error alongside the ledger.
function makeLegacyDb(file: string): Database.Database {
  const d = new Database(file);
  d.exec(`
    CREATE TABLE authors (
      id TEXT PRIMARY KEY,
      name TEXT,
      num_ratings INTEGER,
      catalog_pages INTEGER,
      fail_count INTEGER DEFAULT 0,
      last_error TEXT,
      last_seen TEXT
    );
    CREATE TABLE author_scrape_failures (
      author_id TEXT PRIMARY KEY,
      fail_count INTEGER DEFAULT 0,
      last_error TEXT,
      first_seen TEXT,
      last_seen TEXT
    );
  `);
  return d;
}

const addAuthor = (d: Database.Database, id: string, failCount: number, lastError: string | null = null) =>
  d
    .prepare('INSERT INTO authors (id, name, num_ratings, catalog_pages, fail_count, last_error) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, `A${id}`, 10, null, failCount, lastError);
const addLedger = (d: Database.Database, id: string, failCount: number) =>
  d.prepare('INSERT INTO author_scrape_failures (author_id, fail_count) VALUES (?, ?)').run(id, failCount);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-ledger-'));
  db = makeLegacyDb(path.join(dir, 'test.db'));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ledgerMigrate', () => {
  it('dry run reports the blast radius but writes nothing', () => {
    addAuthor(db, '1', 5, 'ERR_BAD_REQUEST');
    const res = ledgerMigrate(db);
    expect(res.applied).toBe(false);
    expect(res.hadLegacyColumns).toBe(true);
    expect(res.authorsWithLegacyStrikes).toBe(1);
    expect(res.maxLegacyFailCount).toBe(5);
    expect(res.wouldBeBlockedIfImported).toBe(1);
    // nothing changed on disk
    expect(authorColumns(db)).toContain('fail_count');
    expect((db.prepare('SELECT COUNT(*) AS c FROM author_scrape_failures').get() as any).c).toBe(0);
  });

  it('drops both legacy columns', () => {
    addAuthor(db, '1', 3);
    const res = ledgerMigrate(db, { apply: true });
    expect(res.applied).toBe(true);
    expect(authorColumns(db)).not.toContain('fail_count');
    expect(authorColumns(db)).not.toContain('last_error');
    expect(res.columnsAfter).not.toContain('fail_count');
  });

  // Regression guard for dropping the legacy strikes instead of merging them.
  // The two ledgers barely overlap on the live DB (569 ids legacy-only, 721
  // ledger-only), so discarding the legacy column re-admitted every author it had
  // already retired at the threshold — 519 never-crawled authors — and a
  // `--sortBy topRatings` queue GREW (235,645 -> 235,907) instead of shrinking.
  it('seeds the ledger from legacy fail_count', () => {
    addAuthor(db, '1', 8, 'ERR_BAD_REQUEST');
    addAuthor(db, '2', 5, 'ERR_BAD_REQUEST');
    addLedger(db, '3', 2);
    const res = ledgerMigrate(db, { apply: true });
    expect(res.ledgerRowsBefore).toBe(1);
    expect(res.ledgerRowsAfter).toBe(3);
    expect(res.mergedLegacyStrikes).toBe(2);
    expect(
      db.prepare('SELECT author_id, fail_count FROM author_scrape_failures ORDER BY author_id').all() as any[]
    ).toEqual([
      { author_id: '1', fail_count: 8 },
      { author_id: '2', fail_count: 5 },
      { author_id: '3', fail_count: 2 },
    ]);
  });

  it('takes MAX so a legacy strike is never lost to a lower ledger count', () => {
    // The regression that actually bit: an author already exhausted at the legacy
    // threshold but only lightly recorded in the ledger must stay exhausted.
    addAuthor(db, '1', AUTHOR_FAIL_LIMIT, 'ERR_BAD_REQUEST');
    addLedger(db, '1', 1);
    ledgerMigrate(db, { apply: true });
    expect(
      (db.prepare('SELECT fail_count FROM author_scrape_failures WHERE author_id = 1').get() as any).fail_count
    ).toBe(AUTHOR_FAIL_LIMIT);
  });

  it('never lowers an existing ledger count', () => {
    addAuthor(db, '1', 2, 'ERR_BAD_REQUEST');
    addLedger(db, '1', 4);
    ledgerMigrate(db, { apply: true });
    expect(
      (db.prepare('SELECT fail_count FROM author_scrape_failures WHERE author_id = 1').get() as any).fail_count
    ).toBe(4);
  });

  it('keeps an exhausted author out of the crawl queue after the merge', () => {
    addAuthor(db, '1', AUTHOR_FAIL_LIMIT, 'ERR_BAD_REQUEST');
    ledgerMigrate(db, { apply: true });
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM author_scrape_failures WHERE author_id = 1 AND fail_count >= ?').get(AUTHOR_FAIL_LIMIT) as any).c
    ).toBe(1);
  });

  it('preserves all other author data', () => {
    addAuthor(db, '1', 4, 'ERR_BAD_REQUEST');
    addAuthor(db, '2', 0);
    db.prepare("UPDATE authors SET name = 'Keep Me' WHERE id = '1'").run();
    ledgerMigrate(db, { apply: true });
    const one = db.prepare('SELECT * FROM authors WHERE id = 1').get() as any;
    expect(one.name).toBe('Keep Me');
    expect(one.num_ratings).toBe(10);
    expect((db.prepare('SELECT COUNT(*) AS c FROM authors').get() as any).c).toBe(2);
  });

  it('counts every author at the threshold as would-block', () => {
    addAuthor(db, '1', AUTHOR_FAIL_LIMIT, 'ERR_BAD_REQUEST');
    addAuthor(db, '2', AUTHOR_FAIL_LIMIT, 'ERR_BAD_REQUEST');
    expect(ledgerMigrate(db).wouldBeBlockedIfImported).toBe(2);
  });

  it('is idempotent — a second run is a no-op', () => {
    addAuthor(db, '1', 5);
    ledgerMigrate(db, { apply: true });
    const second = ledgerMigrate(db, { apply: true });
    expect(second.hadLegacyColumns).toBe(false);
    expect(second.applied).toBe(true);
    expect(second.droppedColumns).toEqual([]);
    expect(second.authorsWithLegacyStrikes).toBe(0);
    expect(second.mergedLegacyStrikes).toBe(0);
    // The merged row from the first run survives; a re-run must not touch it.
    expect(second.ledgerRowsAfter).toBe(1);
  });
});