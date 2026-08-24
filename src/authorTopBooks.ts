import chalk from 'chalk';
import { loadBookCache, loadAuthorCache, getAuthor, findAuthorBySlug, upsertAuthor, updateAuthorStats, countBooks, recordAuthorFailure, AUTHOR_FAIL_LIMIT } from './storage.js';
import { scrapeAuthorStats } from './scraper.js';
import { delay } from './utils.js';

export interface AuthorTopBooksOptions {
  minRatings?: string;
  maxRatings?: string;
  skip?: boolean;
  minAge?: string;
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

  console.log(chalk.gray(`   Top ${topBooks.length} books → ${authors.length} distinct authors.`));

  // 3. Optionally skip authors that already have captured stats (--skip)
  //    or whose stats were refreshed recently (--minAge <days>)
  const minAgeDays = options.minAge !== undefined ? parseInt(options.minAge, 10) : 0;
  if (isNaN(minAgeDays) || minAgeDays < 0) {
    console.error(chalk.red.bold('Error: --minAge must be a non-negative number of days.'));
    process.exit(1);
  }
  const cutoff = minAgeDays > 0 ? Date.now() - minAgeDays * 24 * 60 * 60 * 1000 : 0;
  let toScrape = authors;
  {
    let skipped = 0;
    let freshSkipped = 0;
    let failSkipped = 0;
    toScrape = authors.filter(a => {
      const entry = authorCache[a.name] || Object.values(authorCache).find(e => e.slug === a.slug);
      if (!entry || entry.numRatings === undefined) return true;
      if ((entry.failCount ?? 0) >= AUTHOR_FAIL_LIMIT) {
        failSkipped++;
        return false;
      }
      if (options.skip) {
        skipped++;
        return false;
      }
      if (cutoff > 0 && entry.lastSeen && new Date(entry.lastSeen).getTime() >= cutoff) {
        freshSkipped++;
        return false;
      }
      return true;
    });
    if (skipped > 0) console.log(chalk.gray(`   Skipping ${skipped} authors already in the cache (--skip).\n`));
    if (freshSkipped > 0) console.log(chalk.gray(`   Skipping ${freshSkipped} authors updated within the last ${minAgeDays} day(s) (--minAge).\n`));
    if (failSkipped > 0) console.log(chalk.gray(`   Skipping ${failSkipped} authors with ≥${AUTHOR_FAIL_LIMIT} consecutive failures.\n`));
  }

  console.log(chalk.gray(`   ${toScrape.length} authors to scrape.\n`));

  let failed = 0;
  let updated = 0;
  let totalInserted = 0;
  let totalEnriched = 0;
  const booksAtStart = countBooks();
  const start = Date.now();

  for (let i = 0; i < toScrape.length; i++) {
    const author = toScrape[i];
    try {
      console.log(chalk.white.bold(`[${i + 1}/${toScrape.length}] Author: ${author.name} (${author.slug})`));
      let failReason = 'no_stats_line';
      const result = await scrapeAuthorStats(author.slug, (r) => { failReason = r; });
      if (!result) {
        failed++;
        console.log(chalk.yellow(`   ⚠️ No stats line found for ${author.name}`));
        recordAuthorFailure(author.name, failReason);
        continue;
      }
      const stats = result.stats;
      totalInserted += result.booksInserted;
      totalEnriched += result.booksEnriched;
      // Resolve the DB row key from the snapshot, then re-read fresh so we
      // merge against current values (another process may have updated it).
      const snapKey = authorCache[author.name]
        ? author.name
        : Object.keys(authorCache).find(k => authorCache[k].slug === author.slug);
      let key = snapKey;
      let entry = key ? getAuthor(key) : undefined;
      if (!entry) {
        const found = findAuthorBySlug(author.slug);
        if (found) {
          key = found.key;
          entry = found.entry;
        }
      }
      if (key && entry) {
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
          upsertAuthor(key, entry);
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

  const duration = ((Date.now() - start) / 1000).toFixed(1);
  const booksAtEnd = countBooks();
  console.log(chalk.cyan.bold(`\n🏁 Done. Processed ${toScrape.length} authors, updated ${updated} (${failed} failures, ${duration}s).`));
  console.log(chalk.cyan.bold(`📚 Books harvested: +${totalInserted.toLocaleString()} new · ${totalEnriched.toLocaleString()} enriched · cache ${booksAtStart.toLocaleString()} → ${booksAtEnd.toLocaleString()}`));
}
