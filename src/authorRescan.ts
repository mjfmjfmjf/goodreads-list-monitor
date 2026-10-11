import chalk from 'chalk';
import { iterateAuthors, countAuthors, getAuthorById, upsertAuthorById, upsertAuthorSlug, updateAuthorStats, countBooks, recordAuthorScrapeFailure, clearAuthorScrapeFailure, loadAuthorScrapeFailure, AUTHOR_FAIL_LIMIT, strikeWeight, type AuthorCacheEntry , isRetiredAuthor } from './storage.ts';
import { selectAuthors, authorPairs, wasAuthorPageScraped } from './authorTopStats.ts';
import type { AuthorTopStatsOptions, SelectedAuthor } from './authorTopStats.ts';
import { scrapeAuthorStats, authorScrapeRef } from './scraper.ts';
import { getDb } from './db.ts';
import { delay, isConnectivityError, parseDelayRange, withConnectivityProbe } from './utils.ts';

export interface AuthorRescanOptions extends AuthorTopStatsOptions {
  minAge?: string;
  rescanMissing?: boolean;
  rescanMissingField?: string;
  multiPage?: boolean;
  onlyUntouched?: boolean;
  withCookie?: boolean;
  sort?: string;
  minYear?: string;
  minBookYear?: string;
}

// An author is "statless" when no author-page count and no average ever parsed
// for it — i.e. it is a minted row or a scrape that came back empty. This is
// the --rescanMissing predicate.
const isStatless = (entry: AuthorCacheEntry): boolean =>
  !entry.numRatings && !entry.averageRating && !entry.numReviews && !entry.numShelves;

// `topRatings`/`newestYear` order by the author's BOOKS in the books table, not
// by author-page stats — which are still 0 for exactly the never-scraped authors
// these paths exist to grind.
export function isBookBasedSort(sortBy: string): boolean {
  return sortBy === 'topRatings' || sortBy === 'newestYear';
}

// The sort key for one author under a given sortBy. Book-based sorts read the
// `loadAuthorBookStats` aggregation; everything else reads the author-page field.
export function authorSortValue(
  entry: AuthorCacheEntry,
  sortBy: string,
  bookStats?: Record<string, AuthorBookStats>
): number {
  if (sortBy === 'topRatings') return bookStats?.[entry.id]?.topRatings ?? 0;
  if (sortBy === 'newestYear') return bookStats?.[entry.id]?.newestYear ?? 0;
  if (sortBy === 'averageRating') return parseFloat(entry.averageRating || '0');
  if (sortBy === 'ratingsRate') return entry.ratingsRate ?? 0;
  return parseNum((entry as any)[sortBy]);
}

// Shared descending comparator. Ties break on the author's top-book rating
// (book-based sorts), then author-page numRatings, then name — so the order is
// total and stable rather than dependent on object key insertion.
export function compareAuthorsBySort(
  a: SelectedAuthor,
  b: SelectedAuthor,
  sortBy: string
): number {
  const byValue = b.value - a.value;
  if (byValue !== 0) return byValue;
  if (isBookBasedSort(sortBy)) {
    const byTop =
      ((b.entry as any).__topRatings ?? 0) - ((a.entry as any).__topRatings ?? 0);
    if (byTop !== 0) return byTop;
  }
  return parseNum(b.entry.numRatings) - parseNum(a.entry.numRatings) || a.name.localeCompare(b.name);
}

// --rescanMissingField maps a Goodreads author-page count field name to the
// author-cache property that holds it.
export const MISSING_FIELD_PROPS: Record<string, string> = {
  ratings: 'numRatings',
  reviews: 'numReviews',
  shelves: 'numShelves',
};

const parseNum = (s?: string): number => parseInt((s || '0').replace(/,/g, ''), 10) || 0;

const parseYear = (published?: string): number | null => {
  if (!published) return null;
  const y = parseInt(published.replace(/[^\d]/g, '').slice(0, 4), 10);
  return Number.isFinite(y) && y > 0 ? y : null;
};

