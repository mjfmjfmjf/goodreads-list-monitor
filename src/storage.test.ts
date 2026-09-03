import fs from 'fs-extra';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Redirect storage to an isolated temp database BEFORE db.js is imported.
// vi.hoisted runs before static imports are evaluated.
vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-storage-test-${process.pid}-${Date.now()}.db`;
});

import { closeDb, getDb } from './db.js';
import {
  deleteBook,
  findAuthorBySlug,
  getAuthor,
  getBook,
  loadAuthorCache,
  loadBookCache,
  loadConfig,
  loadState,
  saveState,
  syncAuthorsToCache,
  syncBooksToCache,
  updateAuthorStats,
  upsertAuthor,
  upsertBook,
  upsertTagBooks,
  loadTagBooks,
  recordAuthorScrapeFailure,
  clearAuthorScrapeFailure,
  loadAuthorScrapeFailure,
  loadScrapeFailures,
  upsertGenres,
  loadGenres,
  countGenres,
  replaceGenreTagXref,
  loadGenreTagXref,
  loadXrefTagMap
} from './storage.js';
import type { AuthorCacheEntry, CachedBook } from './storage.js';

const DB_FILE = process.env.GOODREADS_DB_PATH!;

afterAll(() => {
  closeDb();
  delete process.env.GOODREADS_DB_PATH;
  for (const suffix of ['', '-wal', '-shm']) {
    fs.removeSync(DB_FILE + suffix);
  }
});

const makeEntry = (overrides: Partial<AuthorCacheEntry> = {}): AuthorCacheEntry => ({
  id: '111',
  slug: '111.Test_Author',
  lastSeen: '2026-08-01T00:00:00.000Z',
  averageRating: '4.50',
  numRatings: '1,000',
  numReviews: '100',
  numShelves: '2,000',
  ...overrides,
});

const makeBook = (overrides: Partial<CachedBook> = {}): CachedBook => ({
  id: '9001',
  title: 'Test Book',
  author: 'Test Author',
  ratings: '5,000',
  published: '2020',
  lastUpdated: '2026-08-01T00:00:00.000Z',
  ...overrides,
});

describe('updateAuthorStats (pure)', () => {
  it('rejects regressions in ratings or reviews', () => {
    const entry = makeEntry();
    expect(updateAuthorStats(entry, { numRatings: '999', numReviews: '100' })).toBe(false);
    expect(updateAuthorStats(entry, { numRatings: '1,000', numReviews: '99' })).toBe(false);
    expect(entry.numRatings).toBe('1,000');
    expect(entry.lastSeen).toBe('2026-08-01T00:00:00.000Z');
  });

  it('applies growth and bumps lastSeen', () => {
    const entry = makeEntry({ averageRating: '4.50' });
    const changed = updateAuthorStats(entry, {
      averageRating: '4.72',
      numRatings: '1,234',
      numReviews: '120',
      numShelves: '2,500',
    });
    expect(changed).toBe(true);
    expect(entry.averageRating).toBe('4.72');
    expect(entry.numRatings).toBe('1,234');
    expect(entry.lastSeen).not.toBe('2026-08-01T00:00:00.000Z');
  });

  it('returns false when nothing differs', () => {
    const entry = makeEntry();
    expect(updateAuthorStats(entry, {
      averageRating: '4.50', numRatings: '1,000', numReviews: '100', numShelves: '2,000',
    })).toBe(false);
  });
});

describe('author rows', () => {
  it('round-trips upsertAuthor -> getAuthor with comma strings normalized to integers', () => {
    upsertAuthor('Round Trip Author', makeEntry({ id: '222', slug: '222.Round_Trip_Author' }));
    const got = getAuthor('Round Trip Author')!;
    expect(got).toBeDefined();
    expect(got.id).toBe('222');
    expect(got.slug).toBe('222.Round_Trip_Author');
    expect(got.averageRating).toBe('4.5');
    expect(got.numRatings).toBe('1000');
    expect(got.numReviews).toBe('100');
    expect(got.numShelves).toBe('2000');
  });

  it('upsert on the same name overwrites all columns', () => {
    upsertAuthor('Overwrite Author', makeEntry({ id: '333', slug: '333.Overwrite_Author', numRatings: '10' }));
    upsertAuthor('Overwrite Author', makeEntry({ id: '333', slug: '333.Overwrite_Author', numRatings: '20' }));
    expect(getAuthor('Overwrite Author')!.numRatings).toBe('20');
  });

  it('first_seen defaults to lastSeen on insert and is preserved on update', () => {
    upsertAuthor('First Seen Author', makeEntry({
      id: '555', slug: '555.First_Seen', lastSeen: '2026-08-01T00:00:00.000Z',
    }));
    expect(getAuthor('First Seen Author')!.firstSeen).toBe('2026-08-01T00:00:00.000Z');
    upsertAuthor('First Seen Author', makeEntry({
      id: '555', slug: '555.First_Seen', lastSeen: '2026-08-20T00:00:00.000Z',
    }));
    const seen = getAuthor('First Seen Author')!;
    expect(seen.lastSeen).toBe('2026-08-20T00:00:00.000Z');
    expect(seen.firstSeen).toBe('2026-08-01T00:00:00.000Z');
  });

  it('explicit firstSeen is honored on first insert', () => {
    upsertAuthor('Explicit First Seen', makeEntry({
      id: '557', slug: '557.Explicit_First_Seen', lastSeen: '2026-08-20T00:00:00.000Z', firstSeen: '2026-07-01T00:00:00.000Z',
    }));
    expect(getAuthor('Explicit First Seen')!.firstSeen).toBe('2026-07-01T00:00:00.000Z');
  });

  it('getAuthor returns undefined for unknown names', () => {
    expect(getAuthor('Nobody Knows Me')).toBeUndefined();
  });

  it('findAuthorBySlug picks the most recently seen row for a shared slug', () => {
    upsertAuthor('Kafka Old', makeEntry({
      id: '444', slug: '444.Shared_Slug', lastSeen: '2026-06-14T17:00:00.000Z', numRatings: '1',
    }));
    upsertAuthor('Kafka New', makeEntry({
      id: '444', slug: '444.Shared_Slug', lastSeen: '2026-08-22T15:00:00.000Z', numRatings: '2',
    }));
    const found = findAuthorBySlug('444.Shared_Slug')!;
    expect(found.key).toBe('Kafka New');
    expect(found.entry.numRatings).toBe('2');
    expect(findAuthorBySlug('missing.slug')).toBeUndefined();
  });

  it('loadAuthorCache returns every row keyed by name', () => {
    upsertAuthor('Cache Check A', makeEntry({ id: '666', slug: '666.Cache_Check_A' }));
    const cache = loadAuthorCache();
    expect(cache['Cache Check A'].slug).toBe('666.Cache_Check_A');
    expect(cache['Round Trip Author']).toBeDefined();
  });
});

describe('syncAuthorsToCache seeding', () => {
  it('seeds authors from books, skipping unknowns and missing slugs', async () => {
    const cache = {};
    await syncAuthorsToCache([
      { author: 'Seeded Author', authorSlug: '777.Seeded_Author', authorId: '777' },
      { author: 'Unknown Author', authorSlug: '888.Unknown_Author' },
      { author: 'No Slug Author' },
      { author: '' },
    ], cache as any);
    expect(getAuthor('Seeded Author')!.slug).toBe('777.Seeded_Author');
    expect((cache as any)['Seeded Author'].id).toBe('777');
    expect(Object.keys(cache as any)).toEqual(['Seeded Author']);
  });

  it('leaves existing entries alone when the slug matches, re-seeds when it changes', async () => {
    upsertAuthor('Slug Shift', makeEntry({ id: '999', slug: '999.Old_Slug', numRatings: '50' }));
    const cache = { 'Slug Shift': makeEntry({ id: '999', slug: '999.Old_Slug', numRatings: '50' }) };
    await syncAuthorsToCache([
      { author: 'Slug Shift', authorSlug: '999.Old_Slug' },
      { author: 'Slug Shift', authorSlug: '999.New_Slug', authorId: '999' },
    ], cache);
    const after = getAuthor('Slug Shift')!;
    expect(after.slug).toBe('999.New_Slug');
    // Re-seeding updates identity columns only — previously scraped stats survive.
    expect(after.numRatings).toBe('50');
  });
});

describe('book rows', () => {
  it('round-trips every column through upsertBook -> getBook', () => {
    upsertBook(makeBook({
      id: '9002',
      authorId: '555',
      avgRating: '4.61',
      pages: '384',
      seriesPos: 3,
      genres: ['Fantasy', 'Epic'],
      tags: { 'science-fiction': 12 },
      requiresAuth: true,
      isBad: false,
      failCount: 2,
    }));
    const got = getBook('9002')!;
    expect(got.title).toBe('Test Book');
    expect(got.authorId).toBe('555');
    expect(got.ratings).toBe('5000');
    expect(got.avgRating).toBe('4.61');
    expect(got.published).toBe('2020');
    expect(got.pages).toBe('384');
    expect(got.seriesPos).toBe(3);
    expect(got.genres).toEqual(['Fantasy', 'Epic']);
    expect(got.tags).toEqual({ 'science-fiction': 12 });
    expect(got.requiresAuth).toBe(true);
    expect(got.isBad).toBe(false);
    expect(got.failCount).toBe(2);
  });

  it('upsertBook writes exactly what it is given — omitted columns are cleared', () => {
    upsertBook(makeBook({ id: '9003', genres: ['Fantasy'], failCount: 4 }));
    upsertBook(makeBook({ id: '9003' }));
    const got = getBook('9003')!;
    expect(got.genres).toBeUndefined();
    expect(got.failCount).toBeUndefined();
  });

  it('getBook and loadBookCache agree, and unknown ids are undefined', () => {
    expect(getBook('does-not-exist')).toBeUndefined();
    upsertBook(makeBook({ id: '9004' }));
    expect(loadBookCache()['9004'].title).toBe('Test Book');
  });

  it('deleteBook removes once then reports false', () => {
    upsertBook(makeBook({ id: '9005' }));
    expect(deleteBook('9005')).toBe(true);
    expect(getBook('9005')).toBeUndefined();
    expect(deleteBook('9005')).toBe(false);
  });
});

describe('tag_books upsert / lookup', () => {
  it('inserts rows keyed by (tag, book) with position + timestamp', () => {
    upsertTagBooks('graphic-novels', [
      { id: '1001', position: 1, shelved: 841 },
      { id: '1002', position: 2, shelved: 500 },
      { id: '1003', position: 3 },
    ]);
    const rows = loadTagBooks('graphic-novels');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ tagName: 'graphic-novels', bookId: '1001', position: 1, shelved: 841 });
    expect(rows[0].harvestedAt).toBeTruthy();
    expect(rows[1].shelved).toBe(500);
    expect(rows[2].shelved).toBeUndefined();
    expect(rows.map(r => r.bookId)).toEqual(['1001', '1002', '1003']);
  });

  it('upsert on the same (tag, book) refreshes position and shelved instead of duplicating', () => {
    upsertTagBooks('graphic-novels-pos-refresh', [{ id: '1001', position: 1, shelved: 100 }]);
    upsertTagBooks('graphic-novels-pos-refresh', [{ id: '1001', position: 991, shelved: 841 }]);
    upsertTagBooks('graphic-novels-pos-refresh', [{ id: '1002', position: 992 }]);
    const rows = loadTagBooks('graphic-novels-pos-refresh');
    expect(rows).toHaveLength(2);
    const moved = rows.find(r => r.bookId === '1001')!;
    expect(moved.position).toBe(991);
    expect(moved.shelved).toBe(841);
  });

  it('keeps distinct rows when different books share the same position', () => {
    upsertTagBooks('graphic-novels-shared-pos', [{ id: '2001', position: 1250 }]);
    upsertTagBooks('graphic-novels-shared-pos', [{ id: '2002', position: 1250 }]);
    const rows = loadTagBooks('graphic-novels-shared-pos');
    expect(rows.filter(r => r.position === 1250)).toHaveLength(2);
  });

  it('holds multiple tags independently and supports per-book lookup', () => {
    upsertTagBooks('graphic-novels', [{ id: '3001', position: 5 }]);
    upsertTagBooks('manga', [{ id: '3001', position: 9 }]);
    upsertTagBooks('manga', [{ id: '3002', position: 1 }]);
    expect(loadTagBooks('manga')).toHaveLength(2);
    const byBook = loadTagBooks(undefined, '3001');
    expect(byBook.map(r => r.tagName).sort()).toEqual(['graphic-novels', 'manga']);
  });

  it('is a no-op for an empty book list', () => {
    upsertTagBooks('fantasy', []);
    expect(loadTagBooks('fantasy')).toHaveLength(0);
  });
});

describe('syncBooksToCache merge semantics', () => {
  it('conflict-upgrades ratings without wiping genres/tags/auth flags/failCount', async () => {
    upsertBook(makeBook({
      id: '9100',
      ratings: '1,000',
      genres: ['Fantasy'],
      tags: { 'epic': 7 },
      requiresAuth: true,
      isBad: true,
      failCount: 3,
      seriesPos: 2,
    }));
    await syncBooksToCache([makeBook({ id: '9100', ratings: '1,200' })], {});
    const got = getBook('9100')!;
    expect(got.ratings).toBe('1200');
    expect(got.genres).toEqual(['Fantasy']);
    expect(got.tags).toEqual({ 'epic': 7 });
    expect(got.requiresAuth).toBe(true);
    expect(got.isBad).toBe(true);
    expect(got.failCount).toBe(3);
    expect(got.seriesPos).toBe(2);
  });

  it('never regresses ratings from a stale snapshot', async () => {
    upsertBook(makeBook({ id: '9101', ratings: '9,999' }));
    await syncBooksToCache([makeBook({ id: '9101', ratings: '10' })], {});
    expect(getBook('9101')!.ratings).toBe('9999');
  });

  it('keeps the existing real title when the incoming one is Unknown', async () => {
    upsertBook(makeBook({ id: '9102', title: 'Real Title' }));
    await syncBooksToCache([makeBook({ id: '9102', title: 'Unknown', author: 'Unknown' })], {});
    const got = getBook('9102')!;
    expect(got.title).toBe('Real Title');
    expect(got.author).toBe('Test Author');
  });

  it('inserts brand-new books into the database and seeds the caller cache', async () => {
    const cache = {};
    await syncBooksToCache([makeBook({ id: '9103', tagCount: 5 })], cache as any);
    expect(getBook('9103')).toBeDefined();
    expect((cache as any)['9103'].tags).toEqual({});
  });

  it('reports inserted vs updated counts', async () => {
    upsertBook(makeBook({ id: '9104', ratings: '100' }));
    const first = await syncBooksToCache([
      makeBook({ id: '9105', ratings: '50' }),
      makeBook({ id: '9106', ratings: '60' }),
    ], {});
    expect(first).toEqual({ inserted: 2, updated: 0 });
    const second = await syncBooksToCache([
      makeBook({ id: '9105', ratings: '500' }),
      makeBook({ id: '9106', ratings: '40' }),
    ], {});
    expect(second).toEqual({ inserted: 0, updated: 1 });
  });
});

describe('state and config', () => {
  it('saveState -> loadState round-trips lists with all fields', () => {
    saveState({
      userId: '12345',
      lists: {
        '100': { title: 'Best of 2020', lastCount: 42, seenBookIds: ['1', '2'], ingested: true, discoveryPage: 3, url: 'https://example.com/list' },
        '200': { title: 'To Ingest', lastCount: 0, seenBookIds: [] },
      },
    });
    const state = loadState();
    expect(state.userId).toBe('12345');
    expect(state.lists['100']).toEqual({
      title: 'Best of 2020', lastCount: 42, seenBookIds: ['1', '2'], ingested: true, discoveryPage: 3, url: 'https://example.com/list',
    });
    expect(state.lists['200'].ingested).toBe(false);
    expect(state.lists['200'].discoveryPage).toBeUndefined();
  });

  it('saveState replaces the previous list set entirely', () => {
    saveState({ userId: '1', lists: { '300': { title: 'Gone Soon', lastCount: 1, seenBookIds: [] } } });
    saveState({ userId: '1', lists: { '301': { title: 'Stays', lastCount: 2, seenBookIds: [] } } });
    const state = loadState();
    expect(state.lists['300']).toBeUndefined();
    expect(state.lists['301'].title).toBe('Stays');
  });

  it('loadConfig returns the stored cookie and empty when absent', () => {
    expect(loadConfig()).toEqual({});
    getDb().prepare(`INSERT INTO config (key, value) VALUES ('cookie', 'test-cookie') ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
    expect(loadConfig()).toEqual({ cookie: 'test-cookie' });
  });
});

