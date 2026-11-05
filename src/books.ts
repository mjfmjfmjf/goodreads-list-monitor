import chalk from 'chalk';
import path from 'path';
import { iterateBooks } from './storage.ts';
import type { CachedBook } from './storage.ts';
import { getDb } from './db.ts';
import { RegexCriterion, matchesRegex } from './bookMatch.ts';
import { getYear, formatBookLink } from './utils.ts';
import { loadLibraryExport, loadLibraryExportCache, matchesReviewed, LibraryExport } from './libraryExport.ts';

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
  tag?: string;
  genre?: string;
  notGenre?: string;
  minPages?: string;
  maxPages?: string;
  asc?: boolean;
  desc?: boolean;
  includeBad?: boolean;
  excludeReviewed?: boolean;
  export?: string;
  library?: string;
  dedupe?: boolean;
  hasDetails?: boolean;
}

type SortField =
  | 'numReviews' | 'numRatings' | 'avgRatings' | 'numShelves' | 'numTags'
  | 'currentlyReading' | 'toRead' | 'editionCount' | 'reviewRatio'
  | 'ratingsMean' | 'ratingsMedian' | 'ratingsMode' | 'ratingsVariance'
  | 'ratingsStddev' | 'ratingsSkewness' | 'ratingsKurtosis' | 'ratingsTotal'
  | 'year' | 'title' | 'author';

// Canonical aliases so "ratings"/"avgRating" (the old names) keep working.
const SORT_ALIASES: Record<string, SortField> = {
  ratings: 'numRatings',
  avgRating: 'avgRatings',
};

const SORT_FIELDS: SortField[] = [
  'numReviews', 'numRatings', 'avgRatings', 'numShelves', 'numTags',
  'currentlyReading', 'toRead', 'editionCount', 'reviewRatio',
  'ratingsMean', 'ratingsMedian', 'ratingsMode', 'ratingsVariance',
  'ratingsStddev', 'ratingsSkewness', 'ratingsKurtosis', 'ratingsTotal',
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
  ratingsMean: 'Ratings Mean',
  ratingsMedian: 'Ratings Median',
  ratingsMode: 'Ratings Mode',
  ratingsVariance: 'Ratings Variance',
  ratingsStddev: 'Ratings Standard Deviation',
  ratingsSkewness: 'Ratings Skewness',
  ratingsKurtosis: 'Ratings Excess Kurtosis',
  ratingsTotal: 'Ratings Total (histogram)',
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
  // Derived from book_page.ratings_dist; null when the distribution is missing
  // or unparseable. ratingsTotal is the histogram sum, which may differ from
  // the advertised books.ratings (see PLAN-ratings-derived-columns.md).
  mean: number | null;
  median: number | null;
  mode: number | null;
  variance: number | null;
  stddev: number | null;
  skewness: number | null;
  kurtosis: number | null;
  total: number | null;
}

// Short display label + formatter for the sorted derived column on each row.
const DERIVED_DISPLAY: Partial<Record<SortField, { key: keyof PageStats; label: string; fmt: (n: number) => string }>> = {
  ratingsMean: { key: 'mean', label: 'mean', fmt: (n) => n.toFixed(3) },
  ratingsMedian: { key: 'median', label: 'median', fmt: (n) => n.toFixed(0) },
  ratingsMode: { key: 'mode', label: 'mode', fmt: (n) => n.toFixed(0) },
  ratingsVariance: { key: 'variance', label: 'var', fmt: (n) => n.toFixed(4) },
  ratingsStddev: { key: 'stddev', label: 'sd', fmt: (n) => n.toFixed(4) },
  ratingsSkewness: { key: 'skewness', label: 'skew', fmt: (n) => n.toFixed(4) },
  ratingsKurtosis: { key: 'kurtosis', label: 'kurt', fmt: (n) => n.toFixed(4) },
  ratingsTotal: { key: 'total', label: 'total', fmt: (n) => n.toLocaleString() },
};
interface TagStats {
  numTags: number;
  numShelves: number;
}

const parseNum = (s?: string | number | null): number => {
  const str = s === null || s === undefined ? '0' : String(s);
  return parseInt(str.replace(/,/g, ''), 10) || 0;
};

