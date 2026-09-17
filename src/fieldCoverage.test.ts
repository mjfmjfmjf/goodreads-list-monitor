import { describe, it, expect, vi, afterAll } from 'vitest';
import { computeFieldStats, formatCoverageLine, runFieldCoverage } from './fieldCoverage.js';
import chalk from 'chalk';

vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-fieldcoverage-test-${process.pid}-${Date.now()}.db`;
});

import { closeDb, getDb } from './db.js';

afterAll(() => {
  closeDb();
  delete process.env.GOODREADS_DB_PATH;
});

describe('computeFieldStats', () => {
  it('maps SQL aggregate rows to FieldStats with numeric coercion', () => {
    const stats = computeFieldStats({ work_id: 12, genres: null }, 20);
    expect(stats).toEqual([
      { field: 'work_id', populated: 12, total: 20, distinct: undefined },
      { field: 'genres', populated: 0, total: 20, distinct: undefined },
    ]);
  });

  it('attaches distinct counts when a distinct map is provided', () => {
    const stats = computeFieldStats(
      { work_id: 12, pages: 5 },
      20,
      { work_id: 11, pages: 4 },
    );
    expect(stats).toEqual([
      { field: 'work_id', populated: 12, total: 20, distinct: 11 },
      { field: 'pages', populated: 5, total: 20, distinct: 4 },
    ]);
  });

  it('omits distinct for fields missing from the distinct map', () => {
    const stats = computeFieldStats({ work_id: 12, pages: 5 }, 20, { work_id: 11 });
    expect(stats.find(s => s.field === 'pages')?.distinct).toBeUndefined();
  });
});

describe('formatCoverageLine', () => {
  it('shows percent and missing count', () => {
    chalk.level = 0;
    expect(formatCoverageLine({ field: 'work_id', populated: 5, total: 10 })).toContain('50.0%');
    expect(formatCoverageLine({ field: 'work_id', populated: 5, total: 10 })).toContain('(5 missing)');
  });

  it('marks complete fields', () => {
    chalk.level = 0;
    expect(formatCoverageLine({ field: 'title', populated: 100, total: 100 })).toContain('✓ complete');
  });

  it('shows distinct count when present', () => {
    chalk.level = 0;
    expect(formatCoverageLine({ field: 'work_id', populated: 10, total: 20, distinct: 8 })).toContain('8 distinct');
  });
});

describe('runFieldCoverage', () => {
  it('treats 0 ratings as present and prints a separate zero-rating count', async () => {
    const db = getDb();
    const now = '2026-09-10T00:00:00Z';
    db.prepare(
      `INSERT INTO books (id, title, author, author_id, ratings, avg_rating, published, last_updated, first_seen)
       VALUES ('r1', 'Rated Book', 'A', 'a1', 1200, 4.2, '2001', @now, @now),
              ('z1', 'Zero Book', 'B', 'a2', 0, 0, '2002', @now, @now)`
    ).run({ now });

    chalk.level = 0;
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runFieldCoverage();
    const lines = out.mock.calls.map((c) => c.join(' '));
    out.mockRestore();

    const ratingsLine = lines.find((l) => l.includes('ratings') && l.includes('%'));
    expect(ratingsLine).toContain('100.0%');
    expect(ratingsLine).toContain('✓ complete');
    const zeroLine = lines.find((l) => l.includes('ratings_zero'));
    expect(zeroLine).toContain('1');
    expect(zeroLine).toContain('0 ratings');
  });
});