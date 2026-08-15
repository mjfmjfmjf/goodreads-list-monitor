import { describe, expect, it } from 'vitest';
import { computeBookPagesBackfill } from './libraryExport.js';
import { LibraryEntry } from './libraryExport.js';
import { CachedBook } from './storage.js';

function entry(overrides: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    id: '1',
    title: 'Book',
    author: 'Author',
    shelf: 'read',
    dateRead: '2026/01/01',
    hasReview: true,
    review: 'Great',
    published: '2020',
    myRating: '4',
    pages: '200',
    publisher: 'Pub',
    bookshelves: '',
    ...overrides,
  };
}

function cachedBook(id: string, overrides: Partial<CachedBook> = {}): CachedBook {
  return {
    id,
    title: 'Book',
    author: 'Author',
    ratings: '1000',
    published: '2020',
    lastUpdated: '2026/08/01',
    ...overrides,
  };
}

describe('computeBookPagesBackfill', () => {
  it('fills pages only where the cache has no valid count', () => {
    const cache = {
      '1': cachedBook('1'),
      '2': cachedBook('2'),
      '3': cachedBook('3', { pages: '500' }),
      '4': cachedBook('4', { pages: '0' }),
      '5': cachedBook('5', { pages: 'Unknown' }),
    };
    const result = computeBookPagesBackfill(
      [
        entry({ id: '1', pages: '250' }),
        entry({ id: '2', pages: '' }),
        entry({ id: '3', pages: '999' }),
        entry({ id: '4', pages: '120' }),
        entry({ id: '5', pages: '80' }),
      ],
      cache
    );
    expect(result.updates).toEqual([
      { id: '1', pages: '250' },
      { id: '4', pages: '120' },
      { id: '5', pages: '80' },
    ]);
    expect(result.skippedExisting).toBe(1);
    expect(result.skippedNoCache).toBe(0);
  });

  it('never overrides an existing valid page count', () => {
    const cache = { '1': cachedBook('1', { pages: '500' }) };
    const result = computeBookPagesBackfill([entry({ id: '1', pages: '250' })], cache);
    expect(result.updates).toEqual([]);
    expect(result.skippedExisting).toBe(1);
    expect(cache['1'].pages).toBe('500');
  });

  it('skips rows for books not in the cache', () => {
    const result = computeBookPagesBackfill(
      [entry({ id: '1', pages: '250' }), entry({ id: '2', pages: '300' })],
      { '1': cachedBook('1') }
    );
    expect(result.updates).toEqual([{ id: '1', pages: '250' }]);
    expect(result.skippedNoCache).toBe(1);
  });

  it('ignores missing, zero, and unparseable page values', () => {
    const cache = { '1': cachedBook('1'), '2': cachedBook('2'), '3': cachedBook('3') };
    const result = computeBookPagesBackfill(
      [
        entry({ id: '1', pages: '' }),
        entry({ id: '2', pages: '0' }),
        entry({ id: '3', pages: 'n/a' }),
      ],
      cache
    );
    expect(result.updates).toEqual([]);
    expect(result.skippedExisting).toBe(0);
    expect(result.skippedNoCache).toBe(0);
  });

  it('ignores rows with no book id', () => {
    const result = computeBookPagesBackfill([entry({ id: '', pages: '250' })], { '1': cachedBook('1') });
    expect(result.updates).toEqual([]);
    expect(result.skippedNoCache).toBe(0);
  });

  it('uses the largest valid count for duplicate book ids', () => {
    const cache = { '1': cachedBook('1') };
    const result = computeBookPagesBackfill(
      [entry({ id: '1', pages: '200' }), entry({ id: '1', pages: '350' }), entry({ id: '1', pages: '0' })],
      cache
    );
    expect(result.updates).toEqual([{ id: '1', pages: '350' }]);
  });

  it('parses comma-formatted and suffixed page values', () => {
    const cache = { '1': cachedBook('1') };
    const result = computeBookPagesBackfill(
      [entry({ id: '1', pages: '1,024 pages' })],
      cache
    );
    expect(result.updates).toEqual([{ id: '1', pages: '1024' }]);
  });

  it('returns no updates for an empty export', () => {
    const result = computeBookPagesBackfill([], { '1': cachedBook('1') });
    expect(result.updates).toEqual([]);
    expect(result.skippedExisting).toBe(0);
    expect(result.skippedNoCache).toBe(0);
  });
});
