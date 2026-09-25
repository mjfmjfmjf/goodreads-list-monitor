import chalk from 'chalk';
import { scrapeShelfBooks, scrapeTopShelves } from './scraper.js';
import { getDb } from './db.js';
import { getBook, getKnownShelfPages, loadAuthorCache, syncAuthorsToCache, syncBooksToCache, upsertBook } from './storage.js';
import { delay, isConnectivityError } from './utils.js';

export interface NewTagWalkerOptions {
  maxListPages?: string;
  startPage?: string;
  shelfPages?: string;
  minTags?: string;
  dryRun?: boolean;
}

// A tag is "scraped" once we've captured its shelf into tag_books — the same
// signal gap-genre-tag-discovery uses. Loaded once per run into a Set.
export function loadScrapedTagSet(): Set<string> {
  const db = getDb();
  const rows = db.prepare('SELECT DISTINCT tag_name FROM tag_books').all() as any[];
  return new Set(rows.map(r => r.tag_name));
}

export function isTagScraped(tag: string, scraped?: Set<string>): boolean {
  return (scraped ?? loadScrapedTagSet()).has(tag);
}

function parseShelfRange(range: string): number {
  const m = range.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) throw new Error(`Invalid shelf pages range: "${range}". Use "N" or "N-M".`);
  return parseInt(m[2] || m[1], 10);
}

