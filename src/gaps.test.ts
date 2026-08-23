import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-gaps-test-${process.pid}-${Date.now()}.db`;
});

vi.mock('./scraper.js', () => ({
  scrapeShelfBooks: vi.fn(),
}));

import { closeDb } from './db.js';
import { scrapeShelfBooks } from './scraper.js';
import { upsertBook } from './storage.js';
import type { CachedBook } from './storage.js';
import { runCacheGaps, runTagGaps } from './tagGaps.js';
import { runNextBooks } from './nextBooks.js';

const mockScrape = vi.mocked(scrapeShelfBooks);

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'goodreads-gaps-'));
const CSV_FILE = path.join(TMP_DIR, 'library.csv');
const DB_FILE = process.env.GOODREADS_DB_PATH!;

let captured: string[] = [];

function capture(): { out: string; restore: () => void } {
  const origLog = console.log;
  const origErr = console.error;
  const strip = (s: string) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
  console.log = (...args: any[]) => captured.push(args.map(strip).join(' '));
  console.error = (...args: any[]) => captured.push(args.map(strip).join(' '));
  return {
    out: () => captured.join('\n'),
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

beforeEach(() => {
  captured = [];
  mockScrape.mockReset();
});

const realCwd = process.cwd();

afterAll(() => {
  process.chdir(realCwd);
  closeDb();
  delete process.env.GOODREADS_DB_PATH;
  for (const suffix of ['', '-wal', '-shm']) {
    fs.removeSync(DB_FILE + suffix);
  }
  fs.removeSync(TMP_DIR);
});

const base: CachedBook = {
  id: 'x',
  title: 'x',
  author: 'a',
  ratings: '0',
  published: 'Unknown',
  lastUpdated: '2026-08-22T00:00:00.000Z',
};

const book = (over: Partial<CachedBook>): CachedBook => ({ ...base, ...over });

beforeAll(() => {
  process.chdir(TMP_DIR);
});

beforeAll(async () => {
  const csv = [
    'Book Id,Title,Author,Exclusive Shelf,Date Read,My Review,My Rating,Number of Pages,Publisher,Bookshelves,Year Published',
    '201,Apple Pie,Alice Apple,read,2020/03/03,Loved it,5,300,Orchard,fantasy,2020',
    '202,Banana Boat,Bob Banana,read,2020/07/07,Great fun,4,250,Orchard,sci-fi,2020',
  ].join('\n');
  await fs.writeFile(CSV_FILE, csv);

  await upsertBook(book({ id: '999', title: 'Apple Pie', author: 'Alice Apple', ratings: '990' }));
  await upsertBook(book({ id: 'c1', title: 'Cat Tale', author: 'Cara Cat', ratings: '900', published: '1975', pages: '300' }));
  await upsertBook(book({ id: 'c2', title: 'Dog Days', author: 'Dan Dog', ratings: '800', published: '1980', pages: '280' }));
});

describe('runCacheGaps', () => {
  it('defaults to the most recent review year, skips reviewed books, fills letter/year buckets', async () => {
    const c = capture();
    try {
      await runCacheGaps({ export: CSV_FILE, library: 'gaps-test' });
      const out = c.out();
      expect(out).toContain('using most recent review year: 2020');
      expect(out).toContain('Book-cache gap fillers — review year 2020');
      expect(out).toContain('(skipped 1 already-reviewed books)');
      expect(out).toContain('Title first letter missing (24): C, D,');
      expect(out).toContain('[book:Cat Tale|c1]');
      expect(out).toContain('[book:Dog Days|c2]');
      expect(out).toContain(', pub 1975');
      expect(out).toContain('300 pages');
      expect(out).toContain('      1975:');
      expect(out).toContain('      1980:');
    } finally {
      c.restore();
    }
  });

  it('respects an explicit --year and the candidate limit', async () => {
    const c = capture();
    try {
      await runCacheGaps({ export: CSV_FILE, library: 'gaps-test', year: '2019', limit: '1' });
      const out = c.out();
      expect(out).toContain('review year 2019');
      const catListings = out.split('[book:Cat Tale|c1]').length - 1;
      const dogListings = out.split('[book:Dog Days|c2]').length - 1;
      expect(catListings).toBe(4);
      expect(dogListings).toBe(4);
    } finally {
      c.restore();
    }
  });
});

describe('runTagGaps', () => {
  it('scans mocked shelf results into the same gap dimensions', async () => {
    mockScrape.mockResolvedValue([
      { id: 'e1', title: 'Elk Run', author: 'Elle Elm', published: '1999', pages: '220', ratings: '5,000', avgRating: '4.20' },
    ] as any);
    const c = capture();
    try {
      await runTagGaps('fantasy', { export: CSV_FILE, library: 'gaps-test', pages: '1', year: '2020' });
      const out = c.out();
      expect(mockScrape).toHaveBeenCalledWith('fantasy', 0, 1);
      expect(out).toContain('Tag gaps for shelf "fantasy" — review year 2020');
      expect(out).toContain('[book:Elk Run|e1]');
      expect(out).toContain(', 220 pages');
      expect(out).toContain('shelf order');
    } finally {
      c.restore();
    }
  });
});

describe('runNextBooks', () => {
  it('lists unreviewed books and skips already-reviewed ones', async () => {
    mockScrape.mockResolvedValue([
      { id: '555', title: 'Apple Pie', author: 'Alice Apple', ratings: '1,000', published: 'Unknown' },
      { id: 'f1', title: 'Fox Trot', author: 'Fay Fox', ratings: '7,000', avgRating: '4.10', published: '2015' },
    ] as any);
    const c = capture();
    try {
      await runNextBooks('fantasy', { export: CSV_FILE, library: 'gaps-test', pages: '1', limit: '5' });
      const out = c.out();
      expect(out).toContain('Next 5 unreviewed books from shelf "fantasy"');
      expect(out).toContain('[book:Fox Trot|f1]');
      expect(out).not.toContain('[book:Apple Pie|555]');
      expect(out).toContain('Found 1 unreviewed (scanned 2; skipped 1 already-reviewed)');
    } finally {
      c.restore();
    }
  });

  it('reports when nothing unreviewed remains', async () => {
    mockScrape.mockResolvedValue([] as any);
    const c = capture();
    try {
      await runNextBooks('empty-shelf', { export: CSV_FILE, library: 'gaps-test', pages: '1' });
      const out = c.out();
      expect(out).toContain('No unreviewed books found in the first 0 shelf books.');
      expect(out).toContain('Found 0 unreviewed (scanned 0; skipped 0 already-reviewed)');
    } finally {
      c.restore();
    }
  });
});
