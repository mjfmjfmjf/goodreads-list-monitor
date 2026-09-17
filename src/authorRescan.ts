import chalk from 'chalk';
import { loadAuthorCache, getAuthor, upsertAuthor, updateAuthorStats, countBooks, recordAuthorFailure, AUTHOR_FAIL_LIMIT, type AuthorCacheEntry } from './storage.js';
import { selectAuthors } from './authorTopStats.js';
import type { AuthorTopStatsOptions, SelectedAuthor } from './authorTopStats.js';
import { scrapeAuthorStats } from './scraper.js';
import { getDb } from './db.js';
import { delay, parseDelayRange } from './utils.js';

export interface AuthorRescanOptions extends AuthorTopStatsOptions {
  minAge?: string;
  rescanMissing?: boolean;
  multiPage?: boolean;
  onlyUntouched?: boolean;
  withCookie?: boolean;
  sort?: string;
  minYear?: string;
  minBookYear?: string;
}

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
export interface MultiPageSelectionOptions {
  limit: number;
  sortBy: string;
  minRatings: number;
  maxRatings: number;
  onlyUntouched?: boolean;
  bookStats?: Record<string, AuthorBookStats>;
}

export interface AuthorBookStats {
  topRatings: number;
  newestYear: number;
  books: number;
}

