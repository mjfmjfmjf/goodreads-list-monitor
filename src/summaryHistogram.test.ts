import { describe, it, expect, vi, afterAll } from 'vitest';

vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-sumhist-test-${process.pid}-${Date.now()}.db`;
});

import chalk from 'chalk';
import { closeDb, getDb } from './db.js';
import {
  buildRatingBuckets,
  bucketIndexFor,
  buildCoverageCounts,
  renderCoverageHistogram,
  runRatingsCoverageHistogram,
} from './summaryHistogram.js';

afterAll(() => {
  closeDb();
  delete process.env.GOODREADS_DB_PATH;
});

describe('bucketIndexFor', () => {
  it('maps counts into the same decile brackets the plain histogram uses', () => {
    const buckets = buildRatingBuckets();
    expect(bucketIndexFor(5_500_000, buckets)).toBe(buckets.findIndex(x => x.min === 5_000_000));
    expect(bucketIndexFor(1_000_000, buckets)).toBe(buckets.findIndex(x => x.min === 1_000_000 && x.max === 1_999_999));
    expect(bucketIndexFor(9, buckets)).toBe(buckets.findIndex(x => x.min === 9));
    expect(bucketIndexFor(0, buckets)).toBe(buckets.length - 1);
  });
});

describe('buildCoverageCounts', () => {
  it('splits each bracket into all / work-id / works / field subsets', () => {
    const fieldIds = new Set(['b1', 'b3']);
    const books = [
      { id: 'b1', ratings: '5,500,000', workId: 'w1', workRep: true },
      { id: 'b10', ratings: '4,000,000', workId: 'w1', workRep: false },
      { id: 'b2', ratings: '550,000', workId: 'w2', workRep: true },
      { id: 'b3', ratings: '550,000', workId: null, workRep: false },
      { id: 'b4', ratings: '0', workId: 'w3', workRep: true },
    ];
    const c = buildCoverageCounts(books, fieldIds);
    expect(c.totalAll).toBe(5);
    expect(c.totalWork).toBe(4);
    expect(c.totalWorks).toBe(3);
    expect(c.totalField).toBe(2);

    const big = bucketIndexFor(5_500_000);
    expect(c.all[big]).toBe(1);
    expect(c.work[big]).toBe(1);
    expect(c.works[big]).toBe(1);
    expect(c.field[big]).toBe(1);

    const nearBig = bucketIndexFor(4_000_000);
    expect(c.all[nearBig]).toBe(1);
    expect(c.work[nearBig]).toBe(1);
    expect(c.works[nearBig]).toBe(0);

    const mid = bucketIndexFor(550_000);
    expect(c.all[mid]).toBe(2);
    expect(c.work[mid]).toBe(1);
    expect(c.works[mid]).toBe(1);
    expect(c.field[mid]).toBe(1);

    const zero = bucketIndexFor(0);
    expect(c.all[zero]).toBe(1);
    expect(c.work[zero]).toBe(1);
    expect(c.works[zero]).toBe(1);
    expect(c.field[zero]).toBe(0);
  });
});

describe('renderCoverageHistogram', () => {
  it('renders headers, within-bracket coverage %s, and the totals footer', () => {
    chalk.level = 0;
    const buckets = [{ label: 'Anything', min: 0, max: Infinity }];
    const lines = renderCoverageHistogram(
      { all: [10], work: [6], works: [5], field: [2], totalAll: 10, totalWork: 6, totalWorks: 5, totalField: 2 },
      buckets
    );
    const out = lines.join('\n');
    expect(out).toContain('Book Cache Ratings Coverage by Subset');
    expect(out).toContain('RATING BRACKET');
    expect(out).toContain('60.0%');
    expect(out).toContain('50.0%');
    expect(out).toContain('20.0%');
    expect(out).toContain('Total: cache 10 | work-id 6 (60.0% of cache) | works 5 (50.0% of cache) | field 2 (20.0% of cache)');
  });
});

describe('runRatingsCoverageHistogram', () => {
  it('reports totals from the live books + book_page tables', async () => {
    const db = getDb();
    db.exec('CREATE TABLE IF NOT EXISTS book_page (book_id TEXT PRIMARY KEY, scraped_at TEXT NOT NULL)');
    const now = '2026-09-10T00:00:00Z';
    const ins = db.prepare(
      `INSERT INTO books (id, title, author, author_id, work_id, ratings, avg_rating, published, last_updated, first_seen, is_work_rep)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    ins.run('b1', 'T1', 'A', 'a1', 'w1', 1_200_000, 4.0, '2001', now, now, 1);
    ins.run('b2', 'T2', 'B', 'a2', null, 500_000, 3.5, '2002', now, now, 0);
    ins.run('b3', 'T3', 'C', 'a3', 'w3', 0, 3.0, '2003', now, now, 1);
    db.prepare('INSERT INTO book_page (book_id, scraped_at) VALUES (?, ?)').run('b1', now);

    chalk.level = 0;
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runRatingsCoverageHistogram();
    const lines = out.mock.calls.map((c) => c.join(' '));
    out.mockRestore();

    expect(lines.join('\n')).toContain('Book Cache Ratings Coverage by Subset');
    const footer = lines.find((l) => l.includes('Total: cache'));
    expect(footer).toContain('cache 3');
    expect(footer).toContain('work-id 2');
    expect(footer).toContain('works 2');
    expect(footer).toContain('field 1');
  });
});