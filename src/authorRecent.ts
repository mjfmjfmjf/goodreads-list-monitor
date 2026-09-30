import chalk from 'chalk';
import { loadAuthorCache, getAuthor, upsertAuthor, updateAuthorStats, countBooks, recordAuthorFailure, AUTHOR_FAIL_LIMIT, type AuthorCacheEntry } from './storage.js';
import { loadAuthorBookStats } from './authorRescan.js';
import type { AuthorBookStats } from './authorRescan.js';
import type { SelectedAuthor } from './authorTopStats.js';
import { scrapeAuthorStats } from './scraper.js';
import { delay, isConnectivityError, parseDelayRange, withConnectivityProbe } from './utils.js';

export interface AuthorRecentOptions {
  limit?: string;    // max authors to refresh per run (default 100)
  years?: string;    // rescrape authors with a book published within this many years (default 10)
  minAge?: string;   // skip authors whose stats were updated within this many days (default 14)
  sortBy?: string;   // 'ratings' (default) or 'newestYear'
  withCookie?: boolean;
}

const parseNum = (s?: string): number => parseInt((s || '0').replace(/,/g, ''), 10) || 0;

const parseYear = (published?: string): number | null => {
  if (!published) return null;
  const y = parseInt(published.replace(/[^\d]/g, '').slice(0, 4), 10);
  return Number.isFinite(y) && y > 0 ? y : null;
};

export interface RecentSelectionOptions {
  limit: number;
  bookStats: Record<string, AuthorBookStats>;
  now?: number;
  sortBy?: 'ratings' | 'newestYear';
}

// Bucket a book year for newestYear sorting: future-dated years (> now) are
// treated as one equal bucket (highest priority), then now, then now-1, ... So
// authors with an upcoming (2027+) book are scraped first and equally, then
// authors whose newest book is 2026, then 2025, etc. — running newest-first
// back through the recency window.
export function newestYearSortKey(year: number, now: number): number {
  return year > now ? now + 1 : year;
}

// Select authors who have at least one book published within the recent window
// (their newest qualifying book ≥ currentYear - years). Default sort: most
// overall author-page ratings to least, tie-broken by newer qualifying book,
// then name. With sortBy 'newestYear', sort by the author's newest qualifying
// book year, newest/upcoming first (future years share one bucket, then current
// year, then back), tie-broken by the highest-rated book (books-table ratings —
// populated even for freshly-minted authors whose author-page numRatings is 0),
// then name. Authors with no author-page stats yet (numRatings 0) still qualify
// if they own a recent book.
export function selectRecentAuthors(
  authorCache: Record<string, AuthorCacheEntry>,
  opts: RecentSelectionOptions,
): SelectedAuthor[] {
  const sortBy = opts.sortBy ?? 'ratings';
  const now = opts.now ?? new Date().getFullYear();
  return Object.entries(authorCache)
    .map(([name, entry]) => ({ name, entry, value: parseNum(entry.numRatings) }))
    .filter(({ entry }) => {
      const stats = opts.bookStats[entry.id];
      return stats !== undefined && stats.books > 0;
    })
    .sort((a, b) => {
      if (sortBy === 'newestYear') {
        const aYear = newestYearSortKey(opts.bookStats[a.entry.id]?.newestYear ?? 0, now);
        const bYear = newestYearSortKey(opts.bookStats[b.entry.id]?.newestYear ?? 0, now);
        const byYear = bYear - aYear;
        if (byYear !== 0) return byYear;
        // Same recency bucket: highest-rated book wins (books table is the
        // signal that's populated for untouched authors), then name.
        const byTop =
          (opts.bookStats[b.entry.id]?.topRatings ?? 0) - (opts.bookStats[a.entry.id]?.topRatings ?? 0);
        if (byTop !== 0) return byTop;
        return a.name.localeCompare(b.name);
      }
      const byRatings = b.value - a.value;
      if (byRatings !== 0) return byRatings;
      // Same overall ratings: prefer the author with the newer qualifying book,
      // then tie-break lexically.
      const byNewest =
        (opts.bookStats[b.entry.id]?.newestYear ?? 0) - (opts.bookStats[a.entry.id]?.newestYear ?? 0);
      if (byNewest !== 0) return byNewest;
      return a.name.localeCompare(b.name);
    })
    .slice(0, opts.limit);
}

