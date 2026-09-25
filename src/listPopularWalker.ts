import chalk from 'chalk';
import { scrapePopularListsPage, scrapeListBooks, TagListEntry } from './scraper.js';
import { countAuthors, loadListScrape, syncBooksToCache, upsertListScrape, type BookCache } from './storage.js';
import { delay, isConnectivityError } from './utils.js';
import { shouldSkipList } from './listTagWalker.js';

export interface ListPopularWalkerOptions {
  startPage?: number;
  endPage?: number;
  listMaxPages?: number;
  skipDays?: number;
  dryRun?: boolean;
}

interface ListWalkResult {
  list: TagListEntry;
  elapsedMs: number;
  bookCount: number;
  booksAdded: number;
  authorsAdded: number;
}

const listLabel = (l: TagListEntry): string => {
  const readable = l.slug.replace(/[_\-.]+/g, ' ').trim();
  return readable || l.url.replace(/^.*\/show\//, '') || l.id;
};

const fmtAge = (lastScraped: string): string => {
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(lastScraped)) / 86400000));
  return days < 1 ? 'today' : `${days}d ago`;
};

const fmt = (ms: number): string => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

// Only a crawl that went all the way to the end counts as "fully scraped" for
// the reuse window; an explicit --list-max-pages cap means the list was only
// partially read. Pure + unit-testable.
export function shouldMarkScraped(bookCount: number, listMaxPages: number | undefined, skipDays: number): boolean {
  return skipDays > 0 && listMaxPages === undefined && bookCount > 0;
}

export async function runListPopularWalker(options: ListPopularWalkerOptions): Promise<ListWalkResult[]> {
  const startPage = options.startPage ?? 1;
  const endPage = options.endPage ?? Infinity;
  const dryRun = !!options.dryRun;
  const skipDays = options.skipDays ?? 7;

  console.log(chalk.cyan.bold(`\n🗂️  Listopia popular-lists directory walk (list/popular_lists)`));
  console.log(chalk.gray(`   Directory pages ${startPage}${endPage === Infinity ? ' → end' : `-${endPage}`} · skip lists scraped < ${skipDays}d ago${skipDays <= 0 ? ' (skip disabled)' : ''}${dryRun ? ' · (DRY RUN — enumerate only)' : ''}`));

  const bookCache: BookCache = {};
  const results: ListWalkResult[] = [];
  const seenIds = new Set<string>();
  const runStart = Date.now();
  let skipped = 0;
  let scrolled = 0;

  let page = startPage;
  while (page <= endPage) {
    let parsed;
    try {
      parsed = await scrapePopularListsPage(page);
    } catch (error) {
      if (isConnectivityError(error)) throw error;
      console.error(chalk.red.bold(`   ❌ Failed to enumerate popular-lists directory page ${page}:`), (error as any).message);
      break;
    }

    const lists = parsed.lists;
    if (lists.length === 0) {
      console.log(chalk.yellow(`\n   Nothing on directory page ${page} — stopping. Does the directory exist? Try https://www.goodreads.com/list/popular_lists`));
      break;
    }

    if (dryRun) {
      let shown = 0;
      let wouldSkip = 0;
      for (const l of lists) {
        if (seenIds.has(l.id)) continue;
        seenIds.add(l.id);
        shown++;
        const previous = loadListScrape(l.id);
        const skipping = !!previous && shouldSkipList(previous.lastScraped, new Date().toISOString(), skipDays);
        if (skipping) wouldSkip++;
        console.log(chalk.gray(`   ${shown}. ${l.id} · ${listLabel(l)}${skipping ? ` — skipped, last scraped ${fmtAge(previous.lastScraped)}` : ''}`));
      }
      console.log(chalk.yellow(`\n   Dry run — ${shown} new lists on directory page ${page}: ${wouldSkip} would be skipped (scraped recently) · ${shown - wouldSkip} would be crawled.`));
      if (parsed.nextPage === null) break;
      page = parsed.nextPage;
      await delay(1000, 2500);
      continue;
    }

    for (let i = 0; i < lists.length; i++) {
      const l = lists[i];
      const label = listLabel(l);

      if (seenIds.has(l.id)) {
        skipped++;
        console.log(chalk.gray(`   ⏭  [${i + 1}/${lists.length}] ${label} (${l.id}) — already seen on an earlier directory page`));
        continue;
      }
      seenIds.add(l.id);

      // Skip lists fully scraped within the reuse window.
      const previous = loadListScrape(l.id);
      if (previous && shouldSkipList(previous.lastScraped, new Date().toISOString(), skipDays)) {
        skipped++;
        console.log(chalk.gray(`   ⏭  [${i + 1}/${lists.length}] ${label} (${l.id}) — skipped, last scraped ${fmtAge(previous.lastScraped)}`));
        continue;
      }

      const authorsBefore = countAuthors();
      const listStart = Date.now();
      console.log(chalk.gray(`\n   📖 [${i + 1}/${lists.length}] ${chalk.white.bold(label)} (${l.id}) — crawling...`));
      let books;
      try {
        books = await scrapeListBooks(l.id, options.listMaxPages ?? Infinity);
      } catch (error: any) {
        if (isConnectivityError(error)) throw error;
        console.error(chalk.red.bold(`   ❌ List ${l.id} failed: ${error?.message}`));
        skipped++;
        continue;
      }
      const elapsedMs = Date.now() - listStart;

      const outcome = await syncBooksToCache(books, bookCache);
      const authorsAdded = countAuthors() - authorsBefore;

      if (shouldMarkScraped(books.length, options.listMaxPages, skipDays)) {
        upsertListScrape(l.id, label);
        scrolled++;
      }

      results.push({
        list: l,
        elapsedMs,
        bookCount: books.length,
        booksAdded: outcome.inserted,
        authorsAdded,
      });

      const r = results[results.length - 1];
      console.log(chalk.gray(`      ⏱  ${fmt(r.elapsedMs)} · ${r.bookCount} books on list · +${r.booksAdded} books · +${r.authorsAdded} authors`));

      if (i < lists.length - 1) {
        await delay(1000, 3000);
      }
    }

    if (parsed.nextPage === null) break;
    page = parsed.nextPage;
    await delay(1200, 3000);
  }

  const totalMs = Date.now() - runStart;
  const totalBooks = results.reduce((n, r) => n + r.bookCount, 0);
  const totalAddedBooks = results.reduce((n, r) => n + r.booksAdded, 0);
  const totalAddedAuthors = results.reduce((n, r) => n + r.authorsAdded, 0);

  console.log(chalk.cyan.bold(`\n🏁 Popular-lists directory walk complete`));
  console.log(chalk.gray(`   ${results.length} lists processed · ${skipped} skipped (recently scraped, already-seen, or failed) · ${scrolled} newly marked fully-scraped · ${fmt(totalMs)} · ${totalBooks} books read · +${totalAddedBooks} books · +${totalAddedAuthors} authors`));
  return results;
}