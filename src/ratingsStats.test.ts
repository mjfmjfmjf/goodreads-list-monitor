import { describe, expect, it } from 'vitest';
import { computeRatingsStats, parseRatingsDist, ratingsStatsColumns } from './ratingsStats.ts';

// Real-shape histogram from a /book/show page (Goodreads example fixture).
const MOCKINGBIRD = { '1': 9030, '2': 11853, '3': 51713, '4': 303339, '5': 967486 };

describe('parseRatingsDist', () => {
  it('parses a JSON string into a star->count record', () => {
    expect(parseRatingsDist('{"5":2,"4":1}')).toEqual({ '5': 2, '4': 1 });
  });

  it('accepts an already-parsed object', () => {
    expect(parseRatingsDist({ 5: 2, 4: 1 } as unknown as Record<string, number>)).toEqual({ '5': 2, '4': 1 });
  });

  it('returns null for missing, empty, or non-object input', () => {
    expect(parseRatingsDist(null)).toBeNull();
    expect(parseRatingsDist(undefined)).toBeNull();
    expect(parseRatingsDist('')).toBeNull();
    expect(parseRatingsDist('   ')).toBeNull();
    expect(parseRatingsDist('null')).toBeNull();
    expect(parseRatingsDist('not json')).toBeNull();
    expect(parseRatingsDist('[]')).toBeNull();
    expect(parseRatingsDist('3')).toBeNull();
  });

  it('drops zero, negative and non-numeric counts', () => {
    expect(parseRatingsDist('{"5":0,"4":-1,"3":"x","2":3}')).toEqual({ '2': 3 });
  });

  it('returns null when every entry is unusable', () => {
    expect(parseRatingsDist('{"5":0}')).toBeNull();
  });
});

describe('computeRatingsStats', () => {
  it('computes population moments over a real histogram', () => {
    const stats = computeRatingsStats(MOCKINGBIRD)!;
    expect(stats.total).toBe(1343421);
    expect(stats.mean).toBeCloseTo(4.643861455195355, 12);
    expect(stats.median).toBe(5);
    expect(stats.mode).toBe(5);
    expect(stats.variance).toBeCloseTo(0.4398886499983898, 12);
    expect(stats.stddev).toBeCloseTo(0.6632410195384403, 12);
    expect(stats.skewness).toBeCloseTo(-2.3547233421995446, 12);
    expect(stats.kurtosis).toBeCloseTo(7.064948436716383, 12);
  });

  it('is symmetric for a uniform 1..5 distribution', () => {
    const stats = computeRatingsStats({ '1': 1, '2': 1, '3': 1, '4': 1, '5': 1 })!;
    expect(stats.total).toBe(5);
    expect(stats.mean).toBe(3);
    expect(stats.median).toBe(3);
    expect(stats.variance).toBeCloseTo(2, 12);
    expect(stats.stddev).toBeCloseTo(Math.SQRT2, 12);
    expect(stats.skewness).toBeCloseTo(0, 12);
    expect(stats.kurtosis).toBeCloseTo(-1.3, 12);
  });

  it('picks the smallest star where the cumulative count reaches half', () => {
    const stats = computeRatingsStats({ '1': 1, '2': 1, '3': 1, '4': 7 })!;
    expect(stats.median).toBe(4);
  });

  it('breaks mode ties toward the lower star value', () => {
    const stats = computeRatingsStats({ '1': 3, '2': 3, '3': 1 })!;
    expect(stats.mode).toBe(1);
    expect(stats.median).toBe(2);
  });

  it('reports null skewness/kurtosis when the distribution has no spread', () => {
    const stats = computeRatingsStats({ '4': 5 })!;
    expect(stats.total).toBe(5);
    expect(stats.mean).toBe(4);
    expect(stats.median).toBe(4);
    expect(stats.mode).toBe(4);
    expect(stats.variance).toBe(0);
    expect(stats.stddev).toBe(0);
    expect(stats.skewness).toBeNull();
    expect(stats.kurtosis).toBeNull();
  });

  it('returns null for missing, empty, or weightless distributions', () => {
    expect(computeRatingsStats(null)).toBeNull();
    expect(computeRatingsStats(undefined)).toBeNull();
    expect(computeRatingsStats({})).toBeNull();
    expect(computeRatingsStats({ '5': 0 })).toBeNull();
  });
});

describe('ratingsStatsColumns', () => {
  it('maps a stored JSON distribution to the book_page column names', () => {
    const cols = ratingsStatsColumns(JSON.stringify(MOCKINGBIRD));
    expect(cols.ratings_total).toBe(1343421);
    expect(cols.ratings_mean).toBeCloseTo(4.643861455195355, 12);
    expect(cols.ratings_median).toBe(5);
    expect(cols.ratings_mode).toBe(5);
    expect(cols.ratings_variance).toBeCloseTo(0.4398886499983898, 12);
    expect(cols.ratings_stddev).toBeCloseTo(0.6632410195384403, 12);
    expect(cols.ratings_skewness).toBeCloseTo(-2.3547233421995446, 12);
    expect(cols.ratings_kurtosis).toBeCloseTo(7.064948436716383, 12);
  });

  it('returns all-null columns for an absent or invalid distribution', () => {
    const allNull = {
      ratings_mean: null,
      ratings_median: null,
      ratings_mode: null,
      ratings_variance: null,
      ratings_stddev: null,
      ratings_skewness: null,
      ratings_kurtosis: null,
      ratings_total: null,
    };
    expect(ratingsStatsColumns(null)).toEqual(allNull);
    expect(ratingsStatsColumns('')).toEqual(allNull);
    expect(ratingsStatsColumns('not json')).toEqual(allNull);
    expect(ratingsStatsColumns('{}')).toEqual(allNull);
  });
});
