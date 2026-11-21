import { afterAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-rescrape-top-works-${process.pid}-${Date.now()}.db`;
});

import {
  dedupeWorkCandidates,
  selectRescrapeCandidates,
  type EnglishWorkCandidate,
} from './rescrapeTopWorks.ts';
import { closeDb } from './db.ts';

afterAll(() => closeDb());

const NOW = Date.UTC(2026, 10, 18, 12);
const DAYS = 86_400_000;

function work(bookId: string, values: Partial<EnglishWorkCandidate> = {}): EnglishWorkCandidate {
  return {
    bookId,
    workId: `w${bookId}`,
    title: `Title ${bookId}`,
    author: 'Author',
    authorId: '',
    ratings: 0,
    reviews: 0,
    currentlyReading: 0,
    toRead: 0,
    editions: 0,
    lastScrapeStatus: null,
    lastScrapedAt: null,
    ...values,
  };
}

describe('selectRescrapeCandidates', () => {
  it('unions the top N of all five metrics, not a combined ranking', () => {
    const works: EnglishWorkCandidate[] = [
      work('11', { ratings: 100 }), work('12', { ratings: 90 }),
      work('21', { reviews: 100 }), work('22', { reviews: 90 }),
      work('31', { currentlyReading: 100 }), work('32', { currentlyReading: 90 }),
      work('41', { toRead: 100 }), work('42', { toRead: 90 }),
      work('51', { editions: 100 }), work('52', { editions: 90 }),
    ];
    const result = selectRescrapeCandidates(works, 2, 3, NOW);
    expect(result.unionSize).toBe(10);
    expect(result.bookIds).toEqual(['11', '12', '21', '22', '31', '32', '41', '42', '51', '52']);
    for (const ids of Object.values(result.topByMetric)) expect(ids).toHaveLength(2);
  });

  it('breaks metric ties on lower book id and treats missing values as zero', () => {
    const works = [work('30', { ratings: 10 }), work('20', { ratings: 10 }), work('10', { ratings: 10 })];
    const result = selectRescrapeCandidates(works, 1, 3, NOW);
    expect(result.topByMetric.ratings).toEqual(['10']);
    // Other metrics are all 0, so their top-1 is also the lowest id.
    expect(result.unionSize).toBe(1);
  });

  it('skips only successful scrapes inside the recency window', () => {
    const works = [
      work('1', { ratings: 500, lastScrapeStatus: 'ok', lastScrapedAt: new Date(NOW - 1 * DAYS).toISOString() }),
      work('2', { reviews: 400, lastScrapeStatus: 'ok', lastScrapedAt: new Date(NOW - 4 * DAYS).toISOString() }),
      work('3', { currentlyReading: 300, lastScrapeStatus: 'throttled', lastScrapedAt: new Date(NOW - 1 * DAYS).toISOString() }),
      work('4', { toRead: 200, lastScrapeStatus: 'ok', lastScrapedAt: 'not a date' }),
      work('5', { editions: 100, lastScrapeStatus: 'ok', lastScrapedAt: new Date(NOW - 3 * DAYS).toISOString() }),
    ];
    const result = selectRescrapeCandidates(works, 1, 3, NOW);
    expect(result.unionSize).toBe(5);
    // Exactly 3 days old is NOT "more recent than 3 days", so #5 is eligible.
    expect(result.freshSkipped).toBe(1);
    expect(result.bookIds).toEqual(['2', '3', '4', '5']);
  });

  it('respects a zero recency window and a zero top-N', () => {
    const works = [work('1', { ratings: 5, lastScrapeStatus: 'ok', lastScrapedAt: new Date(NOW).toISOString() })];
    expect(selectRescrapeCandidates(works, 1, 0, NOW).bookIds).toEqual(['1']);
    expect(selectRescrapeCandidates(works, 0, 3, NOW).unionSize).toBe(0);
  });
});

describe('dedupeWorkCandidates', () => {
  it('keeps the highest-rated edition for duplicate work ids with the same title and author', () => {
    const rows = [
      work('20', { workId: 'dup', title: 'Harry Potter #3', author: 'J.K. Rowling', ratings: 100 }),
      work('10', { workId: 'dup2', title: 'Harry Potter #3 (Unabridged)', author: 'J.K. Rowling', ratings: 200 }),
      work('30', { workId: 'other', title: 'A Different Book', author: ' Someone Else ', ratings: 50 }),
    ];
    const result = dedupeWorkCandidates(rows);
    expect(result.map((row) => row.bookId)).toEqual(['10', '30']);
  });

  it('keeps same-titled works by different author ids apart', () => {
    const rows = [
      work('1', { title: 'The Odyssey', author: 'Homer', authorId: 'A1', ratings: 100 }),
      work('2', { title: 'The Odyssey', author: 'Someone Else', authorId: 'A2', ratings: 90 }),
    ];
    expect(dedupeWorkCandidates(rows).map((row) => row.bookId)).toEqual(['1', '2']);
  });
});
