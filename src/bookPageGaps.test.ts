import { describe, it, expect, vi, afterAll } from 'vitest';
import { computeBookPageGapStats, listMissingTopBooks, runBookPageGaps, workKey } from './bookPageGaps.js';
import chalk from 'chalk';

vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-bookpagegaps-test-${process.pid}-${Date.now()}.db`;
});

import { closeDb, getDb } from './db.js';

afterAll(() => {
  closeDb();
  delete process.env.GOODREADS_DB_PATH;
});

function seed(): void {
  const db = getDb();
  const now = '2026-09-16T00:00:00Z';
  db.prepare(
    `INSERT INTO books (id, title, author, author_id, ratings, avg_rating, published, last_updated)
     VALUES ('b1', 'Top Book', 'A. Writer', 'a1', 90000, 4.5, '2000', @now),
            ('b6', 'Top Book (Series, #1)', 'A. Writer', 'a1', 90000, 4.5, '2000', @now),
            ('b2', 'Second Book', 'B. Writer', 'a2', 80000, 4.1, '2001', @now),
            ('b3', 'Third Book', 'C. Writer', 'a3', 70000, 3.9, '2002', @now),
            ('b4', 'Fourth Book', 'D. Writer', 'a4', 60000, 4.0, '2003', @now),
            ('b5', 'Fifth Book', 'E. Writer', 'a5', 1000, 4.2, '2004', @now)`
  ).run({ now });
  db.prepare(
    `INSERT INTO book_page (book_id, scraped_at) VALUES ('b1', @now), ('b2', @now), ('b5', @now)`
  ).run({ now });
}

describe('workKey', () => {
  it('collapses editions of the same work (series suffix, edition brackets, curly apostrophes)', () => {
    expect(workKey("Harry Potter and the Philosopher's Stone (Harry Potter, #1)", 'J.K. Rowling'))
      .toBe(workKey("Harry Potter and the Philosopher's Stone (Bloomsbury Edition)", 'J.K. Rowling'));
    expect(workKey("Harry Potter and the Philosopher's Stone (Harry Potter, #1)", 'J.K. Rowling'))
      .toBe(workKey('Harry Potter and the Philosopher\u2019s Stone', 'j.k. rowling'));
  });

  it('keeps distinct works distinct', () => {
    expect(workKey('Book A', 'S. Author')).not.toBe(workKey('Book B', 'S. Author'));
    expect(workKey('Book A', 'S. Author')).not.toBe(workKey('Book A', 'T. Author'));
  });
});

describe('computeBookPageGapStats', () => {
  it('collapses edition duplicates into works and drops works already covered', () => {
    seed();
    // Top-3 editions: b1 & b6 (siblings of the same covered work) plus b2.
    const stats = computeBookPageGapStats(3);
    expect(stats.scannedEditions).toBe(3);
    expect(stats.uniqueWorks).toBe(2); // Top Book + Second Book
    expect(stats.coveredWorks).toBe(2); // both already covered
    expect(stats.missingWorks).toBe(0);
  });

  it('counts uncovered works and reports the cutoff ratings', () => {
    // Top-4 editions: b1, b6, b2, b3 → Third Book is the sole missing work.
    const stats = computeBookPageGapStats(4);
    expect(stats.uniqueWorks).toBe(3);
    expect(stats.coveredWorks).toBe(2);
    expect(stats.missingWorks).toBe(1);
    expect(stats.cutoffRatings).toBe(70000);
  });
});

describe('listMissingTopBooks', () => {
  it('lists only fully-uncovered works, ranked by ratings', () => {
    const rows = listMissingTopBooks(6, 10);
    expect(rows.map((r) => r.topId)).toEqual(['b3', 'b4']);
    expect(rows[0]).toMatchObject({ rank: 1, title: 'Third Book', ratings: 70000, avgRating: 3.9 });
  });

  it('collapses the covered work out of the missing list even when a sibling edition is uncovered', () => {
    // b6 (uncovered sibling of covered b1) must not appear.
    const rows = listMissingTopBooks(2, 10);
    expect(rows.map((r) => r.topId)).not.toContain('b1');
    expect(rows.map((r) => r.topId)).not.toContain('b6');
    expect(rows).toHaveLength(0);
  });

  it('respects the limit', () => {
    expect(listMissingTopBooks(6, 1)).toHaveLength(1);
  });
});

describe('runBookPageGaps', () => {
  it('prints stats and the missing list with column heads', async () => {
    chalk.level = 0;
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runBookPageGaps({ top: 6, limit: 10 });
    const text = out.mock.calls.map((c) => c.join(' ')).join('\n');
    out.mockRestore();
    expect(text).toContain('distinct works');
    expect(text).toContain('missing works');
    expect(text).toContain('bookId');          // column heads
    expect(text).toContain('Third Book');      // missing work shown
    expect(text).toContain('b3');
    expect(text).not.toContain('Top Book — A. Writer'); // covered work not listed
  });
});