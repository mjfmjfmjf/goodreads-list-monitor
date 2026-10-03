import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-authorone-test-${process.pid}-${Date.now()}.db`;
  // Keep the inter-author politeness gap out of the test's runtime.
  process.env.GR_AUTHOR_DELAY_MS = '0,0';
});

vi.mock('./scraper.js', () => ({
  scrapeAuthorStats: vi.fn(),
}));

import { closeDb, getDb } from './db.js';
import { scrapeAuthorStats } from './scraper.js';
import { authorExistsById, upsertAuthor } from './storage.js';
import { runAuthorOneFile } from './authorOne.js';

const mockScrape = vi.mocked(scrapeAuthorStats);

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'goodreads-authorone-'));
const LIST_FILE = path.join(TMP_DIR, 'authors.txt');

function fakeResult(slug: string) {
  return {
    stats: {
      name: `Name ${slug}`,
      slug: `${slug}.Slug_Name`,
      numRatings: '100',
      numReviews: '5',
      numShelves: '7',
      averageRating: '4.0',
    },
    booksInserted: 3,
    booksEnriched: 1,
    catalogPages: 1,
  };
}

beforeEach(() => {
  mockScrape.mockReset();
  mockScrape.mockImplementation(async (slug: string) => fakeResult(slug) as any);
});

afterAll(() => {
  closeDb();
  delete process.env.GOODREADS_DB_PATH;
});

describe('runAuthorOneFile', () => {
  it('scrapes each id, dedupes, and skips authors already in the cache', async () => {
    const db = getDb();
    // 999 is already cached; it should be skipped.
    upsertAuthor('Existing Author', { id: '999', slug: '999.Existing', lastSeen: new Date().toISOString() });

    fs.writeFileSync(LIST_FILE, ['123', '456', '# a comment', 'not-an-author', '999', '123', ''].join('\n'));

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: any[]) => logs.push(a.map(String).join(' '));
    await runAuthorOneFile(LIST_FILE, { multiPage: true });
    console.log = orig;

    // 123 (deduped), 456 — not 999 (cached), not the junk line.
    expect(mockScrape).toHaveBeenCalledTimes(2);
    expect(mockScrape).toHaveBeenCalledWith('123', expect.any(Function), true, undefined, false);
    expect(mockScrape).toHaveBeenCalledWith('456', expect.any(Function), true, undefined, false);

    // Both were persisted with their scraped ids.
    expect(authorExistsById('123')).toBe(true);
    expect(authorExistsById('456')).toBe(true);

    const out = logs.join('\n');
    expect(out).toContain('skipped (already cached) 1');
    expect(out).toContain('scraped 2 (2 new / 0 already known)');
    // 2 authors x (3 new / 1 enriched) from the mocked scrape result.
    expect(out).toContain('Books: 6 new / 2 enriched');
  });

  it('stops the batch on an exhausted connectivity error and keeps progress', async () => {
    const err: any = new Error('socket hang up');
    err.code = 'ECONNRESET';
    mockScrape.mockImplementationOnce(async (slug: string) => fakeResult(slug) as any);
    mockScrape.mockImplementationOnce(async () => { throw err; });

    fs.writeFileSync(LIST_FILE, ['111', '222', '333'].join('\n'));

    const origErr = console.error;
    console.error = () => {};
    await runAuthorOneFile(LIST_FILE);
    console.error = origErr;

    // 111 succeeded; 222 aborted the batch, so 333 was never attempted.
    expect(mockScrape).toHaveBeenCalledTimes(2);
    expect(authorExistsById('111')).toBe(true);
    expect(authorExistsById('222')).toBe(false);
    expect(authorExistsById('333')).toBe(false);
  });
});
