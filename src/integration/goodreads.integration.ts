import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { delay } from '../utils.js';
import { loadLibraryExportCache } from '../libraryExport.js';
import { loadAuthorCache } from '../storage.js';
import {
  scrapeTopShelves,
  scrapeShelfBooks,
  scrapeAuthorStats,
  scrapeTagCount,
  scrapeListBooks,
  scrapeBookDetails,
  BookMetadata
} from '../scraper.js';

// ── Live integration tests ────────────────────────────────────────────────
// These hit real Goodreads pages (about a dozen requests per run) and assert
// that the scraper's parsers still produce sane output. Run via
// `./runIntegrationTests.sh` (or `npm run test:integration`). They need a
// cached library export (for the add-book lookup) and the app's config.json.
//
// Strict throttle mode: if Goodreads throttles us (HTTP 202 interstitial,
// 403, or 429) we GIVE UP IMMEDIATELY — no retries, no backoff — so a
// throttled run fails fast with a clear message instead of burning minutes
// retrying. Retry the suite after a ~60s+ cooldown.
process.env.GOODREADS_STRICT_THROTTLE = '1';

const SHELF_TAG = 'science-fiction';
const LIST_PAGE_SIZE = 100;

import { loadState } from '../storage.js';

interface ListInfo {
  id: string;
  title: string;
  count: number;
}

function loadMonitoredLists(): ListInfo[] {
  const state = loadState();
  return Object.entries(state.lists || {}).map(([id, list]) => {
    const l = list as any;
    return { id, title: l.title || '', count: l.lastCount || 0 };
  });
}

function pickList(min: number, max: number, target: number): ListInfo {
  const lists = loadMonitoredLists();
  const best = lists
    .filter(l => l.count >= min && l.count <= max)
    .sort((a, b) => Math.abs(a.count - target) - Math.abs(b.count - target))[0];
  if (!best) throw new Error(`No monitored list with ${min}-${max} books found in state.json`);
  return best;
}

// Lists whose book counts imply exactly 1, 2, and 3 pages of 100 books each.
const onePageList = pickList(30, 95, 80);
const twoPageList = pickList(110, 190, 150);
const threePageList = pickList(210, 290, 250);

// Fixture for the scraper smoke tests, seeded by the shelf scrape.
let fixture: BookMetadata | undefined;

// ── Add-book lookup: rate-limited to once per minute ──────────────────────
const RATE_LIMIT_MS = 60_000;
const RATE_FILE = path.join(os.tmpdir(), 'goodreads-addbook-lookup.json');

// Politely space out sequential live calls (~2s between tests) so we don't
// hammer Goodreads. The scrapers themselves also delay internally.
let isFirstLiveCall = true;
beforeEach(async () => {
  if (isFirstLiveCall) {
    isFirstLiveCall = false;
    return;
  }
  await delay(2000, 2000);
});

function lastLookupAt(): number | null {
  try {
    const data = fs.readJsonSync(RATE_FILE);
    return typeof data?.at === 'number' ? data.at : null;
  } catch {
    return null;
  }
}

function markLookup(): void {
  try {
    fs.writeJsonSync(RATE_FILE, { at: Date.now() });
  } catch {
    // Ignore rate-file write errors.
  }
}

const rateLimited = (() => {
  const at = lastLookupAt();
  return at !== null && Date.now() - at < RATE_LIMIT_MS;
})();

function isCleanCandidate(entry: { title: string }): boolean {
  const t = entry.title;
  return (
    t.length >= 5 &&
    t.length <= 60 &&
    !/pack|omnibus|boxed\s*set|trilogy|quartet|series|#/i.test(t)
  );
}

