import fs from 'fs-extra';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-books-test-${process.pid}-${Date.now()}.db`;
});

import { closeDb, getDb } from './db.ts';
import { runBooks, resetBooksCaches } from './books.ts';

const DB_FILE = process.env.GOODREADS_DB_PATH!;

function insertBook(book: {
  id: string; title: string; author: string; ratings?: number; avgRating?: string;
  published?: string; workId?: string; isWorkRep?: number; isBad?: number;
}) {
  getDb().prepare(`
    INSERT INTO books (id, title, author, author_id, ratings, avg_rating, published, last_updated, work_id, is_work_rep, is_bad, genres)
    VALUES (@id, @title, @author, @authorId, @ratings, @avgRating, @published, @lastUpdated, @workId, @isWorkRep, @isBad, @genres)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, author = excluded.author, ratings = excluded.ratings,
      avg_rating = excluded.avg_rating, published = excluded.published,
      work_id = excluded.work_id, is_work_rep = excluded.is_work_rep, is_bad = excluded.is_bad
  `).run({
    id: book.id,
    title: book.title,
    author: book.author,
    authorId: `a-${book.author}`,
    ratings: book.ratings ?? 0,
    avgRating: book.avgRating ?? null,
    published: book.published ?? '2000',
    lastUpdated: new Date().toISOString(),
    workId: book.workId ?? null,
    isWorkRep: book.isWorkRep ?? 0,
    isBad: book.isBad ?? 0,
    genres: null,
  });
}

function insertPage(bookId: string, stats: {
  reviews?: number; currentlyReading?: number; toRead?: number; editions?: number; language?: string;
  derived?: Partial<Record<'mean' | 'median' | 'mode' | 'variance' | 'stddev' | 'skewness' | 'kurtosis' | 'total', number>>;
}) {
  const d = stats.derived ?? {};
  getDb().prepare(`
    INSERT INTO book_page (book_id, reviews_count, currently_reading, to_read, editions_count, language, scraped_at,
      ratings_mean, ratings_median, ratings_mode, ratings_variance, ratings_stddev, ratings_skewness, ratings_kurtosis, ratings_total)
    VALUES (@bookId, @reviews, @cr, @toRead, @editions, @language, @scrapedAt,
      @mean, @median, @mode, @variance, @stddev, @skewness, @kurtosis, @total)
    ON CONFLICT(book_id) DO UPDATE SET
      reviews_count = excluded.reviews_count, currently_reading = excluded.currently_reading,
      to_read = excluded.to_read, editions_count = excluded.editions_count,
      language = excluded.language,
      ratings_mean = excluded.ratings_mean, ratings_median = excluded.ratings_median,
      ratings_mode = excluded.ratings_mode, ratings_variance = excluded.ratings_variance,
      ratings_stddev = excluded.ratings_stddev, ratings_skewness = excluded.ratings_skewness,
      ratings_kurtosis = excluded.ratings_kurtosis, ratings_total = excluded.ratings_total
  `).run({
    bookId,
    reviews: String(stats.reviews ?? 0),
    cr: stats.currentlyReading ?? 0,
    toRead: stats.toRead ?? 0,
    editions: stats.editions ?? null,
    language: stats.language ?? null,
    scrapedAt: new Date().toISOString(),
    mean: d.mean ?? null, median: d.median ?? null, mode: d.mode ?? null,
    variance: d.variance ?? null, stddev: d.stddev ?? null,
    skewness: d.skewness ?? null, kurtosis: d.kurtosis ?? null, total: d.total ?? null,
  });
}

function insertTag(bookId: string, tagName: string, shelved: number) {
  getDb().prepare(`
    INSERT INTO tag_books (tag_name, book_id, position, shelved, harvested_at)
    VALUES (@tagName, @bookId, @position, @shelved, @harvestedAt)
  `).run({
    tagName,
    bookId,
    position: 1,
    shelved,
    harvestedAt: new Date().toISOString(),
  });
}

let logs: string;
beforeEach(() => {
  logs = '';
  const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
    logs += args.map(a => (typeof a === 'string' ? a : String(a))).join(' ') + '\n';
  });
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    logs += args.map(a => (typeof a === 'string' ? a : String(a))).join(' ') + '\n';
  });
});

afterAll(() => {
  closeDb();
  delete process.env.GOODREADS_DB_PATH;
  vi.restoreAllMocks();
});

describe('runBooks', () => {
  beforeEach(() => {
    resetBooksCaches();
    const db = getDb();
    db.prepare('DELETE FROM books').run();
    db.prepare('DELETE FROM book_page').run();
    db.prepare('DELETE FROM tag_books').run();

    insertBook({ id: '1', title: 'Alpha', author: 'Smith John', ratings: 1000, avgRating: '4.5', workId: 'w-1', isWorkRep: 1 });
    insertBook({ id: '2', title: 'Beta', author: 'Jones Amy', ratings: 3000, avgRating: '3.9', workId: 'w-1', isWorkRep: 0 });
    insertBook({ id: '3', title: 'Gamma', author: 'Lee Kim', ratings: 200, avgRating: '4.9', published: '1999' });
    insertBook({ id: '4', title: 'Delta', author: 'Ross Pam', ratings: 8000, avgRating: '4.1' });

    insertPage('1', { reviews: 500, currentlyReading: 10, toRead: 900, editions: 3 });
    insertPage('4', { reviews: 9000, currentlyReading: 200, toRead: 5000, editions: 12 });

    insertTag('1', 'fantasy', 100);
    insertTag('1', 'scifi', 50);
    insertTag('4', 'mystery', 700);
  });

  it('sorts by numRatings descending by default', async () => {
    await runBooks({ limit: '3' });
    expect(logs).toContain('Sort: Number of Ratings (desc)');
    expect(logs.indexOf('Delta')).toBeLessThan(logs.indexOf('Beta'));
    expect(logs.indexOf('Beta')).toBeLessThan(logs.indexOf('Alpha'));
    expect(logs).not.toContain('Gamma');
    expect(logs).not.toContain('Ratings: 200');
  });

  it('honors --minRatings', async () => {
    await runBooks({ minRatings: '1000', sort: 'numRatings' });
    // Gamma (200) excluded; Delta, Beta, Alpha remain.
    expect(logs).toContain('Delta');
    expect(logs).toContain('Alpha');
    expect(logs).not.toContain('Gamma');
  });

  it('sorts by avgRatings and honors the avgRating alias', async () => {
    await runBooks({ sort: 'avgRatings', limit: '3' });
    // Gamma 4.9, Alpha 4.5, Delta 4.1 top three.
    expect(logs.indexOf('Gamma')).toBeLessThan(logs.indexOf('Alpha'));
    expect(logs.indexOf('Alpha')).toBeLessThan(logs.indexOf('Delta'));

    logs = '';
    await runBooks({ sort: 'avgRating', limit: '3' });
    expect(logs.indexOf('Gamma')).toBeLessThan(logs.indexOf('Alpha'));
  });

  it('sorts by numReviews using book_page data', async () => {
    await runBooks({ sort: 'numReviews', limit: '3' });
    // Delta 9000, Alpha 500, then Beta/Gamma (no page row -> 0).
    expect(logs.indexOf('Delta')).toBeLessThan(logs.indexOf('Alpha'));
    expect(logs.indexOf('Alpha')).toBeLessThan(logs.indexOf('Beta'));
    // numReviews lines now also carry the reviews/ratings ratio.
    expect(logs).toContain('reviews=9,000');
    expect(logs).toContain('rev/rat=1.125');
  });

  it('sorts by numShelves using tag_books aggregates', async () => {
    await runBooks({ sort: 'numShelves', limit: '3' });
    // Delta 700, Alpha 150 (100+50), then others 0.
    const shelvedBooks = logs.split('\n').filter(l => l.includes('shelves='));
    expect(shelvedBooks[0]).toContain('shelves=700'); // Delta
    expect(shelvedBooks[1]).toContain('shelves=150'); // Alpha
  });

  it('sorts by numTags using tag_books count', async () => {
    await runBooks({ sort: 'numTags', limit: '3' });
    // Alpha has 2 tags; Delta has 1.
    const tagBooks = logs.split('\n').filter(l => l.includes('tags='));
    expect(tagBooks[0]).toContain('tags=2'); // Alpha
    expect(tagBooks[1]).toContain('tags=1'); // Delta
  });

  it('sorts by reviewRatio (reviews / ratings)', async () => {
    await runBooks({ sort: 'reviewRatio', limit: '3' });
    // Alpha 500/1000 = 0.5; Delta 9000/8000 = 1.125 should be first.
    expect(logs.indexOf('Delta')).toBeLessThan(logs.indexOf('Alpha'));
    expect(logs).toContain('reviews=9,000');
    expect(logs).toContain('rev/rat=1.125');
  });

  it('dedupes works: keeps work representatives + un-clustered books', async () => {
    await runBooks({ sort: 'numRatings', dedupe: true, limit: '10' });
    // w-1 has two editions: id=1 (rep), id=2 (non-rep). Delta and Gamma have no work.
    expect(logs).toContain('Alpha'); // rep kept
    expect(logs).toContain('Delta'); // no work_id -> stands alone
    expect(logs).toContain('Gamma'); // no work_id -> stands alone
    expect(logs).not.toContain('Beta'); // non-rep edition collapsed away
    expect(logs).toContain('Deduplicated works: 1');
  });

  it('dedupe prefers a known English edition over the ratings rep', async () => {
    // w-1's ratings rep is id=1 (Alpha), but id=2 (Beta) is known English.
    insertPage('2', { reviews: 1, language: 'English' });
    await runBooks({ sort: 'numReviews', dedupe: true, limit: '10' });
    expect(logs).toContain('Beta'); // English edition kept
    expect(logs).not.toContain('Alpha'); // non-English ratings rep collapsed away
  });

  it('dedupe falls back to the ratings rep when no language is known', async () => {
    insertPage('1', { reviews: 500 });
    insertPage('2', { reviews: 1, language: 'Spanish; Castilian' });
    await runBooks({ sort: 'numReviews', dedupe: true, limit: '10' });
    expect(logs).toContain('Alpha'); // is_work_rep kept
    expect(logs).not.toContain('Beta'); // translation collapsed away
  });

  it('sorts by toRead and currentlyReading', async () => {
    await runBooks({ sort: 'toRead', limit: '3' });
    expect(logs.slice(0, logs.indexOf('Beta'))).toContain('Delta');
    expect(logs.indexOf('Delta')).toBeLessThan(logs.indexOf('Alpha'));

    logs = '';
    await runBooks({ sort: 'currentlyReading', limit: '3' });
    expect(logs.indexOf('Delta')).toBeLessThan(logs.indexOf('Alpha'));
  });

  it('sorts by editionCount', async () => {
    await runBooks({ sort: 'editionCount', limit: '3' });
    // Delta 12, Alpha 3.
    expect(logs.indexOf('Delta')).toBeLessThan(logs.indexOf('Alpha'));
    expect(logs).toContain('editions=12');
  });

  it('aggregates editionCount across the work when deduping', async () => {
    // w-1 has two editions: id=1 is the rep (page row has editions NULL), id=2
    // is a sibling whose page row carries an editions count (e.g. 27).
    getDb().prepare('DELETE FROM book_page WHERE book_id = ?').run('1');
    insertPage('2', { reviews: 9, currentlyReading: 3, toRead: 11, editions: 27 });

    await runBooks({ sort: 'numRatings', dedupe: true, limit: '10' });
    expect(logs).toContain('Alpha'); // rep kept even with null own-row editions

    logs = '';
    await runBooks({ sort: 'editionCount', dedupe: true, limit: '10' });
    // Alpha's work shows the max across editions (27), not 0 and not the
    // rep's own null row.
    expect(logs.indexOf('Alpha')).toBeLessThan(logs.indexOf('Gamma'));
    expect(logs).toContain('editions=27');
    expect(logs).not.toContain('editions=0');
  });

  it('sorts by derived ratings stats from the histogram', async () => {
    insertPage('1', { derived: { mean: 4.75, stddev: 0.5 } });
    insertPage('4', { derived: { mean: 3.25, stddev: 1.5 } });

    await runBooks({ sort: 'ratingsMean', limit: '3' });
    expect(logs.indexOf('Alpha')).toBeLessThan(logs.indexOf('Delta'));
    expect(logs).toContain('mean=4.750');

    logs = '';
    await runBooks({ sort: 'ratingsStddev', limit: '3' });
    expect(logs.indexOf('Delta')).toBeLessThan(logs.indexOf('Alpha'));
    expect(logs).toContain('sd=1.5000');
  });

  it('excludes books without the derived stat instead of treating it as 0', async () => {
    // Only Alpha carries a mean; Beta/Delta/Gamma have no distribution. A missing
    // stat is unknown, not 0, so those books are dropped entirely (both dirs).
    insertPage('1', { derived: { mean: 4.75 } });
    await runBooks({ sort: 'ratingsMean', limit: '4' });
    expect(logs).toContain('Alpha');
    expect(logs).not.toContain('Delta');
    expect(logs).not.toContain('Beta');
    expect(logs).not.toContain('Gamma');
    expect(logs).toContain('Total books matching: 1');
  });

  it('asc by a derived stat does not surface unknown (0) values first', async () => {
    // Regression for the reported bug: with null->0, ascending variance listed
    // distribution-less books (value 0) ahead of real low-variance books.
    insertPage('1', { derived: { variance: 1.5 } });
    insertPage('4', { derived: { variance: 0.25 } });
    await runBooks({ sort: 'ratingsVariance', asc: true, limit: '4' });
    expect(logs).toContain('Delta'); // 0.25, the real lowest
    expect(logs).toContain('Alpha'); // 1.5
    expect(logs).not.toContain('Beta'); // no distribution
    expect(logs).not.toContain('Gamma'); // no distribution
    expect(logs.indexOf('Delta')).toBeLessThan(logs.indexOf('Alpha'));
  });

  it('shows the sorted total as a histogram count', async () => {
    insertPage('4', { derived: { total: 12345 } });
    await runBooks({ sort: 'ratingsTotal', limit: '3' });
    expect(logs).toContain('total=12,345');
  });

  it('dedupes to the English edition per work when sorting by a derived stat', async () => {
    // Same as the editionCount dedupe: w-1's rep (id=1, Alpha) is not English,
    // but id=2 (Beta) is, so the work collapses to Beta regardless of sort key.
    insertPage('1', { derived: { mean: 4.9 } });
    insertPage('2', { language: 'English', derived: { mean: 4.2 } });
    await runBooks({ sort: 'ratingsMean', dedupe: true, limit: '10' });
    expect(logs).toContain('Beta');
    expect(logs).not.toContain('Alpha');
    expect(logs).toContain('mean=4.200');
  });
});