// Normalize a genre label or user input for comparison: lowercase, spaces ≡
// hyphens (the column stores "Graphic Novels", users type "graphic-novels").
const normGenre = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, '-');

// Comma-separated user input → trimmed display labels (empties dropped).
const parseGenreList = (s: string): string[] => s.split(',').map(x => x.trim()).filter(Boolean);

// Word-boundary match on the normalized (hyphen-joined) form, so --notGenre
// "comics" catches Goodreads' own compound legacy labels ("Graphic Novels
// Comics", "Dc Comics", "Comics Manga") while "novel" does NOT match "novels".
const genreWordMatch = (entryNorm: string, key: string): boolean => `-${entryNorm}-`.includes(`-${key}-`);

const PAGE_SORTS: SortField[] = [
  'numReviews', 'currentlyReading', 'toRead', 'editionCount', 'reviewRatio',
  'ratingsMean', 'ratingsMedian', 'ratingsMode', 'ratingsVariance',
  'ratingsStddev', 'ratingsSkewness', 'ratingsKurtosis', 'ratingsTotal',
];
const TAG_SORTS: SortField[] = ['numShelves', 'numTags'];

let pageStatsCache: Map<string, PageStats> | null = null;
let tagStatsCache: Map<string, TagStats> | null = null;
let workEditionsCache: Map<string, number> | null = null;
let englishKeepersCache: Map<string, string> | null = null;
let bookLanguagesCache: Map<string, string> | null = null;
let tagBookIdsCache: Map<string, Set<string>> | null = null;
let bookPageIdsCache: Set<string> | null = null;

// Test seam: runBooks caches these maps at module scope, so a test that mutates
// the DB between runBooks calls must drop the caches first.
export function resetBooksCaches(): void {
  pageStatsCache = null;
  tagStatsCache = null;
  workEditionsCache = null;
  englishKeepersCache = null;
  bookLanguagesCache = null;
  tagBookIdsCache = null;
  bookPageIdsCache = null;
}

interface PageRow {
  book_id: string;
  reviews_count: string | null;
  currently_reading: number | null;
  to_read: number | null;
  editions_count: number | null;
  ratings_mean: number | null;
  ratings_median: number | null;
  ratings_mode: number | null;
  ratings_variance: number | null;
  ratings_stddev: number | null;
  ratings_skewness: number | null;
  ratings_kurtosis: number | null;
  ratings_total: number | null;
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
      `SELECT book_id, reviews_count, currently_reading, to_read, editions_count,
              ratings_mean, ratings_median, ratings_mode, ratings_variance,
              ratings_stddev, ratings_skewness, ratings_kurtosis, ratings_total
       FROM book_page`
    ).iterate() as IterableIterator<PageRow>) {
      map.set(row.book_id, {
        reviews: parseNum(row.reviews_count),
        currentlyReading: row.currently_reading ?? 0,
        toRead: row.to_read ?? 0,
        editions: row.editions_count ?? undefined,
        mean: row.ratings_mean,
        median: row.ratings_median,
        mode: row.ratings_mode,
        variance: row.ratings_variance,
        stddev: row.ratings_stddev,
        skewness: row.ratings_skewness,
        kurtosis: row.ratings_kurtosis,
        total: row.ratings_total,
      });
    }
  }
  pageStatsCache = map;
  return map;
}

interface LanguageRow {
  book_id: string;
  language: string | null;
}

