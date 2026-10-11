import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Isolated temp DB: loadAuthorBookStats is a SQL aggregation over the real
// books table, so it needs one. Never touches goodreads.db.
vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-bookstats-test-${process.pid}-${Date.now()}.db`;
});

import fs from 'node:fs';
import { closeDb, getDb } from './db.ts';
import { loadAuthorBookStats } from './authorRescan.ts';

interface SeedBook {
  authorId: string;
  ratings: number;
  published: string | null;
}

function seed(books: SeedBook[]): void {
  const db = getDb();
  const ins = db.prepare(
    "INSERT OR REPLACE INTO books (id, title, author, author_id, ratings, published, last_updated) VALUES (?, 'T', 'A', ?, ?, ?, '2026-01-01')"
  );
  db.transaction(() => {
    books.forEach((b, i) => ins.run(`bk-${i}`, b.authorId, b.ratings, b.published));
  })();
}

beforeEach(() => {
  getDb().exec('DELETE FROM books');
});

afterAll(() => {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${process.env.GOODREADS_DB_PATH}${suffix}`, { force: true });
  }
});

describe('loadAuthorBookStats', () => {
  // Regression: `published` is the literal string 'Unknown' for 8,780,422 of
  // 11,578,563 books (75.8%) in the live DB. The year range used to gate the
  // whole aggregation, so an author whose books were all 'Unknown' produced no
  // stats row — and selectMultiPageAuthors drops book-based-sort authors with
  // no stats row. That made `--sortBy topRatings` blind to 236,411 of 236,804
  // never-crawled authors (99.84%). Only `newest` is a year.
  it('counts books with published="Unknown" in topRatings and books', () => {
    seed([{ authorId: 'a1', ratings: 5000, published: 'Unknown' }, { authorId: 'a1', ratings: 20, published: 'Unknown' }]);
    const stats = loadAuthorBookStats(0, 0);
    expect(stats.a1).toBeDefined();
    expect(stats.a1.topRatings).toBe(5000);
    expect(stats.a1.books).toBe(2);
    // No parseable year anywhere, so there is no newest year to report.
    expect(stats.a1.newestYear).toBe(0);
  });

  it('still reports newestYear only from a parseable year', () => {
    seed([{ authorId: 'a1', ratings: 5000, published: 'Unknown' }, { authorId: 'a1', ratings: 900, published: '2019-04-01' }]);
    const stats = loadAuthorBookStats(0, 0);
    expect(stats.a1.topRatings).toBe(5000);
    expect(stats.a1.newestYear).toBe(2019);
    expect(stats.a1.books).toBe(2);
  });

  it('drops BCE-style years above the future ceiling from newestYear', () => {
    seed([{ authorId: 'a1', ratings: 10, published: '2600-01-01' }, { authorId: 'a1', ratings: 20, published: '2001-01-01' }]);
    const stats = loadAuthorBookStats(0, 0);
    expect(stats.a1.newestYear).toBe(2001);
    // Both books still count toward topRatings — only `newest` is year-bounded.
    expect(stats.a1.books).toBe(2);
  });

  it('minBookYear narrows topRatings and books too (that flag\'s documented job)', () => {
    seed([{ authorId: 'a1', ratings: 5000, published: '2019-01-01' }, { authorId: 'a1', ratings: 30, published: 'Unknown' }]);
    const all = loadAuthorBookStats(0, 0);
    expect(all.a1.topRatings).toBe(5000);
    expect(all.a1.books).toBe(2);

    const recent = loadAuthorBookStats(2015, 0);
    expect(recent.a1.topRatings).toBe(5000);
    expect(recent.a1.books).toBe(1);
  });

  it('minRatings gates books with or without a year', () => {
    seed([{ authorId: 'a1', ratings: 5000, published: 'Unknown' }, { authorId: 'a1', ratings: 3, published: '2005-01-01' }]);
    const gated = loadAuthorBookStats(0, 1000);
    expect(gated.a1.topRatings).toBe(5000);
    expect(gated.a1.books).toBe(1);
  });

  it('omits authors with no qualifying book row entirely', () => {
    seed([{ authorId: 'a1', ratings: 5, published: '2005-01-01' }]);
    const stats = loadAuthorBookStats(0, 10000);
    expect(stats.a1).toBeUndefined();
  });
});