export async function runAuthorRecent(options: AuthorRecentOptions = {}): Promise<void> {
  const authorCache = await loadAuthorCache();

  const years = options.years !== undefined ? parseNum(options.years) : 10;
  const now = new Date().getFullYear();
  const minYear = now - years;
  const limit = options.limit ? parseNum(options.limit) : 100;
  const minAgeDays = options.minAge !== undefined ? parseNum(options.minAge) : 14;
  const sortBy = options.sortBy === 'newestYear' ? 'newestYear' : 'ratings';

  const bookStats = loadAuthorBookStats(minYear, 0);
  const authors = selectRecentAuthors(authorCache, { limit, bookStats, now, sortBy });

  const orderNote = sortBy === 'newestYear'
    ? `sorted newest qualifying book first (future years equal, then ${now}, then back)`
    : 'sorted by overall author-page ratings (most first)';
  console.log(chalk.cyan.bold(`\n🔎 Author Recent: rescraping authors with a book published ${minYear}+ (within ${years} years), first page only, sorted by original_publication_year`));
  console.log(chalk.gray(`   ${authors.length} candidates (top ${limit}) · books-table recency gate: newest qualifying book ≥ ${minYear} · ${orderNote}`));
  console.log(chalk.gray(`   Min Age: ${minAgeDays > 0 ? `${minAgeDays} day(s)` : 'none (scrape everything)'}`));
  console.log('');

  if (authors.length === 0) {
    console.log(chalk.yellow('   No authors have a book from the recent window.'));
    return;
  }

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
  if (minAgeSkipped > 0) console.log(chalk.gray(`   Skipping ${minAgeSkipped} authors updated within the last ${minAgeDays} day(s).`));
  if (failSkipped > 0) console.log(chalk.gray(`   Skipping ${failSkipped} authors with ≥${AUTHOR_FAIL_LIMIT} consecutive failures.`));
  console.log('');

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
      const statsEntry = bookStats[snapshotEntry.id];
      const bookSuffix = statsEntry
        ? ` newest=${statsEntry.newestYear} top-bk-ratings=${statsEntry.topRatings.toLocaleString('en-US')} books=${statsEntry.books}`
        : '';
      const failCount = snapshotEntry.failCount ?? 0;
      const failSuffix = failCount > 0 ? ` failCount=${failCount}` : '';
      console.log(chalk.white.bold(`[${i + 1}/${toScrape.length}] Author: ${name} (${snapshotEntry.slug}) numRatings=${value.toLocaleString('en-US')}${bookSuffix}${failSuffix}`));
      let failReason = 'no_stats_line';
      const result = await withConnectivityProbe(
        () => scrapeAuthorStats(snapshotEntry.slug, (r) => { failReason = r; }, false, 'original_publication_year', !!options.withCookie),
        { label: `author recent "${name}"` }
      );
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

        const recent = (result.books ?? [])
          .map(b => ({ title: b.title, year: parseYear(b.published) }))
          .filter((b): b is { title: string; year: number } => b.year !== null && b.year >= minYear)
          .sort((a, b) => b.year - a.year);
        if (recent.length > 0) {
          console.log(chalk.green(`   🔥 Recent books (${minYear}+):`));
          for (const b of recent) {
            console.log(`      ${chalk.cyan(b.title)} (${b.year})`);
          }
        } else {
          console.log(chalk.gray(`   (No books from ${minYear}+ on first page)`));
        }

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
          entry.lastSeen = new Date().toISOString();
          upsertAuthor(name, entry);
          console.log(chalk.gray(`   (No change - values already current or not greater; refreshed last_seen)`));
        }
      }
    } catch (error) {
      if (isConnectivityError(error)) {
        console.error(chalk.red.bold(`\n🛑 Aborting author recent: network error (${(error as any).code} — ${(error as any).message}).`));
        console.error(chalk.red.bold(`   Progress is saved to the DB; re-run when your connection is back.`));
        const duration = ((Date.now() - start) / 1000).toFixed(1);
        console.log(chalk.cyan.bold(`\n🏁 Aborted. Processed ${i} of ${toScrape.length} authors, updated ${updated} (${noStats} no stats line, ${failed} failures, ${minAgeSkipped} skipped by --minAge, ${duration}s).`));
        return;
      }
      failed++;
      console.error(chalk.red.bold(`   ❌ Failed for ${name}: ${(error as any).message}`));
    }
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