// Select authors eligible for a --multiPage crawl and return them sorted by the
// requested field (descending), validated against min/max ratings. With
// `onlyUntouched`, restrict to authors that have never been multi-page-crawled
// (no catalogPages recorded yet) so a first pass only targets the remaining
// tail instead of re-evaluating already-completed ones. The `topRatings` sort
// key (max ratings across the author's books in the books table) is new: it
// orders by how popular the author's BOOKS are, not the author-page stats —
// which are still 0 for authors minted but not yet author-scraped (e.g. by a
// list/shelf walk). In that mode minRatings/maxRatings also filter on the
// top-book rating so `--minRatings N` means "has a book with ≥ N ratings".
//
// `minBookYear` restricts the (topRatings/newestYear) book aggregation to books
// published ≥ that year (and ≥ minRatings ratings), so an author qualifies only
// if they have at least one "recent enough" book. `newestYear` sorts by the
// newest qualifying book year (recent books first).
//
export interface MultiPageSelectionOptions {
  limit: number;
  sortBy: string;
  minRatings: number;
  maxRatings: number;
  onlyUntouched?: boolean;
  missingField?: string;
  bookStats?: Record<string, AuthorBookStats>;
}

export interface AuthorBookStats {
  topRatings: number;
  newestYear: number;
  books: number;
}

// SQL-side aggregation of the books table — O(books) in the DB, O(distinct
// authors) in JS, per-AuthorCacheEntry-sized.
//
// The year range only ever gated `newest`, but it used to gate `top` and `books`
// too. `published` is the literal string 'Unknown' for 8,780,422 of 11,578,563
// books (75.8%), so requiring a parseable year for the whole aggregation made
// any author whose books are all 'Unknown' produce no stats row at all — and
// `selectMultiPageAuthors` drops book-based-sort authors with no stats row. That
// made `--sortBy topRatings` structurally blind to 236,411 of the 236,804
// never-crawled authors (99.84%): the grind came up with ~597 candidates and
// reported "done" while 236k were invisible. Only `newest` is a year, so only
// `newest` needs the year range.
//
// Years above a future ceiling are dropped from `newest`: Goodreads encodes some
// BCE works as positive years (e.g. 2600), which otherwise outrank genuinely
// recent books. `--minBookYear N` still narrows `top`/`books` as well — that is
// the documented job of that flag ("only count books published ≥ N").
export function loadAuthorBookStats(minBookYear = 0, minRatings = 0): Record<string, AuthorBookStats> {
  console.log(chalk.gray(`   Loading author book stats (minBookYear=${minBookYear}, minRatings=${minRatings})...`));
  const t0 = Date.now();
  const futureCeil = new Date().getFullYear() + 5;
  const ratingCond = `ratings >= @minRatings`;
  const yearCond = `(published GLOB '[0-9][0-9][0-9][0-9]*'
                   AND CAST(substr(published, 1, 4) AS INTEGER) BETWEEN @minYear AND @maxYear)`;
  const bookCond = minBookYear > 0 ? `(${ratingCond} AND ${yearCond})` : ratingCond;
  const rows = getDb()
    .prepare(`SELECT author_id AS id,
                     MAX(CASE WHEN ${bookCond} THEN ratings END) AS top,
                     MAX(CASE WHEN ${bookCond} AND ${yearCond} THEN CAST(substr(published, 1, 4) AS INTEGER) END) AS newest,
                     COUNT(CASE WHEN ${bookCond} THEN 1 END) AS books
              FROM books
              WHERE author_id IS NOT NULL AND author_id != ''
              GROUP BY author_id`)
    .all({ minYear: minBookYear, maxYear: futureCeil, minRatings }) as any[];
  const map: Record<string, AuthorBookStats> = {};
  for (const row of rows) {
    if (row.top !== null || row.newest !== null || row.books > 0) {
      map[row.id] = { topRatings: row.top ?? 0, newestYear: row.newest ?? 0, books: row.books ?? 0 };
    }
  }
  console.log(chalk.gray(`   Loaded ${Object.keys(map).length.toLocaleString()} author book stats in ${((Date.now()-t0)/1000).toFixed(1)}s`));
  return map;
}

