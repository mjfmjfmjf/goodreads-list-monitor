import { describe, it, expect } from 'vitest';
import { computeFacetCatalog, normalizeFacetValue, isFacetName, FACETS, type FacetBookRow } from './facetCatalog.ts';

const row = (facetValue: string, workKey: string, ratings: number, avgRating: number | null = null): FacetBookRow => ({
  facetValue,
  workKey,
  ratings,
  avgRating,
});

describe('normalizeFacetValue', () => {
  it('trims and collapses internal whitespace', () => {
    expect(normalizeFacetValue('  Mass   Market  Paperback ')).toBe('mass market paperback');
  });

  it('case-folds by default and preserves case with foldCase=false', () => {
    expect(normalizeFacetValue('Paperback')).toBe('paperback');
    expect(normalizeFacetValue('Paperback', false)).toBe('Paperback');
  });
});

describe('isFacetName', () => {
  it('accepts only the two whitelisted facets', () => {
    expect(isFacetName('language')).toBe(true);
    expect(isFacetName('format')).toBe(true);
    expect(isFacetName('publisher')).toBe(false);
    expect(isFacetName('id; DROP TABLE books')).toBe(false);
  });

  it('maps each facet to a distinct whitelisted column', () => {
    expect(FACETS.language.column).toBe('language');
    expect(FACETS.format.column).toBe('format');
  });
});

describe('computeFacetCatalog', () => {
  it('collapses case variants into one entry and reports them', () => {
    const out = computeFacetCatalog([
      row('Paperback', 'w1', 100),
      row('paperback', 'w2', 50),
      row('Paperback', 'w3', 25),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].value).toBe('Paperback'); // most frequent spelling wins the label
    expect(out[0].works).toBe(3);
    expect(out[0].variants).toEqual(['paperback']);
  });

  it('trims trailing whitespace into the same entry (not a separate variant)', () => {
    const out = computeFacetCatalog([row('Paperback', 'w1', 100), row('Paperback ', 'w2', 50)]);
    expect(out).toHaveLength(1);
    expect(out[0].works).toBe(2);
    expect(out[0].variants).toEqual([]);
  });

  it('keeps variants separate with raw=true', () => {
    const out = computeFacetCatalog([
      row('Paperback', 'w1', 100),
      row('paperback', 'w2', 50),
    ], { raw: true });
    expect(out).toHaveLength(2);
    expect(out[0].value).toBe('Paperback');
    expect(out[0].works).toBe(1);
  });

  it('drops placeholder values like "Unknown Binding"', () => {
    const out = computeFacetCatalog([
      row('Unknown Binding', 'w1', 1000),
      row('Paperback', 'w2', 10),
    ]);
    expect(out.map((o) => o.value)).toEqual(['Paperback']);
  });

  it('counts one work once, using the highest-rated edition', () => {
    // Two editions of the same work must not inflate the count or the average.
    const out = computeFacetCatalog([
      row('Hardcover', 'work-1', 10, 3.0),
      row('Hardcover', 'work-1', 900, 4.5),
      row('Hardcover', 'work-2', 100, 4.0),
    ]);
    expect(out[0].works).toBe(2);
    expect(out[0].totalRatings).toBe(1000);
    // avg is over the 2 representative works, not all 3 editions
    expect(out[0].avgRating).toBeCloseTo((4.5 + 4.0) / 2, 5);
  });

  it('sorts by works, avgRating, or totalRatings', () => {
    const rows = [
      row('English', 'a', 1000, 3.0),
      row('German', 'b', 100, 4.5),
      row('French', 'c', 500, 4.5),
    ];
    expect(computeFacetCatalog(rows)[0].value).toBe('English'); // most works (1) -> tie, then totalRatings
    expect(computeFacetCatalog(rows, { sortBy: 'avgRating' })[0].value).toBe('French'); // tie on avg, then more ratings
    expect(computeFacetCatalog(rows, { sortBy: 'totalRatings' })[0].value).toBe('English');
  });

  it('applies minBooks and minRatings filters', () => {
    const rows = [row('English', 'a', 5000), row('German', 'b', 10)];
    // every entry here has exactly 1 work, so minBooks:2 drops them all
    expect(computeFacetCatalog(rows, { minBooks: '2' })).toEqual([]);
    expect(computeFacetCatalog(rows, { minBooks: '1' }).map((o) => o.value)).toEqual(['English', 'German']);
    // minRatings filters on the per-work rating count, so German's only work drops out
    expect(computeFacetCatalog(rows, { minRatings: '1000' }).map((o) => o.value)).toEqual(['English']);
  });

  it('returns null avgRating when no work has one', () => {
    const out = computeFacetCatalog([row('English', 'a', 100)]);
    expect(out[0].avgRating).toBeNull();
  });

  it('returns everything ranked; the caller applies the limit', () => {
    const out = computeFacetCatalog([row('English', 'a', 3), row('German', 'b', 2), row('French', 'c', 1)]);
    expect(out).toHaveLength(3);
  });
});