describe('author scrape-failure tracking', () => {
  it('records a failure, increments the count across calls, and loads it back', () => {
    clearAuthorScrapeFailure('51912681');
    expect(loadAuthorScrapeFailure('51912681')).toBeUndefined();

    recordAuthorScrapeFailure('51912681', 'ERR_BAD_REQUEST');
    recordAuthorScrapeFailure('51912681', 'ERR_BAD_REQUEST');

    const fail = loadAuthorScrapeFailure('51912681');
    expect(fail?.authorId).toBe('51912681');
    expect(fail?.failCount).toBe(2);
    expect(fail?.lastError).toBe('ERR_BAD_REQUEST');
    expect(fail?.firstSeen).toBeTruthy();
    expect(fail?.lastSeen).toBeTruthy();
  });

  it('clearAuthorScrapeFailure removes the record', () => {
    recordAuthorScrapeFailure('55', 'boom');
    expect(loadAuthorScrapeFailure('55')?.failCount).toBe(1);
    clearAuthorScrapeFailure('55');
    expect(loadAuthorScrapeFailure('55')).toBeUndefined();
  });

  it('loadScrapeFailures returns all tracked ids with their count', () => {
    clearAuthorScrapeFailure('111');
    clearAuthorScrapeFailure('222');
    recordAuthorScrapeFailure('111', 'e1');
    recordAuthorScrapeFailure('222', 'e2');
    recordAuthorScrapeFailure('222', 'e2b');

    const all = loadScrapeFailures();
    const byId = Object.fromEntries(all.map(f => [f.authorId, f.failCount]));
    expect(byId['111']).toBe(1);
    expect(byId['222']).toBe(2);
  });
});

