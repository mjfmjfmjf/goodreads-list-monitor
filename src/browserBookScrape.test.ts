import { describe, expect, it, vi, afterAll, beforeEach } from 'vitest';

vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-bbs-test-${process.pid}-${Date.now()}.db`;
});

import { getDb, closeDb } from './db.ts';
import { buildCoverageGapQuery, shouldRescrapeUnknownTitle, saveBookPage, UNKNOWN_TITLE_RESCAN_DAYS } from './browserBookScrape.ts';
import type { CheckpointRow } from './browserBookScrape.ts';
import { computeRatingsStats } from './ratingsStats.ts';

afterAll(() => {
  closeDb();
  delete process.env.GOODREADS_DB_PATH;
});

const DAY = 86400000;

function prior(status: 'ok' | 'error', scrapedAt: string): CheckpointRow {
  return {
    book_id: '1',
    status,
    scraped_at: scrapedAt,
  };
}

describe('buildCoverageGapQuery', () => {
  const seed = () => {
    const db = getDb();
    const now = '2026-09-10T00:00:00Z';
    db.exec('DELETE FROM books; DELETE FROM book_page;');
    const ins = db.prepare(
      `INSERT INTO books (id, title, author, author_id, work_id, ratings, avg_rating, published, last_updated, first_seen, is_work_rep)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    ins.run('b1', 'Covered Rep', 'A', 'a1', 'w1', 2_000_000, 4.0, '2001', now, now, 1);
    ins.run('b2', 'Top Gap Rep', 'B', 'a2', 'w2', 1_500_000, 4.0, '2002', now, now, 1);
    ins.run('b3', 'Second Gap Rep', 'C', 'a3', 'w3', 800_000, 3.5, '2003', now, now, 1);
    ins.run('b4', 'Gap Non-Rep Edition', 'C', 'a3', 'w3', 900_000, 3.5, '2003', now, now, 0);
    ins.run('b5', 'Low Gap Rep', 'D', 'a4', 'w5', 10_000, 3.0, '2005', now, now, 1);
    db.prepare('INSERT INTO book_page (book_id, scraped_at) VALUES (?, ?)').run('b1', now);
  };

  it('picks work-representative books without a book_page row, most ratings first', () => {
    seed();
    const { sql, params } = buildCoverageGapQuery({ limit: 100 });
    const rows = getDb().prepare(sql).all(...params) as Array<{ id: string; ratings: number }>;
    expect(rows.map(r => r.id)).toEqual(['b2', 'b3', 'b5']); // b1 covered, b4 not a rep
    expect(rows[0].ratings).toBe(1_500_000);
  });

  it('respects minRatings and limit', () => {
    seed();
    const { sql, params } = buildCoverageGapQuery({ limit: 2, minRatings: 500_000 });
    const rows = getDb().prepare(sql).all(...params) as Array<{ id: string }>;
    expect(rows.map(r => r.id)).toEqual(['b2', 'b3']); // b5 below the floor
  });

  it('emits the is_work_rep + missing book_page predicates in SQL', () => {
    const { sql, params } = buildCoverageGapQuery({ limit: 10 });
    expect(sql).toContain('LEFT JOIN book_page bp ON bp.book_id = b.id');
    expect(sql).toContain('b.is_work_rep = 1');
    expect(sql).toContain('bp.book_id IS NULL');
    expect(sql).toContain('ORDER BY b.ratings DESC, b.id ASC');
    expect(params).toEqual([10]);
  });
});

