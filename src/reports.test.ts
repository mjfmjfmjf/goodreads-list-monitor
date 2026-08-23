import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-reports-test-${process.pid}-${Date.now()}.db`;
});

import { closeDb } from './db.js';
import { upsertBook } from './storage.js';
import type { CachedBook } from './storage.js';
import { runSummaryByYear } from './summary.js';
import { runSummaryRatings } from './summaryRatings.js';
import { runRatingsHistogram } from './summaryHistogram.js';
import { runAvgHistogram } from './summaryAvgHistogram.js';
import { runSummaryTop, runSummaryBottom } from './summaryTopRated.js';
import { runShelfStats } from './shelfStats.js';

const DB_FILE = process.env.GOODREADS_DB_PATH!;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'goodreads-reports-'));
const CSV_FILE = path.join(TMP_DIR, 'library.csv');

let captured: string[] = [];
let captureErr: string[] = [];

function capture(): { out: () => string; err: () => string; restore: () => void } {
  const origLog = console.log;
  const origErr = console.error;
  const strip = (s: string) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
  console.log = (...args: any[]) => captured.push(args.map(strip).join(' '));
  console.error = (...args: any[]) => captureErr.push(args.map(strip).join(' '));
  return {
    out: () => captured.join('\n'),
    err: () => captureErr.join('\n'),
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

beforeEach(() => {
  captured = [];
  captureErr = [];
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

// loadLibraryExport writes its cache JSON to process.cwd() — run everything
// from a temp directory so the repo's real libraryExportCache.json is never
// touched. DB path and CSV path are already absolute.
beforeAll(() => {
  process.chdir(TMP_DIR);
});

beforeAll(async () => {
  await upsertBook(book({ id: 'b1', title: 'Alpha Prime', author: 'A. Alpha', ratings: '3,000,000', avgRating: '4.50', published: '2001' }));
  await upsertBook(book({ id: 'b2', title: 'Beta Waves', author: 'B. Beta', ratings: '500,000', avgRating: '4.00', published: '2001' }));
  await upsertBook(book({ id: 'b3', title: 'Gamma Ray', author: 'G. Gamma', ratings: '120,000', avgRating: '2.00', published: '1999' }));
  await upsertBook(book({ id: 'b4', title: 'Delta Dawn', author: 'D. Delta', ratings: '10,000', avgRating: '4.75', published: 'Unknown' }));
  await upsertBook(book({ id: 'b5', title: 'Bad Egg', author: 'B. Bad', ratings: '900,000', avgRating: '4.90', published: '2020', isBad: true }));
  await upsertBook(book({ id: 'b6', title: 'Epsilon Minus', author: 'E. Epsilon', ratings: '42', published: '2020' }));
  await upsertBook(book({ id: 'b7', title: 'Zeta Narrow', author: 'Z. Zeta', ratings: '60', avgRating: '4.50', published: '2012' }));
  await upsertBook(book({ id: 'b8', title: 'Alpha Prime II', author: 'A. Alpha', ratings: '250,000', avgRating: '4.50', published: '2001' }));
  await upsertBook(book({ id: 'b9', title: 'Zeta Future', author: 'Z. Zeta', ratings: '5', published: 'Forthcoming' }));

  const csv = [
    'Book Id,Title,Author,Exclusive Shelf,Date Read,My Review,My Rating,Number of Pages,Publisher,Bookshelves',
    '101,Shelf One,Auth X,read,2020/01/01,,4,100,PubOne,fantasy',
    '102,Shelf Two,Auth Y,read,2021/02/02,,5,200,PubTwo,fantasy',
    '103,Shelf Three,Auth Z,read,,,,0,PubThree,sci-fi',
    '104,Shelf Four,Auth W,want-to-read,,,,0,,',
  ].join('\n');
  await fs.writeFile(CSV_FILE, csv);
});

describe('runSummaryByYear', () => {
  it('counts books per year with Unknown and unparseable buckets', async () => {
    const c = capture();
    try {
      await runSummaryByYear();
      const out = c.out();
      expect(out).toContain('1999: 1 books');
      expect(out).toContain('2001: 3 books');
      expect(out).toContain('2012: 1 books');
      expect(out).toContain('2020: 2 books');
      expect(out).toContain('Unknown: 1 books');
      expect(out).toContain('Forthcoming: 1 books');
      expect(out).toContain('Total books in cache: 9');
    } finally {
      c.restore();
    }
  });
});

describe('runSummaryRatings', () => {
  it('buckets every book by ratings count', async () => {
    const c = capture();
    try {
      await runSummaryRatings();
      const out = c.out();
      expect(out).toContain('3,000,000 to 3,999,999');
      expect(out).toContain('40 to 49');
      expect(out).toContain('Total books in cache: 9');
    } finally {
      c.restore();
    }
  });

  it('hideZero drops empty buckets', async () => {
    const c = capture();
    try {
      await runSummaryRatings({ hideZero: true });
      const out = c.out();
      expect(out).not.toContain('10,000,000+');
      expect(out).toContain('3,000,000 to 3,999,999');
    } finally {
      c.restore();
    }
  });

  it('without hideZero empty buckets are printed', async () => {
    const c = capture();
    try {
      await runSummaryRatings();
      expect(c.out()).toContain('10,000,000+');
    } finally {
      c.restore();
    }
  });
});

describe('runRatingsHistogram', () => {
  it('shows cumulative >= / <= columns that reconcile with the total', async () => {
    const c = capture();
    try {
      await runRatingsHistogram();
      const out = c.out();
      expect(out).toContain('Total books in cache: 9');
      expect(out).toContain('       9 <=');
      expect(out).toContain('       9 >=');
    } finally {
      c.restore();
    }
  });
});

describe('runAvgHistogram', () => {
  it('groups by 0.01 steps and excludes no-average books', async () => {
    const c = capture();
    try {
      await runAvgHistogram();
      const out = c.out();
      expect(out).toContain('Step: 0.01 (no grouping)');
      expect(out).toContain('Total books with avg rating: 7');
      expect(out).toContain('2 books have no average rating');
      expect(out).toContain('4.75');
    } finally {
      c.restore();
    }
  });

  it('applies the ratings filter and reports exclusions', async () => {
    const c = capture();
    try {
      await runAvgHistogram({ minRatings: '1000' });
      const out = c.out();
      expect(out).toContain('outside ratings filter (min 1,000)');
      expect(out).toContain('Total books with avg rating: 6');
    } finally {
      c.restore();
    }
  });

  it('coarse grouping merges adjacent averages into range labels', async () => {
    const c = capture();
    try {
      await runAvgHistogram({ step: '0.5' });
      const out = c.out();
      expect(out).toContain('Step: 0.50');
      expect(out).toContain('4.50 to 4.99');
    } finally {
      c.restore();
    }
  });
});

describe('runSummaryTop / runSummaryBottom', () => {
  it('top sorts by avg desc with ratings-count tiebreak, honors limit', async () => {
    const c = capture();
    try {
      await runSummaryTop({ minRatings: '1000', limit: '2' });
      const out = c.out();
      expect(out.indexOf('Delta Dawn')).toBeGreaterThanOrEqual(0);
      expect(out.indexOf('[book:Delta Dawn|b4]')).toBeLessThan(out.indexOf('[book:Alpha Prime|b1]'));
      expect(out).not.toContain('Alpha Prime II');
      expect(out).not.toContain('Bad Egg');
      expect(out).not.toContain('Beta Waves');
      expect(out).toContain('Total books matching criteria: 5 (Displayed: 2)');
    } finally {
      c.restore();
    }
  });

  it('bottom reverses the order', async () => {
    const c = capture();
    try {
      await runSummaryBottom({ minRatings: '1000' });
      const out = c.out();
      expect(out.indexOf('Gamma Ray')).toBeLessThan(out.indexOf('Beta Waves'));
      expect(out.indexOf('Beta Waves')).toBeLessThan(out.indexOf('Delta Dawn'));
    } finally {
      c.restore();
    }
  });

  it('reports when nothing matches', async () => {
    const c = capture();
    try {
      await runSummaryTop({ minRatings: '999999999' });
      expect(c.out()).toContain('No books found matching the criteria.');
    } finally {
      c.restore();
    }
  });

  it('respects min/max avg window', async () => {
    const c = capture();
    try {
      await runSummaryTop({ minAvg: '4.7', minRatings: '1000' });
      const out = c.out();
      expect(out).toContain('Delta Dawn');
      expect(out).not.toContain('Alpha Prime');
      expect(out).toContain('Total books matching criteria: 1 (Displayed: 1)');
    } finally {
      c.restore();
    }
  });
});

describe('most-rated book per year script', () => {
  it('prints the highest-rated book for each publication year', async () => {
    const c = capture();
    try {
      await import('./summaryTopByYear.js');
      const out = c.out();
      expect(out).toContain('Most Rated Book per Year');
      expect(out).toMatch(/2001 numRatings=3,000,000 \(4\.5 avg\)[^\n]*Alpha Prime/);
      expect(out).toMatch(/1999 numRatings=120,000[^\n]*Gamma Ray/);
      expect(out).toMatch(/2012 numRatings=60[^\n]*Zeta Narrow/);
      expect(out).toMatch(/2020 numRatings=900,000[^\n]*Bad Egg/);
      expect(out).toContain('Total years represented: 4');
    } finally {
      c.restore();
    }
  });
});

describe('runShelfStats', () => {
  it('counts shelves and sorts by count descending', async () => {
    const c = capture();
    try {
      await runShelfStats({ export: CSV_FILE, library: 'reports-test', limit: '10' });
      const out = c.out();
      expect(out).toContain('fantasy: 2 (50.0%)');
      expect(out).toContain('sci-fi: 1 (25.0%)');
      expect(out).toContain('Distinct shelves: 2 | Books: 4 (1 without shelves)');
      expect(out.indexOf('fantasy')).toBeLessThan(out.indexOf('sci-fi'));
    } finally {
      c.restore();
    }
  });

  it('honors limit and minCount', async () => {
    const c1 = capture();
    try {
      await runShelfStats({ export: CSV_FILE, library: 'reports-test', limit: '1' });
      expect(c1.out()).not.toContain('sci-fi:');
    } finally {
      c1.restore();
    }

    const c2 = capture();
    try {
      await runShelfStats({ export: CSV_FILE, library: 'reports-test', minCount: '2', limit: '10' });
      const out = c2.out();
      expect(out).toContain('Min count: 2');
      expect(out).toContain('fantasy');
      expect(out).not.toContain('sci-fi:');
    } finally {
      c2.restore();
    }
  });

  it('sorts alphabetically with sortBy=name', async () => {
    const c = capture();
    try {
      await runShelfStats({ export: CSV_FILE, library: 'reports-test', sortBy: 'name', limit: '10' });
      const out = c.out();
      expect(out.indexOf('fantasy')).toBeLessThan(out.indexOf('sci-fi'));
      expect(out).toContain('Sort: shelf name');
    } finally {
      c.restore();
    }
  });
});
