import chalk from 'chalk';
import { loadAuthorCache, saveAuthorCache, updateAuthorStats } from './storage.js';
import { selectAuthors } from './authorTopStats.js';
import type { AuthorTopStatsOptions, SelectedAuthor } from './authorTopStats.js';
import { scrapeAuthorStats } from './scraper.js';
import { delay } from './utils.js';

export interface AuthorRescanOptions extends AuthorTopStatsOptions {
  minAge?: string;
}

const parseNum = (s?: string): number => parseInt((s || '0').replace(/,/g, ''), 10) || 0;

export async function runAuthorRescan(options: AuthorRescanOptions = {}): Promise<void> {
  const authorCache = await loadAuthorCache();

  const sortBy = (options.sortBy || 'numRatings') as string;
  const limit = options.limit ? parseInt(options.limit, 10) : 100;
  const minAgeDays = options.minAge !== undefined ? parseNum(options.minAge) : 0;

  const { authors, missingField } = selectAuthors(authorCache, options);

  console.log(chalk.cyan.bold(`\n👤 Author Rescan: re-scraping stats for ${authors.length} authors (Top ${limit} by ${sortBy})`));
  console.log(chalk.gray(`   Min Age: ${minAgeDays > 0 ? `${minAgeDays} day(s)` : 'none (scrape everything)'}${missingField > 0 ? `, Excluded (no ${sortBy}): ${missingField.toLocaleString()}` : ''}\n`));

  if (authors.length === 0) {
    console.log(chalk.yellow('   No authors match the criteria.'));
    return;
  }

  // Filter out authors updated within minAge days
  const cutoff = minAgeDays > 0 ? Date.now() - minAgeDays * 24 * 60 * 60 * 1000 : 0;
  const toScrape: SelectedAuthor[] = [];
  let minAgeSkipped = 0;
  for (const a of authors) {
    if (a.entry.lastSeen && cutoff > 0 && new Date(a.entry.lastSeen).getTime() >= cutoff) {
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
    const { name, entry } = toScrape[i];
    try {
      console.log(chalk.white.bold(`[${i + 1}/${toScrape.length}] Author: ${name} (${entry.slug})`));
      const stats = await scrapeAuthorStats(entry.slug);
      if (!stats) {
        noStats++;
        console.log(chalk.yellow(`   ⚠️ No stats line found for ${name}`));
        continue;
      }
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
        console.log(chalk.green.bold(`   ✅ Author cache updated`));
      } else {
        console.log(chalk.gray(`   (No change - values already current or not greater)`));
      }
      await saveAuthorCache(authorCache);
    } catch (error) {
      failed++;
      console.error(chalk.red.bold(`   ❌ Failed for ${name}: ${(error as any).message}`));
    }
    await delay(2000, 5000);
  }

  const duration = ((Date.now() - start) / 1000).toFixed(1);
  console.log(chalk.cyan.bold(`\n🏁 Done. Processed ${toScrape.length} authors, updated ${updated} (${noStats} no stats line, ${failed} failures, ${minAgeSkipped} skipped by --minAge, ${duration}s).`));
}
