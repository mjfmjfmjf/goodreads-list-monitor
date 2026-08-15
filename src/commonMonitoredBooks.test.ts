import { describe, expect, it } from 'vitest';
import { findCommonMonitoredBooks } from './commonMonitoredBooks.js';
import { State, BookCache } from './storage.js';

const cache: BookCache = {
  '1': { id: '1', title: 'Book One', author: 'Author A', ratings: '10,000', avgRating: '4.5', published: '2020', lastUpdated: '' },
  '2': { id: '2', title: 'Book Two', author: 'Author B', ratings: '5,000', avgRating: '4.0', published: '2019', lastUpdated: '' },
  '3': { id: '3', title: 'Book Three', author: 'Author C', ratings: '20,000', avgRating: '3.8', published: '2021', lastUpdated: '' },
  '4': { id: '4', title: 'Unknown', author: 'Author D', ratings: '100', published: '2020', lastUpdated: '' }
};

function makeState(lists: { [id: string]: string[] }): State {
  const stateLists: State['lists'] = {};
  for (const [id, seenBookIds] of Object.entries(lists)) {
    stateLists[id] = { title: `List ${id}`, lastCount: seenBookIds.length, seenBookIds };
  }
  return { userId: 'u', lists: stateLists };
}

describe('findCommonMonitoredBooks', () => {
  it('ranks books by number of lists they appear in', () => {
    const state = makeState({
      a: ['1', '2'],
      b: ['1', '2', '3'],
      c: ['1', '3']
    });
    const { results } = findCommonMonitoredBooks(state, cache);
    expect(results.map(r => r.bookId)).toEqual(['1', '3', '2']);
    expect(results[0].listCount).toBe(3);
    expect(results[0].listTitles).toEqual(['List a', 'List b', 'List c']);
  });

  it('applies the limit', () => {
    const state = makeState({
      a: ['1', '2'],
      b: ['1', '2', '3'],
      c: ['1', '3']
    });
    const { results } = findCommonMonitoredBooks(state, cache, 2);
    expect(results).toHaveLength(2);
    expect(results.map(r => r.bookId)).toEqual(['1', '3']);
  });

  it('skips uncached and Unknown-titled books, and reports the uncached count', () => {
    const state = makeState({
      a: ['1', '4', '999'],
      b: ['1', '4', '999']
    });
    const { results, uncached } = findCommonMonitoredBooks(state, cache);
    expect(results.map(r => r.bookId)).toEqual(['1']);
    expect(uncached).toBe(1);
  });

  it('ties break by ratings then title', () => {
    const state = makeState({
      a: ['1', '2', '3'],
      b: ['1', '2', '3'],
      c: ['1', '2', '3']
    });
    const { results } = findCommonMonitoredBooks(state, cache);
    expect(results.map(r => r.bookId)).toEqual(['3', '1', '2']);
  });

  it('returns empty results for no lists', () => {
    const { results, totalLists, totalDistinctBooks } = findCommonMonitoredBooks(makeState({}), cache);
    expect(results).toEqual([]);
    expect(totalLists).toBe(0);
    expect(totalDistinctBooks).toBe(0);
  });

  it('applies a filter and reports excluded count', () => {
    const state = makeState({
      a: ['1', '2', '3'],
      b: ['1', '2', '3']
    });
    const { results, excluded } = findCommonMonitoredBooks(
      state,
      cache,
      20,
      (bookId) => bookId !== '1' && bookId !== '3'
    );
    expect(results.map(r => r.bookId)).toEqual(['2']);
    expect(excluded).toBe(2);
  });
});
