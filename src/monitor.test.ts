import { describe, it, expect } from 'vitest';
import { resolveRemovedBookDetails } from './monitor.js';
import type { BookCache, CachedBook } from './storage.js';

function row(id: string, title: string, author = 'Some Author'): CachedBook {
  return {
    id,
    title,
    author,
    ratings: '100',
    published: '2020',
    lastUpdated: '2026-01-01T00:00:00.000Z',
  };
}

describe('resolveRemovedBookDetails', () => {
  it('resolves from the SQLite row when the in-run cache is empty (regression: 2026/09/13 empty-cache refactor)', () => {
    const cache: BookCache = {};
    const removedId = '43721059';
    const dbRow = row(removedId, 'Night Watch', 'Terry Pratchett');
    expect(resolveRemovedBookDetails(removedId, cache, () => dbRow)).toBe(dbRow);
  });

  it('prefers a real in-run cache hit over the DB row', () => {
    const cache: BookCache = { '1': row('1', 'Fresh title') };
    const staleDbRow = row('1', 'Stale title');
    expect(resolveRemovedBookDetails('1', cache, () => staleDbRow)).toBe(cache['1']);
  });

  it('returns undefined when neither the cache nor the DB knows the book (caller falls through to a live scrape)', () => {
    expect(resolveRemovedBookDetails('123', {}, () => undefined)).toBeUndefined();
  });

  it('falls back to the DB row when the cache only has an Unknown placeholder', () => {
    const cache: BookCache = { '2': row('2', 'Unknown') };
    const dbRow = row('2', 'Real title');
    expect(resolveRemovedBookDetails('2', cache, () => dbRow)).toBe(dbRow);
  });

  it('returns the Unknown placeholder when that is all that exists (caller still live-fetches)', () => {
    const cache: BookCache = { '3': row('3', 'Unknown') };
    expect(resolveRemovedBookDetails('3', cache, () => undefined)).toBe(cache['3']);
  });
});