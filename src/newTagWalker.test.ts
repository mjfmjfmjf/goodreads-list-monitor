import fs from 'fs-extra';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-newtag-${process.pid}-${Date.now()}.db`;
});

vi.mock('./scraper.js', () => ({
  scrapeTopShelves: vi.fn(),
  scrapeShelfBooks: vi.fn(),
}));

vi.mock('./utils.js', () => ({
  delay: vi.fn(async () => {}),
  isConnectivityError: vi.fn(() => false),
  isDbLockError: vi.fn(() => false),
}));

import { closeDb, getDb } from './db.js';
import { scrapeShelfBooks, scrapeTopShelves } from './scraper.js';
import { getBook, persistShelfPageCount, upsertBook, upsertTagBooks } from './storage.js';
import { loadScrapedTagSet, isTagScraped, runNewTagWalker } from './newTagWalker.js';

const mockTopShelves = vi.mocked(scrapeTopShelves);
const mockShelfBooks = vi.mocked(scrapeShelfBooks);

const DB_FILE = process.env.GOODREADS_DB_PATH!;

const book = (id: string, ratings = '1000'): any => ({
  id,
  title: `Title ${id}`,
  author: 'Author',
  ratings,
  avgRating: '4.00',
  published: '2020',
  lastUpdated: '2026-01-01T00:00:00Z',
});

afterAll(() => {
  closeDb();
  delete process.env.GOODREADS_DB_PATH;
  for (const suffix of ['', '-wal', '-shm']) fs.removeSync(DB_FILE + suffix);
});

beforeEach(() => {
  mockTopShelves.mockReset();
  mockShelfBooks.mockReset();
});

describe('scraped-tag detection', () => {
  it('is false for tags never scraped', () => {
    expect(isTagScraped('cooking')).toBe(false);
    expect(loadScrapedTagSet().size).toBe(0);
  });

  it('is true once the shelf has been captured into tag_books', () => {
    upsertTagBooks('cooking', [{ id: '111', position: 1, shelved: 50 }]);
    expect(isTagScraped('cooking')).toBe(true);
  });

  it('does not consider a tag scraped from tag_stats alone (tag_books is the signal)', () => {
    persistShelfPageCount('searched-only', 7);
    expect(isTagScraped('searched-only')).toBe(false);
  });
});

describe('runNewTagWalker', () => {
  it('scrapes only tags not yet in tag_books, walking pages in order', async () => {
    upsertTagBooks('sci-fi', [{ id: '1', position: 1, shelved: 10 }]);
    upsertBook(book('111'));

    mockTopShelves
      .mockResolvedValueOnce(['sci-fi', 'grilling'])      // page 1: sci-fi already scraped
      .mockResolvedValueOnce(['medicine'])                // page 2
      .mockResolvedValueOnce([]);                         // page 3: end of list

    mockShelfBooks.mockImplementation(async (tag) => {
      if (tag === 'grilling') return [{ ...book('111'), position: 1, tagCount: 42 }];
      if (tag === 'medicine') return [{ ...book('222'), position: 1, tagCount: 7 }];
      return [];
    });

    await runNewTagWalker({});

    expect(mockTopShelves).toHaveBeenCalledTimes(3);      // walked until list ended
    const scrapedTags = mockShelfBooks.mock.calls.map(c => c[0]);
    expect(scrapedTags).toEqual(['grilling', 'medicine']); // sci-fi skipped

    // stamps tags[grilling]=42 on the book row (the discovery "usual way")
    const stamped = getBook('111')!;
    expect(stamped.tags).toEqual({ grilling: 42 });
  });

  it('dry run lists new tags without scraping', async () => {
    mockTopShelves.mockResolvedValueOnce(['fresh-tag']).mockResolvedValueOnce([]);
    await runNewTagWalker({ dryRun: true });
    expect(mockShelfBooks).not.toHaveBeenCalled();
  });

  it('handles a non-connectivity scrape error by logging and continuing', async () => {
    upsertTagBooks('history', [{ id: '1', position: 1, shelved: 10 }]);
    const countBefore = (getDb().prepare('SELECT COUNT(*) AS c FROM tag_books').get() as any).c;
    mockTopShelves.mockResolvedValueOnce(['history', 'broken']).mockResolvedValueOnce([]);
    mockShelfBooks.mockRejectedValueOnce(new Error('boom'));
    await expect(runNewTagWalker({})).resolves.not.toThrow();
    const countAfter = (getDb().prepare('SELECT COUNT(*) AS c FROM tag_books').get() as any).c;
    expect(countAfter).toBe(countBefore); // failed scrape adds nothing
  });
});