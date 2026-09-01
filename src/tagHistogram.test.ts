import { describe, it, expect } from 'vitest';
import { computeTagHistogram, parseTagHistogramSortKey } from './tagHistogram.js';
import type { TagBookRow } from './storage.js';

const row = (tag: string, book: string, shelved?: number): TagBookRow => ({
  tagName: tag,
  bookId: book,
  position: 1,
  harvestedAt: '2026-08-29T00:00:00.000Z',
  shelved,
});

describe('computeTagHistogram', () => {
  it('marks books that appear in exactly one tag as single-tag', () => {
    const hist = computeTagHistogram([
      row('graphic-novels', 'A'), // only tag
      row('graphic-novels', 'B'),
      row('manga', 'B'), // B is in two tags
      row('graphic-novels', 'C'),
      row('manga', 'C'), // C is in two tags
    ]);
    const gn = hist.rows.find(r => r.tag === 'graphic-novels')!;
    expect(gn.total).toBe(3);
    expect(gn.singleTag).toBe(1);
    expect(gn.pct).toBeCloseTo(33.333, 2);
  });

  it('totals 100% when every book has exactly one tag', () => {
    const hist = computeTagHistogram([
      row('a', '1'),
      row('a', '2'),
      row('b', '3'),
    ]);
    const a = hist.rows.find(r => r.tag === 'a')!;
    const b = hist.rows.find(r => r.tag === 'b')!;
    expect(a.pct).toBe(100);
    expect(b.pct).toBe(100);
  });

  it('is 0% when every book is multi-tag', () => {
    const hist = computeTagHistogram([
      row('a', '1'),
      row('b', '1'),
      row('a', '2'),
      row('b', '2'),
    ]);
    const a = hist.rows.find(r => r.tag === 'a')!;
    expect(a.pct).toBe(0);
  });

  it('ignores duplicate rows for the same (tag, book)', () => {
    const hist = computeTagHistogram([
      row('a', '1'),
      row('a', '1'),
      row('b', '1'),
    ]);
    const a = hist.rows.find(r => r.tag === 'a')!;
    expect(a.total).toBe(1);
    expect(a.singleTag).toBe(0);
    expect(a.pct).toBe(0);
  });

  it('enriches each tag with min/max/avg ratings from the ratings map', () => {
    const ratings = new Map<string, number>([
      ['1', 1000],
      ['2', 5000],
      ['3', 2000],
    ]);
    const hist = computeTagHistogram([
      row('a', '1'), row('a', '2'), row('a', '3'),
    ], ratings);
    const a = hist.rows.find(r => r.tag === 'a')!;
    expect(a.ratingsMin).toBe(1000);
    expect(a.ratingsMax).toBe(5000);
    expect(a.ratingsAvg).toBeCloseTo((1000 + 5000 + 2000) / 3, 5);
  });

  it('omits rating stats when no ratings population is available', () => {
    const hist = computeTagHistogram([row('a', '1')]);
    const a = hist.rows.find(r => r.tag === 'a')!;
    expect(a.ratingsMin).toBeUndefined();
    expect(a.ratingsMax).toBeUndefined();
    expect(a.ratingsAvg).toBeUndefined();
  });

  it('ignores zero/missing ratings when aggregating', () => {
    const ratings = new Map<string, number>([
      ['1', 0],
      ['2', 4000],
    ]);
    const hist = computeTagHistogram([row('a', '1'), row('a', '2')], ratings);
    const a = hist.rows.find(r => r.tag === 'a')!;
    expect(a.ratingsMin).toBe(4000);
    expect(a.ratingsMax).toBe(4000);
    expect(a.ratingsAvg).toBe(4000);
  });

  it('sorts by pct ascending as the primary key', () => {
    // Book M is shared across all three tags (multi-tag), the rest are single.
    const hist = computeTagHistogram([
      row('low', 'M'), row('low', 'l1'), row('low', 'l2'),
      row('med', 'M'), row('med', 'm1'),
      row('high', 'M'), row('high', 'h1'), row('high', 'h2'), row('high', 'h3'),
    ]);
    // low: {M,l1,l2} single=2/3 => 66.7%; med: {M,m1} single=1/2 => 50%; high: {M,h1,h2,h3} single=3/4 => 75%
    expect(hist.rows.map(r => r.tag)).toEqual(['med', 'low', 'high']);
  });

  it('computes min/max shelves per tag from the shelved column', () => {
    const hist = computeTagHistogram([
      row('a', '1', 100), row('a', '2', 40), row('a', '3', 40),
      row('b', '2', 10), row('b', '4'),
    ]);
    const a = hist.rows.find(r => r.tag === 'a')!;
    expect(a.shelvesMin).toBe(40);
    expect(a.shelvesMax).toBe(100);
    const b = hist.rows.find(r => r.tag === 'b')!;
    expect(b.shelvesMin).toBe(10);
    expect(b.shelvesMax).toBe(10);
  });

  it('omits shelves stats when the shelved column is absent', () => {
    const hist = computeTagHistogram([row('a', '1')]);
    const a = hist.rows.find(r => r.tag === 'a')!;
    expect(a.shelvesMin).toBeUndefined();
    expect(a.shelvesMax).toBeUndefined();
  });

  it('counts books on one or two tags as upTo2 (superset of single-tag)', () => {
    // Tag 'a': books 1 (only tag), 2 (two tags), 3 (three tags)
    const hist = computeTagHistogram([
      row('a', '1'),
      row('a', '2'), row('b', '2'),
      row('a', '3'), row('b', '3'), row('c', '3'),
    ]);
    const a = hist.rows.find(r => r.tag === 'a')!;
    expect(a.total).toBe(3);
    expect(a.singleTag).toBe(1);
    expect(a.pct).toBeCloseTo(33.333, 2);
    expect(a.upTo2).toBe(2); // books 1 and 2
    expect(a.pctUpTo2).toBeCloseTo(66.667, 2);
  });

  it('upTo2 is 100% when no book has more than two tags', () => {
    const hist = computeTagHistogram([
      row('a', '1'), row('a', '2'), row('b', '2'),
    ]);
    const a = hist.rows.find(r => r.tag === 'a')!;
    expect(a.upTo2).toBe(2);
    expect(a.pctUpTo2).toBe(100);
  });
});

describe('parseTagHistogramSortKey', () => {
  it('maps common aliases to canonical keys', () => {
    expect(parseTagHistogramSortKey('pct')).toBe('pct');
    expect(parseTagHistogramSortKey('pct2')).toBe('pct2');
    expect(parseTagHistogramSortKey('pctUpTo2')).toBe('pct2');
    expect(parseTagHistogramSortKey('upTo2')).toBe('upTo2');
    expect(parseTagHistogramSortKey('single')).toBe('single');
    expect(parseTagHistogramSortKey('total')).toBe('total');
    expect(parseTagHistogramSortKey('TAG')).toBe('tag');
    expect(parseTagHistogramSortKey('ratings')).toBe('ratings');
    expect(parseTagHistogramSortKey('shelves')).toBe('shelves');
  });

  it('throws on an unknown key', () => {
    expect(() => parseTagHistogramSortKey('bogus')).toThrow(/Unknown sortBy/);
  });
});