describe('genre catalog tracking', () => {
  const clear = () => getDb().prepare(`DELETE FROM genres WHERE name IN ('scifi', 'scifi-2')`).run();
  beforeEach(() => clear());

  it('upsertGenres inserts new rows with first_seen + last_updated', () => {
    const { inserted, updated } = upsertGenres([{ name: 'scifi', memberCount: 123 }]);
    expect(inserted).toBe(1);
    expect(updated).toBe(0);

    const g = loadGenres().find(x => x.name === 'scifi')!;
    expect(g.memberCount).toBe(123);
    expect(g.firstSeen).toBeTruthy();
    expect(g.lastUpdated).toBeTruthy();
    expect(g.lastUpdated).toBe(g.firstSeen); // first insert sets both to now
  });

  it('re-upsert refreshes last_updated and member_count but keeps first_seen', async () => {
    upsertGenres([{ name: 'scifi', memberCount: 100 }]);
    const before = loadGenres().find(x => x.name === 'scifi')!;
    await new Promise(r => setTimeout(r, 5));

    const { inserted, updated } = upsertGenres([{ name: 'scifi', memberCount: 999 }]);
    expect(inserted).toBe(0);
    expect(updated).toBe(1);

    const after = loadGenres().find(x => x.name === 'scifi')!;
    expect(after.memberCount).toBe(999);
    expect(after.firstSeen).toBe(before.firstSeen);
    expect(after.lastUpdated >= before.lastUpdated).toBe(true);
  });

  it('countGenres reflects the number of distinct genres', () => {
    upsertGenres([{ name: 'scifi', memberCount: 1 }, { name: 'scifi-2', memberCount: 2 }]);
    expect(countGenres()).toBe(2);
  });
});

