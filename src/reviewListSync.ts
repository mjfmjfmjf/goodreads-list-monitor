import chalk from 'chalk';
import * as cheerio from 'cheerio';
import { LibraryEntry, LibraryExport } from './libraryExport.js';
import { loadConfig, loadState, Config } from './storage.js';
import { fetchWithRetry, delay } from './utils.js';
import { USER_AGENT } from './scraper.js';

const TIMEOUT = 30000;
const PER_PAGE = 100;
const MAX_PAGES = 8;

const MONTHS: Record<string, string> = {
  january: '01', jan: '01',
  february: '02', feb: '02',
  march: '03', mar: '03',
  april: '04', apr: '04',
  may: '05',
  june: '06', jun: '06',
  july: '07', jul: '07',
  august: '08', aug: '08',
  september: '09', sep: '09', sept: '09',
  october: '10', oct: '10',
  november: '11', nov: '11',
  december: '12', dec: '12'
};

export interface ReviewListRow {
  reviewId: string;
  bookId: string;
  title: string;
  author: string;
  dateRead: string;
  hasReview: boolean;
  review: string;
  myRating: string;
  pages: string;
  published: string;
  bookshelves: string;
}

export function buildReviewListUrl(userId: string, page: number, perPage = PER_PAGE): string {
  return `https://www.goodreads.com/review/list/${userId}?shelf=read&per_page=${perPage}&sort=date_read&order=d&page=${page}`;
}

// Filtered server-side to reads dated (or started) in the given year.
export function buildReadAtUrl(userId: string, year: string, page: number, perPage = PER_PAGE): string {
  return `https://www.goodreads.com/review/list/${userId}?shelf=read&read_at=${year}&per_page=${perPage}&sort=date_read&order=d&page=${page}`;
}

// Keeps rows whose Date Read falls in `year` (read_at also matches Date Started,
// so that quirk must be filtered here) and dedupes by book id.
export function liveEntriesForYear(rows: ReviewListRow[], year: string, seenIds: Set<string>): LibraryEntry[] {
  const prefix = `${year}/`;
  const entries: LibraryEntry[] = [];
  for (const row of rows) {
    if (!row.dateRead.startsWith(prefix)) continue;
    if (seenIds.has(row.bookId)) continue;
    seenIds.add(row.bookId);
    entries.push(rowToEntry(row));
  }
  return entries;
}

// "Scieszka, Jon" → "Jon Scieszka" (match the CSV's First-Last Author column).
export function flipAuthorName(author: string): string {
  const m = author.trim().match(/^([^,]+),\s*(.+)$/);
  return m ? `${m[2].trim()} ${m[1].trim()}` : author.trim();
}

// "Aug 31, 2026" → "2026/08/31" (the CSV Date Read format).
// Goodreads also renders a month-only date (e.g. "Feb 2026") when a specific
// day isn't known; that becomes "2026/02/01" so it still lands in the right year.
export function parsePageDate(value: string): string {
  const trimmed = value.trim();
  const full = trimmed.match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/);
  if (full) {
    const mon = MONTHS[full[1].toLowerCase()];
    if (!mon) return '';
    return `${full[3]}/${mon}/${full[2].padStart(2, '0')}`;
  }
  const monthOnly = trimmed.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (monthOnly) {
    const mon = MONTHS[monthOnly[1].toLowerCase()];
    if (!mon) return '';
    return `${monthOnly[2]}/${mon}/01`;
  }
  return '';
}

// Goodreads renders the reviewer's rating as static stars (title text) when
// viewing someone else's list, and as our own interactive stars widget when
// viewing our own list.
const STATIC_RATING_LABELS: Record<string, string> = {
  'did not like it': '1',
  'it was ok': '2',
  'liked it': '3',
  'really liked it': '4',
  'it was amazing': '5'
};

export function parseRowRating($el: cheerio.Cheerio<any>): string {
  const ownRating = $el.find('.field.rating .stars').attr('data-rating');
  if (typeof ownRating === 'string' && ownRating.trim()) return ownRating.trim();

  // Other-user view: staticStars with a title like "liked it", and/or
  // .staticStar.p10 spans (filled star) — count them if no title.
  const title = ($el.find('.field.rating .staticStars').attr('title') || '').toLowerCase().trim();
  if (STATIC_RATING_LABELS[title]) return STATIC_RATING_LABELS[title];

  const filled = $el.find('.field.rating .staticStar.p10').length;
  if (filled > 0) return String(filled);

  return '';
}