// book_page.language is partial (~200k rows) but small, so a full load keeps the
// per-row display lookup O(1) while streaming the 11M-row books table.
function loadBookLanguages(): Map<string, string> {
  if (bookLanguagesCache) return bookLanguagesCache;
  const db = getDb();
  const hasPage = !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='book_page'`).get();
  const map = new Map<string, string>();
  if (hasPage) {
    for (const row of db.prepare(
      `SELECT book_id, language FROM book_page WHERE language IS NOT NULL AND language <> ''`
    ).iterate() as IterableIterator<LanguageRow>) {
      map.set(row.book_id, row.language as string);
    }
  }
  bookLanguagesCache = map;
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

// ── tag → book_ids via the tag xref tables ──────────────────────────
// `--tag fantasy` resolves EXACTLY against genre_tag_xref.genre_name (all
// kinds), then each mapped tag's book set from tag_books. Both lookups are
// covering PK-prefix scans; the reverse book_id → tags path has NO index, so
// membership is resolved once here into a Set and checked per streamed row.
// A tag with no xref row falls back to being a scraped tag_books tag itself.
// (--genre is the separate, narrower filter over the books.genres JSON column.)
function loadTagBookIds(tag: string): Set<string> {
  const key = tag.trim().toLowerCase();
  const cached = tagBookIdsCache?.get(key);
  if (cached) return cached;
  const db = getDb();
  const tagRows = db.prepare('SELECT tag_name FROM genre_tag_xref WHERE genre_name = ?').all(key) as Array<{ tag_name: string }>;
  const tags = tagRows.map(r => r.tag_name);
  if (tags.length === 0) {
    const direct = db.prepare('SELECT 1 AS x FROM tag_books WHERE tag_name = ?').get(key) as any;
    if (direct) tags.push(key);
  }
  if (tags.length === 0) {
    const suggestions = [
      ...(db.prepare('SELECT genre_name FROM genre_tag_xref WHERE genre_name LIKE ? LIMIT 5').all(`${key}%`) as any[]).map(r => r.genre_name as string),
      ...(db.prepare('SELECT DISTINCT tag_name FROM tag_books WHERE tag_name LIKE ? LIMIT 5').all(`${key}%`) as any[]).map(r => r.tag_name as string),
    ];
    const hint = suggestions.length ? ` — did you mean: ${[...new Set(suggestions)].join(', ')}?` : '';
    console.error(chalk.red.bold(`Error: --tag "${tag}" matches no genre_tag_xref row and no scraped tag_books tag${hint}`));
    console.error(chalk.gray('  Seed the xref (genrePairings) or scrape the tag first (gapGenreTagDiscovery).'));
    process.exit(1);
  }
  const set = new Set<string>();
  const stmt = db.prepare('SELECT book_id FROM tag_books WHERE tag_name = ?');
  for (const tagName of tags) {
    for (const row of stmt.iterate(tagName) as IterableIterator<{ book_id: string }>) {
      set.add(row.book_id);
    }
  }
  tagBookIdsCache = tagBookIdsCache ?? new Map();
  tagBookIdsCache.set(key, set);
  return set;
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

// ── English-edition preference for --dedupe ─────────────────────────
// --dedupe normally keeps books.is_work_rep (highest ratings, lowest id). But a
// work's ratings rep can be a translation, so a "most reviewed" listing can
// surface e.g. "El dador de recuerdos" instead of "The Giver". When book_page
// knows an edition's language, prefer an English edition as the keeper.
// Language coverage is partial (~200k book_page rows), so works without it fall
// back to is_work_rep unchanged — best-effort, never worse than today.
function loadEnglishWorkKeepers(): Map<string, string> {
  if (englishKeepersCache) return englishKeepersCache;
  const db = getDb();
  const map = new Map<string, string>();
  const hasBooks = !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='books'`).get();
  const hasPage = !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='book_page'`).get();
  if (hasBooks && hasPage) {
    // Best English edition per work: highest ratings, lowest id on ties. Driven
    // from book_page (only rows with a language) so the 9M-row books table is
    // never scanned.
    const best = new Map<string, { id: string; ratings: number }>();
    for (const row of db.prepare(
      `SELECT b.work_id AS work_id, b.id AS id, b.ratings AS ratings
       FROM book_page bp
       JOIN books b ON b.id = bp.book_id
       WHERE bp.language LIKE 'English%'
         AND b.work_id IS NOT NULL AND b.work_id <> ''`
    ).iterate() as IterableIterator<{ work_id: string; id: string; ratings: string | null }>) {
      const ratings = parseNum(row.ratings);
      const current = best.get(row.work_id);
      if (
        current === undefined ||
        ratings > current.ratings ||
        (ratings === current.ratings && parseInt(row.id, 10) < parseInt(current.id, 10))
      ) {
        best.set(row.work_id, { id: row.id, ratings });
      }
    }
    for (const [workId, entry] of best) map.set(workId, entry.id);
  }
  englishKeepersCache = map;
  return map;
}

// ── book_page presence for --hasDetails ────────────────────────────
// book_page holds the browser-scraped details page (~282k of the 14M books
// rows: description, genres, pages, reviews, ratings histogram). --hasDetails
// restricts the match set to books that have one — a Set membership check per
// streamed row (book_page is book_id-keyed, so this is one covering scan of
// 282k rows). It also acts as an accelerator for details-heavy queries: every
// filter after it (regex, excludeReviewed, page-stats lookups) only runs on
// books that can actually pass, instead of on the whole stream.
function loadBookPageIds(): Set<string> {
  if (bookPageIdsCache) return bookPageIdsCache;
  const db = getDb();
  const set = new Set<string>();
  const hasPage = !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='book_page'`).get();
  if (hasPage) {
    for (const row of db.prepare('SELECT book_id FROM book_page').iterate() as IterableIterator<{ book_id: string }>) {
      set.add(row.book_id);
    }
  }
  bookPageIdsCache = set;
  return set;
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
  const minPages = options.minPages ? parseNum(options.minPages) : 0;
  const maxPages = options.maxPages ? parseNum(options.maxPages) : Infinity;
  const limit = options.limit ? parseInt(options.limit, 10) : 100;

  // Resolved once up front; errors (unknown tag) exit before streaming.
  const tagSet = options.tag ? loadTagBookIds(options.tag) : null;
  // Books with a scraped details page (book_page row) — the "only books that
  // have book details" limiter. Checked before regex/excludeReviewed so those
  // only run on books that can pass.
  const detailsSet = options.hasDetails ? loadBookPageIds() : null;
  // Narrow filters over the books.genres JSON column (e.g. "fiction"), which is
  // only populated on browser-scraped books (~240k rows). Comma lists allowed
  // (OR within each flag; --genre AND --notGenre combine). --genre is exact on
  // the normalized label; --notGenre is word-boundary so it also catches
  // Goodreads' compound legacy labels ("Graphic Novels Comics" etc.).
  const genreList = options.genre ? parseGenreList(options.genre) : [];
  const genreKeySet = new Set(genreList.map(normGenre));
  const notGenreList = options.notGenre ? parseGenreList(options.notGenre) : [];
  const notGenreKeys = notGenreList.map(normGenre);

  // Load the enrichment maps lazily — only if the sort field needs them.
  const pageStats = PAGE_SORTS.includes(sortBy) ? loadPageStats() : null;
  const tagStats = TAG_SORTS.includes(sortBy) ? loadTagStats() : null;
  const workEditions = options.dedupe && sortBy === 'editionCount' ? loadWorkEditions() : null;
  const englishKeepers = options.dedupe ? loadEnglishWorkKeepers() : null;
  const bookLanguages = loadBookLanguages();

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
      case 'ratingsMean': return pageStats?.get(book.id)?.mean ?? 0;
      case 'ratingsMedian': return pageStats?.get(book.id)?.median ?? 0;
      case 'ratingsMode': return pageStats?.get(book.id)?.mode ?? 0;
      case 'ratingsVariance': return pageStats?.get(book.id)?.variance ?? 0;
      case 'ratingsStddev': return pageStats?.get(book.id)?.stddev ?? 0;
      case 'ratingsSkewness': return pageStats?.get(book.id)?.skewness ?? 0;
      case 'ratingsKurtosis': return pageStats?.get(book.id)?.kurtosis ?? 0;
      case 'ratingsTotal': return pageStats?.get(book.id)?.total ?? 0;
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
  // When the sort key is one of the derived ratings stats, only books that
  // actually HAVE the stat are considered. Their value is unknown (not zero)
  // when ratings_dist is absent, and the `?? 0` in valueOf would otherwise sort
  // those unknowns to the FRONT under --asc. Excluding them (both directions)
  // makes the match set "books that have this stat".
  const derivedSort = DERIVED_DISPLAY[sortBy];

  // Top-N maintenance is BATCHED. Re-sorting `matched` after every insert was
  // O(N × limit·log·limit) — invisible at the default limit=100, but
  // `--limit 100000` re-sorted a 100k-element array once per qualifying book
  // (each comparison also running valueOf → parseNum), i.e. hours of runtime
  // for a query that streams ~300k rows. Qualifying books now buffer in
  // `pending`; every PENDING_FLUSH inserts (and once after the loop) the
  // buffer is sorted and merged into the already-sorted `matched`, keeping
  // its top `limit`. `matched` stays sorted best-first, so the worst-element
  // early-exit in the loop stays valid, and memory stays bounded at
  // limit + PENDING_FLUSH.
  const matched: CachedBook[] = [];
  const PENDING_FLUSH = Math.max(1024, Math.ceil(limit / 4));
  let pending: CachedBook[] = [];
  const flushPending = (): void => {
    if (pending.length === 0) return;
    pending.sort(compare);
    if (matched.length === 0) {
      const n = Math.min(pending.length, limit);
      for (let k = 0; k < n; k++) matched.push(pending[k]);
    } else {
      const merged: CachedBook[] = [];
      let i = 0;
      let j = 0;
      while (merged.length < limit && (i < matched.length || j < pending.length)) {
        if (j >= pending.length || (i < matched.length && compare(matched[i], pending[j]) <= 0)) {
          merged.push(matched[i++]);
        } else {
          merged.push(pending[j++]);
        }
      }
      matched.length = 0;
      for (const b of merged) matched.push(b);
    }
    pending = [];
  };

  let reviewedExcluded = 0;
  let dedupedExcluded = 0;
  let totalMatched = 0;
  for (const book of iterateBooks(minRatings > 0 ? { minRatings } : {})) {
    if (book.isBad && !options.includeBad) continue;
    if (book.title === 'Unknown') continue;
    if (options.dedupe && book.workId) {
      // A known English sibling wins outright; otherwise the ratings rep does.
      const englishKeeper = englishKeepers?.get(book.workId);
      if (englishKeeper !== undefined) {
        if (book.id !== englishKeeper) {
          dedupedExcluded++;
          continue;
        }
      } else if (!book.isWorkRep) {
        dedupedExcluded++;
        continue;
      }
    }

    const ratings = parseNum(book.ratings);
    if (ratings < minRatings || ratings > maxRatings) continue;

    const year = getYear(book.published);
    if (minYear > 0 || maxYear < Infinity) {
      if (year === null || year < minYear || year > maxYear) continue;
    }

    if (tagSet && !tagSet.has(book.id)) continue;
    if (detailsSet && !detailsSet.has(book.id)) continue;
    if (genreKeySet.size > 0 && !book.genres?.some(g => genreKeySet.has(normGenre(g)))) continue;
    if (notGenreKeys.length > 0 && book.genres?.some(g => notGenreKeys.some(k => genreWordMatch(normGenre(g), k)))) continue;

    if (minPages > 0 || maxPages < Infinity) {
      // Unknown pages parse as 0 and are auto-excluded whenever --minPages >= 1.
      const pages = parseNum(book.pages);
      if (pages < minPages || pages > maxPages) continue;
    }

    // A missing/0 avgRating is unknown, not a real score; `valueOf`'s
    // `parseFloat(avgRating || '0')` would otherwise sort these books FIRST
    // under --asc. Exclude them outright (both directions), same as the
    // derived-stats exclusion above.
    if (sortBy === 'avgRatings') {
      const avg = parseFloat(book.avgRating || '0');
      if (!(avg > 0)) continue;
    }

    if (derivedSort) {
      const statValue = pageStats?.get(book.id)?.[derivedSort.key];
      if (typeof statValue !== 'number') continue;
    }

    if (!matchesRegex(book, criterion)) continue;
    if (library && options.excludeReviewed && matchesReviewed(library, book.id, book.title, book.author)) {
      reviewedExcluded++;
      continue;
    }
    totalMatched++;

    // matched is kept sorted by `compare`; the end holds the worst element.
    if (limit > 0 && matched.length === limit && compare(book, matched[matched.length - 1]) > 0) continue;
    pending.push(book);
    if (pending.length >= PENDING_FLUSH) flushPending();
  }
  flushPending();

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
  if (tagSet) criteriaMsg += `, Tag: ${options.tag!.trim().toLowerCase()} (tag xref)`;
  if (detailsSet) criteriaMsg += ', Has details: yes (book_page row)';
  if (genreList.length) criteriaMsg += `, Genre: ${genreList.join(', ')}`;
  if (notGenreList.length) criteriaMsg += `, Not Genre: ${notGenreList.join(', ')}`;
  if (minPages > 0 || maxPages < Infinity) criteriaMsg += `, Pages: ${minPages > 0 ? minPages : 'Any'}-${maxPages < Infinity ? maxPages : 'Any'}`;
  console.log(chalk.gray(criteriaMsg));
  if (options.dedupe) console.log(chalk.gray('   Dedupe works: yes (one row per distinct work; English edition preferred when known)'));
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
    const year = getYear(book.published);
    // Compact "key=value; key=value" tail so more fields fit on the line.
    const fields: string[] = [
      year !== null ? `pub=${year}` : 'pub=N/A',
      book.ratings ? `ratings=${chalk.yellow(parseNum(book.ratings).toLocaleString())}` : 'ratings=N/A',
      book.avgRating ? `avg=${chalk.green.bold(book.avgRating)}` : 'avg=N/A',
    ];
    const reviewsField = (ps: PageStats) => {
      const ratingsN = parseNum(book.ratings);
      const ratio = ratingsN > 0 ? (ps.reviews / ratingsN) : 0;
      fields.push(`reviews=${chalk.magenta(ps.reviews.toLocaleString())}`);
      fields.push(`rev/rat=${chalk.magenta(ratio.toFixed(3))}`);
    };

    if (sortBy === 'editionCount' && workEditions && book.workId && workEditions.has(book.workId)) {
      fields.push(`editions=${chalk.cyan(workEditions.get(book.workId)!.toLocaleString())}`);
    }
    if (pageStats) {
      const ps = pageStats.get(book.id);
      if (ps) {
        if (sortBy === 'numReviews' && ps.reviews > 0) reviewsField(ps);
        if (sortBy === 'currentlyReading' || sortBy === 'reviewRatio') fields.push(`currently_reading=${chalk.magenta(ps.currentlyReading.toLocaleString())}`);
        if (sortBy === 'toRead') fields.push(`to_read=${chalk.magenta(ps.toRead.toLocaleString())}`);
        if (sortBy === 'editionCount' && ps.editions !== undefined && fields.length === 3) fields.push(`editions=${chalk.cyan(ps.editions.toLocaleString())}`);
        if (sortBy === 'reviewRatio') reviewsField(ps);
        const derived = DERIVED_DISPLAY[sortBy];
        if (derived) {
          const value = ps[derived.key];
          if (typeof value === 'number') fields.push(`${derived.label}=${chalk.cyan(derived.fmt(value))}`);
        }
      }
    }
    if (tagStats) {
      const ts = tagStats.get(book.id);
      if (ts) {
        if (sortBy === 'numTags') fields.push(`tags=${chalk.magenta(ts.numTags.toLocaleString())}`);
        if (sortBy === 'numShelves' && ts.numShelves > 0) fields.push(`shelves=${chalk.cyan(ts.numShelves.toLocaleString())}`);
      }
    }
    const language = bookLanguages.get(book.id);
    if (language) fields.push(`language=${language.toLowerCase()}`);

    console.log(
      `${(i + 1).toString().padStart(4, ' ')}. ${chalk.white(formatBookLink(book.title, book.id))} by ${book.author}\n` +
      `      ${fields.join('; ')}`
    );
  }

  console.log(chalk.gray('------------------------------------------'));
  let footerMsg = `Total books matching: ${totalMatched.toLocaleString()} (Displayed: ${countToDisplay})`;
  if (options.dedupe) footerMsg += ` | Deduplicated works: ${dedupedExcluded.toLocaleString()}`;
  if (library && options.excludeReviewed) footerMsg += ` | Excluded (already reviewed): ${reviewedExcluded.toLocaleString()}`;
  console.log(chalk.cyan(`${footerMsg}\n`));
}