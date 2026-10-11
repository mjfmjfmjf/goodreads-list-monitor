import { describe, expect, it, vi, afterAll } from 'vitest';

vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-bbs-test-${process.pid}-${Date.now()}.db`;
});

import { getDb, closeDb } from './db.ts';
import { buildCoverageGapQuery, shouldRescrapeUnknownTitle, UNKNOWN_TITLE_RESCAN_DAYS } from './browserBookScrape.ts';
import type { CheckpointRow } from './browserBookScrape.ts';

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