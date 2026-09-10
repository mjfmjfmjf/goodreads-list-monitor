import { describe, it, expect } from 'vitest';
import { computeCumulativeGrid } from './ratingsByDateHistogram.js';

const buckets = [
  { label: '10+', min: 10, max: Infinity },
  { label: '5 to 9', min: 5, max: 9 },
  { label: '0 to 4', min: 0, max: 4 },
];

const periods = [
  { label: 'day1', start: '2026-09-01', end: '2026-09-01' },
  { label: 'day2', start: '2026-09-02', end: '2026-09-02' },
  { label: 'day3', start: '2026-09-03', end: '2026-09-03' },
];

const book = (ratings: number, firstSeen: string) => ({ ratings, firstSeen });

describe('computeCumulativeGrid (days)', () => {
  it('fills per-period counts by rating bracket and first-seen date', () => {
    const { counts, totals } = computeCumulativeGrid(periods, buckets, [
      book(12, '2026-09-01T10:00:00Z'),
      book(7, '2026-09-01T11:00:00Z'),
      book(3, '2026-09-02T10:00:00Z'),
      book(6, '2026-09-02T12:00:00Z'),
      book(11, '2026-09-03T10:00:00Z'),
    ], false);

    // Cumulative: day1 sums day1; day2 sums day1+2; day3 all.
    expect(counts[0]).toEqual([1, 1, 0]);
    expect(counts[1]).toEqual([1, 2, 1]);
    expect(counts[2]).toEqual([2, 2, 1]);
    expect(totals).toEqual([2, 4, 5]);
  });

  it('ignores books with no first_seen or outside the window', () => {
    const { totals } = computeCumulativeGrid(periods, buckets, [
      book(12, ''),
      book(12, '2026-08-30T00:00:00Z'),
      book(9, '2026-09-05T00:00:00Z'),
    ], false);
    expect(totals).toEqual([0, 0, 0]);
  });

  it('treats missing/non-numeric ratings as the 0 bracket', () => {
    const { counts } = computeCumulativeGrid(periods, buckets, [
      { firstSeen: '2026-09-01T00:00:00Z' },
      { ratings: undefined, firstSeen: '2026-09-01T00:00:00Z' },
    ], false);
    expect(counts[0][2]).toBe(2);
  });
});

describe('computeCumulativeGrid (months)', () => {
  it('keys month periods on YYYY-MM', () => {
    const mPeriods = [
      { label: '2026-08', start: '2026-08-01', end: '2026-08-31' },
      { label: '2026-09', start: '2026-09-01', end: '2026-09-30' },
    ];
    const { counts, totals } = computeCumulativeGrid(mPeriods, buckets, [
      book(12, '2026-08-15T00:00:00Z'),
      book(5, '2026-09-01T00:00:00Z'),
    ], true);
    expect(counts[0]).toEqual([1, 0, 0]);
    expect(counts[1]).toEqual([1, 1, 0]);
    expect(totals).toEqual([1, 2]);
  });
});