export function selectMultiPageAuthors(
  authorModels: Record<string, AuthorCacheEntry> | Iterable<AuthorCacheEntry>,
  opts: MultiPageSelectionOptions,
): SelectedAuthor[] {
  const bookBased = isBookBasedSort(opts.sortBy);
  const selected: SelectedAuthor[] = [];
  for (const [id, entry] of authorPairs(authorModels)) {
    const stats = opts.bookStats?.[entry.id];
    const filterRatings = bookBased ? (stats?.topRatings ?? 0) : parseNum(entry.numRatings);
    // Book-based sorts require the author to actually have a qualifying book.
    if (bookBased && !stats) continue;
    // Offline throttle lever: drop the 1-book tail before any request is made.
    if (opts.missingField) {
      // Re-scrub a partially-parsed author: avg proves the author page was
      // scraped, but the requested count field never came through (a singular
      // "1 rating" missed by a plural-only regex, a shelves widget that didn't
      // render, or a genuine 0). Rows with no stats at all belong to
      // --rescanMissing, not this path.
      const prop = MISSING_FIELD_PROPS[opts.missingField];
      if (!entry.averageRating) continue;
      if (parseNum((entry as any)[prop]) > 0) continue;
      if (!(filterRatings >= opts.minRatings && filterRatings <= opts.maxRatings)) continue;
    } else {
      const isMultiPage = !entry.catalogPages || entry.catalogPages >= 2;
      if (opts.onlyUntouched && entry.catalogPages && entry.catalogPages >= 2) continue;
      if (!isMultiPage) continue;
      if (!(filterRatings >= opts.minRatings && filterRatings <= opts.maxRatings)) continue;
    }
    selected.push({ id, name: entry.name ?? id, entry, value: authorSortValue(entry, opts.sortBy, opts.bookStats) });
  }
  selected.sort((a, b) => compareAuthorsBySort(a, b, opts.sortBy));
  return selected.slice(0, opts.limit);
}

// Candidates for --rescanMissing: every author with no author-page stats yet,
// ordered by book popularity and sliced by --limit.
//
// Unlike the --multiPage path this does NOT gate on catalogPages, and a book-based
// sort puts authors with no book rows at the bottom instead of dropping them —
// the point is to grind *everyone* statless, and an author-page-only row (no
// books at all) is still statless and still worth a scrape.
export function selectStatlessAuthors(
  authorModels: Record<string, AuthorCacheEntry> | Iterable<AuthorCacheEntry>,
  opts: MultiPageSelectionOptions,
): SelectedAuthor[] {
  const bookBased = isBookBasedSort(opts.sortBy);
  const selected: SelectedAuthor[] = [];
  for (const [id, entry] of authorPairs(authorModels)) {
    if (!isStatless(entry)) continue;
    const filterRatings = bookBased
      ? (opts.bookStats?.[entry.id]?.topRatings ?? 0)
      : parseNum(entry.numRatings);
    if (!(filterRatings >= opts.minRatings && filterRatings <= opts.maxRatings)) continue;
    selected.push({ id, name: entry.name ?? id, entry, value: authorSortValue(entry, opts.sortBy, opts.bookStats) });
  }
  selected.sort((a, b) => compareAuthorsBySort(a, b, opts.sortBy));
  return selected.slice(0, opts.limit);
}

