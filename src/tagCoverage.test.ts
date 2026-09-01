import { describe, it, expect } from 'vitest';
import { computeTagCoverage } from './tagCoverage.js';
import type { TagBookRow } from './storage.js';

const row = (tag: string, book: string): TagBookRow => ({
  tagName: tag,
  bookId: book,
  position: 1,
  harvestedAt: '2026-08-29T00:00:00.000Z',
});

describe('computeTagCoverage', () => {
  it('picks the tag covering the most new books first', () => {
    // a covers 3, b covers 2, c covers 1
    const hist = computeTagCoverage([
      row('a', '1'), row('a', '2'), row('a', '3'),
      row('b', '4'), row('b', '5'),
      row('c', '6'),
    ], 10);
    expect(hist.rows.map(r => r.tag)).toEqual(['a', 'b', 'c']);
    expect(hist.totalBooks).toBe(6);
    expect(hist.rows[0]).toMatchObject({ tag: 'a', tagBooks: 3, newBooks: 3, cumulative: 3, pct: 50 });
  });

  it('only counts NEW books a tag adds (not already-covered ones)', () => {
    // a = {1,2,3} (3 books), b = {2,3,4,5,6} (5 books) -> greedy picks b (5)
    // first, then a adds only book 1.
    const hist = computeTagCoverage([
      row('a', '1'), row('a', '2'), row('a', '3'),
      row('b', '2'), row('b', '3'), row('b', '4'), row('b', '5'), row('b', '6'),
    ], 10);
    expect(hist.rows[0].tag).toBe('b');
    expect(hist.rows[0]).toMatchObject({ newBooks: 5, cumulative: 5 });
    expect(hist.rows[1].tag).toBe('a');
    expect(hist.rows[1]).toMatchObject({ newBooks: 1, cumulative: 6, pct: 100 });
  });

  it('honors the limit and stops early at 100%', () => {
    const hist = computeTagCoverage([
      row('a', '1'), row('a', '2'),
      row('b', '3'),
    ], 1);
    expect(hist.rows).toHaveLength(1);
    expect(hist.rows[0].tag).toBe('a');
    expect(hist.rows[0].pct).toBeCloseTo(66.667, 2);
  });

  it('stops once 100% coverage is reached even if limit is larger', () => {
    const hist = computeTagCoverage([
      row('a', '1'), row('a', '2'),
      row('b', '3'),
    ], 10);
    expect(hist.rows.map(r => r.tag)).toEqual(['a', 'b']);
    expect(hist.rows[hist.rows.length - 1].pct).toBe(100);
  });

  it('returns empty rows for no data', () => {
    const hist = computeTagCoverage([], 10);
    expect(hist.rows).toHaveLength(0);
    expect(hist.totalBooks).toBe(0);
  });

  it('books column shows single-tag count, not raw tag size', () => {
    // tag a has 3 books {1,2,3}: 1 and 2 are also under b, only 3 is single -> singleCount=1
    // tag b has 4 books {1,2,4,5}: 4,5 are single, 1,2 shared -> singleCount=2
    const hist = computeTagCoverage([
      row('a', '1'), row('a', '2'), row('a', '3'),
      row('b', '1'), row('b', '2'), row('b', '4'), row('b', '5'),
    ], 10);
    const a = hist.rows.find(r => r.tag === 'a')!;
    const b = hist.rows.find(r => r.tag === 'b')!;
    expect(a.tagBooks).toBe(1); // only book 3 is single-tag
    expect(b.tagBooks).toBe(2); // books 4 and 5 are single-tag
  });

  it('tie-breaks by most unique books, then highest average ratings', () => {
    // a and b both have 3 books (equal size) and add the same number of new
    // books, so the higher average ratings should win the first pick.
    const ratings = new Map<string, number>([
      ['1', 100], ['2', 50], ['3', 25],   // a avg = 58.33
      ['4', 1000], ['5', 900], ['6', 800], // b avg = 900
    ]);
    const hist = computeTagCoverage([
      row('a', '1'), row('a', '2'), row('a', '3'),
      row('b', '4'), row('b', '5'), row('b', '6'),
    ], 2, ratings);
    expect(hist.rows[0].tag).toBe('b');
    expect(hist.rows[0].avgRatings).toBe(900);
    expect(hist.rows[1].tag).toBe('a');
  });
});
