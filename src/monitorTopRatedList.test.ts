import { describe, expect, it } from 'vitest';

import type { CachedBook } from './storage.js';
import {
  computeTopRated,
  diffTopRated,
  extractSeriesName,
  normalizeSeriesName,
  isBoxSet,
} from './monitorTopRatedList.js';
import { SERIES_POS_MULTI } from './seriesPos.js';
import type { UserVoteEntry } from './scraper.js';

function book(id: string, over: Partial<CachedBook> = {}): CachedBook {
  return {
    id,
    title: over.title ?? `Book ${id}`,
    author: over.author ?? 'Some Author',
    ratings: over.ratings ?? '10000',
    avgRating: over.avgRating ?? '4.5',
    published: over.published ?? '2000',
    seriesPos: over.seriesPos,
    lastUpdated: '2026-01-01',
    workId: over.workId ?? `work-${id}`,
    ...over,
  };
}

function vote(position: number, bookId: string, title = `Book ${bookId}`, author = 'Author'): UserVoteEntry {
  return { position, bookId, title, author };
}

describe('extractSeriesName', () => {
  it('parses the series name from the "(Name, #N)" suffix', () => {
    expect(extractSeriesName('Oathbringer (The Stormlight Archive, #3)')).toBe('The Stormlight Archive');
  });
  it('handles parts ("#2, Part 1 of 2")', () => {
    expect(extractSeriesName('Words of Radiance, Part 2 (The Stormlight Archive, #2, Part 2 of 2)')).toBe('The Stormlight Archive');
  });
  it('accepts the "(Name #N)" form without a comma', () => {
    expect(extractSeriesName('The Way of Kings, Part 2 (The Stormlight Archive #1, Part 2 of 2)')).toBe('The Stormlight Archive');
    expect(extractSeriesName('Light Bringer (Red Rising #6)')).toBe('Red Rising');
  });
  it('extracts series from manga "Vol. N" titles', () => {
    expect(extractSeriesName('Heaven Official\'s Blessing: Tian Guan Ci Fu (Novel) Vol. 8')).toBe('Heaven Official\'s Blessing: Tian Guan Ci Fu');
    expect(extractSeriesName('Berserk, Vol. 12 (Paperback)')).toBe('Berserk');
  });
  it('returns undefined for standalone titles', () => {
    expect(extractSeriesName('The Martian')).toBeUndefined();
    expect(extractSeriesName('Nonfiction Book')).toBeUndefined();
  });
  it('returns undefined for non-series parentheticals (edition/format)', () => {
    expect(extractSeriesName('The Martian (Hardcover)')).toBeUndefined();
    expect(extractSeriesName('Some Book (Paperback)')).toBeUndefined();
  });
  it('drops Deluxe/format tokens from manga volume series base', () => {
    expect(extractSeriesName('Berserk Deluxe Edition, Vol. 2 (Hardcover)')).toBe('Berserk');
  });
});

describe('normalizeSeriesName', () => {
  it('lowercases, trims, collapses whitespace, drops leading "the"', () => {
    expect(normalizeSeriesName('  The  STORMLIGHT   ARCHIVE  ')).toBe('stormlight archive');
    expect(normalizeSeriesName('throne of glass')).toBe('throne of glass');
  });
});

describe('isBoxSet', () => {
  it('flags seriesPos == MULTI', () => {
    expect(isBoxSet(book('x', { seriesPos: SERIES_POS_MULTI }))).toBe(true);
    expect(isBoxSet(book('y', { seriesPos: 2 }))).toBe(false);
    expect(isBoxSet(book('z'))).toBe(false);
  });
});

