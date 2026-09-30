import { describe, expect, it } from 'vitest';
import { selectRecentAuthors, newestYearSortKey } from './authorRecent.js';
import type { AuthorCacheEntry } from './storage.js';

const entry = (id: string, extra: Partial<AuthorCacheEntry> = {}): AuthorCacheEntry => ({
  id,
  slug: `${id}.slug`,
  lastSeen: '2026-01-01T00:00:00.000Z',
  ...extra,
});

const bk = (newestYear: number, books = 1, topRatings = 900): { topRatings: number; newestYear: number; books: number } => ({
  topRatings,
  newestYear,
  books,
});

describe('selectRecentAuthors', () => {
  const base = { limit: 10 };

  it('sorts authors with recent books from most to least ratings', () => {
    const cache = {
      a1: entry('1', { numRatings: '100' }),
      a2: entry('2', { numRatings: '900' }),
      a3: entry('3', { numRatings: '500' }),
    };
    const bookStats = {
      '1': bk(2026),
      '2': bk(2026),
      '3': bk(2026),
    };
    const out = selectRecentAuthors(cache, { ...base, bookStats });
    expect(out.map((o) => o.name)).toEqual(['a2', 'a3', 'a1']);
  });

  it('excludes authors with no qualifying recent book', () => {
    const cache = {
      a1: entry('1', { numRatings: '100000' }),
      a2: entry('2', { numRatings: '10' }),
    };
    const bookStats = { '1': bk(2026) };
    const out = selectRecentAuthors(cache, { ...base, bookStats });
    expect(out.map((o) => o.name)).toEqual(['a1']);
  });

  it('includes untracked-authors (no ratings) that own a recent book, sorting them last', () => {
    const cache = {
      a1: entry('1', { numRatings: '0' }),
      a2: entry('2', { numRatings: '7' }),
    };
    const bookStats = {
      '1': bk(2026),
      '2': bk(2026),
    };
    const out = selectRecentAuthors(cache, { ...base, bookStats });
    expect(out.map((o) => o.name)).toEqual(['a2', 'a1']);
  });

  it('tie-breaks equal ratings by newer qualifying book, then name', () => {
    const cache = {
      aaa: entry('1', { numRatings: '50' }),
      bbb: entry('2', { numRatings: '50' }),
      ccc: entry('3', { numRatings: '50' }),
    };
    const bookStats = {
      '1': bk(2020),
      '2': bk(2026),
      '3': bk(2026),
    };
    const out = selectRecentAuthors(cache, { ...base, bookStats });
    expect(out.map((o) => o.name)).toEqual(['bbb', 'ccc', 'aaa']);
  });

  it('respects the limit', () => {
    const cache = {
      a1: entry('1', { numRatings: '300' }),
      a2: entry('2', { numRatings: '200' }),
      a3: entry('3', { numRatings: '100' }),
    };
    const bookStats = {
      '1': bk(2026),
      '2': bk(2026),
      '3': bk(2026),
    };
    const out = selectRecentAuthors(cache, { ...base, limit: 2, bookStats });
    expect(out.map((o) => o.name)).toEqual(['a1', 'a2']);
  });
});

describe('newestYearSortKey', () => {
  it('keeps past/current years as-is and buckets all future years together above now', () => {
    expect(newestYearSortKey(2024, 2026)).toBe(2024);
    expect(newestYearSortKey(2026, 2026)).toBe(2026);
    expect(newestYearSortKey(2027, 2026)).toBe(2027);
    expect(newestYearSortKey(2029, 2026)).toBe(2027); // future shares the "2027+" equal bucket
    expect(newestYearSortKey(2600, 2026)).toBe(2027); // BCE-encoded year also future-bucketed
  });
});

describe('selectRecentAuthors — sortBy newestYear', () => {
  const base = { limit: 10, now: 2026, sortBy: 'newestYear' as const };

  it('sorts newest qualifying book first, future years equal, then current, then back', () => {
    const cache = {
      old: entry('1', { numRatings: '5' }),
      current: entry('2', { numRatings: '900' }),
      future2027: entry('3', { numRatings: '100' }),
      future2030: entry('4', { numRatings: '2' }),
    };
    const bookStats = {
      '1': bk(2020),
      '2': bk(2026),
      '3': bk(2027),
      '4': bk(2030),
    };
    const out = selectRecentAuthors(cache, { ...base, bookStats });
    // future bucket is shared (2027 & 2030 both map to "2027+"); their year key
    // is identical so topRatings (identical here), then name, decides; then 2026, then 2020
    expect(out.map((o) => o.name)).toEqual(['future2027', 'future2030', 'current', 'old']);
  });

  it('tie-breaks equal newest year by top book ratings, not author-page numRatings', () => {
    const cache = {
      lowRatings: entry('1', { numRatings: '0' }),   // untouched author, author page not scraped
      top: entry('2', { numRatings: '0' }),
      mid: entry('3', { numRatings: '0' }),
    };
    const bookStats = {
      '1': bk(2027, 5, 100),   // low book ratings
      '2': bk(2027, 5, 900),   // high book ratings
      '3': bk(2027, 5, 500),   // mid book ratings
    };
    const out = selectRecentAuthors(cache, { ...base, bookStats });
    expect(out.map((o) => o.name)).toEqual(['top', 'mid', 'lowRatings']);
  });

  it('falls back to name when top book ratings tie', () => {
    const cache = {
      zed: entry('1', { numRatings: '0' }),
      aaa: entry('2', { numRatings: '0' }),
    };
    const bookStats = {
      '1': bk(2027, 5, 500),
      '2': bk(2027, 5, 500),
    };
    const out = selectRecentAuthors(cache, { ...base, bookStats });
    expect(out.map((o) => o.name)).toEqual(['aaa', 'zed']);
  });

  it('limit applies to the year-first ordering', () => {
    const cache = {
      a: entry('1', { numRatings: '10' }),
      b: entry('2', { numRatings: '10' }),
      c: entry('3', { numRatings: '10' }),
    };
    const bookStats = {
      '1': bk(2028),
      '2': bk(2026),
      '3': bk(2025),
    };
    const out = selectRecentAuthors(cache, { ...base, limit: 2, bookStats });
    expect(out.map((o) => o.name)).toEqual(['a', 'b']);
  });
});