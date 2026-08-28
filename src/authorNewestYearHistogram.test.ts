import { describe, expect, it } from 'vitest';
import { computeAuthorsNewestYear, extractYear } from './authorNewestYearHistogram.js';
import type { CachedBook } from './storage.js';

const book = (o: Partial<CachedBook>): CachedBook => ({
  id: 'x', title: 'T', author: 'A', ratings: '0', published: '', lastUpdated: '', ...o,
});

describe('extractYear', () => {
  it('parses plain years and date-prefixed strings', () => {
    expect(extractYear('1945')).toBe(1945);
    expect(extractYear('2013.05.07')).toBe(2013);
    expect(extractYear('2012.06.20')).toBe(2012);
  });
  it('returns null for unknown/invalid', () => {
    expect(extractYear('Unknown')).toBeNull();
    expect(extractYear('')).toBeNull();
    expect(extractYear(undefined)).toBeNull();
  });
});

describe('computeAuthorsNewestYear', () => {
  const NOW = 2026;

  it('binaries each author by their newest publication year', () => {
    // Orwell: books in 1945 (newest). Rowling: 1997.
    const out = computeAuthorsNewestYear([
      book({ author: 'George Orwell', authorId: '3706', published: '1945' }),
      book({ author: 'George Orwell', authorId: '3706', published: '1937' }),
      book({ author: 'J.K. Rowling', authorId: '1077326', published: '1997' }),
    ], 'year', NOW);
    expect(out.totalAuthors).toBe(2);
    expect(out.unknownAuthors).toBe(0);
    expect(out.buckets.map(b => b.label)).toEqual(['1945', '1997']);
    expect(out.counts).toEqual([1, 1]);
  });

  it('ignores unknown-date books when the author has a known one', () => {
    const out = computeAuthorsNewestYear([
      book({ author: 'A', authorId: '1', published: 'Unknown' }),
      book({ author: 'A', authorId: '1', published: '2020' }),
    ], 'year', NOW);
    expect(out.totalAuthors).toBe(1);
    expect(out.unknownAuthors).toBe(0);
    expect(out.buckets.map(b => b.label)).toEqual(['2020']);
    expect(out.counts).toEqual([1]);
  });

  it('counts an author as Unknown date only when ALL their books have unknown dates', () => {
    const out = computeAuthorsNewestYear([
      book({ author: 'A', authorId: '1', published: 'Unknown' }),
      book({ author: 'B', authorId: '2', published: '2015' }),
    ], 'year', NOW);
    expect(out.totalAuthors).toBe(2);
    expect(out.unknownAuthors).toBe(1);
    expect(out.buckets.map(b => b.label)).toEqual(['2015', 'Unknown date']);
    expect(out.counts).toEqual([1, 1]);
  });

  it('breaks out pre-1800 and future newest-years into their own buckets', () => {
    const out = computeAuthorsNewestYear([
      book({ author: 'A', authorId: '1', published: '1100' }),       // pre-1800
      book({ author: 'B', authorId: '2', published: '2050' }),       // future
      book({ author: 'C', authorId: '3', published: '2001' }),       // ok
      book({ author: 'D', authorId: '4', published: '2029' }),       // boundary (now+3)
    ], 'year', NOW);
    expect(out.buckets.map(b => b.label)).toEqual(['2001', '2029', 'Pre-1800', 'After 2029']);
    expect(out.counts).toEqual([1, 1, 1, 1]);
    expect(out.outOfRange).toBe(2);
  });

  it('skips multi-author concatenation rows and bad books', () => {
    const out = computeAuthorsNewestYear([
      book({ author: 'Mark TwainGeorge Eliot', authorId: 'x', published: '2010' }),
      book({ id: 'bad', author: 'A', authorId: '1', published: '2005', isBad: true }),
      book({ author: 'A', authorId: '1', published: '2009' }),
    ], 'year', NOW);
    expect(out.totalAuthors).toBe(1);
    expect(out.buckets.map(b => b.label)).toEqual(['2009']);
  });

  it('groups into decades in decade mode, catching out-of-range into their own buckets', () => {
    const out = computeAuthorsNewestYear([
      book({ author: 'A', authorId: '1', published: '2005' }),
      book({ author: 'B', authorId: '2', published: '2013' }),
      book({ author: 'C', authorId: '3', published: '2022' }),
      book({ author: 'D', authorId: '4', published: '1790' }),
      book({ author: 'E', authorId: '5', published: '2055' }),
    ], 'decade', NOW);
    expect(out.buckets.map(b => b.label)).toEqual(['2000-2009', '2010-2019', '2020-2029', 'Pre-1800', 'After 2029']);
    expect(out.counts).toEqual([1, 1, 1, 1, 1]);
  });

  it('sorts by count descending when requested', () => {
    const out = computeAuthorsNewestYear([
      book({ author: 'A', authorId: '1', published: '2015' }),
      book({ author: 'B', authorId: '2', published: '2010' }),
      book({ author: 'C', authorId: '3', published: '2010' }),
    ], 'year', NOW, 'count');
    expect(out.buckets.map(b => b.label)).toEqual(['2010', '2015']);
    expect(out.counts).toEqual([2, 1]);
  });
});
