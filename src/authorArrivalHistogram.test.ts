import { describe, expect, it } from 'vitest';
import { buildAuthorArrivalBuckets } from './authorArrivalHistogram.ts';

const base = {
  totalAuthors: 10,
  missingFirstSeen: 1,
  beforeWindow: 3,
  earliestFirstSeen: '2031-02-25T00:00:00.000Z',
};

describe('buildAuthorArrivalBuckets', () => {
  it('fills every contiguous UTC day and accumulates totals', () => {
    const summary = buildAuthorArrivalBuckets({
      ...base,
      start: '2031-03-01',
      end: '2031-03-03',
      grouped: [
        { day: '2031-03-01', count: 2, ratingSum: 400, maxRatings: 300 },
        { day: '2031-03-03', count: 1, ratingSum: 50, maxRatings: 50 },
        { day: '2031-03-09', count: 5, ratingSum: 500, maxRatings: 500 },
      ],
    });

    expect(summary.buckets.map((b) => b.label)).toEqual(['2031-03-01', '2031-03-02', '2031-03-03']);
    expect(summary.buckets[0]).toMatchObject({ added: 2, total: 5, avgRatings: 200, maxRatings: 300 });
    expect(summary.buckets[1]).toMatchObject({ added: 0, total: 5, avgRatings: 0, maxRatings: 0 });
    expect(summary.buckets[2]).toMatchObject({ added: 1, total: 6, avgRatings: 50, maxRatings: 50 });
    expect(summary.addedInWindow).toBe(3);
    expect(summary.totalAuthors).toBe(10);
    expect(summary.missingFirstSeen).toBe(1);
    expect(summary.beforeWindow).toBe(3);
    expect(summary.earliestFirstSeen).toBe('2031-02-25T00:00:00.000Z');
  });

  it('rounds the per-day average author rating', () => {
    const summary = buildAuthorArrivalBuckets({
      ...base,
      start: '2031-03-01',
      end: '2031-03-01',
      grouped: [{ day: '2031-03-01', count: 2, ratingSum: 201, maxRatings: 101 }],
    });

    expect(summary.buckets[0]).toMatchObject({ added: 2, avgRatings: 101, maxRatings: 101 });
  });

  it('returns an empty series for a missing or inverted range', () => {
    const empty = buildAuthorArrivalBuckets({ ...base, start: '', end: '', grouped: [] });
    expect(empty.buckets).toEqual([]);
    expect(empty.addedInWindow).toBe(0);
    expect(empty.totalAuthors).toBe(10);

    const inverted = buildAuthorArrivalBuckets({
      ...base,
      start: '2031-03-03',
      end: '2031-03-01',
      grouped: [{ day: '2031-03-01', count: 1, ratingSum: 1, maxRatings: 1 }],
    });
    expect(inverted.buckets).toEqual([]);
    expect(inverted.addedInWindow).toBe(0);
  });
});
