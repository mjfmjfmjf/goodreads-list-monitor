import { describe, expect, it } from 'vitest';
import { selectMultiPageAuthors } from './authorRescan.js';
import type { AuthorCacheEntry } from './storage.js';

const entry = (id: string, extra: Partial<AuthorCacheEntry> = {}): AuthorCacheEntry => ({
  id,
  slug: `${id}.slug`,
  lastSeen: '2026-01-01T00:00:00.000Z',
  ...extra,
});

const base = {
  limit: 10,
  minRatings: 0,
  maxRatings: Infinity,
  onlyUntouched: true,
};

describe('selectMultiPageAuthors', () => {
  it('sorts by the author top-book ratings when sortBy=topRatings', () => {
    const cache = {
      a1: entry('1'),
      a2: entry('2'),
      a3: entry('3'),
    };
    const bookStats = {
      '3': { topRatings: 1000, newestYear: 2020, books: 1 },
      '1': { topRatings: 42, newestYear: 2020, books: 1 },
      '2': { topRatings: 5, newestYear: 2020, books: 1 },
    };
    const out = selectMultiPageAuthors(cache, { ...base, sortBy: 'topRatings', bookStats });
    expect(out.map((o) => o.name)).toEqual(['a3', 'a1', 'a2']);
  });

  it('sorts authors with no qualifying book to the bottom (excluded)', () => {
    const cache = {
      a1: entry('1'),
      a2: entry('2'),
    };
    const bookStats = { '1': { topRatings: 900, newestYear: 2020, books: 1 } };
    const out = selectMultiPageAuthors(cache, { ...base, sortBy: 'topRatings', bookStats });
    // a2 has no qualifying book in the aggregation → filtered out entirely.
    expect(out.map((o) => o.name)).toEqual(['a1']);
  });

  it('minRatings filters on the top-book rating in topRatings mode', () => {
    const cache = {
      a1: entry('1'),
      a2: entry('2'),
      a3: entry('3'),
    };
    const bookStats = {
      '1': { topRatings: 5, newestYear: 2020, books: 1 },
      '2': { topRatings: 500, newestYear: 2020, books: 1 },
      '3': { topRatings: 42, newestYear: 2020, books: 1 },
    };
    const out = selectMultiPageAuthors(cache, {
      ...base,
      sortBy: 'topRatings',
      bookStats,
      minRatings: 100,
    });
    expect(out.map((o) => o.name)).toEqual(['a2']);
  });

  it('onlyUntouched keeps only never-multi-page-crawled authors (no catalogPages)', () => {
    const cache = {
      done: entry('10', { catalogPages: 5 }),
      single: entry('11', { catalogPages: 1 }),
      todo: entry('12'),
      todo2: entry('13'),
    };
    const bookStats = {
      '10': { topRatings: 99999, newestYear: 2020, books: 1 },
      '11': { topRatings: 88888, newestYear: 2020, books: 1 },
      '12': { topRatings: 40, newestYear: 2020, books: 1 },
      '13': { topRatings: 20, newestYear: 2020, books: 1 },
    };
    const out = selectMultiPageAuthors(cache, { ...base, sortBy: 'topRatings', bookStats });
    expect(out.map((o) => o.name)).toEqual(['todo', 'todo2']);
  });

  it('without onlyUntouched includes catalogPages>=2 authors but never single-page catalogs', () => {
    const cache = {
      done: entry('10', { catalogPages: 5 }),
      single: entry('11', { catalogPages: 1 }),
      unknown: entry('12'),
    };
    const bookStats = {
      '10': { topRatings: 99999, newestYear: 2020, books: 1 },
      '11': { topRatings: 88888, newestYear: 2020, books: 1 },
      '12': { topRatings: 1, newestYear: 2020, books: 1 },
    };
    const out = selectMultiPageAuthors(cache, {
      limit: 10,
      sortBy: 'topRatings',
      bookStats,
      minRatings: 0,
      maxRatings: Infinity,
      onlyUntouched: false,
    });
    expect(out.map((o) => o.name)).toEqual(['done', 'unknown']);
  });

  it('limit slices the sorted selection', () => {
    const cache = { a1: entry('1'), a2: entry('2'), a3: entry('3') };
    const bookStats = {
      '1': { topRatings: 30, newestYear: 2020, books: 1 },
      '2': { topRatings: 20, newestYear: 2020, books: 1 },
      '3': { topRatings: 10, newestYear: 2020, books: 1 },
    };
    const out = selectMultiPageAuthors(cache, { ...base, sortBy: 'topRatings', bookStats, limit: 2 });
    expect(out.map((o) => o.name)).toEqual(['a1', 'a2']);
  });

  it('sorts by newest qualifying book year with sortBy=newestYear', () => {
    const cache = { a1: entry('1'), a2: entry('2'), a3: entry('3') };
    const bookStats = {
      '1': { topRatings: 100, newestYear: 2018, books: 1 },
      '2': { topRatings: 500, newestYear: 2023, books: 1 },
      '3': { topRatings: 999, newestYear: 2015, books: 1 },
    };
    const out = selectMultiPageAuthors(cache, { ...base, sortBy: 'newestYear', bookStats });
    expect(out.map((o) => o.name)).toEqual(['a2', 'a1', 'a3']);
  });

  it('newestYear excludes authors with no qualifying book', () => {
    const cache = { a1: entry('1'), a2: entry('2') };
    const bookStats = { '1': { topRatings: 100, newestYear: 2023, books: 1 } };
    const out = selectMultiPageAuthors(cache, { ...base, sortBy: 'newestYear', bookStats });
    expect(out.map((o) => o.name)).toEqual(['a1']);
  });
});