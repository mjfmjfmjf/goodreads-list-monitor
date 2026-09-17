import chalk from 'chalk';
import { scrapeListsByTag, scrapeListBooks, TagListEntry } from './scraper.js';
import { countAuthors, loadListScrape, syncBooksToCache, upsertListScrape, type BookCache } from './storage.js';
import { delay, isConnectivityError } from './utils.js';

export interface ListTagWalkerOptions {
  tag: string;
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

const fmt = (ms: number): string => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

// Skip a list whose last complete scrape is at most skipDays old (a scrape
// exactly skipDays ago still counts as "in the last n days"). skipDays=0 (or
// negative) never skips. Pure + unit-testable.
export function shouldSkipList(lastScraped: string, now: string, skipDays: number): boolean {
  if (skipDays <= 0) return false;
  const ageMs = Date.parse(now) - Date.parse(lastScraped);
  return Number.isFinite(ageMs) && ageMs <= skipDays * 24 * 60 * 60 * 1000;
}

const fmtAge = (lastScraped: string): string => {
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(lastScraped)) / 86400000));
  return days < 1 ? 'today' : `${days}d ago`;
};

export async function runListTagWalker(options: ListTagWalkerOptions): Promise<ListWalkResult[]> {
  const { tag } = options;
  const startPage = options.startPage ?? 1;
  const endPage = options.endPage ?? Infinity;
  const dryRun = !!options.dryRun;

  console.log(chalk.cyan.bold(`\n🗂️  Listopia tag walk: "list/tag/${tag}"`));
  const skipDays = options.skipDays ?? 7;
  console.log(chalk.gray(`   Pages ${startPage}${endPage === Infinity ? ' → end' : `-${endPage}`} · skip lists scraped < ${skipDays}d ago${skipDays <= 0 ? ' (skip disabled)' : ''}${dryRun ? ' (DRY RUN — enumerate only)' : ''}`));

  const lists = await scrapeListsByTag(tag, { startPage, maxPages: endPage });
  console.log(chalk.green.bold(`   Found ${lists.length} unique lists under tag "${tag}".`));
  if (lists.length === 0) {
    console.log(chalk.yellow(`\n   Nothing to walk — does the tag page exist? Try https://www.goodreads.com/list/tag/${tag}`));
    return [];
  }

  if (dryRun) {
    lists.forEach((l, i) => console.log(chalk.gray(`   ${i + 1}. ${l.id} · ${listLabel(l)}`)));
    console.log(chalk.yellow(`\n   Dry run — ${lists.length} lists would be crawled. Pass without --dry-run to harvest.`));
    return [];
  }

  // Don't load the full book cache (5.6M+ rows, several GB in JS memory) — the
  // SQLite row is the merge source of truth inside syncBooksToCache (getBook),
  // so an empty in-run cache is enough; it accumulates only this run's books.
  const bookCache: BookCache = {};
  const results: ListWalkResult[] = [];
  const runStart = Date.now();
  let skipped = 0;
  let scrolled = 0;

  for (let i = 0; i < lists.length; i++) {
    const l = lists[i];
    const label = listLabel(l);

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

    // Only a crawl that went all the way to the end counts as "scraped".
    // An explicit --list-max-pages cap means the list is only partially read.
    if (skipDays > 0 && options.listMaxPages === undefined && books.length > 0) {
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
      await delay(1000, 4000);
    }
  }

  const totalMs = Date.now() - runStart;
  const totalBooks = results.reduce((n, r) => n + r.bookCount, 0);
  const totalAddedBooks = results.reduce((n, r) => n + r.booksAdded, 0);
  const totalAddedAuthors = results.reduce((n, r) => n + r.authorsAdded, 0);

  console.log(chalk.cyan.bold(`\n🏁 List tag walk complete for "${tag}"`));
  console.log(chalk.gray(`   ${results.length} lists processed · ${skipped} skipped (recently scraped or failed) · ${scrolled} newly marked fully-scraped · ${fmt(totalMs)} · ${totalBooks} books read · +${totalAddedBooks} books · +${totalAddedAuthors} authors`));
  return results;
}