export function parseReviewListPage(html: string): ReviewListRow[] {
  const $ = cheerio.load(html);
  const rows: ReviewListRow[] = [];

  $('tr.bookalike.review').each((_, el) => {
    const $el = $(el);
    const reviewId = ($el.attr('id') || '').replace(/^review_/, '');
    const bookId = ($el.find('.field.cover [data-resource-id]').attr('data-resource-id') || '').trim();
    const title = $el.find('.field.title a').first().text().trim();
    const author = flipAuthorName($el.find('.field.author a').first().text().trim());
    const dateRead = parsePageDate($el.find('.field.date_read .date_read_value').first().text());

    // Real Goodreads ids are freeTextreview{id} / freeTextContainerreview{id};
    // fall back to freeText{id} / freeTextContainer{id} for safety.
    const hiddenReview = $el.find(`#freeTextreview${reviewId}, #freeText${reviewId}`).first().text().trim();
    const visibleReview = $el.find(`#freeTextContainerreview${reviewId}, #freeTextContainer${reviewId}`).first().text().trim();
    const review = hiddenReview || visibleReview;

    const pages = ($el.find('.field.num_pages').text().match(/\d+/) || [''])[0];

    const pubText = $el.find('.field.date_pub').text().replace(/\s+/g, ' ').trim();
    const published = (pubText.match(/\b(19|20)\d{2}\b/) || [''])[0];

    // When viewing someone else's list the .field.shelves cell holds the
    // viewer's own interactive rating/shelf widget, not the reviewer's shelves
    // — the real reviewer shelves are absent there, so skip that cell.
    const shelves: string[] = [];
    if ($el.find('.field.shelves .stars').length === 0) {
      $el.find('.field.shelves .shelfLink').each((_, link) => {
        const name = $(link).text().trim();
        if (name && name !== 'read') shelves.push(name);
      });
    }

    rows.push({
      reviewId,
      bookId,
      title,
      author,
      dateRead,
      hasReview: review.length > 0,
      review,
      myRating: parseRowRating($el),
      pages,
      published,
      bookshelves: shelves.join(', ')
    });
  });

  return rows;
}

export function rowToEntry(row: ReviewListRow): LibraryEntry {
  return {
    id: row.bookId,
    title: row.title,
    author: row.author,
    shelf: 'read',
    dateRead: row.dateRead,
    hasReview: row.hasReview,
    review: row.review,
    published: row.published,
    myRating: row.myRating,
    pages: row.pages,
    publisher: '',
    bookshelves: row.bookshelves
  };
}

// Which of the rows represent reads the cached export doesn't already know about.
// A row is "known" when the library already contains that book id on the read
// shelf. A book that was on to-read and has since been finished counts as new.
export function newEntriesSinceExport(
  rows: ReviewListRow[],
  library: LibraryExport,
  year: string,
  seenIds: Set<string>
): LibraryEntry[] {
  const knownReadIds = new Set(
    library.entries.filter(e => e.shelf === 'read').map(e => e.id)
  );
  const entries: LibraryEntry[] = [];
  for (const row of rows) {
    if (seenIds.has(row.bookId)) continue;
    seenIds.add(row.bookId);
    if (knownReadIds.has(row.bookId)) continue;
    if (!row.dateRead.startsWith(year)) continue;
    entries.push(rowToEntry(row));
  }
  return entries;
}

export interface SyncResult {
  entries: LibraryEntry[];
  pagesFetched: number;
  stoppedReason: 'caught-up' | 'empty' | 'max-pages' | 'error';
  error?: string;
}

