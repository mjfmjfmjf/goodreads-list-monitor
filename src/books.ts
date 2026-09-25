import chalk from 'chalk';
import path from 'path';
import { iterateBooks } from './storage.js';
import type { CachedBook } from './storage.js';
import { getDb } from './db.js';
import { RegexCriterion, matchesRegex } from './bookMatch.js';
import { getYear, formatBookLink } from './utils.js';
import { loadLibraryExport, loadLibraryExportCache, matchesReviewed, LibraryExport } from './libraryExport.js';

export interface BooksOptions {
  pattern?: string;
  title?: string;
  authorLast?: string;
  authorFirst?: string;
  sort?: string;
  limit?: string;
  minRatings?: string;
  maxRatings?: string;
  minYear?: string;
  maxYear?: string;
  asc?: boolean;
  desc?: boolean;
  includeBad?: boolean;
  excludeReviewed?: boolean;
  export?: string;
  library?: string;
  dedupe?: boolean;
}

type SortField =
  | 'numReviews' | 'numRatings' | 'avgRatings' | 'numShelves' | 'numTags'
  | 'currentlyReading' | 'toRead' | 'editionCount' | 'reviewRatio'
  | 'year' | 'title' | 'author';

// Canonical aliases so "ratings"/"avgRating" (the old names) keep working.
const SORT_ALIASES: Record<string, SortField> = {
  ratings: 'numRatings',
  avgRating: 'avgRatings',
};

const SORT_FIELDS: SortField[] = [
  'numReviews', 'numRatings', 'avgRatings', 'numShelves', 'numTags',
  'currentlyReading', 'toRead', 'editionCount', 'reviewRatio',
  'year', 'title', 'author',
];

const SORT_LABELS: Record<SortField, string> = {
  numReviews: 'Number of Reviews',
  numRatings: 'Number of Ratings',
  avgRatings: 'Average Rating',
  numShelves: 'Number of Shelves',
  numTags: 'Number of Tags',
  currentlyReading: 'Currently Reading',
  toRead: 'To Read',
  editionCount: 'Number of Editions',
  reviewRatio: 'Reviews / Ratings',
  year: 'Publication Year',
  title: 'Title',
  author: 'Author'
};

// Enrichment maps pulled from the side tables once per run, only when a sort
// field actually needs them. These are deliberately small relative to the 9M-row
// `books` table (book_page ~163k rows, tag_books ~710k distinct books), so the
// top-N streaming over iterateBooks() stays cheap.
interface PageStats {
  reviews: number;
  currentlyReading: number;
  toRead: number;
  editions: number | undefined;
}
interface TagStats {
  numTags: number;
  numShelves: number;
}

const parseNum = (s?: string | null): number => parseInt((s || '0').replace(/,/g, ''), 10) || 0;

const PAGE_SORTS: SortField[] = ['numReviews', 'currentlyReading', 'toRead', 'editionCount', 'reviewRatio'];
const TAG_SORTS: SortField[] = ['numShelves', 'numTags'];

let pageStatsCache: Map<string, PageStats> | null = null;
let tagStatsCache: Map<string, TagStats> | null = null;
let workEditionsCache: Map<string, number> | null = null;

interface PageRow {
  book_id: string;
  reviews_count: string | null;
  currently_reading: number | null;
  to_read: number | null;
  editions_count: number | null;
}

interface TagRow {
  book_id: string;
  num_tags: number;
  num_shelves: number;
}

interface WorkEditionsRow {
  work_id: string;
  editions_count: number;
}

