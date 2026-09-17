import Database from 'better-sqlite3';
import fs from 'fs-extra';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-dblock-${process.pid}-${Date.now()}.db`;
  // Fast retry cycle so the test doesn't wait 30s per attempt.
  process.env.GOODREADS_BUSY_TIMEOUT_MS = '80';
  process.env.GOODREADS_LOCK_RETRY_DELAY_MS = '20';
});

import { closeDb, getDb } from './db.js';
import { upsertBook, upsertTagBooks } from './storage.js';

const DB_FILE = process.env.GOODREADS_DB_PATH!;

const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

afterAll(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  closeDb();
  delete process.env.GOODREADS_DB_PATH;
  delete process.env.GOODREADS_BUSY_TIMEOUT_MS;
  delete process.env.GOODREADS_LOCK_RETRY_DELAY_MS;
  for (const suffix of ['', '-wal', '-shm']) fs.removeSync(DB_FILE + suffix);
});

beforeEach(() => {
  warnSpy.mockClear();
  errorSpy.mockClear();
});

describe('SQLITE_BUSY retry', () => {
  it('succeeds on ordinary writes without contention', () => {
    upsertBook({ id: 'ok1', title: 'Ok', author: 'A', ratings: '10', avgRating: '4.0', published: '2020', lastUpdated: '2026-01-01T00:00:00Z' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('retries a single-statement write while another connection holds the write lock, then rethrows after exhausting retries', () => {
    // Initialize schema first, then hold the whole-DB write lock from a second
    // connection for the duration of this test (SQLite locks are database-wide,
    // not per-row — this models a peer crawler mid-transaction).
    const db = getDb();
    db.prepare('SELECT 1').get();

    const holder = new Database(DB_FILE);
    holder.pragma('journal_mode = WAL');
    holder.exec('BEGIN IMMEDIATE');
    try {
      expect(() =>
        upsertBook({ id: 'locked1', title: 'Locked', author: 'A', ratings: '10', avgRating: '4.0', published: '2020', lastUpdated: '2026-01-01T00:00:00Z' })
      ).toThrow(/SQLITE_BUSY|database is locked/);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }

    // The retry loop fired (attempt 1 and 2 log retry warnings) before the
    // final lock dump + rethrow.
    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes('retrying')).length).toBe(2);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('Database lock (SQLITE_BUSY)'))).toBe(true);
  });

  it('retries each autocommit statement of a bulk write under the same contention and persists nothing', () => {
    const db = getDb();
    db.prepare('SELECT 1').get();

    const holder = new Database(DB_FILE);
    holder.pragma('journal_mode = WAL');
    holder.exec('BEGIN IMMEDIATE');
    try {
      const books = Array.from({ length: 600 }, (_, i) => ({ id: `tx${i}`, position: i + 1, shelved: 1 }));
      expect(() => upsertTagBooks('locked-tag', books)).toThrow(/SQLITE_BUSY|database is locked/);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }

    const count = (db.prepare('SELECT COUNT(*) AS c FROM tag_books WHERE tag_name = ?').get('locked-tag') as any).c;
    expect(count).toBe(0);
  });
});