// SQL-side aggregation of the books table — O(books) in the DB, O(distinct
// authors) in JS, per-AuthorCacheEntry-sized. With minBookYear/minRatings
// bounds, only books that clear BOTH gates are counted, so `.newestYear` is the
// newest qualifying book and `.topRatings` its rating. Years above a future
// ceiling are dropped: Goodreads encodes some BCE works as positive years
// (e.g. 2600), which otherwise outrank genuinely recent books.
export function loadAuthorBookStats(minBookYear = 0, minRatings = 0): Record<string, AuthorBookStats> {
  const futureCeil = new Date().getFullYear() + 5;
  const cond = `(published GLOB '[0-9][0-9][0-9][0-9]*'
                 AND CAST(substr(published, 1, 4) AS INTEGER) BETWEEN @minYear AND @maxYear
                 AND ratings >= @minRatings)`;
  const rows = getDb()
    .prepare(`SELECT author_id AS id,
                     MAX(CASE WHEN ${cond} THEN ratings END) AS top,
                     MAX(CASE WHEN ${cond} THEN CAST(substr(published, 1, 4) AS INTEGER) END) AS newest,
                     COUNT(CASE WHEN ${cond} THEN 1 END) AS books
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
  return map;
}

export function selectMultiPageAuthors(
  authorCache: Record<string, AuthorCacheEntry>,
  opts: MultiPageSelectionOptions,
): SelectedAuthor[] {
  const valueOf = (entry: AuthorCacheEntry): number => {
    if (opts.sortBy === 'topRatings') return opts.bookStats?.[entry.id]?.topRatings ?? 0;
    if (opts.sortBy === 'newestYear') return opts.bookStats?.[entry.id]?.newestYear ?? 0;
    if (opts.sortBy === 'averageRating') return parseFloat(entry.averageRating || '0');
    return parseNum((entry as any)[opts.sortBy]);
  };
  const bookBased = opts.sortBy === 'topRatings' || opts.sortBy === 'newestYear';
  return Object.entries(authorCache)
    .filter(([, entry]) => {
      const isMultiPage = !entry.catalogPages || entry.catalogPages >= 2;
      if (opts.onlyUntouched && entry.catalogPages && entry.catalogPages >= 2) return false;
      const stats = opts.bookStats?.[entry.id];
      const filterRatings = bookBased ? (stats?.topRatings ?? 0) : parseNum(entry.numRatings);
      // Book-based sorts require the author to actually have a qualifying book.
      if (bookBased && !stats) return false;
      return isMultiPage && filterRatings >= opts.minRatings && filterRatings <= opts.maxRatings;
    })
    .map(([name, entry]) => ({ name, entry, value: valueOf(entry) }))
    .sort((a, b) => {
      const byValue = b.value - a.value;
      if (byValue !== 0) return byValue;
      // Within the same sort value (e.g. all authored in the same newest year),
      // prefer the more popular qualifying book rather than falling through to
      // the author-page numRatings (which is still 0 for untouched authors) and
      // then lexical order.
      if (bookBased) {
        const byTop = (opts.bookStats?.[b.entry.id]?.topRatings ?? 0) - (opts.bookStats?.[a.entry.id]?.topRatings ?? 0);
        if (byTop !== 0) return byTop;
      }
      return parseNum(b.entry.numRatings) - parseNum(a.entry.numRatings) || a.name.localeCompare(b.name);
    })
    .slice(0, opts.limit);
}

export async function runAuthorRescan(options: AuthorRescanOptions = {}): Promise<void> {
  const authorCache = await loadAuthorCache();

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
    // Select all authors missing stats, then apply minAge
    authors = Object.entries(authorCache)
      .filter(([, entry]) => !entry.numRatings && !entry.averageRating && !entry.numReviews && !entry.numShelves)
      .map(([name, entry]) => ({ name, entry, value: 0 }));
    console.log(chalk.cyan.bold(`\n👤 Author Rescan: scanning authors with no stats (limit ${limit})`));
  } else if (options.multiPage) {
    // Select authors with null or ≥2 catalog pages (skip single-page catalogs),
    // then apply the same --sortBy / --minRatings / --maxRatings filters.
    // With --onlyUntouched, restrict to authors that have never been
    // multi-page-crawled (no catalogPages recorded yet) so a first pass only
    // targets the not-yet-done tail instead of re-evaluating completed ones.
    const sortBy = (options.sortBy || 'numRatings') as string;
    const minRatings = options.minRatings !== undefined ? parseNum(options.minRatings) : 0;
    const maxRatings = options.maxRatings !== undefined ? parseNum(options.maxRatings) : Infinity;
    const untouchedOnly = !!options.onlyUntouched;
    // --minBookYear restricts candidate books to those published ≥ that year
    // (and ≥ minRatings), driving a bookStats aggregation shared by topRatings
    // and newestYear sorts. Authors with no qualifying book are excluded.
    const minBookYear = options.minBookYear !== undefined ? parseNum(options.minBookYear) : 0;
    const bookBased = sortBy === 'topRatings' || sortBy === 'newestYear';
    bookStats = (bookBased || minBookYear > 0) ? loadAuthorBookStats(minBookYear, minRatings) : undefined;
    effectiveSortBy = sortBy === 'topRatings' && minBookYear > 0 ? 'newestYear' : sortBy;
    authors = selectMultiPageAuthors(authorCache, {
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
      effectiveSortBy;
    console.log(chalk.cyan.bold(`\n👤 Author Rescan: re-scraping multi-page authors${untouchedOnly ? ' (never crawled)' : ''} (Top ${limit} by ${sortLabel}, ≥${minRatings.toLocaleString()} ratings${minBookYear > 0 ? `, books from ${minBookYear}+` : ''})`));
  } else {
      const selected = selectAuthors(authorCache, options);
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
  
    // Filter out authors updated within minAge days (but always keep authors with no stats)
    const cutoff = minAgeDays > 0 ? Date.now() - minAgeDays * 24 * 60 * 60 * 1000 : 0;
    const toScrape: SelectedAuthor[] = [];
    let minAgeSkipped = 0;
    let failSkipped = 0;
    for (const a of authors) {
      const hasStats = a.entry.numRatings || a.entry.averageRating || a.entry.numReviews || a.entry.numShelves;
      if ((a.entry.failCount ?? 0) >= AUTHOR_FAIL_LIMIT) {
        failSkipped++;
        continue;
      }
      if (hasStats && a.entry.lastSeen && cutoff > 0 && new Date(a.entry.lastSeen).getTime() >= cutoff) {
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
    let totalInserted = 0;
    let totalEnriched = 0;
    const booksAtStart = countBooks();
    const start = Date.now();
  
    for (let i = 0; i < toScrape.length; i++) {
      const { name, entry: snapshotEntry, value } = toScrape[i];
      try {
        // Show the value this author was sorted on (e.g. topRatings=N,
        // numRatings=N, averageRating=X) so the ordering isn't a guessing game.
        const sortSuffix = options.rescanMissing ? '' : ` ${effectiveSortBy}=${value.toLocaleString('en-US')}`;
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
        // Prior consecutive failures persist (failCount) so repeat attempts are
        // obvious; authors at the limit are already filtered out up front.
        const failCount = snapshotEntry.failCount ?? 0;
        const failSuffix = failCount > 0 ? ` failCount=${failCount}` : '';
        console.log(chalk.white.bold(`[${i + 1}/${toScrape.length}] Author: ${name} (${snapshotEntry.slug})${sortSuffix}${bookSuffix}${failSuffix}`));
        let failReason = 'no_stats_line';
        const result = await scrapeAuthorStats(snapshotEntry.slug, (r) => { failReason = r; }, crawlAllPages, listSort, !!options.withCookie);
        if (!result) {
          noStats++;
          console.log(chalk.yellow(`   ⚠️ No stats line found for ${name}`));
          recordAuthorFailure(name, failReason);
          const strikes = getAuthor(name)?.failCount ?? (snapshotEntry.failCount ?? 0) + 1;
          console.log(chalk.gray(`      ↳ Consecutive failure ${strikes}/${AUTHOR_FAIL_LIMIT}${strikes >= AUTHOR_FAIL_LIMIT ? ' — skipped for future runs' : ''}`));
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
          const entry = getAuthor(name) ?? snapshotEntry;
          const prevCatalogPages = entry.catalogPages;
          if (result.catalogPages) entry.catalogPages = result.catalogPages;
          entry.failCount = 0;
          entry.lastError = undefined;
          const prev = {
            averageRating: entry.averageRating,
            numRatings: entry.numRatings,
            numReviews: entry.numReviews,
            numShelves: entry.numShelves,
          };
          const changed = updateAuthorStats(entry, stats) || entry.catalogPages !== prevCatalogPages;
          const fmt = (cur?: string, was?: string) =>
            `${cur ?? 'n/a'}${was !== undefined && was !== cur ? chalk.gray(` (prev ${was})`) : ''}`;
          console.log(
            `   ${chalk.green.bold(fmt(stats.numRatings, prev.numRatings))} ratings · ` +
            `${chalk.yellow(fmt(stats.numReviews, prev.numReviews))} reviews · ` +
            `${chalk.cyan(fmt(stats.numShelves, prev.numShelves))} shelves · ` +
            `Avg ${fmt(stats.averageRating, prev.averageRating)}`
          );
          if (changed) {
            updated++;
            upsertAuthor(name, entry);
            console.log(chalk.green.bold(`   ✅ Author cache updated`));
          } else {
            // Values already current — a no-op scrape. Still stamp last_seen so the
            // author is not immediately re-crawled by --minAge on the next run.
            entry.lastSeen = new Date().toISOString();
            upsertAuthor(name, entry);
            console.log(chalk.gray(`   (No change - values already current or not greater; refreshed last_seen)`));
          }
        }
      } catch (error) {
        failed++;
        console.error(chalk.red.bold(`   ❌ Failed for ${name}: ${(error as any).message}`));
      }
      // Anonymous crawls (no cookie) run at a faster but still polite cadence;
      // GR_AUTHOR_DELAY_MS overrides either profile ("min,max").
      const [authorDelayMin, authorDelayMax] = parseDelayRange(
        process.env.GR_AUTHOR_DELAY_MS,
        options.withCookie ? 2000 : 1000,
        options.withCookie ? 5000 : 1800
      );
      await delay(authorDelayMin, authorDelayMax);
  }

  const duration = ((Date.now() - start) / 1000).toFixed(1);
  const booksAtEnd = countBooks();
  console.log(chalk.cyan.bold(`\n🏁 Done. Processed ${toScrape.length} authors, updated ${updated} (${noStats} no stats line, ${failed} failures, ${minAgeSkipped} skipped by --minAge, ${duration}s).`));
  console.log(chalk.cyan.bold(`📚 Books harvested: +${totalInserted.toLocaleString()} new · ${totalEnriched.toLocaleString()} enriched · cache ${booksAtStart.toLocaleString()} → ${booksAtEnd.toLocaleString()}`));
}