// Walk https://www.goodreads.com/shelf page by page. For every tag on the page
// that we HAVEN'T already scraped into tag_books, scrape its shelf in the usual
// way (scrapeShelfBooks persists tag_books membership and the shelf's real page
// count into tag_stats; we then sync the shelf's books into the book cache,
// sync its authors, and stamp tags[tag] = shelving count on the book rows,
// mirroring gap-genre-tag-discovery). Already-scraped tags are skipped, so an
// interrupted walk simply resumes on re-run. Per-tag and per-run lines report
// how many books/authors were newly added, in the 📚 format of the other
// scrapes.
//
// Unlike runTagDiscovery we do NOT reload the whole 4.3M-row book table per
// tag (that is impractically slow when walking hundreds of tags) and we do NOT
// do the per-book metadata detail fetches — this walker is about shelf
// coverage, not first-seen enrichment.
export async function runNewTagWalker(options: NewTagWalkerOptions = {}): Promise<void> {
  const maxListPages = parseInt(options.maxListPages || '1000', 10);
  const startPage = parseInt(options.startPage || '1', 10);
  const minTags = parseInt(options.minTags || '0', 10);
  const shelfPageEnd = options.shelfPages ? parseShelfRange(options.shelfPages) : 25;
  const dryRun = !!options.dryRun;

  if (isNaN(maxListPages) || maxListPages < 1) throw new Error(`Invalid max list pages: ${options.maxListPages}`);
  if (isNaN(startPage) || startPage < 1) throw new Error(`Invalid start page: ${options.startPage}`);

  const scraped = loadScrapedTagSet();
  const globalSeen = new Set<string>();
  let newCount = 0;
  let skipCount = 0;
  let totalBooks = 0;
  let totalBooksNew = 0;
  let totalAuthors = 0;
  let totalStamped = 0;

  // One author cache for the whole run: scrapeShelfBooks skips its internal
  // author sync (skipAuthorSync), so every author we mint here comes through
  // our own syncAuthorsToCache call and can be counted precisely.
  const authorCache = loadAuthorCache();

  console.log(chalk.cyan.bold('\n🔀 Walking top shelves for tags not yet scraped...'));
  console.log(chalk.gray(`   Start page ${startPage}, up to ${maxListPages} page(s), ${shelfPageEnd} shelf page(s) per tag, ${dryRun ? 'dry run (no scraping)' : 'scraping new tags'}.`));
  console.log(chalk.gray(`   Tags already scraped into tag_books: ${formatNum(scraped.size)}.`));

  const lastPage = startPage + maxListPages - 1;
  for (let page = startPage; page <= lastPage; page++) {
    let pageShelves: string[];
    try {
      pageShelves = await scrapeTopShelves(page);
    } catch (err: any) {
      if (isConnectivityError(err)) {
        console.log(chalk.red.bold(`\n🛑 Aborting walker: network error (${err.code} — ${err.message}).`));
        console.log(chalk.red.bold(`   Progress is saved to the DB; re-run when your connection is back.`));
        printSummary(newCount, skipCount, scraped.size, totalBooks, totalBooksNew, totalAuthors, totalStamped);
        return;
      }
      console.error(chalk.red.bold(`   ❌ Error fetching shelf page ${page}:`), err.message);
      break;
    }

    if (pageShelves.length === 0) {
      console.log(chalk.gray(`\n   (Page ${page} returned no shelves — reached the end of the /shelf list${page > startPage ? '' : ' or the page was throttled'}. Stopping.)`));
      break;
    }

    // Tags seen on an earlier page of this run are not re-processed.
    const fresh: string[] = [];
    for (const t of pageShelves) {
      if (!globalSeen.has(t)) {
        globalSeen.add(t);
        fresh.push(t);
      }
    }
    if (fresh.length === 0) {
      console.log(chalk.gray(`   Page ${page}: all tags already seen this run — skipping page.`));
      continue;
    }

    const newTags = fresh.filter(t => !scraped.has(t));
    const already = fresh.filter(t => scraped.has(t));
    skipCount += already.length;

    console.log(chalk.cyan.bold(`\n📄 Shelf page ${page}: ${fresh.length} unique tag(s) (${already.length} already scraped, ${newTags.length} new).`));
    if (already.length > 0) {
      console.log(chalk.gray(`   ⏭  Skipping: ${already.join(', ')}`));
    }

    if (newTags.length === 0) {
      console.log(chalk.green.bold('   ✅ Everything on this page is already scraped.'));
      if (page < lastPage) await delay(500, 1500);
      continue;
    }

    for (const [pos, tag] of newTags.entries()) {
      newCount++;
      console.log(chalk.yellow.bold(`\n   🆕 NEW TAG [${newCount}] (shelf list page ${page} · #${pos + 1} on page): "${tag}"`));
      if (dryRun) {
        const known = getKnownShelfPages(tag);
        console.log(chalk.gray(`      (dry run — would scrape ~${known ?? shelfPageEnd} page(s))`));
        continue;
      }

      // Cap each shelf crawl at what we believe it actually has — mirroring
      // gap-genre-tag-discovery. The live pagination footer overrides downward
      // anyway; never crawl past the requested end page.
      const known = getKnownShelfPages(tag);
      const end = known !== null ? Math.min(shelfPageEnd, known) : shelfPageEnd;
      console.log(chalk.gray(`      Scraping shelf "${tag}" (pages 1-${end})...`));

      try {
        const shelfBooks = await scrapeShelfBooks(tag, minTags, end, 1, { skipAuthorSync: true });

        // Sync the scraped shelf into the book cache and mint its authors,
        // counting what was newly added this tag.
        const bookOutcome = await syncBooksToCache(shelfBooks, {});
        const authorAdded = syncAuthorsToCache(shelfBooks, authorCache);
        totalBooks += shelfBooks.length;
        totalBooksNew += bookOutcome.inserted;
        totalAuthors += authorAdded;

        // Stamp tags[tag] = shelving count on affected books (same effect as
        // tag-discovery step 1b, but via the DB directly — no full-cache load).
        let stamped = 0;
        for (const sb of shelfBooks) {
          const existing = getBook(sb.id);
          if (!existing) continue;
          if (!existing.tags) existing.tags = {};
          if (existing.tags[tag] !== (sb.tagCount || 0)) {
            existing.tags[tag] = sb.tagCount || 0;
            existing.lastUpdated = new Date().toISOString();
            upsertBook(existing);
            stamped++;
          }
        }
        totalStamped += stamped;
        scraped.add(tag);
        console.log(chalk.green.bold(`      ✅ "${tag}": ${shelfBooks.length} books scraped, +${bookOutcome.inserted} new in cache (${bookOutcome.updated} enriched), +${authorAdded} authors, ${stamped} books stamped.`));
      } catch (err: any) {
        if (isConnectivityError(err)) {
          console.log(chalk.red.bold(`\n🛑 Aborting walker: network error (${err.code} — ${err.message}).`));
          console.log(chalk.red.bold(`   Progress is saved to the DB; re-run when your connection is back.`));
          printSummary(newCount, skipCount, scraped.size, totalBooks, totalBooksNew, totalAuthors, totalStamped);
          return;
        }
        console.error(chalk.red.bold(`   ❌ Error scraping tag "${tag}":`), err.message);
      }

      await delay(1000, 3000);
    }

    if (page < lastPage) await delay(500, 1500);
  }

  printSummary(newCount, skipCount, scraped.size, totalBooks, totalBooksNew, totalAuthors, totalStamped);
}

function printSummary(newScraped: number, skipped: number, totalScraped: number, totalBooks: number, totalBooksNew: number, totalAuthors: number, totalStamped: number): void {
  console.log(chalk.cyan.bold(`\n🎉 Walker complete. New tags scraped: ${newScraped}, skipped (already scraped): ${formatNum(skipped)}.`));
  console.log(chalk.green.bold(`   Tags now in tag_books: ${formatNum(totalScraped)}.`));
  console.log(chalk.green.bold(`   Books scraped: ${formatNum(totalBooks)} (+${formatNum(totalBooksNew)} new in cache), authors added: ${formatNum(totalAuthors)}, presence stamped on ${formatNum(totalStamped)}.`));
}

const formatNum = (n: number): string => n.toLocaleString('en-US');