export async function runAuthorRescan(options: AuthorRescanOptions = {}): Promise<void> {
  const startTs = Date.now();
  console.log(chalk.cyan.bold(`\n👤 Author Rescan starting...`));
  console.log(chalk.gray(`   Options: multiPage=${!!options.multiPage} onlyUntouched=${!!options.onlyUntouched} sortBy=${options.sortBy || '(default)'} limit=${options.limit || '(default)'} minAge=${options.minAge || 0} minRatings=${options.minRatings ?? 'any'} maxRatings=${options.maxRatings ?? 'any'} rescanMissing=${!!options.rescanMissing} rescanMissingField=${options.rescanMissingField || 'n/a'} minBookYear=${options.minBookYear || 0}`));

  console.log(chalk.gray('   Counting authors...'));
  console.log(chalk.gray(`   ${countAuthors().toLocaleString()} authors in cache`));

  const sortBy = (options.sortBy || 'numRatings') as string;
  const limit = options.limit ? parseInt(options.limit, 10) : 100;
  const minAgeDays = options.minAge !== undefined ? parseNum(options.minAge) : 0;
  const minYear = options.minYear !== undefined ? parseNum(options.minYear) : 0;
  const listSort = options.sort || (minYear > 0 ? 'original_publication_year' : 'popularity');
  // --minYear only looks at the first page (newest books), so never crawl all pages.
  const crawlAllPages = !!options.multiPage && minYear === 0;

  let authors: SelectedAuthor[];
  let missingField = 0;
  // Populated by the --multiPage path; the header loop reads them to annotate
  // each author with their qualifying-book aggregate.
  let bookStats: Record<string, AuthorBookStats> | undefined;
  let effectiveSortBy = sortBy;

  if (options.rescanMissing) {
    // Every statless author, ordered by book popularity, sliced by --limit.
    // This path used to map all of them with value 0 and apply neither a sort
    // nor a slice, so `--rescanMissing --limit 100` scraped the entire ~222k
    // tail in arbitrary insertion order while the header claimed "limit 100".
    const minRatingsMissing = options.minRatings !== undefined ? parseNum(options.minRatings) : 0;
    const maxRatingsMissing = options.maxRatings !== undefined ? parseNum(options.maxRatings) : Infinity;
    // The CLI hands us --sortBy's commander default ('numRatings') even when the
    // user never typed it, and every statless author has numRatings 0 — so that
    // order is a no-op that would tie the whole tail together. Auto-upgrade to
    // book popularity, the same way --minBookYear upgrades topRatings below.
    effectiveSortBy = sortBy === 'numRatings' ? 'topRatings' : sortBy;
    bookStats = isBookBasedSort(effectiveSortBy) ? loadAuthorBookStats(0, minRatingsMissing) : undefined;
    authors = selectStatlessAuthors(iterateAuthors(), {
      limit,
      sortBy: effectiveSortBy,
      minRatings: minRatingsMissing,
      maxRatings: maxRatingsMissing,
      ...(bookStats ? { bookStats } : {}),
    });
    console.log(chalk.cyan.bold(`\n👤 Author Rescan: scanning authors with no stats (top ${limit} by ${effectiveSortBy === 'topRatings' ? 'top book ratings' : effectiveSortBy})`));
  } else if (options.rescanMissingField) {
    const field = options.rescanMissingField.toLowerCase();
    if (!(field in MISSING_FIELD_PROPS)) {
      throw new Error(`--rescanMissingField expects one of: ratings, reviews, shelves (got "${options.rescanMissingField}")`);
    }
    const minRatings = options.minRatings !== undefined ? parseNum(options.minRatings) : 0;
    const maxRatings = options.maxRatings !== undefined ? parseNum(options.maxRatings) : Infinity;
    // --minBookYear restricts candidate books to those published ≥ that year
    // (and ≥ minRatings) for the topRatings/newestYear sorts, exactly like the
    // multiPage path below.
    const minBookYear = options.minBookYear !== undefined ? parseNum(options.minBookYear) : 0;
    const bookBased = isBookBasedSort(sortBy);
    bookStats = (bookBased || minBookYear > 0) ? loadAuthorBookStats(minBookYear, minRatings) : undefined;
    effectiveSortBy = sortBy === 'topRatings' && minBookYear > 0 ? 'newestYear' : sortBy;
    authors = selectMultiPageAuthors(iterateAuthors(), {
      limit,
      sortBy: effectiveSortBy,
      minRatings,
      maxRatings,
      missingField: field,
      ...(bookStats ? { bookStats } : {}),
    });
    const sortLabel =
      effectiveSortBy === 'topRatings' ? 'top book ratings' :
      effectiveSortBy === 'newestYear' ? 'newest qualifying book year' :
      effectiveSortBy === 'ratingsRate' ? 'ratings growth / day' :
      effectiveSortBy;
    console.log(chalk.cyan.bold(`\n👤 Author Rescan: re-scraping authors missing ${field} (Top ${limit} by ${sortLabel})`));
  } else if (options.multiPage) {
    // Select authors with null or ≥2 catalog pages (skip single-page catalogs),
    // then apply the same --sortBy / --minRatings / --maxRatings filters.
    // With --onlyUntouched, restrict to authors that have never been
    // multi-page-crawled (no catalogPages recorded yet) so a first pass only
    // targets the not-yet-done tail instead of re-evaluating completed ones.
const sortBy = (options.sortBy || (options.rescanMissingField ? 'topRatings' : 'numRatings')) as string;
    const minRatings = options.minRatings !== undefined ? parseNum(options.minRatings) : 0;
    const maxRatings = options.maxRatings !== undefined ? parseNum(options.maxRatings) : Infinity;
    const untouchedOnly = !!options.onlyUntouched;
    // --minBookYear restricts candidate books to those published ≥ that year
    // (and ≥ minRatings), driving a bookStats aggregation shared by topRatings
    // and newestYear sorts. Authors with no qualifying book are excluded.
    const minBookYear = options.minBookYear !== undefined ? parseNum(options.minBookYear) : 0;
    const bookBased = isBookBasedSort(sortBy);
    bookStats = (bookBased || minBookYear > 0) ? loadAuthorBookStats(minBookYear, minRatings) : undefined;
    effectiveSortBy = sortBy === 'topRatings' && minBookYear > 0 ? 'newestYear' : sortBy;
    authors = selectMultiPageAuthors(iterateAuthors(), {
      limit,
      sortBy: effectiveSortBy,
      minRatings,
      maxRatings,
      onlyUntouched: untouchedOnly,
      ...(bookStats ? { bookStats } : {}),
    });
    const sortLabel =
      effectiveSortBy === 'topRatings' ? 'top book ratings' :
      effectiveSortBy === 'newestYear' ? 'newest qualifying book year' :
      effectiveSortBy === 'ratingsRate' ? 'ratings growth / day' :
      effectiveSortBy;
    console.log(chalk.cyan.bold(`\n👤 Author Rescan: re-scraping multi-page authors${untouchedOnly ? ' (never crawled)' : ''} (Top ${limit} by ${sortLabel}, ≥${minRatings.toLocaleString()} ratings${minBookYear > 0 ? `, books from ${minBookYear}+` : ''})`));
  } else {
      const selected = selectAuthors(iterateAuthors(), options);
      authors = selected.authors;
      missingField = selected.missingField;
      console.log(chalk.cyan.bold(`\n👤 Author Rescan: re-scraping stats for ${authors.length} authors (Top ${limit} by ${sortBy})`));
    }
  
    if (minYear > 0) {
      console.log(chalk.cyan.bold(`\n🔎 Find authors with a book from ${minYear}+ (list sorted by ${listSort}, first page only)`));
    }
    console.log(chalk.gray(`   List sort: ${listSort}${crawlAllPages ? ' | crawling all pages' : ' | first page only'}`));
    console.log(chalk.gray(`   Min Age: ${minAgeDays > 0 ? `${minAgeDays} day(s)` : 'none (scrape everything)'}${missingField > 0 ? `, Excluded (no ${sortBy}): ${missingField.toLocaleString()}` : ''}\n`));
  
    if (authors.length === 0) {
      console.log(chalk.yellow('   No authors match the criteria.'));
      return;
    }
  
    // Filter out authors updated within minAge days (but always keep authors with no stats
    // and no catalog-pages proof of a prior scrape)
    const cutoff = minAgeDays > 0 ? Date.now() - minAgeDays * 24 * 60 * 60 * 1000 : 0;
    const toScrape: SelectedAuthor[] = [];
    let minAgeSkipped = 0;
    let failSkipped = 0;
    // One ledger, one threshold. Loaded once (the table is small) instead of a
    for (const a of authors) {
      if (isRetiredAuthor(a.id)) {
        failSkipped++;
        continue;
      }
      if (wasAuthorPageScraped(a.entry) && a.entry.lastSeen && cutoff > 0 && new Date(a.entry.lastSeen).getTime() >= cutoff) {
        minAgeSkipped++;
        continue;
      }
      toScrape.push(a);
    }
  
    console.log(chalk.gray(`   ${toScrape.length} authors to scrape.`));
    if (minAgeSkipped > 0) console.log(chalk.gray(`   Skipping ${minAgeSkipped} authors updated within the last ${minAgeDays} day(s) (--minAge).\n`));
    if (failSkipped > 0) console.log(chalk.gray(`   Skipping ${failSkipped} authors with ≥${AUTHOR_FAIL_LIMIT} consecutive failures.\n`));
    else console.log('');
  
    let failed = 0;
    let updated = 0;
    let noStats = 0;
    // Retired THIS run (reached the limit). Distinct from the pre-filtered
    // `failSkipped`, which counts authors already retired before we started.
    let strikeRetired = 0;
        let totalInserted = 0;
    let totalEnriched = 0;
    const booksAtStart = countBooks();
    const start = Date.now();
  
    for (let i = 0; i < toScrape.length; i++) {
      const { id, name, entry: snapshotEntry, value } = toScrape[i];
      // Anonymous crawls (no cookie) run at a faster but still polite cadence;
      // GR_AUTHOR_DELAY_MS overrides either profile ("min,max"). Declared out here
      // (not inside the try) because BOTH the dead-page branch and the tail of the
      // loop have to wait: retiring an author still cost one Goodreads request.
      const [authorDelayMin, authorDelayMax] = parseDelayRange(
        process.env.GR_AUTHOR_DELAY_MS,
        options.withCookie ? 2000 : 1000,
        options.withCookie ? 5000 : 1800
      );
      try {
        // Show the value this author was sorted on (e.g. topRatings=N,
        // numRatings=N, averageRating=X) so the ordering isn't a guessing game.
        const sortSuffix = options.rescanMissing
          ? ''
          : effectiveSortBy === 'ratingsRate'
            ? ` ${effectiveSortBy}=${value.toLocaleString('en-US')}/day`
            : ` ${effectiveSortBy}=${value.toLocaleString('en-US')}`;
        // Book-stats-backed sorts: surface the author's qualifying-book aggregate
        // (newest year + top rating + book count) so recency sorting doesn't hide
        // popularity. In newestYear mode the sort value already IS newestYear, so
        // add topRatings; otherwise add books count.
        const statsEntry = bookStats?.[snapshotEntry.id];
        const bookSuffix = !options.rescanMissing && statsEntry
          ? (effectiveSortBy === 'newestYear'
              ? ` topRatings=${statsEntry.topRatings.toLocaleString('en-US')}`
              : ` books=${statsEntry.books}`)
          : '';
        // A mint-only row (author-mint) has no slug yet. The scraper needs *a*
        // reference, and the id is always valid, so fall back to it — passing a
        // NULL slug used to build `/author/list/null`, a guaranteed 404 that
        // burned all five strikes and then skipped the author forever.
        const scrapeRef = snapshotEntry.slug || id;
        const slugShown = snapshotEntry.slug || '(mint, no slug yet)';
        // Prior consecutive failures persist (failCount) so repeat attempts are
        // obvious; authors at the limit are already filtered out up front.
        const failCount = loadAuthorScrapeFailure(id)?.failCount ?? 0;
        const failSuffix = failCount > 0 ? ` failCount=${failCount}` : '';
        console.log(chalk.white.bold(`[${i + 1}/${toScrape.length}] Author: ${name} (${slugShown})${sortSuffix}${bookSuffix}${failSuffix}`));
        let failReason = 'no_stats_line';
        const result = await withConnectivityProbe(
          () => scrapeAuthorStats(authorScrapeRef(snapshotEntry.slug, id), (r) => { failReason = r; }, crawlAllPages, listSort, !!options.withCookie),
          { label: `author scan "${name}"` }
        );
        if (!result) {
          noStats++;
          // `scrapeAuthorStats` logs the reason itself (with HTTP status/bytes
          // for a parse miss, or the status for an HTTP error), so record the
          // strike here without repeating the message.
          recordAuthorScrapeFailure(id, failReason);
          const n = loadAuthorScrapeFailure(id)?.failCount ?? 1;
          const retired = n >= AUTHOR_FAIL_LIMIT;
          const weight = strikeWeight(failReason);
          console.log(
            chalk.gray(
              `      ↳ ${weight > 1 ? `${failReason} counts ${weight} strikes — ` : ''}` +
              `Consecutive failure ${n}/${AUTHOR_FAIL_LIMIT}${retired ? ' — skipped for future runs' : ''}`
            )
          );
          if (retired) strikeRetired++;
        } else {
          const stats = result.stats;
          totalInserted += result.booksInserted;
          totalEnriched += result.booksEnriched;

          if (minYear > 0) {
            const recent = (result.books ?? [])
              .map(b => ({ title: b.title, year: parseYear(b.published) }))
              .filter((b): b is { title: string; year: number } => b.year !== null && b.year >= minYear)
              .sort((a, b) => b.year - a.year);
            if (recent.length > 0) {
              console.log(chalk.green(`   🔥 Books from ${minYear}+:`));
              for (const b of recent) {
                console.log(`      ${chalk.cyan(b.title)} (${b.year})`);
              }
            } else {
              console.log(chalk.gray(`   (No books from ${minYear}+ on first page)`));
            }
          }
          // Re-read fresh so we merge against current values (another process
          // may have updated this row since the snapshot was taken).
          const entry = getAuthorById(id) ?? snapshotEntry;
          const prevCatalogPages = entry.catalogPages;
          if (result.catalogPages) entry.catalogPages = result.catalogPages;
          clearAuthorScrapeFailure(id);
          // Every successful scrape (stats moved, catalog was extended, or the
          // page was identical) = "seen recently", so the other scrapers' --minAge
          // gate can skip it for the cooldown window.
          entry.lastSeen = new Date().toISOString();
          const prev = {
            averageRating: entry.averageRating,
            numRatings: entry.numRatings,
            numReviews: entry.numReviews,
            numShelves: entry.numShelves,
          };
          const prevSlug = entry.slug;
          const statsChanged = updateAuthorStats(entry, stats);
          const catalogChanged = entry.catalogPages !== prevCatalogPages;
          const fmt = (cur?: string, was?: string) =>
            `${cur ?? 'n/a'}${was !== undefined && was !== cur ? chalk.gray(` (prev ${was})`) : ''}`;
          console.log(
            `   ${chalk.green.bold(fmt(stats.numRatings, prev.numRatings))} ratings · ` +
            `${chalk.yellow(fmt(stats.numReviews, prev.numReviews))} reviews · ` +
            `${chalk.cyan(fmt(stats.numShelves, prev.numShelves))} shelves · ` +
            `Avg ${fmt(stats.averageRating, prev.averageRating)}` +
            ` ${chalk.gray(`· slug ${prevSlug ?? '(none)'}`)}`
          );
          // Persist the page's canonical name/slug; ids can outlive their slugs.
          if (stats.name) entry.name = stats.name;
          if (stats.slug) entry.slug = stats.slug;
          upsertAuthorById(id, entry);
          upsertAuthorSlug(id, entry.slug, entry.name);
          // A newly-discovered slug IS a cache change even when every stat is
          // identical, so it must count toward `updated` and be reported.
          const slugChanged = !!entry.slug && entry.slug !== prevSlug;
          if (slugChanged) {
            console.log(chalk.green.bold(`   🔄 Slug changed: ${prevSlug ?? '(none)'} → ${entry.slug}`));
          }
          if (statsChanged || catalogChanged || slugChanged) {
            updated++;
            console.log(chalk.green.bold(`   ✅ Author cache updated`));
          } else {
            console.log(chalk.gray(`   (No change - values already current or not greater)`));
          }
        }
      } catch (error) {
        // Network went down mid-run — aborts cleanly instead of black-marking
        // every remaining author with a failure strike (the authors aren't at
        // fault, the outage is). Progress is saved per-author, so a re-run
        // resumes where this run stopped.
        if (isConnectivityError(error)) {
          console.error(chalk.red.bold(`\n🛑 Aborting author scan: network error (${(error as any).code} — ${(error as any).message}).`));
          console.error(chalk.red.bold(`   Progress is saved to the DB; re-run when your connection is back.`));
          const duration = ((Date.now() - start) / 1000).toFixed(1);
          const totalDuration = ((Date.now() - startTs) / 1000).toFixed(1);
          console.log(chalk.cyan.bold(`\n🏁 Aborted. Processed ${i} of ${toScrape.length} authors, updated ${updated} (${noStats} no result, ${failed} failures, ${strikeRetired} retired at ≥${AUTHOR_FAIL_LIMIT} strikes, ${minAgeSkipped} skipped by --minAge, ${duration}s; total run ${totalDuration}s).`));
          return;
        }
        failed++;
        console.error(chalk.red.bold(`   ❌ Failed for ${name}: ${(error as any).message}`));
      }
      await delay(authorDelayMin, authorDelayMax);
  }

  const duration = ((Date.now() - start) / 1000).toFixed(1);
  const totalDuration = ((Date.now() - startTs) / 1000).toFixed(1);
  const booksAtEnd = countBooks();
  console.log(chalk.cyan.bold(`\n🏁 Done. Processed ${toScrape.length} authors, updated ${updated} (${noStats} no result, ${failed} failures, ${strikeRetired} retired at ≥${AUTHOR_FAIL_LIMIT} strikes, ${minAgeSkipped} skipped by --minAge, ${duration}s; total run ${totalDuration}s).`));
  console.log(chalk.cyan.bold(`📚 Books harvested: +${totalInserted.toLocaleString()} new · ${totalEnriched.toLocaleString()} enriched · cache ${booksAtStart.toLocaleString()} → ${booksAtEnd.toLocaleString()}`));
}
