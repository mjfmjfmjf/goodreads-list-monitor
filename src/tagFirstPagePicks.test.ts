import { describe, expect, it } from 'vitest';
import { findTagFirstPagePicks } from './tagFirstPagePicks.js';
import { TagBookRow, BookCache } from './storage.js';

const cache: BookCache = {
  '1': { id: '1', title: 'Book One', author: 'Author A', ratings: '10,000', avgRating: '4.5', published: '2020', lastUpdated: '' },
  '2': { id: '2', title: 'Book Two', author: 'Author B', ratings: '5,000', avgRating: '4.0', published: '2019', lastUpdated: '' },
  '3': { id: '3', title: 'Book Three', author: 'Author C', ratings: '20,000', avgRating: '3.8', published: '2021', lastUpdated: '' },
  '4': { id: '4', title: 'Unknown', author: 'Author D', ratings: '100', published: '2020', lastUpdated: '' }
};

function row(tag: string, bookId: string, position?: number): TagBookRow {
  return { tagName: tag, bookId, position, harvestedAt: '2026-09-01T00:00:00.000Z' };
}

describe('findTagFirstPagePicks', () => {
  it('ranks books by number of distinct tags whose first page they appear on', () => {
    const rows = [
      row('a', '1', 5), row('b', '1', 10), row('c', '1', 20),
      row('a', '2', 3), row('b', '2', 4),
      row('a', '3', 40),
    ];
    const { results } = findTagFirstPagePicks(rows, cache);
    expect(results.map(r => r.bookId)).toEqual(['1', '2', '3']);
    expect(results[0].tagCount).toBe(3);
    expect(results[0].tagNames).toEqual(['a', 'b', 'c']);
  });

  it('ignores rows at position 0 and beyond the first page (50)', () => {
    const rows = [
      row('a', '1', 0),
      row('a', '1', 51),
      row('b', '1', 1),
      row('b', '1', 50),
      row('c', '2', 50),
      row('c', '2', 52),
    ];
    const { results } = findTagFirstPagePicks(rows, cache);
    expect(results.map(r => r.bookId)).toEqual(['1', '2']);
    expect(results[0].tagCount).toBe(2); // 51 and 0 excluded, 1 and 50 counted
  });

  it('applies the limit', () => {
    const rows = [row('a', '1', 1), row('a', '2', 1), row('a', '3', 1)];
    const { results } = findTagFirstPagePicks(rows, cache, 2);
    expect(results).toHaveLength(2);
    expect(results.map(r => r.bookId)).toEqual(['3', '1']); // ratings tiebreak
  });

  it('skips uncached and Unknown-titled books, and reports the uncached count', () => {
    const rows = [
      row('a', '1', 1),
      row('a', '4', 1),
      row('a', '999', 1),
      row('a', 'nope', 1),
    ];
    const { results, uncached, totalDistinctBooks } = findTagFirstPagePicks(rows, cache);
    expect(results.map(r => r.bookId)).toEqual(['1']);
    expect(uncached).toBe(2);
    expect(totalDistinctBooks).toBe(4);
  });

  it('ties break by ratings then title', () => {
    const rows = [
      row('a', '1', 1), row('b', '1', 1),
      row('a', '2', 1), row('b', '2', 1),
      row('a', '3', 1), row('b', '3', 1),
    ];
    const { results } = findTagFirstPagePicks(rows, cache);
    expect(results.map(r => r.bookId)).toEqual(['3', '1', '2']);
  });

  it('reports the total distinct tags with first-page data', () => {
    const rows = [
      row('a', '1', 1),
      row('a', '2', 51), // beyond first page, but tag 'a' still has first-page data via '1'
      row('b', '1', 2),
      row('c', '2', 60), // tag 'c' has no row inside 1-50 -> not counted
      row('c', '3', 0),
    ];
    const { totalTags } = findTagFirstPagePicks(rows, cache);
    expect(totalTags).toBe(2); // a and b
  });

  it('applies a filter and reports excluded count', () => {
    const rows = [
      row('a', '1', 1), row('b', '1', 1),
      row('a', '2', 1), row('b', '2', 1),
      row('a', '3', 1), row('b', '3', 1),
    ];
    const { results, excluded } = findTagFirstPagePicks(
      rows,
      cache,
      20,
      (bookId) => bookId !== '1' && bookId !== '3'
    );
    expect(results.map(r => r.bookId)).toEqual(['2']);
    expect(excluded).toBe(2);
  });

  it('returns empty results for no rows', () => {
    const { results, totalTags, totalDistinctBooks } = findTagFirstPagePicks([], cache);
    expect(results).toEqual([]);
    expect(totalTags).toBe(0);
    expect(totalDistinctBooks).toBe(0);
  });
});