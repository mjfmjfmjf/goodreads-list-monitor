import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-backfill-ratings-test-${process.pid}-${Date.now()}.db`;
});

import { closeDb, getDb } from './db.ts';
import { runBackfillRatingsStats, CHUNK } from './backfillRatingsStats.ts';

interface Derived {
  mean?: number; median?: number; mode?: number; variance?: number;
  stddev?: number; skewness?: number; kurtosis?: number; total?: number;
}

function insertRow(bookId: string, ratingsDist: string | null, d: Derived = {}) {
  getDb().prepare(`
    INSERT INTO book_page (book_id, ratings_dist, ratings_mean, ratings_median, ratings_mode,
      ratings_variance, ratings_stddev, ratings_skewness, ratings_kurtosis, ratings_total, scraped_at)
    VALUES (@book_id, @dist, @mean, @median, @mode, @variance, @stddev, @skewness, @kurtosis, @total, @scraped)
  `).run({
    book_id: bookId,
    dist: ratingsDist,
    mean: d.mean ?? null, median: d.median ?? null, mode: d.mode ?? null,
    variance: d.variance ?? null, stddev: d.stddev ?? null,
    skewness: d.skewness ?? null, kurtosis: d.kurtosis ?? null, total: d.total ?? null,
    scraped: '2026-09-05T00:00:00Z',
  });
}

function getRow(bookId: string): any {
  return getDb().prepare('SELECT * FROM book_page WHERE book_id = ?').get(bookId);
}

let logs: string;

beforeEach(() => {
  logs = '';
  vi.spyOn(console, 'log').mockImplementation((...args) => {
    logs += args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n';
  });
  getDb().prepare('DELETE FROM book_page').run();
  logs = '';
});

afterAll(() => {
  closeDb();
  delete process.env.GOODREADS_DB_PATH;
  vi.restoreAllMocks();
});

describe('runBackfillRatingsStats', () => {
  it('recomputes derived columns from ratings_dist and leaves dist-less rows alone', async () => {
    // Wild-session-style wrong values on a real distribution.
    insertRow('1', '{"5":2,"4":1}', { mean: 0, median: 3, mode: 1, variance: 0, stddev: 0, skewness: 0, kurtosis: 0, total: 0 });
    // No distribution: must be skipped, not zeroed.
    insertRow('2', null, { mean: 0, median: 3, mode: 1, stddev: 0, total: 0 });
    // Single star: skew/kurt must become NULL (zero spread).
    insertRow('3', '{"5":1}', { mean: 9, total: 999 });

    await runBackfillRatingsStats();

    const r1 = getRow('1');
    expect(r1.ratings_total).toBe(3);
    expect(r1.ratings_mean).toBeCloseTo(14 / 3, 12);
    expect(r1.ratings_median).toBe(5);
    expect(r1.ratings_mode).toBe(5);
    expect(r1.ratings_stddev).toBeCloseTo(Math.sqrt(2 / 9), 12);
    expect(r1.ratings_skewness).not.toBeNull();

    const r2 = getRow('2');
    expect(r2.ratings_total).toBe(0);
    expect(r2.ratings_mean).toBe(0);

    const r3 = getRow('3');
    expect(r3.ratings_total).toBe(1);
    expect(r3.ratings_mean).toBe(5);
    expect(r3.ratings_stddev).toBe(0);
    expect(r3.ratings_skewness).toBeNull();
    expect(r3.ratings_kurtosis).toBeNull();

    expect(logs).toMatch(/Updated:.*2.*rows/);
    expect(logs).toMatch(/Skipped:.*1.*rows/);
  });

  it('writes every row across a keyset chunk boundary', async () => {
    const n = CHUNK + 1;
    const db = getDb();
    db.transaction(() => {
      for (let i = 0; i < n; i++) {
        insertRow(String(i).padStart(6, '0'), '{"5":2,"4":1}', { total: 0 });
      }
    })();

    await runBackfillRatingsStats();

    const corrected = (getDb().prepare('SELECT COUNT(*) AS c FROM book_page WHERE ratings_total = 3').get() as any).c;
    expect(corrected).toBe(n);
  });

  it('is idempotent on a second run', async () => {
    insertRow('1', '{"5":2,"4":1}', { total: 0 });
    await runBackfillRatingsStats();

    logs = '';
    await runBackfillRatingsStats();
    expect(logs).toMatch(/Updated:.*0.*rows/);
    expect(logs).toMatch(/Unchanged:.*1.*rows/);
  });
});