describe('genre_tag_xref', () => {
  const clear = () => getDb().prepare(`DELETE FROM genre_tag_xref WHERE genre_name IN ('science-fiction', 'non-fiction')`).run();
  beforeEach(() => clear());

  it('replaceGenreTagXref inserts the mapping rows', () => {
    const r = replaceGenreTagXref('science-fiction', [
      { tagName: 'sf', kind: 'cognate' },
      { tagName: 'sci-fi', kind: 'cognate' },
      { tagName: 'science-fiction', kind: 'cognate' },
    ]);
    expect(r.added).toBe(3);

    const rows = loadGenreTagXref().filter(x => x.genreName === 'science-fiction');
    expect(rows.map(x => x.tagName).sort()).toEqual(['sci-fi', 'science-fiction', 'sf']);
    expect(rows.every(x => x.kind === 'cognate')).toBe(true);
  });

  it('re-running with the same set is idempotent (no adds/removes)', () => {
    replaceGenreTagXref('non-fiction', [{ tagName: 'nonfiction', kind: 'cognate' }]);
    const r = replaceGenreTagXref('non-fiction', [{ tagName: 'nonfiction', kind: 'cognate' }]);
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
  });

  it('removes a stale alias no longer in the set', () => {
    replaceGenreTagXref('science-fiction', [
      { tagName: 'sf', kind: 'cognate' },
      { tagName: 'scifi', kind: 'cognate' },
    ]);
    const r = replaceGenreTagXref('science-fiction', [
      { tagName: 'sf', kind: 'cognate' },
    ]);
    expect(r.removed).toBe(1);
    expect(loadGenreTagXref().filter(x => x.genreName === 'science-fiction').map(x => x.tagName)).toEqual(['sf']);
  });

  it('loadXrefTagMap maps each tag to its canonical genre', () => {
    replaceGenreTagXref('science-fiction', [
      { tagName: 'sf', kind: 'cognate' },
      { tagName: 'scifi', kind: 'cognate' },
    ]);
    const map = loadXrefTagMap();
    expect(map.get('sf')).toBe('science-fiction');
    expect(map.get('scifi')).toBe('science-fiction');
  });
});