// Walks the interactive review-list page (newest date-read first) until the
// cached export already covers an entire page — i.e. we've caught up to the
// last CSV download — and returns the reads made since then.
export async function syncLiveReads(
  library: LibraryExport,
  opts: { userId?: string; cookie?: string; year?: string; maxPages?: number } = {}
): Promise<SyncResult> {
  const year = opts.year || '';
  const maxPages = opts.maxPages || MAX_PAGES;
  const seenIds = new Set<string>();
  const entries: LibraryEntry[] = [];

  let pagesFetched = 0;
  for (let page = 1; page <= maxPages; page++) {
    pagesFetched = page;
    let html: string;
    try {
      const headers: any = { 'User-Agent': USER_AGENT };
      if (opts.cookie) headers['Cookie'] = opts.cookie;
      const response = await fetchWithRetry(
        buildReviewListUrl(opts.userId || '', page),
        { headers, timeout: TIMEOUT },
        2
      );
      html = String(response.data);
    } catch (error: any) {
      return {
        entries,
        pagesFetched,
        stoppedReason: 'error',
        error: error.message
      };
    }

    const rows = parseReviewListPage(html);
    if (rows.length === 0) {
      return { entries, pagesFetched, stoppedReason: 'empty' };
    }

    const fresh = newEntriesSinceExport(rows, library, year, seenIds);
    entries.push(...fresh);

    // Once the export already covers everything on a page, any deeper page is
    // older reads that are also already in the export → caught up.
    if (fresh.length === 0) {
      return { entries, pagesFetched, stoppedReason: 'caught-up' };
    }

    if (page < maxPages) await delay();
  }

  return { entries, pagesFetched, stoppedReason: 'max-pages' };
}

// Loads the config cookie + stored user id, then pulls live reads.
export async function maybeSyncLiveReads(
  library: LibraryExport,
  year: string
): Promise<SyncResult | null> {
  const config: Config = loadConfig();
  if (!config.cookie) {
    console.log(chalk.gray('   ⚠️  No login cookie in config — skipping live review-list sync. Run in the `monitor` CLI to refresh your cookie, or re-download the CSV.'));
    return null;
  }
  const state = loadState();
  const userId = state.userId;
  if (!userId) {
    console.log(chalk.gray('   ⚠️  No stored user id — skipping live review-list sync. Set it with `set-user <id>`.'));
    return null;
  }

  const result = await syncLiveReads(library, { userId, cookie: config.cookie, year });
  return result;
}

export interface LiveYearResult {
  entries: LibraryEntry[];
  pagesFetched: number;
  stoppedReason: 'empty' | 'max-pages' | 'error';
  error?: string;
}

// Human-readable summary of a failed request for the live-walk logs.
export function describeFetchError(error: any, timeoutMs = TIMEOUT): string {
  const status = error?.response?.status;
  if (status) return `got HTTP ${status}`;
  if (error?.code === 'ECONNABORTED') return `timed out (no response after ${Math.round(timeoutMs / 1000)}s)`;
  if (error?.code === 'ERR_FR_TOO_MANY_REDIRECTS') return `hit a redirect loop (anti-bot throttle)`;
  return `failed (${error?.code || error?.message || 'unknown error'})`;
}

// Builds a full year's read list straight from the review-list page
// (read_at=YYYY filter), no CSV export needed — usable for other people's
// public profiles. Goodreads redirects anonymous review-list requests to a
// "Sign in" interstitial, so the stored login cookie is required.
export async function fetchLiveYearReads(
  userId: string,
  year: string,
  opts: { maxPages?: number; cookie?: string } = {}
): Promise<LiveYearResult> {
  const maxPages = opts.maxPages || MAX_PAGES;
  const seenIds = new Set<string>();
  const entries: LibraryEntry[] = [];

  let pagesFetched = 0;
  for (let page = 1; page <= maxPages; page++) {
    pagesFetched = page;
    let html: string;
    console.log(chalk.gray(`   Fetching review-list page ${page} (read_at=${year}, user ${userId})...`));
    try {
      const headers: any = { 'User-Agent': USER_AGENT };
      if (opts.cookie) headers['Cookie'] = opts.cookie;
      const response = await fetchWithRetry(
        buildReadAtUrl(userId, year, page),
        { headers, timeout: TIMEOUT },
        2,
        (error, attempt, willRetry) => {
          const detail = describeFetchError(error);
          if (willRetry) {
            console.log(chalk.yellow(`   ⚠️  Page ${page} ${detail} — retrying (attempt ${attempt + 1})...`));
          } else {
            console.log(chalk.red(`   ⛔ Page ${page} ${detail} — giving up.`));
          }
        }
      );
      html = String(response.data);
    } catch (error: any) {
      return { entries, pagesFetched, stoppedReason: 'error', error: error.message };
    }

    const rows = parseReviewListPage(html);
    if (rows.length === 0) {
      return { entries, pagesFetched, stoppedReason: 'empty' };
    }

    entries.push(...liveEntriesForYear(rows, year, seenIds));

    // With read_at=YYYY, deeper pages are still within the year, so keep going
    // until we get an empty page or hit the page cap.
    if (page < maxPages) await delay();
  }

  return { entries, pagesFetched, stoppedReason: 'max-pages' };
}