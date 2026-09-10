import { describe, it, expect } from 'vitest';
import { dayBuckets, weekBuckets, monthBuckets } from './booksAddedHistogram.js';

type Bucket = ReturnType<typeof dayBuckets>[number];

describe('dayBuckets', () => {
  it('builds the last N days ending on today, inclusive, oldest first', () => {
    const buckets = dayBuckets(3, '2026-09-07');
    expect(buckets.map(b => b.label)).toEqual(['2026-09-05', '2026-09-06', '2026-09-07']);
    expect(buckets.every(b => b.start === b.label && b.end === b.label)).toBe(true);
  });
});

describe('weekBuckets', () => {
  it('buckets into Monday-start weeks ending on the current Monday-week', () => {
    // 2026-09-07 is a Monday; its own week runs 09-07..09-13.
    const buckets = weekBuckets(2, '2026-09-07');
    expect(buckets.map(b => b.label)).toEqual(['2026-08-31', '2026-09-07']);
    expect(buckets[0].start).toBe('2026-08-31');
    expect(buckets[0].end).toBe('2026-09-06');
    expect(buckets[1].end).toBe('2026-09-13');
  });

  it('mid-week "today" resolves to the current Monday-start week', () => {
    const buckets = weekBuckets(1, '2026-09-10'); // Thursday
    expect(buckets[0].label).toBe('2026-09-07');
    expect(buckets[0].start).toBe('2026-09-07');
    expect(buckets[0].end).toBe('2026-09-13');
  });
});

describe('monthBuckets', () => {
  it('buckets into the last N calendar months, oldest first', () => {
    const buckets = monthBuckets(3, '2026-09-15');
    expect(buckets.map(b => b.label)).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(buckets[0].start).toBe('2026-07-01');
    expect(buckets[0].end).toBe('2026-07-31');
    expect(buckets[1].end).toBe('2026-08-31');
    expect(buckets[2].end).toBe('2026-09-30');
  });
});