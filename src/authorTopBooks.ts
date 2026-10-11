import chalk from 'chalk';
import { iterateBooks, getAuthor, getAuthorById, upsertAuthorById, upsertAuthorSlug, updateAuthorStats, countBooks, countAuthors, recordAuthorScrapeFailure, clearAuthorScrapeFailure, AUTHOR_FAIL_LIMIT  , isRetiredAuthor } from './storage.ts';
import type { CachedBook } from './storage.ts';
import { scrapeAuthorStats, authorScrapeRef, describeAuthorId } from './scraper.ts';
import { delay, isConnectivityError, parseDelayRange, withConnectivityProbe } from './utils.ts';

export interface AuthorTopBooksOptions {
  minRatings?: string;
  maxRatings?: string;
  skip?: boolean;
  minAge?: string;
  withCookie?: boolean;
}

const parseRatingsNum = (s?: string): number => parseInt((s || '0').replace(/,/g, ''), 10) || 0;

export async function runAuthorTopBooks(n: number, options: AuthorTopBooksOptions = {}): Promise<void> {
  const minRatings = options.minRatings !== undefined ? parseRatingsNum(options.minRatings) : 0;
  const maxRatings = options.maxRatings !== undefined ? parseRatingsNum(options.maxRatings) : Infinity;

  console.log(chalk.cyan.bold(`\n👤 Author Stats: capturing stats for the authors of the top ${n} books by ratings`));
  console.log(chalk.gray(`   Ratings filter: ${minRatings.toLocaleString()} - ${maxRatings === Infinity ? '∞' : maxRatings.toLocaleString()}`));

  console.log(chalk.gray(`   ${countBooks().toLocaleString()} books, ${countAuthors().toLocaleString()} authors in cache. Filtering and sorting...`));

  // 1. Stream the book table, keeping only the top `n` books by ratings (same
  //    range semantics as the histograms).
  const topBooks: CachedBook[] = [];
  let totalInRange = 0;
  for (const book of iterateBooks()) {
    const r = parseRatingsNum(book.ratings);
    if (r < minRatings || r > maxRatings) continue;
    totalInRange++;
    if (topBooks.length < n) {
      topBooks.push(book);
      topBooks.sort((a, b) => parseRatingsNum(b.ratings) - parseRatingsNum(a.ratings));
    } else if (r > parseRatingsNum(topBooks[topBooks.length - 1].ratings)) {
      topBooks[topBooks.length - 1] = book;
      topBooks.sort((a, b) => parseRatingsNum(b.ratings) - parseRatingsNum(a.ratings));
    }
  }

  console.log(chalk.gray(`   Books in range: ${totalInRange.toLocaleString()}\n`));

  if (topBooks.length === 0) {
    console.log(chalk.yellow('   No books match the ratings filter.'));
    return;
  }

  // 2. Distinct authors from those books (scrape each author only once per run).
  //    Only the top-n books' authors are ever resolved — a handful of indexed
  //    row lookups, so there's no full ~960k-row load here.
  const authors: { id: string; name: string; slug: string }[] = [];
  const seenIds = new Set<string>();
  for (const book of topBooks) {
    const entry = (book.authorId ? getAuthorById(String(book.authorId)) : undefined)
      ?? (book.author ? getAuthor(book.author) : undefined);
    const slug = entry?.slug;
    if (!slug || !entry?.id) continue;
    const id = String(entry.id);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    authors.push({ id, name: entry.name ?? book.author, slug });
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
      const entry = getAuthorById(a.id);
      if (!entry || entry.numRatings === undefined) return true;
      if (isRetiredAuthor(a.id)) {
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
    // Anonymous crawls (no cookie) run at a faster but still polite cadence;
    // GR_AUTHOR_DELAY_MS overrides either profile ("min,max"). Declared out here
    // because every exit from this loop has to wait — retiring a page or failing
    // to parse one still cost a Goodreads request.
    const [authorDelayMin, authorDelayMax] = parseDelayRange(
      process.env.GR_AUTHOR_DELAY_MS,
      options.withCookie ? 2000 : 1000,
      options.withCookie ? 5000 : 1800
    );
    try {
      console.log(chalk.white.bold(`[${i + 1}/${toScrape.length}] Author: ${author.name} (${author.slug || '(mint, no slug yet)'})`));
      let failReason = 'no_stats_line';
      const result = await withConnectivityProbe(
        // Fall back to the id when the row is a mint with no slug yet, or
        // buildAuthorListUrl would fetch `/author/list/null` and burn strikes.
        () => scrapeAuthorStats(authorScrapeRef(author.slug, author.id), (r) => { failReason = r; }, false, undefined, !!options.withCookie),
        { label: `author top-books scan "${author.name}"` }
      );
      if (!result) {
        failed++;
        console.log(chalk.yellow(`   ⚠️ No stats line found for ${describeAuthorId(author.id, author.name)}`));
        recordAuthorScrapeFailure(author.id, failReason);
        await delay(authorDelayMin, authorDelayMax);
        continue;
      }
      const stats = result.stats;
      totalInserted += result.booksInserted;
      totalEnriched += result.booksEnriched;
      // Re-read fresh so we merge against current values (another process may
      // have updated this row since the snapshot was taken). Mint if the id
      // isn't cached yet (e.g. books written after the cache snapshot).
      const entry = getAuthorById(author.id) ?? {
        id: author.id,
        name: author.name,
        slug: author.slug,
        lastSeen: new Date().toISOString(),
      };
      const prevCatalogPages = entry.catalogPages;
      if (result.catalogPages) entry.catalogPages = result.catalogPages;
      clearAuthorScrapeFailure(author.id);
      // Every successful scrape = "seen recently", so --minAge gates in the
      // other scrapers can skip this author for the cooldown window.
      entry.lastSeen = new Date().toISOString();
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
        `Avg ${fmt(stats.averageRating, prev.averageRating)}` +
        ` ${chalk.gray(`· slug ${entry.slug ?? '(none)'}`)}`
      );
      // Persist the page's canonical name/slug; ids can outlive their slugs.
      if (stats.name) entry.name = stats.name;
      if (stats.slug) entry.slug = stats.slug;
      upsertAuthorById(author.id, entry);
      upsertAuthorSlug(author.id, entry.slug, entry.name);
      if (changed) {
        updated++;
        console.log(chalk.green.bold(`   ✅ Author cache updated`));
      } else {
        console.log(chalk.gray(`   (No change - values already current or not greater)`));
      }
    } catch (error) {
      // Network went down mid-run — aborts cleanly instead of black-marking
      // every remaining author with a failure strike (the authors aren't at
      // fault, the outage is). Progress is saved per-author, so a re-run
      // resumes where this run stopped.
      if (isConnectivityError(error)) {
        console.error(chalk.red.bold(`\n🛑 Aborting author top-books scan: network error (${(error as any).code} — ${(error as any).message}).`));
        console.error(chalk.red.bold(`   Progress is saved to the DB; re-run when your connection is back.`));
        const duration = ((Date.now() - start) / 1000).toFixed(1);
        console.log(chalk.cyan.bold(`\n🏁 Aborted. Processed ${i} of ${toScrape.length} authors, updated ${updated} (${failed} failures, ${duration}s).`));
        return;
      }
      failed++;
      console.error(chalk.red.bold(`   ❌ Failed for ${author.name}: ${(error as any).message}`));
    }
    await delay(authorDelayMin, authorDelayMax);
  }

  const duration = ((Date.now() - start) / 1000).toFixed(1);
  const booksAtEnd = countBooks();
  console.log(chalk.cyan.bold(`\n🏁 Done. Processed ${toScrape.length} authors, updated ${updated} (${failed} failures, ${duration}s).`));
  console.log(chalk.cyan.bold(`📚 Books harvested: +${totalInserted.toLocaleString()} new · ${totalEnriched.toLocaleString()} enriched · cache ${booksAtStart.toLocaleString()} → ${booksAtEnd.toLocaleString()}`));
}