describe('live Goodreads lookups (scraper)', () => {
  it('top shelves page parses', { timeout: 60_000 }, async () => {
    const tags = await scrapeTopShelves();
    expect(tags.length).toBeGreaterThanOrEqual(3);
    tags.forEach(tag => {
      expect(typeof tag).toBe('string');
      expect(tag.trim().length).toBeGreaterThan(0);
    });
    console.log(`   Top shelves (first 5): ${tags.slice(0, 5).join(', ')}`);
  });

  it('shelf page parses books with id/title/author', { timeout: 60_000 }, async () => {
    const books = await scrapeShelfBooks(SHELF_TAG, 0, 1);
    expect(books.length).toBeGreaterThanOrEqual(1);
    books.forEach(book => {
      expect(book.id).toBeTruthy();
      expect(book.title).toBeTruthy();
      expect(book.author).toBeTruthy();
    });
    fixture = books.find(b => b.authorSlug) || books[0];
    console.log(`   Sample book: "${fixture.title}" by ${fixture.author}`);
  });

  it('author stats parse for the shelf book author', { timeout: 60_000 }, async () => {
    if (!fixture?.authorSlug) throw new Error('Prerequisite: fixture has no authorSlug');
    const result = await scrapeAuthorStats(fixture.authorSlug);
    expect(result).toBeDefined();
    const s = result!.stats;
    expect(s.averageRating || s.numRatings || s.numReviews || s.numShelves).toBeTruthy();
    console.log(`   Author stats: ${JSON.stringify(s)}`);
  });

  it('tag count for the shelf tag is a number', { timeout: 60_000 }, async () => {
    if (!fixture) throw new Error('Prerequisite: shelf scrape produced no fixture');
    const count = await scrapeTagCount(fixture.id, SHELF_TAG);
    expect(typeof count).toBe('number');
    expect(Number.isFinite(count)).toBe(true);
    console.log(`   "${SHELF_TAG}" shelved count: ${count}${count === 0 ? ' (⚠️ possibly 0 or unparsed)' : ''}`);
  });
});

describe('list pagination (from monitored lists in state.json)', () => {
  it(`1-page list "${onePageList.title}" fetches fully and terminates`, { timeout: 90_000 }, async () => {
    const books = await scrapeListBooks(onePageList.id, Infinity);
    expect(books.length).toBeGreaterThanOrEqual(onePageList.count - 5);
    expect(books.length).toBeLessThanOrEqual(LIST_PAGE_SIZE);
    console.log(`   ${onePageList.title} (${onePageList.count} books) -> fetched ${books.length}`);
  });

  it(`2-page list "${twoPageList.title}" crosses into page 2`, { timeout: 90_000 }, async () => {
    const books = await scrapeListBooks(twoPageList.id, Infinity);
    expect(books.length).toBeGreaterThan(LIST_PAGE_SIZE);
    expect(books.length).toBeGreaterThanOrEqual(twoPageList.count - 5);
    expect(books.length).toBeLessThanOrEqual(twoPageList.count + 10);
    console.log(`   ${twoPageList.title} (${twoPageList.count} books) -> fetched ${books.length}`);
  });

  it(`3-page list "${threePageList.title}" crosses into page 3`, { timeout: 120_000 }, async () => {
    const books = await scrapeListBooks(threePageList.id, Infinity);
    expect(books.length).toBeGreaterThan(LIST_PAGE_SIZE * 2);
    expect(books.length).toBeGreaterThanOrEqual(threePageList.count - 5);
    expect(books.length).toBeLessThanOrEqual(threePageList.count + 10);
    console.log(`   ${threePageList.title} (${threePageList.count} books) -> fetched ${books.length}`);
  });

  it('maxPages=1 caps the scan at one page', { timeout: 60_000 }, async () => {
    const books = await scrapeListBooks(twoPageList.id, 1);
    expect(books.length).toBeGreaterThan(0);
    expect(books.length).toBeLessThanOrEqual(LIST_PAGE_SIZE);
    console.log(`   ${twoPageList.title} with maxPages=1 -> fetched ${books.length}`);
  });
});

describe('add-book single lookup', () => {
  it.skipIf(rateLimited)(
    'resolves an unknown publication year from the library export',
    { timeout: 120_000 },
    async () => {
      try {
        const library = await loadLibraryExportCache();
        if (!library) throw new Error('No library export cache. Run once with --export <path>.');
        const authorCache = await loadAuthorCache();

        const candidates = library.entries.filter(entry => {
          const pub = (entry.published || '').trim();
          return !pub && !!entry.author && !!authorCache[entry.author]?.slug;
        });
        const candidate = candidates.find(isCleanCandidate) || candidates[0];
        if (!candidate) throw new Error('No unknown-year book whose author has a slug in authorsCache.json');

        console.log(`   Book: "${candidate.title}" by ${candidate.author} (id ${candidate.id})`);
        const result = await scrapeBookDetails(candidate.id, candidate.title, candidate.author);

        expect(result.isFailed).not.toBe(true);
        expect(result.title).toBeTruthy();
        expect(result.published).toBeTruthy();
        expect(result.published).not.toBe('Unknown');
        console.log(`   Resolved: "${result.title}" — published ${result.published}`);
      } finally {
        markLookup();
      }
    }
  );
});
