import chalk from 'chalk';
import { loadAuthorCache, getAuthor, upsertAuthor, updateAuthorStats, countBooks, recordAuthorFailure, AUTHOR_FAIL_LIMIT } from './storage.js';
import { selectAuthors } from './authorTopStats.js';
import type { AuthorTopStatsOptions, SelectedAuthor } from './authorTopStats.js';
import { scrapeAuthorStats } from './scraper.js';
import { delay } from './utils.js';

export interface AuthorRescanOptions extends AuthorTopStatsOptions {
  minAge?: string;
  rescanMissing?: boolean;
  multiPage?: boolean;
  sort?: string;
  minYear?: string;
}

const parseNum = (s?: string): number => parseInt((s || '0').replace(/,/g, ''), 10) || 0;

const parseYear = (published?: string): number | null => {
  if (!published) return null;
  const y = parseInt(published.replace(/[^\d]/g, '').slice(0, 4), 10);
  return Number.isFinite(y) && y > 0 ? y : null;
};

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

  if (options.rescanMissing) {
    // Select all authors missing stats, then apply minAge
    authors = Object.entries(authorCache)
      .filter(([, entry]) => !entry.numRatings && !entry.averageRating && !entry.numReviews && !entry.numShelves)
      .map(([name, entry]) => ({ name, entry, value: 0 }));
    console.log(chalk.cyan.bold(`\n👤 Author Rescan: scanning authors with no stats (limit ${limit})`));
  } else if (options.multiPage) {
    // Select authors with null or ≥2 catalog pages (skip single-page catalogs),
    // then apply the same --sortBy / --minRatings / --maxRatings filters.
    const sortBy = (options.sortBy || 'numRatings') as string;
    const minRatings = options.minRatings !== undefined ? parseNum(options.minRatings) : 0;
    const maxRatings = options.maxRatings !== undefined ? parseNum(options.maxRatings) : Infinity;
    authors = Object.entries(authorCache)
      .filter(([, entry]) => (!entry.catalogPages || entry.catalogPages >= 2) && parseNum(entry.numRatings) >= minRatings && parseNum(entry.numRatings) <= maxRatings)
      .map(([name, entry]) => ({ name, entry, value: sortBy === 'averageRating' ? parseFloat(entry.averageRating || '0') : parseNum((entry as any)[sortBy]) }))
      .sort((a, b) => b.value - a.value || parseNum(b.entry.numRatings) - parseNum(a.entry.numRatings) || a.name.localeCompare(b.name))
      .slice(0, limit);
    console.log(chalk.cyan.bold(`\n👤 Author Rescan: re-scraping multi-page authors (Top ${limit} by ${sortBy}, ≥${minRatings.toLocaleString()} ratings)`));
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
    const { name, entry: snapshotEntry } = toScrape[i];
    try {
      console.log(chalk.white.bold(`[${i + 1}/${toScrape.length}] Author: ${name} (${snapshotEntry.slug})`));
      let failReason = 'no_stats_line';
      const result = await scrapeAuthorStats(snapshotEntry.slug, (r) => { failReason = r; }, crawlAllPages, listSort);
      if (!result) {
        noStats++;
        console.log(chalk.yellow(`   ⚠️ No stats line found for ${name}`));
        recordAuthorFailure(name, failReason);
        continue;
      }
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
    } catch (error) {
      failed++;
      console.error(chalk.red.bold(`   ❌ Failed for ${name}: ${(error as any).message}`));
    }
    await delay(2000, 5000);
  }

  const duration = ((Date.now() - start) / 1000).toFixed(1);
  const booksAtEnd = countBooks();
  console.log(chalk.cyan.bold(`\n🏁 Done. Processed ${toScrape.length} authors, updated ${updated} (${noStats} no stats line, ${failed} failures, ${minAgeSkipped} skipped by --minAge, ${duration}s).`));
  console.log(chalk.cyan.bold(`📚 Books harvested: +${totalInserted.toLocaleString()} new · ${totalEnriched.toLocaleString()} enriched · cache ${booksAtStart.toLocaleString()} → ${booksAtEnd.toLocaleString()}`));
}
