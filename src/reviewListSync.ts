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

// "Scieszka, Jon" → "Jon Scieszka" (match the CSV's First-Last Author column).
export function flipAuthorName(author: string): string {
  const m = author.trim().match(/^([^,]+),\s*(.+)$/);
  return m ? `${m[2].trim()} ${m[1].trim()}` : author.trim();
}

// "Aug 31, 2026" → "2026/08/31" (the CSV Date Read format).
export function parsePageDate(value: string): string {
  const m = value.trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/);
  if (!m) return '';
  const mon = MONTHS[m[1].toLowerCase()];
  if (!mon) return '';
  return `${m[3]}/${mon}/${m[2].padStart(2, '0')}`;
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

    const hiddenReview = $el.find(`#freeText${reviewId}`).text().trim();
    const visibleReview = $el.find(`#freeTextContainer${reviewId}`).text().trim();
    const review = hiddenReview || visibleReview;

    const pages = ($el.find('.field.num_pages').text().match(/\d+/) || [''])[0];

    const pubText = $el.find('.field.date_pub').text().replace(/\s+/g, ' ').trim();
    const published = (pubText.match(/\b(19|20)\d{2}\b/) || [''])[0];

    const shelves: string[] = [];
    $el.find('.field.shelves .shelfLink').each((_, link) => {
      const name = $(link).text().trim();
      if (name && name !== 'read') shelves.push(name);
    });

    rows.push({
      reviewId,
      bookId,
      title,
      author,
      dateRead,
      hasReview: review.length > 0,
      review,
      myRating: ($el.find('.field.rating .stars').attr('data-rating') || '').trim(),
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