function loadPageStats(): Map<string, PageStats> {
  if (pageStatsCache) return pageStatsCache;
  const db = getDb();
  const hasPage = !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='book_page'`).get();
  const map = new Map<string, PageStats>();
  if (hasPage) {
    for (const row of db.prepare(
      `SELECT book_id, reviews_count, currently_reading, to_read, editions_count FROM book_page`
    ).iterate() as IterableIterator<PageRow>) {
      map.set(row.book_id, {
        reviews: parseNum(row.reviews_count),
        currentlyReading: row.currently_reading ?? 0,
        toRead: row.to_read ?? 0,
        editions: row.editions_count ?? undefined,
      });
    }
  }
  pageStatsCache = map;
  return map;
}

function loadTagStats(): Map<string, TagStats> {
  if (tagStatsCache) return tagStatsCache;
  const db = getDb();
  const map = new Map<string, TagStats>();
  for (const row of db.prepare(
    `SELECT book_id, COUNT(*) AS num_tags, COALESCE(SUM(shelved), 0) AS num_shelves FROM tag_books GROUP BY book_id`
  ).iterate() as IterableIterator<TagRow>) {
    map.set(row.book_id, { numTags: row.num_tags, numShelves: row.num_shelves });
  }
  tagStatsCache = map;
  return map;
}

// Ediitions counts are a per-WORK figure on Goodreads (the "Show all N editions"
// drive on any edition's page reads the same work). Different editions of a work
// carry drift-bucket snapshots; under --dedupe the surviving row is often missing
// the count entirely, so aggregate the max across the work's book_page rows.
// Drive from book_page (only rows with a count) not books (9M) — SQLite's planner
// walks idx_books_work_id otherwise, ~15s vs ~1.5s.
function loadWorkEditions(): Map<string, number> {
  if (workEditionsCache) return workEditionsCache;
  const db = getDb();
  const hasBooksWork = !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='books'`).get();
  const hasPage = !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='book_page'`).get();
  const map = new Map<string, number>();
  if (hasBooksWork && hasPage) {
    for (const row of db.prepare(
      `SELECT b.work_id AS work_id, MAX(editions) AS editions_count
       FROM (SELECT bp.book_id AS bid, MAX(bp.editions_count) AS editions
             FROM book_page bp WHERE bp.editions_count IS NOT NULL GROUP BY bp.book_id) x
       JOIN books b ON b.id = x.bid
       WHERE b.work_id IS NOT NULL
       GROUP BY b.work_id`
    ).iterate() as IterableIterator<WorkEditionsRow>) {
      map.set(row.work_id, row.editions_count);
    }
  }
  workEditionsCache = map;
  return map;
}

export async function runBooks(options: BooksOptions = {}): Promise<void> {
  const rawSort = (options.sort || 'numRatings') as string;
  const sortBy: SortField = SORT_ALIASES[rawSort] ?? (rawSort as SortField);
  if (!SORT_FIELDS.includes(sortBy)) {
    console.error(chalk.red.bold(`Error: --sort must be one of: ${SORT_FIELDS.join(', ')}`));
    process.exit(1);
  }

  let library: LibraryExport | null = null;
  if (options.export) {
    library = await loadLibraryExport(options.export, options.library);
  } else if (options.excludeReviewed) {
    library = await loadLibraryExportCache(options.library);
    if (!library) {
      console.error(chalk.red.bold('Error: No library export cache found. Run once with --export <path> (or --import <path>) to import + cache your Goodreads library export.'));
      process.exit(1);
    }
  }

  const criterion: RegexCriterion = {};
  if (options.title) criterion.titleRegex = options.title;
  if (options.authorLast) criterion.authorLastRegex = options.authorLast;
  if (options.authorFirst) criterion.authorFirstRegex = options.authorFirst;
  if (!options.title && !options.authorLast && !options.authorFirst && options.pattern) {
    criterion.titleRegex = options.pattern;
  }

  let regexError: string | null = null;
  try {
    for (const pattern of [criterion.titleRegex, criterion.authorLastRegex, criterion.authorFirstRegex]) {
      if (pattern) new RegExp(pattern, 'i');
    }
  } catch (error: any) {
    regexError = error.message;
  }
  if (regexError) {
    console.error(chalk.red.bold(`Error: Invalid regex: ${regexError}`));
    process.exit(1);
  }

  const minRatings = options.minRatings !== undefined ? parseNum(options.minRatings) : 0;
  const maxRatings = options.maxRatings !== undefined ? parseNum(options.maxRatings) : Infinity;
  const minYear = options.minYear ? parseInt(options.minYear, 10) : 0;
  const maxYear = options.maxYear ? parseInt(options.maxYear, 10) : Infinity;
  const limit = options.limit ? parseInt(options.limit, 10) : 100;

  // Load the enrichment maps lazily — only if the sort field needs them.
  const pageStats = PAGE_SORTS.includes(sortBy) ? loadPageStats() : null;
  const tagStats = TAG_SORTS.includes(sortBy) ? loadTagStats() : null;
  const workEditions = options.dedupe && sortBy === 'editionCount' ? loadWorkEditions() : null;

  const valueOf = (book: CachedBook): number | string => {
    switch (sortBy) {
      case 'numReviews': return pageStats?.get(book.id)?.reviews ?? 0;
      case 'numRatings': return parseNum(book.ratings);
      case 'avgRatings': return parseFloat(book.avgRating || '0');
      case 'numShelves': return tagStats?.get(book.id)?.numShelves ?? 0;
      case 'numTags': return tagStats?.get(book.id)?.numTags ?? 0;
      case 'currentlyReading': return pageStats?.get(book.id)?.currentlyReading ?? 0;
      case 'toRead': return pageStats?.get(book.id)?.toRead ?? 0;
      case 'editionCount': {
        if (workEditions && book.workId && workEditions.has(book.workId)) return workEditions.get(book.workId)!;
        return pageStats?.get(book.id)?.editions ?? 0;
      }
      case 'reviewRatio': {
        const ratings = parseNum(book.ratings);
        const reviews = pageStats?.get(book.id)?.reviews ?? 0;
        return ratings > 0 ? reviews / ratings : 0;
      }
      case 'year': return getYear(book.published) ?? 0;
      case 'title': return (book.title || '').toLowerCase();
      case 'author': return (book.author || '').toLowerCase();
    }
  };

  const naturalDirection = sortBy === 'title' || sortBy === 'author' ? 'asc' : 'desc';
  const direction = options.asc ? 'asc' : (options.desc ? 'desc' : naturalDirection);

  const compare = (a: CachedBook, b: CachedBook): number => {
    const va = valueOf(a);
    const vb = valueOf(b);
    let cmp = 0;
    if (typeof va === 'number' && typeof vb === 'number') {
      cmp = va - vb;
    } else {
      cmp = String(va).localeCompare(String(vb));
    }
    if (cmp === 0) cmp = parseNum(a.ratings) - parseNum(b.ratings);
    if (cmp === 0) cmp = (a.title || '').localeCompare(b.title || '');
    return direction === 'asc' ? cmp : -cmp;
  };

  // Stream the table, keeping only the top `limit` matches in memory.
  // With --dedupe only the work-representative editions (books.is_work_rep)
  // are considered: editions that share a work_id collapse to one row, and
  // books with no work_id (never clustered) each stand alone.
  const matched: CachedBook[] = [];
  let reviewedExcluded = 0;
  let dedupedExcluded = 0;
  let totalMatched = 0;
  for (const book of iterateBooks()) {
    if (book.isBad && !options.includeBad) continue;
    if (book.title === 'Unknown') continue;
    if (options.dedupe && book.workId && !book.isWorkRep) {
      dedupedExcluded++;
      continue;
    }

    const ratings = parseNum(book.ratings);
    if (ratings < minRatings || ratings > maxRatings) continue;

    const year = getYear(book.published);
    if (minYear > 0 || maxYear < Infinity) {
      if (year === null || year < minYear || year > maxYear) continue;
    }

    if (!matchesRegex(book, criterion)) continue;
    if (library && options.excludeReviewed && matchesReviewed(library, book.id, book.title, book.author)) {
      reviewedExcluded++;
      continue;
    }
    totalMatched++;

    if (limit > 0 && matched.length === limit) {
      // Matched is kept sorted by `compare`; the end holds the worst element.
      if (compare(book, matched[matched.length - 1]) > 0) continue;
    }
    matched.push(book);
    matched.sort(compare);
    if (matched.length > limit) matched.pop();
  }

  const countToDisplay = Math.min(matched.length, limit);

  const parts: string[] = [];
  if (criterion.titleRegex) parts.push(`Title: /${criterion.titleRegex}/`);
  if (criterion.authorLastRegex) parts.push(`Author Last Name: /${criterion.authorLastRegex}/`);
  if (criterion.authorFirstRegex) parts.push(`Author First Name: /${criterion.authorFirstRegex}/`);

  console.log(chalk.cyan.bold('\n📚 Book Cache Search'));
  console.log(chalk.gray(`   Match: ${parts.length ? parts.join(' AND ') : 'all books'}`));
  let criteriaMsg = `   Min Ratings: ${minRatings.toLocaleString()}`;
  if (maxRatings < Infinity) criteriaMsg += `, Max Ratings: ${maxRatings.toLocaleString()}`;
  if (minYear > 0 || maxYear < Infinity) criteriaMsg += `, Year: ${minYear}-${maxYear === Infinity ? 'Any' : maxYear}`;
  console.log(chalk.gray(criteriaMsg));
  if (options.dedupe) console.log(chalk.gray('   Dedupe works: yes (one row per distinct work)'));
  if (library && options.excludeReviewed) {
    const source = library.cachedAt
      ? `cached: ${path.basename(library.sourcePath)} (imported ${library.cachedAt.slice(0, 10)})`
      : `from ${library.sourcePath}`;
    console.log(chalk.gray(`   Exclude reviewed: yes (${source})`));
  }
  console.log(chalk.gray(`   Sort: ${SORT_LABELS[sortBy]} (${direction}) | Limit: top ${limit}`));
  console.log(chalk.gray('------------------------------------------'));

  if (countToDisplay === 0) {
    console.log(chalk.yellow('   No books found matching the criteria.'));
  }

  for (let i = 0; i < countToDisplay; i++) {
    const book = matched[i];
    const ratings = book.ratings ? `Ratings: ${chalk.yellow(book.ratings)}` : 'Ratings: N/A';
    const avg = book.avgRating ? `Avg: ${chalk.green.bold(book.avgRating)}` : 'Avg: N/A';
    const year = getYear(book.published);
    const yearStr = year !== null ? `Year: ${year}` : 'Year: N/A';

    const statParts: string[] = [];
    if (sortBy === 'editionCount' && workEditions && book.workId && workEditions.has(book.workId)) {
      statParts.push(`Editions: ${chalk.cyan(workEditions.get(book.workId)!.toLocaleString())}`);
    }
    if (pageStats) {
      const ps = pageStats.get(book.id);
      if (ps) {
        if (sortBy === 'numReviews' && ps.reviews > 0) statParts.push(`Reviews: ${chalk.magenta(ps.reviews.toLocaleString())}`);
        if (sortBy === 'currentlyReading' || sortBy === 'reviewRatio') statParts.push(`Currently Reading: ${chalk.magenta(ps.currentlyReading.toLocaleString())}`);
        if (sortBy === 'toRead') statParts.push(`To Read: ${chalk.magenta(ps.toRead.toLocaleString())}`);
        if (sortBy === 'editionCount' && ps.editions !== undefined && statParts.length === 0) statParts.push(`Editions: ${chalk.cyan(ps.editions.toLocaleString())}`);
        if (sortBy === 'reviewRatio') {
          const ratingsN = parseNum(book.ratings);
          const ratio = ratingsN > 0 ? (ps.reviews / ratingsN) : 0;
          statParts.push(`Reviews/Ratings: ${chalk.magenta(ratio.toFixed(3))}`);
        }
      }
    }
    if (tagStats) {
      const ts = tagStats.get(book.id);
      if (ts) {
        if (sortBy === 'numTags') statParts.push(`Tags: ${chalk.magenta(ts.numTags.toLocaleString())}`);
        if (sortBy === 'numShelves' && ts.numShelves > 0) statParts.push(`Shelves: ${chalk.cyan(ts.numShelves.toLocaleString())}`);
      }
    }
    const statStr = statParts.length ? ` | ${statParts.join(', ')}` : '';

    console.log(
      `${(i + 1).toString().padStart(4, ' ')}. ${chalk.white(formatBookLink(book.title, book.id))}\n` +
      `      by ${book.author} | ${yearStr}, ${ratings}, ${avg}${statStr}`
    );
  }

  console.log(chalk.gray('------------------------------------------'));
  let footerMsg = `Total books matching: ${totalMatched.toLocaleString()} (Displayed: ${countToDisplay})`;
  if (options.dedupe) footerMsg += ` | Deduplicated works: ${dedupedExcluded.toLocaleString()}`;
  if (library && options.excludeReviewed) footerMsg += ` | Excluded (already reviewed): ${reviewedExcluded.toLocaleString()}`;
  console.log(chalk.cyan(`${footerMsg}\n`));
}