import { describe, expect, it } from 'vitest';
import { computeAuthorMaxGap, extractYear } from './authorGapHistogram.js';
import type { CachedBook } from './storage.js';

const book = (o: Partial<CachedBook>): CachedBook => ({
  id: 'x', title: 'T', author: 'A', ratings: '0', published: '', lastUpdated: '', ...o,
});

describe('extractYear', () => {
  it('parses plain years and date-prefixed strings', () => {
    expect(extractYear('1945')).toBe(1945);
    expect(extractYear('2013.05.07')).toBe(2013);
  });
  it('returns null for unknown/invalid', () => {
    expect(extractYear('Unknown')).toBeNull();
    expect(extractYear('')).toBeNull();
    expect(extractYear(undefined)).toBeNull();
  });
});

describe('computeAuthorMaxGap', () => {
  const NOW = 2026;
  const recent = (author: string, id: string, published: string): CachedBook =>
    book({ author, authorId: id, published });

  it('bins authors by their largest gap between consecutive publication years', () => {
    // Gaiman: 1991 -> 1997 -> 2001 -> 2005 => gaps 6, 4, 4 => biggest 6
    // Rowling: 1997 -> 2000 -> 2003 => gaps 3, 3 => biggest 3
    const out = computeAuthorMaxGap([
      recent('Neil Gaiman', '1221698', '1991'),
      recent('Neil Gaiman', '1221698', '1997'),
      recent('Neil Gaiman', '1221698', '2001'),
      recent('Neil Gaiman', '1221698', '2005'),
      recent('J.K. Rowling', '1077326', '1997'),
      recent('J.K. Rowling', '1077326', '2000'),
      recent('J.K. Rowling', '1077326', '2003'),
    ], NOW);
    expect(out.buckets.map(b => b.label)).toEqual(['3', '6']);
    expect(out.counts).toEqual([1, 1]);
    expect(out.qualified).toBe(2);
  });

  it('treats multiple books in one year as gap 0', () => {
    const out = computeAuthorMaxGap([
      recent('A', '1', '2020'),
      recent('A', '1', '2020'),
      recent('B', '2', '2019'),
      recent('B', '2', '2020'),
    ], NOW);
    expect(out.buckets.map(b => b.label)).toEqual(['0', '1']);
    expect(out.counts).toEqual([1, 1]);
  });

  it('ignores duplicate same-year rows when computing the gap', () => {
    const out = computeAuthorMaxGap([
      recent('A', '1', '2015'),
      recent('A', '1', '2015'),
      recent('A', '1', '2016'),
    ], NOW);
    expect(out.buckets.map(b => b.label)).toEqual(['1']);
    expect(out.counts).toEqual([1]);
  });

  it('qualifies on the newest book year even when old books exist (whole-career gap)', () => {
    const out = computeAuthorMaxGap([
      recent('A', '1', '1950'),
      recent('A', '1', '2020'),   // newest within 40y of 2026
    ], NOW, 100);
    expect(out.buckets.map(b => b.label)).toEqual(['70']);
    expect(out.counts).toEqual([1]);
  });

  it('excludes authors whose newest book is outside the 40-year window', () => {
    const out = computeAuthorMaxGap([
      recent('A', '1', '1980'),   // newest = 41y before 2026
      recent('A', '1', '1985'),
    ], NOW);
    expect(out.buckets).toEqual([]);
    expect(out.outOfRange).toBe(1);
    expect(out.qualified).toBe(0);
  });

  it('excludes single-publication authors entirely (no gap at all)', () => {
    const out = computeAuthorMaxGap([
      recent('A', '1', '2020'),
    ], NOW);
    expect(out.buckets).toEqual([]);
    expect(out.noGapAuthors).toBe(1);
    expect(out.qualified).toBe(0);
  });

  it('counts an author as Unknown date when ALL their books have unknown dates', () => {
    const out = computeAuthorMaxGap([
      book({ author: 'A', authorId: '1', published: 'Unknown' }),
      recent('B', '2', '2020'),
      recent('B', '2', '2020'),   // two books -> qualified gap 0
    ], NOW);
    expect(out.buckets.map(b => b.label)).toEqual(['0', 'Unknown date']);
    expect(out.counts).toEqual([1, 1]);
    expect(out.unknownAuthors).toBe(1);
    expect(out.qualified).toBe(1);
  });

  it('ignores unknown-date books when the author has a known one', () => {
    const out = computeAuthorMaxGap([
      book({ author: 'A', authorId: '1', published: 'Unknown' }),
      recent('A', '1', '2020'),
      recent('A', '1', '2020'),
    ], NOW);
    expect(out.buckets.map(b => b.label)).toEqual(['0']);
    expect(out.counts).toEqual([1]);
    expect(out.unknownAuthors).toBe(0);
  });

  it('respects the cap and bins larger gaps into a tail bucket', () => {
    const out = computeAuthorMaxGap([
      recent('A', '1', '1990'),
      recent('A', '1', '2020'),
      recent('B', '2', '2010'),
      recent('B', '2', '2012'),
    ], NOW, 5);
    expect(out.buckets.map(b => b.label)).toEqual(['2', '6+']);
    expect(out.counts).toEqual([1, 1]);
  });

  it('skips multi-author concatenation rows and bad books', () => {
    const out = computeAuthorMaxGap([
      book({ author: 'Mark TwainGeorge Eliot', authorId: 'x', published: '2010' }),
      book({ id: 'bad', author: 'A', authorId: '1', published: '2005', isBad: true }),
      recent('A', '1', '2009'),
      recent('A', '1', '2011'),
    ], NOW);
    expect(out.totalAuthors).toBe(1);
    expect(out.buckets.map(b => b.label)).toEqual(['2']);
    expect(out.counts).toEqual([1]);
  });
});