describe('computeTopRated', () => {
  it('returns books meeting the min ratings threshold, ranked by avg rating desc', () => {
    const grouped = computeTopRated([
      book('1', { avgRating: '4.6', ratings: '20000' }),
      book('2', { avgRating: '4.9', ratings: '15000' }),
      book('3', { avgRating: '4.8', ratings: '5000' }), // below min ratings → excluded
    ]);
    expect(grouped.approved.map(r => r.book.id)).toEqual(['2', '1']);
  });

  it('excludes box sets', () => {
    const grouped = computeTopRated([
      book('box', { title: 'Harry Potter Box Set (Harry Potter, #1-7)', seriesPos: SERIES_POS_MULTI, avgRating: '4.9' }),
      book('single', { avgRating: '4.8' }),
    ]);
    expect(grouped.approved.map(r => r.book.id)).toEqual(['single']);
    expect(grouped.excluded).toEqual([expect.objectContaining({ reason: 'box-set' })]);
  });

  it('collapses edition variants by workId, keeping the highest avg rating', () => {
    const grouped = computeTopRated([
      book('a', { workId: 'w1', avgRating: '4.7', ratings: '30000' }),
      book('b', { workId: 'w1', avgRating: '4.9', ratings: '20000' }),
    ]);
    expect(grouped.approved.map(r => r.book.id)).toEqual(['b']);
    expect(grouped.excluded).toEqual([expect.objectContaining({ reason: 'duplicate-edition' })]);
  });

  it('excludes books without a work_id entirely', () => {
    const grouped = computeTopRated([
      book('with', { workId: 'w1', avgRating: '4.8' }),
      book('without', { workId: undefined, avgRating: '4.9' }),
    ]);
    expect(grouped.approved.map(r => r.book.id)).toEqual(['with']);
    expect(grouped.excluded).toEqual([expect.objectContaining({ book: expect.objectContaining({ id: 'without' }), reason: 'missing-work-id' })]);
  });

  it('keeps only the highest-rated book per series', () => {
    const grouped = computeTopRated([
      book('s1', { title: 'Oathbringer (The Stormlight Archive, #3)', avgRating: '4.6' }),
      book('s2', { title: 'Words of Radiance (The Stormlight Archive, #2)', avgRating: '4.8' }),
      book('s3', { title: 'The Way of Kings (The Stormlight Archive, #1)', avgRating: '4.5' }),
      book('standalone', { title: 'The Martian', avgRating: '4.4' }),
    ]);
    expect(grouped.approved.map(r => r.book.id)).toEqual(['s2', 'standalone']);
    expect(grouped.excluded.map(e => e.book.id)).toEqual(expect.arrayContaining(['s1', 's3']));
    expect(grouped.excluded.map(e => e.reason)).toEqual(expect.arrayContaining(['series']));
  });

  it('respects a custom limit', () => {
    const grouped = computeTopRated(
      [book('1', { avgRating: '4.9' }), book('2', { avgRating: '4.8' }), book('3', { avgRating: '4.7' })],
      { limit: 2 }
    );
    expect(grouped.approved).toHaveLength(2);
    expect(grouped.approved[0].rank).toBe(1);
    expect(grouped.approved[1].rank).toBe(2);
  });
});

describe('diffTopRated', () => {
  const ranked = [
    { book: book('a', { avgRating: '4.9' }), rank: 1, avgRating: 4.9, ratings: 20000 },
    { book: book('b', { avgRating: '4.8' }), rank: 2, avgRating: 4.8, ratings: 19000 },
    { book: book('c', { avgRating: '4.7' }), rank: 3, avgRating: 4.7, ratings: 18000 },
  ];

  it('reports dropped voted books that are no longer in the top-N', () => {
    const { dropped } = diffTopRated([vote(1, 'a'), vote(2, 'zzz')], ranked as any, 3);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].bookId).toBe('zzz');
    expect(dropped[0].position).toBe(2);
  });

  it('reports qualifying ranked books missing from votes', () => {
    const { additions } = diffTopRated([vote(1, 'a'), vote(2, 'b')], ranked as any, 3);
    expect(additions.map(r => r.book.id)).toEqual(['c']);
  });

  it('reports moves when voted books are in different positions than their rank', () => {
    // votes: a@3, b@1, c@2; ranking: a@1, b@2, c@3 — a full rotation.
    const { moves } = diffTopRated([vote(3, 'a'), vote(1, 'b'), vote(2, 'c')], ranked as any, 3);
    expect(moves.map(m => ({ id: m.bookId, from: m.position, to: m.targetRank }))).toEqual([
      { id: 'b', from: 1, to: 2 },
      { id: 'c', from: 2, to: 3 },
      { id: 'a', from: 3, to: 1 },
    ]);
  });

  it('reports nothing when votes match the ranking exactly', () => {
    const { dropped, additions, moves } = diffTopRated([vote(1, 'a'), vote(2, 'b'), vote(3, 'c')], ranked as any, 3);
    expect(dropped).toHaveLength(0);
    expect(additions).toHaveLength(0);
    expect(moves).toHaveLength(0);
  });
});