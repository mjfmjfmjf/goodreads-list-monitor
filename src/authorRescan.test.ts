import { describe, expect, it } from 'vitest';
import { selectMultiPageAuthors, selectStatlessAuthors } from './authorRescan.ts';
import { selectAuthors } from './authorTopStats.ts';
import { authorScrapeRef, buildAuthorListUrl, describeAuthorId } from './scraper.ts';
import type { AuthorCacheEntry } from './storage.ts';

const entry = (id: string, extra: Partial<AuthorCacheEntry> = {}): AuthorCacheEntry => ({
  id,
  slug: `${id}.slug`,
  lastSeen: '2026-01-01T00:00:00.000Z',
  ...extra,
});

// A mint-only row: id + display name, no slug until the first author-page scrape.
const minted = (id: string, name: string): AuthorCacheEntry => ({
  id,
  name,
  slug: undefined as unknown as string,
  lastSeen: '2026-01-01T00:00:00.000Z',
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

describe('selectMultiPageAuthors with missingField', () => {
  const opts = { ...base, onlyUntouched: false };

  it('selects scraped authors missing the target count field, skips others', () => {
    const cache = {
      missR: entry('1', { averageRating: '4.5', numRatings: '0', numReviews: '1', numShelves: '100' }),
      hasR: entry('2', { averageRating: '4.5', numRatings: '5' }),
      noAvg: entry('3', { numRatings: '0' }),
      unscraped: entry('4'),
    };
    const out = selectMultiPageAuthors(cache, { ...opts, sortBy: 'numRatings', missingField: 'ratings' });
    expect(out.map((o) => o.name)).toEqual(['missR']);
  });

  it('targets each requested field independently', () => {
    const cache = {
      noShelves: entry('1', { averageRating: '4.67', numRatings: '3', numReviews: '14', numShelves: '0' }),
      noReviews: entry('2', { averageRating: '5.0', numRatings: '2', numReviews: '0', numShelves: '4408' }),
      fine: entry('3', { averageRating: '4.2', numRatings: '9', numReviews: '2', numShelves: '50' }),
    };
    expect(selectMultiPageAuthors(cache, { ...opts, sortBy: 'numRatings', missingField: 'shelves' }).map(o => o.name)).toEqual(['noShelves']);
    expect(selectMultiPageAuthors(cache, { ...opts, sortBy: 'numRatings', missingField: 'reviews' }).map(o => o.name)).toEqual(['noReviews']);
    expect(selectMultiPageAuthors(cache, { ...opts, sortBy: 'numRatings', missingField: 'ratings' })).toEqual([]);
  });

  it('orders misses by top-book ratings and applies minRatings (topRatings sort)', () => {
    const cache = {
      small: entry('1', { averageRating: '4.0', numRatings: '0' }),
      big: entry('2', { averageRating: '4.5', numRatings: '0' }),
      withRatings: entry('3', { averageRating: '4.6', numRatings: '777' }),
    };
    const bookStats = {
      '1': { topRatings: 5, newestYear: 2020, books: 1 },
      '2': { topRatings: 5000, newestYear: 2020, books: 1 },
      '3': { topRatings: 99999, newestYear: 2020, books: 1 },
    };
    const out = selectMultiPageAuthors(cache, { ...opts, sortBy: 'topRatings', bookStats, missingField: 'ratings' });
    expect(out.map((o) => o.name)).toEqual(['big', 'small']);
  });

  it('sorts by per-day ratings growth, NULL-rate authors last, minRatings filtering numRatings', () => {
    const cache = {
      fast: entry('1', { numRatings: '1,000', ratingsRate: 88.5 }),
      mid: entry('2', { numRatings: '5,000', ratingsRate: 12.3 }),
      noRate: entry('3', { numRatings: '9,000' }),
    };
    const all = selectMultiPageAuthors(cache, { ...base, sortBy: 'ratingsRate' });
    expect(all.map((o) => o.name)).toEqual(['fast', 'mid', 'noRate']);
    // --minRatings still filters on the author-page rating count, so a tiny
    // but fast-growing author is excluded.
    const filtered = selectMultiPageAuthors(cache, { ...base, sortBy: 'ratingsRate', minRatings: 5000 });
    expect(filtered.map((o) => o.name)).toEqual(['mid', 'noRate']);
  });
});

describe('selectStatlessAuthors (--rescanMissing)', () => {
  // The bug this replaces: the path mapped every statless author with value 0
  // and applied neither a sort nor a slice, so `--limit N` scraped the entire
  // tail in insertion order while the header claimed "limit N".
  const bookStats = {
    '1': { topRatings: 10, newestYear: 2020, books: 1 },
    '2': { topRatings: 900, newestYear: 2020, books: 3 },
    '3': { topRatings: 450, newestYear: 2020, books: 2 },
  };

  it('honors --limit instead of returning the whole statless tail', () => {
    const cache = {
      a: minted('1', 'A'),
      b: minted('2', 'B'),
      c: minted('3', 'C'),
    };
    expect(selectStatlessAuthors(cache, { ...base, sortBy: 'topRatings', bookStats })).toHaveLength(3);
    expect(selectStatlessAuthors(cache, { ...base, sortBy: 'topRatings', bookStats, limit: 2 })).toHaveLength(2);
    expect(selectStatlessAuthors(cache, { ...base, sortBy: 'topRatings', bookStats, limit: 1 })).toHaveLength(1);
  });

  it('orders by top-book ratings, not by the always-zero author-page numRatings', () => {
    const cache = {
      small: minted('1', 'small'),
      big: minted('2', 'big'),
      mid: minted('3', 'mid'),
    };
    const out = selectStatlessAuthors(cache, { ...base, sortBy: 'topRatings', bookStats });
    expect(out.map((o) => o.name)).toEqual(['big', 'mid', 'small']);
  });

  it('includes statless authors that have no book rows (unlike the multiPage path)', () => {
    const cache = {
      hasBooks: minted('2', 'hasBooks'),
      noBooks: minted('9', 'noBooks'),
    };
    const out = selectStatlessAuthors(cache, { ...base, sortBy: 'topRatings', bookStats });
    // Sorted to the bottom, not dropped: an author-page-only row is still statless.
    expect(out.map((o) => o.name)).toEqual(['hasBooks', 'noBooks']);
  });

  it('skips authors that already have any author-page stats', () => {
    const cache = {
      statless: minted('1', 'statless'),
      hasAvg: entry('2', { averageRating: '4.1' }),
      hasRatings: entry('3', { numRatings: '12' }),
      hasReviews: entry('4', { numReviews: '3' }),
      hasShelves: entry('5', { numShelves: '900' }),
    };
    const out = selectStatlessAuthors(cache, { ...base, sortBy: 'topRatings', bookStats });
    expect(out.map((o) => o.name)).toEqual(['statless']);
  });

  it('ignores catalogPages (this path is about stats, not catalog depth)', () => {
    const cache = {
      deep: entry('2', { catalogPages: 9 }),
      single: entry('3', { catalogPages: 1 }),
    };
    const out = selectStatlessAuthors(cache, { ...base, sortBy: 'topRatings', bookStats });
    expect(out.map((o) => o.name)).toEqual(['deep', 'single']);
  });

  it('applies minRatings/maxRatings to the top-book rating in topRatings mode', () => {
    const cache = { a: minted('1', 'a'), b: minted('2', 'b'), c: minted('3', 'c') };
    const opts = { ...base, sortBy: 'topRatings', bookStats };
    // bookStats: 1→10, 2→900, 3→450
    expect(selectStatlessAuthors(cache, { ...opts, minRatings: 400 }).map((o) => o.name)).toEqual(['b', 'c']);
    expect(selectStatlessAuthors(cache, { ...opts, maxRatings: 400 }).map((o) => o.name)).toEqual(['a']);
  });

  it('includes mint rows that have no slug yet', () => {
    const cache = { fresh: minted('2', 'Gina Russo') };
    const out = selectStatlessAuthors(cache, { ...base, sortBy: 'topRatings', bookStats });
    expect(out).toHaveLength(1);
    expect(out[0].entry.slug).toBeFalsy();
  });
});

describe('authorScrapeRef — the id is the only reference we send', () => {
  // The slug is DISPLAY ONLY and must never reach the scraper. Goodreads
  // resolves it itself: /author/list/<id> 301-redirects to
  // /author/list/<id>.<Canonical_Slug>, preserving ?page= and ?sort= (verified
  // live). Passing a stored slug only added a way to fail — a stale or
  // degenerate slug 404s immediately, and a NULL slug built `/author/list/`,
  // which read like a genuine scrape failure and burned all five strikes.
  it('always returns the id, ignoring whatever slug is stored', () => {
    expect(authorScrapeRef(undefined, '3338972')).toBe('3338972');
    expect(authorScrapeRef(null, '3338972')).toBe('3338972');
    expect(authorScrapeRef('', '3338972')).toBe('3338972');
    expect(authorScrapeRef('3338972.Gina_Russo', '3338972')).toBe('3338972');
    // Degenerate / book-page-derived slugs must not leak through either.
    expect(authorScrapeRef('16470125._', '16470125')).toBe('16470125');
    expect(authorScrapeRef('47630088.Jose_Mauro_DeVasconcelos', '47630088')).toBe('47630088');
  });
});

describe('describeAuthorId — log lines must be keyed on the id', () => {
  // "No stats line found for Jose Mauro DeVasconcelos" was unactionable: the
  // name is often a book-page artifact (Last, First / "(Editor)" / co-author
  // run-together) and is not a key — ~8,071 name families map to 2+ ids.
  it('puts the id first and the name in parentheses only when present', () => {
    expect(describeAuthorId('47630088')).toBe('authorId=47630088');
    expect(describeAuthorId('47630088', 'Jose Mauro DeVasconcelos')).toBe(
      'authorId=47630088 (Jose Mauro DeVasconcelos)'
    );
    expect(describeAuthorId('47630088', null)).toBe('authorId=47630088');
    expect(describeAuthorId('47630088', '')).toBe('authorId=47630088');
  });
});

describe('buildAuthorListUrl', () => {
  // A bad ref must fail loudly rather than fetch /author/list/, which reads
  // like a genuine scrape failure and burns the author's strike budget.
  it('rejects an empty, null, or non-numeric author reference', () => {
    expect(() => buildAuthorListUrl(null as unknown as string)).toThrow(/bad author reference/);
    expect(() => buildAuthorListUrl('')).toThrow(/bad author reference/);
    expect(() => buildAuthorListUrl('   ')).toThrow(/bad author reference/);
    expect(() => buildAuthorListUrl('not-an-id.Someone')).toThrow(/bad author reference/);
  });

  it('emits an id-only URL, never a slug', () => {
    expect(buildAuthorListUrl('8777')).toBe('https://www.goodreads.com/author/list/8777');
    expect(buildAuthorListUrl('14018357.Steve_the_Noob')).toBe('https://www.goodreads.com/author/list/14018357');
    expect(buildAuthorListUrl('16470125._')).toBe('https://www.goodreads.com/author/list/16470125');
  });

  it('carries sort and page through as query params', () => {
    expect(buildAuthorListUrl('786023', 'books', 2)).toBe(
      'https://www.goodreads.com/author/list/786023?sort=books&page=2'
    );
    // page=1 is implicit — an explicit page=1 would needlessly re-request it.
    expect(buildAuthorListUrl('786023', undefined, 1)).toBe('https://www.goodreads.com/author/list/786023');
  });
});

describe('selectAuthors (authorTopStats) — ratingsRate', () => {
  it('sorts by per-day growth and excludes authors with no recorded rate', () => {
    const cache = {
      slow: entry('1', { numRatings: '100', ratingsRate: 0.5 }),
      fast: entry('2', { numRatings: '10', ratingsRate: 40 }),
      noRate: entry('3', { numRatings: '1,000' }),
    };
    const { authors, missingField } = selectAuthors(cache, { sortBy: 'ratingsRate', limit: '10' });
    expect(authors.map((o) => o.name)).toEqual(['fast', 'slow']);
    expect(missingField).toBe(1);
  });
});