describe('saveBookPage (book_page write path)', () => {
  const DERIVED = [
    'ratings_mean', 'ratings_median', 'ratings_mode', 'ratings_variance',
    'ratings_stddev', 'ratings_skewness', 'ratings_kurtosis', 'ratings_total',
  ] as const;

  const getRow = (bookId: string): any =>
    getDb().prepare('SELECT * FROM book_page WHERE book_id = ?').get(bookId);

  beforeEach(() => {
    getDb().prepare('DELETE FROM book_page').run();
  });

  it('recomputes the derived columns from the distribution it writes', () => {
    saveBookPage(
      'bp1',
      { genres: ['Fiction'], series: [], ratingsCountDist: { '5': 2, '4': 1 } },
      { currentlyReading: 3, toRead: 10 },
      42,
    );

    const row = getRow('bp1');
    expect(JSON.parse(row.ratings_dist)).toEqual({ '5': 2, '4': 1 });
    expect(row.ratings_total).toBe(3);
    expect(row.ratings_mean).toBeCloseTo(14 / 3, 12);
    expect(row.ratings_median).toBe(5);
    expect(row.ratings_mode).toBe(5);
    expect(row.ratings_stddev).toBeCloseTo(Math.sqrt(2 / 9), 12);
    expect(row.ratings_skewness).not.toBeNull();
    expect(row.ratings_kurtosis).not.toBeNull();
    expect(row.editions_count).toBe(42);
    expect(row.currently_reading).toBe(3);
    expect(row.to_read).toBe(10);
    expect(typeof row.scraped_at).toBe('string');
  });

  it('writes every derived column NULL when there is no distribution', () => {
    saveBookPage('bp2', { genres: [], series: [], ratingsCountDist: null }, {});

    const row = getRow('bp2');
    expect(row.ratings_dist).toBeNull();
    for (const col of DERIVED) expect(row[col]).toBeNull();
  });

  it('overwrites stale derived values on re-scrape and clears them when dist disappears', () => {
    saveBookPage('bp3', { genres: [], series: [], ratingsCountDist: { '5': 2, '4': 1 } }, {});
    expect(getRow('bp3').ratings_total).toBe(3);

    // Re-scrape with a different distribution: columns must track the new one.
    saveBookPage('bp3', { genres: [], series: [], ratingsCountDist: { '1': 4 } }, {});
    let row = getRow('bp3');
    expect(row.ratings_total).toBe(4);
    expect(row.ratings_mean).toBe(1);
    expect(row.ratings_stddev).toBe(0);
    expect(row.ratings_skewness).toBeNull();

    // Re-scrape with no distribution: no stale derived numbers left behind.
    saveBookPage('bp3', { genres: [], series: [], ratingsCountDist: null }, {});
    row = getRow('bp3');
    expect(row.ratings_dist).toBeNull();
    for (const col of DERIVED) expect(row[col]).toBeNull();
  });

  it('agrees with computeRatingsStats (single source of truth)', () => {
    const dist = { '5': 967, '4': 303, '3': 100, '2': 20, '1': 5 };
    saveBookPage('bp4', { genres: [], series: [], ratingsCountDist: dist }, {});

    const expected = computeRatingsStats(dist)!;
    const row = getRow('bp4');
    expect(row.ratings_total).toBe(expected.total);
    expect(row.ratings_mean).toBeCloseTo(expected.mean, 12);
    expect(row.ratings_median).toBe(expected.median);
    expect(row.ratings_mode).toBe(expected.mode);
    expect(row.ratings_variance).toBeCloseTo(expected.variance, 12);
    expect(row.ratings_stddev).toBeCloseTo(expected.stddev, 12);
    expect(row.ratings_skewness).toBeCloseTo(expected.skewness as number, 12);
    expect(row.ratings_kurtosis).toBeCloseTo(expected.kurtosis as number, 12);
  });
});

describe('shouldRescrapeUnknownTitle', () => {
  const now = Date.UTC(2026, 8, 25, 12, 0, 0);

  it('is false for real-titled books with fresh checkpoints', () => {
    expect(shouldRescrapeUnknownTitle(prior('ok', new Date(now - 2 * DAY).toISOString()), 'The Dinner Party', now)).toBe(false);
  });

  it('is false when the checkpoint is not ok', () => {
    expect(shouldRescrapeUnknownTitle(prior('error', new Date(now - 90 * DAY).toISOString()), 'Unknown Title', now)).toBe(false);
  });

  it('is false when unknown-title but the ok checkpoint is still fresh', () => {
    expect(shouldRescrapeUnknownTitle(prior('ok', new Date(now - 1 * DAY).toISOString()), 'Unknown Title', now)).toBe(false);
  });

  it('re-scrapes an unknown-title book once the ok checkpoint goes stale', () => {
    expect(shouldRescrapeUnknownTitle(prior('ok', new Date(now - (UNKNOWN_TITLE_RESCAN_DAYS + 1) * DAY).toISOString()), 'Unknown Title', now)).toBe(true);
  });

  it('treats the "Unknown" placeholder the same way', () => {
    expect(shouldRescrapeUnknownTitle(prior('ok', new Date(now - (UNKNOWN_TITLE_RESCAN_DAYS + 1) * DAY).toISOString()), 'Unknown', now)).toBe(true);
  });

  it('is false with no prior checkpoint (nothing to skip anyway)', () => {
    expect(shouldRescrapeUnknownTitle(undefined, 'Unknown Title', now)).toBe(false);
  });
});