import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// runLifeInBooks boots the book cache + reads a library CSV, so each call is
// ~3.5s on its own; under the parallel unit-suite run that routinely exceeds
// vitest's 5000ms default. Give the slow tests a generous timeout.
const SLOW_TIMEOUT = 30_000;
import { runLifeInBooks } from './lifeInBooks.js';
import { runPublisherStats } from './publisherStats.js';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'goodreads-lifestats-'));
const CSV_FILE = path.join(TMP_DIR, 'library.csv');
const EMPTY_CSV = path.join(TMP_DIR, 'empty.csv');

let captured: string[] = [];

function capture(): { out: () => string; restore: () => void } {
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

const realCwd = process.cwd();

beforeEach(() => {
  captured = [];
});

beforeAll(() => {
  process.chdir(TMP_DIR);
});

afterAll(() => {
  process.chdir(realCwd);
  fs.removeSync(TMP_DIR);
});

const CSV_ROWS = [
  'Book Id,Title,Author,Exclusive Shelf,Date Read,My Review,My Rating,Number of Pages,Publisher,Bookshelves',
  '401,Moby Duck,Nina Nile,read,2019/01/15,Slow burn,3,200,SeaBooks,sea',
  '402,Otter World,Omar Oll,read,2020/02/02,,4,150,RiverBooks,river',
  '403,Pending Pigeon,Pia Pine,want-to-read,,,,0,,',
].join('\n');

beforeAll(async () => {
  await fs.writeFile(CSV_FILE, CSV_ROWS);
  await fs.writeFile(
    EMPTY_CSV,
    [
      'Book Id,Title,Author,Exclusive Shelf,Date Read,My Review,My Rating,Number of Pages,Publisher,Bookshelves',
      '403,Pending Pigeon,Pia Pine,want-to-read,,,,0,,',
    ].join('\n')
  );
});

describe('runLifeInBooks', () => {
  it('summarizes read entries across all report sections', async () => {
    const c = capture();
    try {
      await runLifeInBooks({ export: CSV_FILE, library: 'life-test' });
      const out = c.out();
      expect(out).toContain('Life in Books');
      expect(out).toContain('2 books read (1 reviewed)');
      expect(out).toContain('Active span: 2019 → 2020');
      expect(out).toContain('Moby Duck');
      expect(out).toContain('Otter World');
      expect(out).toContain('2019: 1 book, 200 pages, mean rating 3.00');
      expect(out).toContain('2020: 1 book, 150 pages, mean rating 4.00');
      expect(out).toContain('Ratings and reviews');
      expect(out).toContain('Publishers');
      expect(out).toContain('Bookshelves');
    } finally {
      c.restore();
    }
  }, SLOW_TIMEOUT);

  it('restricts to reviewed entries with requireReviews', async () => {
    const c = capture();
    try {
      await runLifeInBooks({ export: CSV_FILE, library: 'life-test', requireReviews: true });
      const out = c.out();
      expect(out).toContain('mean rating 3.00');
      expect(out).not.toContain('mean rating 4.00');
      expect(out).toContain('Active span: 2019 → 2019');
    } finally {
      c.restore();
    }
  }, SLOW_TIMEOUT);

  it('reports an empty read shelf', async () => {
    const c = capture();
    try {
      await runLifeInBooks({ export: EMPTY_CSV, library: 'life-empty' });
      const out = c.out();
      expect(out).toContain('No books read in the library export.');
    } finally {
      c.restore();
    }
  });
});

describe('runPublisherStats', () => {
  it('groups rated read books by publisher', async () => {
    const c = capture();
    try {
      await runPublisherStats({ export: CSV_FILE, library: 'life-test', minBooks: '1', limit: '5' });
      const out = c.out();
      expect(out).toContain('Favorite Publishers by');
      const riverPos = out.indexOf('RiverBooks');
      const seaPos = out.indexOf('SeaBooks');
      expect(riverPos).toBeGreaterThan(-1);
      expect(seaPos).toBeGreaterThan(-1);
      expect(riverPos).toBeLessThan(seaPos);
      expect(out).toContain('Avg my rating: 4.00');
      expect(out).toContain('Avg my rating: 3.00');
      expect(out).toContain('Distinct Publishers: 2');
      expect(out).toContain('Reviewed books: 2');
    } finally {
      c.restore();
    }
  });

  it('shows the no-match message when minBooks filters everything out', async () => {
    const c = capture();
    try {
      await runPublisherStats({ export: CSV_FILE, library: 'life-test' });
      const out = c.out();
      expect(out).toContain('No publishers with 3+ rated books found.');
    } finally {
      c.restore();
    }
  });
});
