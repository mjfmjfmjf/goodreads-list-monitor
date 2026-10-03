import fs from 'fs-extra';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-tagrecent-${process.pid}-${Date.now()}.db`;
});

vi.mock('./scraper.js', () => ({
  scrapeShelfBooks: vi.fn(),
}));

vi.mock('./utils.js', () => ({
  delay: vi.fn(async () => {}),
  isConnectivityError: vi.fn(() => false),
  isDbLockError: vi.fn(() => false),
  withConnectivityProbe: vi.fn(async (fn: any) => fn()),
  connectivityProbeDefaults: vi.fn(() => ({ waitMs: 1, probes: 1 })),
}));

import { closeDb, getDb } from './db.js';
import { scrapeShelfBooks } from './scraper.js';
import { isConnectivityError } from './utils.js';
import {
  getBook,
  getKnownShelfPages,
  loadTagTailScrape,
  loadTagTailState,
  persistShelfPageCount,
  saveTagTailState,
  upsertTagBooks,
} from './storage.js';
import { needsTailReprobe, pickAnchorPage, runTagRecentMonitor, shouldResumePass, tailAnchorPage, tailReadWindow } from './tagRecentMonitor.js';

const mockShelfBooks = vi.mocked(scrapeShelfBooks);
const DB_FILE = process.env.GOODREADS_DB_PATH!;

const book = (id: string, extra: Record<string, any> = {}): any => ({
  id,
  title: `Title ${id}`,
  author: 'Author',
  authorId: '1',
  authorSlug: '1.Author',
  ratings: '1000',
  avgRating: '4.00',
  published: '2020',
  lastUpdated: '2026-01-01T00:00:00Z',
  ...extra,
});

const shelfRows = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, position: i + 1, shelved: 5 }));

// A deterministic set-cover fixture whose tags are DENSE harvests, so the xref
// anchor is meaningful: beta adds 100 new books, gamma adds the last 49, so the
// greedy pick order is exactly [beta, gamma] and 'alpha' is never chosen.
// beta's xref runs to position 100 → anchor page 2; gamma's to 49 → page 1.
function seedCoverageFixture(): void {
  upsertTagBooks('beta', shelfRows('b', 100));
  upsertTagBooks('gamma', shelfRows('g', 49));
  upsertTagBooks('alpha', [{ id: 'b1', position: 1, shelved: 3 }, { id: 'b2', position: 2, shelved: 3 }]);
}

function markTagDoneInPass(tag: string, runStartedAt: string, lastPage: number): void {
  saveTagTailState({ runStartedAt, runCompleted: false });
  getDb().prepare(
    'INSERT INTO tag_tail_scrapes (tag_name, last_scraped, last_page_seen, books_added, authors_added) VALUES (?,?,?,?,?)'
  ).run(tag, new Date(Date.now() + 1000).toISOString(), lastPage, 0, 0);
}

beforeAll(() => {
  getDb(); // create schema in the temp DB
});

afterAll(() => {
  closeDb();
  delete process.env.GOODREADS_DB_PATH;
  for (const suffix of ['', '-wal', '-shm']) fs.removeSync(DB_FILE + suffix);
});

beforeEach(() => {
  mockShelfBooks.mockReset();
  (isConnectivityError as any).mockReturnValue(false);
  // Each test starts from an empty slate (one temp DB backs the whole file).
  const db = getDb();
  for (const table of ['tag_books', 'tag_tail_scrapes', 'tag_tail_monitor_state', 'books', 'authors', 'tag_stats']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tailAnchorPage', () => {
  it('derives the last harvested page from the xref max position (50 books/page)', () => {
    expect(tailAnchorPage(1250, 1250)).toBe(25); // the common saturated case
    expect(tailAnchorPage(100, 100)).toBe(2);
    expect(tailAnchorPage(51, 51)).toBe(2);
    expect(tailAnchorPage(50, 50)).toBe(1);
    expect(tailAnchorPage(1, 1)).toBe(1);
  });

  it('is null when the tag has no xref rows (caller falls back to measured)', () => {
    expect(tailAnchorPage(null, 0)).toBeNull();
    expect(tailAnchorPage(0, 0)).toBeNull();
  });

  it('starts at page 1 when the harvest is sparse (gaps below us we never read)', () => {
    // only pages 7-11 were ever harvested: max position 550 but just 250 rows
    expect(tailAnchorPage(550, 250)).toBe(1);
    expect(tailAnchorPage(1250, 500)).toBe(1);
  });
});

describe('pickAnchorPage', () => {
  it('uses the xref anchor when there is no measured page count', () => {
    expect(pickAnchorPage(25, null)).toBe(25);
  });

  it('lowers a stale xref anchor to a shorter measured page count (shelf shrank)', () => {
    // xref harvested 509 positions (page 11) but the footer admits 8 pages
    expect(pickAnchorPage(11, 8)).toBe(8);
  });

  it('never raises the anchor — a grown shelf still walks forward from the xref page', () => {
    expect(pickAnchorPage(8, 25)).toBe(8);
  });

  it('falls back to the measured page when the tag has no xref rows', () => {
    expect(pickAnchorPage(null, 6)).toBe(6);
    expect(pickAnchorPage(null, null)).toBeNull();
  });
});

describe('tailReadWindow', () => {
  it('starts at page 1 when the anchor is unknown', () => {
    expect(tailReadWindow(null, 25)).toEqual({ startPage: 1, maxPages: 25 });
  });

  it('starts at the anchor page and keeps the shelf cap as the outer wall', () => {
    expect(tailReadWindow(16, 25)).toEqual({ startPage: 16, maxPages: 25 });
  });

  it('clamps an anchor beyond the reachable ceiling (25) — the footer advertises unreachable pages', () => {
    expect(tailReadWindow(100, 25)).toEqual({ startPage: 25, maxPages: 25 });
    expect(tailReadWindow(125293, 25)).toEqual({ startPage: 25, maxPages: 25 });
    expect(tailReadWindow(26, 25)).toEqual({ startPage: 25, maxPages: 25 });
    expect(tailReadWindow(25, 25)).toEqual({ startPage: 25, maxPages: 25 });
  });

  it('never returns an outer wall above the reachable ceiling even with --shelfPages 100', () => {
    expect(tailReadWindow(10, 100)).toEqual({ startPage: 10, maxPages: 25 });
  });

  it('treats an anchor of 0 or 1 as a from-page-1 read', () => {
    expect(tailReadWindow(0, 25)).toEqual({ startPage: 1, maxPages: 25 });
    expect(tailReadWindow(1, 25)).toEqual({ startPage: 1, maxPages: 25 });
  });
});

describe('needsTailReprobe', () => {
  it('is true only when the read was empty and there was a known page to shrink from', () => {
    expect(needsTailReprobe(0, 5)).toBe(true);
    expect(needsTailReprobe(0, 1)).toBe(true);
    expect(needsTailReprobe(0, null)).toBe(false); // already read from page 1
    expect(needsTailReprobe(3, 5)).toBe(false);     // got books
  });
});

describe('shouldResumePass', () => {
  const now = new Date().toISOString();
  const recentStart = new Date(Date.now() - 2 * 3600 * 1000).toISOString();   // 2h ago
  const staleStart = new Date(Date.now() - 100 * 3600 * 1000).toISOString();  // 100h ago

  it('resumes a recent incomplete pass', () => {
    expect(shouldResumePass({ runStartedAt: recentStart, runCompleted: false }, now, 36, false)).toBe(true);
  });

  it('does not resume a completed pass', () => {
    expect(shouldResumePass({ runStartedAt: recentStart, runCompleted: true }, now, 36, false)).toBe(false);
  });

  it('does not resume a stale incomplete pass beyond the horizon', () => {
    expect(shouldResumePass({ runStartedAt: staleStart, runCompleted: false }, now, 36, false)).toBe(false);
  });

  it('does not resume with no prior state, or with --fresh', () => {
    expect(shouldResumePass(undefined, now, 36, false)).toBe(false);
    expect(shouldResumePass({ runStartedAt: recentStart, runCompleted: false }, now, 36, true)).toBe(false);
  });

  it('does not resume a start in the future (clock skew / bad row)', () => {
    const future = new Date(Date.now() + 10 * 3600 * 1000).toISOString();
    expect(shouldResumePass({ runStartedAt: future, runCompleted: false }, now, 36, false)).toBe(false);
  });
});

describe('runTagRecentMonitor', () => {
  it('walks the set-cover order and anchors each tail read on the tag_books xref', async () => {
    seedCoverageFixture();
    mockShelfBooks.mockImplementation(async (tag) => [book(tag === 'beta' ? '7' : '8', { position: 1, tagCount: 1 })]);

    await runTagRecentMonitor({});

    const calls = mockShelfBooks.mock.calls;
    expect(calls.map(c => c[0])).toEqual(['beta', 'gamma']); // coverage order; 'alpha' not chosen

    // beta's xref runs to position 100 → page 2; gamma's to 49 → page 1.
    const betaCall = calls[0];
    expect(betaCall[1]).toBe(0);       // minTags
    expect(betaCall[2]).toBe(25);      // maxPages outer wall
    expect(betaCall[3]).toBe(2);       // startPage from the xref anchor
    expect(betaCall[4]).toMatchObject({ skipAuthorSync: true });
    expect(calls[1][3]).toBe(1);

    expect(getBook('7')).toBeTruthy(); // new shelf book synced into the cache
    expect(loadTagTailScrape('beta')).toBeTruthy();
    expect(loadTagTailScrape('beta')!.booksAdded).toBeGreaterThanOrEqual(1);
    expect(loadTagTailState()!.runCompleted).toBe(true);
  });

  it('ignores a bogus measured page count in favour of the xref anchor (biology: measured 100)', async () => {
    seedCoverageFixture();
    // Saturated harvest to position 1,250 (page 25) plus the footer's unreachable
    // "100" — the 404 from the first live run.
    upsertTagBooks('beta', shelfRows('b', 1250));
    upsertTagBooks('gamma', shelfRows('g', 49));
    upsertTagBooks('alpha', [{ id: 'b1', position: 1, shelved: 3 }]);
    persistShelfPageCount('beta', 100);
    expect(getKnownShelfPages('beta')).toBe(100);

    mockShelfBooks.mockImplementation(async (tag) => [book(tag === 'beta' ? '70' : '80', { position: 1 })]);
    await runTagRecentMonitor({});

    const betaCall = mockShelfBooks.mock.calls.find(c => c[0] === 'beta')!;
    expect(betaCall[3]).toBe(25); // xref anchor (1250/50), NOT the measured 100
    expect(mockShelfBooks).toHaveBeenCalledTimes(2); // one fetch each, no 404+probe
  });

  it('anchors on a shorter measured page count instead of spending a refused fetch', async () => {
    seedCoverageFixture();
    // beta's xref says page 2 (100 positions), but the footer admits 1 page —
    // the stale-max-position case the live run kept paying 2 requests for.
    persistShelfPageCount('beta', 1);
    mockShelfBooks.mockImplementation(async () => [book('30', { position: 1 })]);
    await runTagRecentMonitor({});

    const betaCall = mockShelfBooks.mock.calls.find(c => c[0] === 'beta')!;
    expect(betaCall[3]).toBe(1); // lowered to the measured page
    expect(mockShelfBooks).toHaveBeenCalledTimes(2); // one fetch each, no probe
  });

  it('mints new authors from tail books and does NOT stamp books.tags', async () => {
    seedCoverageFixture();
    mockShelfBooks.mockImplementation(async (tag) =>
      tag === 'beta'
        ? [book('8', { author: 'Fresh Tail Author', authorId: '4242', authorSlug: '4242.Fresh_Tail_Author' })]
        : [book('9', { position: 1 })]
    );
    await runTagRecentMonitor({});
    const row = getDb().prepare('SELECT * FROM authors WHERE name = ?').get('Fresh Tail Author') as any;
    expect(row).toBeTruthy();
    expect(row.id).toBe('4242');
    expect(getBook('8')!.tags).toBeUndefined();
  });

  it('resumes an in-flight pass: skips a tag already tail-scraped in it', async () => {
    seedCoverageFixture();
    markTagDoneInPass('beta', new Date(Date.now() - 3600 * 1000).toISOString(), 2);

    mockShelfBooks.mockImplementation(async () => [book('20', { position: 1 })]);
    await runTagRecentMonitor({});

    expect(mockShelfBooks.mock.calls.map(c => c[0])).toEqual(['gamma']); // beta skipped
    expect(loadTagTailState()!.runCompleted).toBe(true);
  });

  it('--fresh re-checks a tag that was already done in a recent partial pass', async () => {
    seedCoverageFixture();
    markTagDoneInPass('beta', new Date(Date.now() - 3600 * 1000).toISOString(), 2);

    mockShelfBooks.mockImplementation(async () => [book('21', { position: 1 })]);
    await runTagRecentMonitor({ fresh: true });

    expect(mockShelfBooks.mock.calls.map(c => c[0])).toEqual(['beta', 'gamma']); // skip ignored
  });

  it('--minAgeHours skips a tag whose tail was read too recently', async () => {
    seedCoverageFixture();
    // beta was read 1h ago; gamma's row is absent (never checked).
    getDb().prepare(
      'INSERT INTO tag_tail_scrapes (tag_name, last_scraped, last_page_seen, books_added, authors_added) VALUES (?,?,?,?,?)'
    ).run('beta', new Date(Date.now() - 3600 * 1000).toISOString(), 2, 0, 0);

    mockShelfBooks.mockImplementation(async () => [book('40', { position: 1 })]);
    await runTagRecentMonitor({ minAgeHours: 24 });

    expect(mockShelfBooks.mock.calls.map(c => c[0])).toEqual(['gamma']); // beta too fresh
    expect(loadTagTailState()!.runCompleted).toBe(true);
  });

  it('--minAgeHours 0 (the default) re-checks everything', async () => {
    seedCoverageFixture();
    getDb().prepare(
      'INSERT INTO tag_tail_scrapes (tag_name, last_scraped, last_page_seen, books_added, authors_added) VALUES (?,?,?,?,?)'
    ).run('beta', new Date(Date.now() - 3600 * 1000).toISOString(), 2, 0, 0);

    mockShelfBooks.mockImplementation(async () => [book('41', { position: 1 })]);
    await runTagRecentMonitor({});

    expect(mockShelfBooks.mock.calls.map(c => c[0])).toEqual(['beta', 'gamma']);
  });

  it('--minAgeHours also gates a tag scraped just before this pass started (a resume)', async () => {
    seedCoverageFixture();
    markTagDoneInPass('beta', new Date(Date.now() - 2 * 3600 * 1000).toISOString(), 2);

    mockShelfBooks.mockImplementation(async () => [book('42', { position: 1 })]);
    await runTagRecentMonitor({ minAgeHours: 24 });

    // beta is both "already this pass" and inside the age gate — either way, skipped
    expect(mockShelfBooks.mock.calls.map(c => c[0])).toEqual(['gamma']);
  });

  it('a dry run previews the age gate without scraping', async () => {
    seedCoverageFixture();
    getDb().prepare(
      'INSERT INTO tag_tail_scrapes (tag_name, last_scraped, last_page_seen, books_added, authors_added) VALUES (?,?,?,?,?)'
    ).run('beta', new Date(Date.now() - 3600 * 1000).toISOString(), 2, 0, 0);

    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => logs.push(a.map(String).join(' ')));
    try {
      await runTagRecentMonitor({ dryRun: true, minAgeHours: 24 });
    } finally {
      spy.mockRestore();
    }
    expect(mockShelfBooks).not.toHaveBeenCalled();
    expect(logs.some(l => l.includes('Age gate: skipping 1 covered tag(s)'))).toBe(true);
  });

  it('dry run previews without scraping or writing pass state', async () => {
    seedCoverageFixture();
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => logs.push(a.map(String).join(' ')));
    try {
      await runTagRecentMonitor({ dryRun: true });
    } finally {
      spy.mockRestore();
    }
    expect(mockShelfBooks).not.toHaveBeenCalled();
    expect(loadTagTailState()).toBeUndefined();
    expect(logs.some(l => l.includes('dry run'))).toBe(true);
  });

  it('leaves the pass incomplete on a connectivity abort and stops early', async () => {
    seedCoverageFixture();
    (isConnectivityError as any).mockReturnValue(true);
    mockShelfBooks.mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

    await expect(runTagRecentMonitor({})).resolves.not.toThrow();

    expect(mockShelfBooks).toHaveBeenCalledTimes(1); // aborted on beta, gamma never attempted
    expect(loadTagTailState()!.runCompleted).toBe(false); // still open for resume
  });

  it('re-probes a shrunken shelf: empty tail + learned shorter length → reads the new tail', async () => {
    seedCoverageFixture();
    mockShelfBooks.mockImplementation(async (tag, _min, _max, start) => {
      if (tag !== 'beta') return [book('50', { position: 1 })];
      if (start === 2) {
        persistShelfPageCount('beta', 1); // probe learns the shelf is now 1 page
        return [];
      }
      if (start === 1) return [book('9', { position: 1 })];
      return [];
    });
    await runTagRecentMonitor({});
    const betaStarts = mockShelfBooks.mock.calls.filter(c => c[0] === 'beta').map(c => c[3]);
    expect(betaStarts).toEqual([2, 1, 1]); // anchor 2 empty → probe p1 → re-read tail p1
    expect(loadTagTailScrape('beta')!.lastPageSeen).toBe(1);
  });

  it('keeps the probe books when the empty tail page does not shrink the shelf', async () => {
    seedCoverageFixture();
    mockShelfBooks.mockImplementation(async (tag, _min, _max, start) => {
      if (tag !== 'beta') return [book('50', { position: 1 })];
      if (start === 2) return [];                              // flaky/empty tail
      if (start === 1) return [book('51', { position: 1 })];   // probe; length unchanged
      return [];
    });
    await runTagRecentMonitor({});
    const betaStarts = mockShelfBooks.mock.calls.filter(c => c[0] === 'beta').map(c => c[3]);
    expect(betaStarts).toEqual([2, 1]); // no second tail read
    // ...but the probe's book is still harvested rather than discarded.
    expect(getBook('51')).toBeTruthy();
  });
});
