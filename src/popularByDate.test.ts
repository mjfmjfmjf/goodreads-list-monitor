import { describe, it, expect } from 'vitest';
import {
  pageKeyFor,
  topListNameFor,
  pageUrlFor,
  buildPageKeys,
  isClient404,
  parseTopListRows,
  shouldSkipPage,
  distinctIdsFromRows,
} from './popularByDate.js';

describe('distinctIdsFromRows', () => {
  it('dedupes book ids preserving rank order and drops junk', () => {
    expect(
      distinctIdsFromRows([
        { book_id: '3', rank: 3, count: 1, title: 'c' },
        { book_id: '1', rank: 1, count: 1, title: 'a' },
        { book_id: '3', rank: 5, count: 1, title: 'c again' },
        { book_id: 'undefined', rank: 2, count: 1, title: 'junk' },
        { book_id: '', rank: 4, count: 1, title: 'empty' },
        { book_id: '2', rank: 2, count: 1, title: 'b' },
      ])
    ).toEqual(['3', '1', '2']);
  });

  it('returns empty for empty input', () => {
    expect(distinctIdsFromRows([])).toEqual([]);
    expect(distinctIdsFromRows(undefined as any)).toEqual([]);
  });
});

describe('pageKeyFor / topListNameFor / pageUrlFor', () => {
  it('builds year page keys and URLs', () => {
    expect(pageKeyFor(2012)).toBe('2012');
    expect(topListNameFor('2012')).toBe('works-by-release-date-2012');
    expect(pageUrlFor('2012')).toBe('https://www.goodreads.com/book/popular_by_date/2012');
  });

  it('builds month page keys with bare months and books query names', () => {
    expect(pageKeyFor(2026, 9)).toBe('2026-9');
    expect(topListNameFor('2026-9')).toBe('books-by-release-date-2026-9');
    expect(pageUrlFor('2026-9')).toBe('https://www.goodreads.com/book/popular_by_date/2026/9');
    expect(pageKeyFor(2026, 10)).toBe('2026-10');
    expect(topListNameFor('2026-10')).toBe('books-by-release-date-2026-10');
  });
});

describe('buildPageKeys', () => {
  const nov2026 = new Date(2026, 10, 15); // November 2026

  it('walks the anchored month page before the anchor year page', () => {
    expect(buildPageKeys({ monthBack: 1, month: 9, year: 2026 })).toEqual(['2026-9', '2026']);
  });

  it('walks the current month before the current year by default', () => {
    expect(buildPageKeys({}, nov2026)).toEqual(['2026-11', '2026']);
  });

  it('walks months interleaved: each year\u2019s months then that year page', () => {
    expect(buildPageKeys({ yearBack: 2 }, nov2026)).toEqual(['2026-11', '2026', '2025', '2024']);
  });

  it('rolls month keys backward across year boundaries', () => {
    expect(buildPageKeys({ monthBack: 3, month: 1, year: 2026 })).toEqual(['2026-1', '2026', '2025-12', '2025-11']);
  });

  it('supports explicit year + month override', () => {
    expect(buildPageKeys({ year: 2012 }, nov2026)).toEqual(['2012-11', '2012']);
  });
});

describe('isClient404', () => {
  it('detects the Goodreads client-side 404 title', () => {
    expect(isClient404('404: This page could not be found')).toBe(true);
    expect(isClient404('Popular By Date | Goodreads')).toBe(false);
  });
});

describe('parseTopListRows', () => {
  it('parses TopListBookEdge rows (month pages)', () => {
    const pages = [
      {
        edges: [
          {
            __typename: 'TopListBookEdge',
            rank: 1,
            count: 226422,
            node: {
              legacyId: 241564688,
              title: 'The Knave and the Moon',
              __typename: 'Book',
              work: {
                id: 'kca://work/amzn1.gr.work.v3.pXUNrQ1_EDlaVHYc',
                stats: { ratingsCount: 39004, textReviewsCount: 8591, averageRating: 4.3, __typename: 'BookOrWorkStats' },
              },
            },
          },
        ],
      },
    ];
    expect(parseTopListRows(pages)).toEqual([
      {
        book_id: '241564688',
        rank: 1,
        count: 226422,
        title: 'The Knave and the Moon',
        work_id: 'kca://work/amzn1.gr.work.v3.pXUNrQ1_EDlaVHYc',
        stats_ratings: 39004,
        stats_reviews: 8591,
        stats_avg: 4.3,
      },
    ]);
  });

  it('parses TopListWorkEdge rows (year pages, bestBook indirection)', () => {
    const pages = [
      {
        edges: [
          {
            __typename: 'TopListWorkEdge',
            rank: 1,
            count: 8821374,
            node: {
              id: 'kca://work/amzn1.gr.work.v1.ZWeA15QphzWjRB87CLg-TA',
              __typename: 'Work',
              stats: { ratingsCount: 5888479, textReviewsCount: 191516, averageRating: 4.12, __typename: 'BookOrWorkStats' },
              details: {
                bestBook: { legacyId: 25856606, title: 'The Fault in Our Stars', __typename: 'Book' },
                __typename: 'WorkDetails',
              },
            },
          },
        ],
      },
    ];
    expect(parseTopListRows(pages)).toEqual([
      {
        book_id: '25856606',
        rank: 1,
        count: 8821374,
        title: 'The Fault in Our Stars',
        work_id: 'kca://work/amzn1.gr.work.v1.ZWeA15QphzWjRB87CLg-TA',
        stats_ratings: 5888479,
        stats_reviews: 191516,
        stats_avg: 4.12,
      },
    ]);
  });

  it('drops edges with no usable book id', () => {
    const pages = [
      { edges: [{ __typename: 'TopListUserEdge', rank: 5, node: { name: 'someone' } }] },
      { edges: [{ __typename: 'TopListBookEdge', rank: 3, node: { legacyId: undefined, work: {} } }] },
    ];
    expect(parseTopListRows(pages)).toEqual([]);
  });

  it('handles empty / nullish payloads', () => {
    expect(parseTopListRows([])).toEqual([]);
    expect(parseTopListRows(undefined as any)).toEqual([]);
    expect(parseTopListRows([null, { edges: null }, { edges: [] }])).toEqual([]);
  });
});

describe('shouldSkipPage', () => {
  const now = '2026-11-15T00:00:00Z';
  it('skips pages scraped within the window, not older ones', () => {
    expect(shouldSkipPage('2026-11-14T00:00:00Z', now, 7)).toBe(true);
    expect(shouldSkipPage('2026-11-01T00:00:00Z', now, 7)).toBe(false);
  });
  it('never skips when skipDays <= 0', () => {
    expect(shouldSkipPage('2026-11-14T00:00:00Z', now, 0)).toBe(false);
  });
  it('handles unparseable timestamps', () => {
    expect(shouldSkipPage('not-a-date', now, 7)).toBe(false);
  });
});