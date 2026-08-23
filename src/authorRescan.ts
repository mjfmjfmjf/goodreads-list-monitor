import chalk from 'chalk';
import { loadAuthorCache, getAuthor, upsertAuthor, updateAuthorStats } from './storage.js';
import { selectAuthors } from './authorTopStats.js';
import type { AuthorTopStatsOptions, SelectedAuthor } from './authorTopStats.js';
import { scrapeAuthorStats } from './scraper.js';
import { delay } from './utils.js';

export interface AuthorRescanOptions extends AuthorTopStatsOptions {
  minAge?: string;
  rescanMissing?: boolean;
}

const parseNum = (s?: string): number => parseInt((s || '0').replace(/,/g, ''), 10) || 0;

export async function runAuthorRescan(options: AuthorRescanOptions = {}): Promise<void> {
  const authorCache = await loadAuthorCache();

  const sortBy = (options.sortBy || 'numRatings') as string;
  const limit = options.limit ? parseInt(options.limit, 10) : 100;
  const minAgeDays = options.minAge !== undefined ? parseNum(options.minAge) : 0;

  let authors: SelectedAuthor[];
  let missingField = 0;

  if (options.rescanMissing) {
    // Select all authors missing stats, then apply minAge
    authors = Object.entries(authorCache)
      .filter(([, entry]) => !entry.numRatings && !entry.averageRating && !entry.numReviews && !entry.numShelves)
      .map(([name, entry]) => ({ name, entry, value: 0 }));
    console.log(chalk.cyan.bold(`\n👤 Author Rescan: scanning authors with no stats (limit ${limit})`));
  } else {
    const selected = selectAuthors(authorCache, options);
    authors = selected.authors;
    missingField = selected.missingField;
    console.log(chalk.cyan.bold(`\n👤 Author Rescan: re-scraping stats for ${authors.length} authors (Top ${limit} by ${sortBy})`));
  }
  console.log(chalk.gray(`   Min Age: ${minAgeDays > 0 ? `${minAgeDays} day(s)` : 'none (scrape everything)'}${missingField > 0 ? `, Excluded (no ${sortBy}): ${missingField.toLocaleString()}` : ''}\n`));

  if (authors.length === 0) {
    console.log(chalk.yellow('   No authors match the criteria.'));
    return;
  }

  // Filter out authors updated within minAge days (but always keep authors with no stats)
  const cutoff = minAgeDays > 0 ? Date.now() - minAgeDays * 24 * 60 * 60 * 1000 : 0;
  const toScrape: SelectedAuthor[] = [];
  let minAgeSkipped = 0;
  for (const a of authors) {
    const hasStats = a.entry.numRatings || a.entry.averageRating || a.entry.numReviews || a.entry.numShelves;
    if (hasStats && a.entry.lastSeen && cutoff > 0 && new Date(a.entry.lastSeen).getTime() >= cutoff) {
      minAgeSkipped++;
      continue;
    }
    toScrape.push(a);
  }

  console.log(chalk.gray(`   ${toScrape.length} authors to scrape.`));
  if (minAgeSkipped > 0) console.log(chalk.gray(`   Skipping ${minAgeSkipped} authors updated within the last ${minAgeDays} day(s) (--minAge).\n`));
  else console.log('');

  let failed = 0;
  let updated = 0;
  let noStats = 0;
  const start = Date.now();

  for (let i = 0; i < toScrape.length; i++) {
    const { name, entry: snapshotEntry } = toScrape[i];
    try {
      console.log(chalk.white.bold(`[${i + 1}/${toScrape.length}] Author: ${name} (${snapshotEntry.slug})`));
      const stats = await scrapeAuthorStats(snapshotEntry.slug);
      if (!stats) {
        noStats++;
        console.log(chalk.yellow(`   ⚠️ No stats line found for ${name}`));
        continue;
      }
      // Re-read fresh so we merge against current values (another process
      // may have updated this row since the snapshot was taken).
      const entry = getAuthor(name) ?? snapshotEntry;
      const prev = {
        averageRating: entry.averageRating,
        numRatings: entry.numRatings,
        numReviews: entry.numReviews,
        numShelves: entry.numShelves,
      };
      const changed = updateAuthorStats(entry, stats);
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
        console.log(chalk.gray(`   (No change - values already current or not greater)`));
      }
    } catch (error) {
      failed++;
      console.error(chalk.red.bold(`   ❌ Failed for ${name}: ${(error as any).message}`));
    }
    await delay(2000, 5000);
  }

  const duration = ((Date.now() - start) / 1000).toFixed(1);
  console.log(chalk.cyan.bold(`\n🏁 Done. Processed ${toScrape.length} authors, updated ${updated} (${noStats} no stats line, ${failed} failures, ${minAgeSkipped} skipped by --minAge, ${duration}s).`));
}
