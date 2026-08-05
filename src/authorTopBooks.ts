import chalk from 'chalk';
import { loadBookCache, loadAuthorCache, saveAuthorCache, updateAuthorStats } from './storage.js';
import { scrapeAuthorStats } from './scraper.js';
import { delay } from './utils.js';

export interface AuthorTopBooksOptions {
  minRatings?: string;
  maxRatings?: string;
}

const parseRatingsNum = (s?: string): number => parseInt((s || '0').replace(/,/g, ''), 10) || 0;

export async function runAuthorTopBooks(n: number, options: AuthorTopBooksOptions = {}): Promise<void> {
  const minRatings = options.minRatings !== undefined ? parseRatingsNum(options.minRatings) : 0;
  const maxRatings = options.maxRatings !== undefined ? parseRatingsNum(options.maxRatings) : Infinity;

  console.log(chalk.cyan.bold(`\n👤 Author Stats: capturing stats for the authors of the top ${n} books by ratings`));
  console.log(chalk.gray(`   Ratings filter: ${minRatings.toLocaleString()} - ${maxRatings === Infinity ? '∞' : maxRatings.toLocaleString()}`));

  console.log(chalk.gray('   Loading book cache...'));
  const bookCache = await loadBookCache();
  console.log(chalk.gray(`   Loading author cache...`));
  const authorCache = await loadAuthorCache();

  console.log(chalk.gray(`   Loaded ${Object.keys(bookCache).length.toLocaleString()} books, ${Object.keys(authorCache).length.toLocaleString()} authors. Filtering and sorting...`));

  // 1. Books from the book cache, filtered by ratings range (same semantics as the histograms)
  const candidates = Object.values(bookCache)
    .filter(b => {
      const r = parseRatingsNum(b.ratings);
      return r >= minRatings && r <= maxRatings;
    })
    .sort((a, b) => parseRatingsNum(b.ratings) - parseRatingsNum(a.ratings));

  const topBooks = candidates.slice(0, n);

  console.log(chalk.gray(`   Books in range: ${candidates.length.toLocaleString()}\n`));

  if (topBooks.length === 0) {
    console.log(chalk.yellow('   No books match the ratings filter.'));
    return;
  }

  // 2. Distinct authors from those books (scrape each author only once per run)
  const authors: { name: string; slug: string }[] = [];
  const seenSlugs = new Set<string>();
  for (const book of topBooks) {
    const entry = authorCache[book.author];
    const slug = entry?.slug;
    if (!slug || seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    authors.push({ name: book.author, slug });
  }

  console.log(chalk.gray(`   Top ${topBooks.length} books → ${authors.length} distinct authors to scrape.\n`));

  let failed = 0;
  let updated = 0;
  const start = Date.now();

  for (let i = 0; i < authors.length; i++) {
    const author = authors[i];
    try {
      console.log(chalk.white.bold(`[${i + 1}/${authors.length}] Author: ${author.name} (${author.slug})`));
      const stats = await scrapeAuthorStats(author.slug);
      if (!stats) {
        console.log(chalk.yellow(`   ⚠️ No stats line found for ${author.name}`));
        continue;
      }
      const entry = authorCache[author.name] ||
        Object.values(authorCache).find(e => e.slug === author.slug);
      if (entry) {
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
      }
    } catch (error) {
      failed++;
      console.error(chalk.red.bold(`   ❌ Failed for ${author.name}: ${(error as any).message}`));
    }
    await delay(2000, 5000);
  }

  await saveAuthorCache(authorCache);

  const duration = ((Date.now() - start) / 1000).toFixed(1);
  console.log(chalk.cyan.bold(`\n🏁 Done. Processed ${authors.length} authors, updated ${updated} (${failed} failures, ${duration}s).`));
}
