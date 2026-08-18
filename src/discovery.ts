import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { scrapeListBooks, scrapeShelfBooks, scrapeBookDetails, scrapeTopShelves } from './scraper.js';
import { loadState, loadBookCache, saveBookCache, syncBooksToCache } from './storage.js';
import { TagConfig, ListEntry } from './tagConfig.js';
import { getYear, normalizeTitle, normalizeAuthor, formatDate, delay, formatBookLink } from './utils.js';

const AUDIT_REPORT = path.join(process.cwd(), 'auditReport.txt');

interface DiscoveryResult {
  list: ListEntry;
  toAdd: string[];
}

/**
 * Normalization helper for matching
 */
function isSameBook(book1: { id: string, title: string, author: string }, book2: { id: string, title: string, author: string }): boolean {
  if (book1.id === book2.id) return true;
  
  const title1 = normalizeTitle(book1.title);
  const title2 = normalizeTitle(book2.title);
  const auth1 = normalizeAuthor(book1.author);
  const auth2 = normalizeAuthor(book2.author);
  
  return title1 === title2 && auth1 === auth2;
}

async function appendToAuditReport(listTitle: string, message: string): Promise<void> {
  const timestamp = new Date().toLocaleString();
  const entry = `[${timestamp}] [${listTitle}] ${message.trim()}\n`;
  await fs.appendFile(AUDIT_REPORT, entry);
}

export async function runTagDiscovery(tagName: string, globalOptions: { minTags?: string, minAvg?: string, maxAvg?: string, cacheOnly?: boolean, shelfPageStart?: string, shelfPageEnd?: string }): Promise<void> {
  const configPath = path.join(process.cwd(), 'tags', `${tagName}.json`);
  let config: TagConfig | null = null;
  if (await fs.pathExists(configPath)) {
    config = await fs.readJson(configPath);
  } else {
    console.log(chalk.yellow(`\n⚠️ Config file for tag "${tagName}" not found at ${configPath}.`));
    console.log(chalk.yellow(`   Parsing shelf books into book cache without list audits.`));
  }

  const bookCache = await loadBookCache();
  const initialCacheSize = Object.keys(bookCache).length;
  const minTags = parseInt(globalOptions.minTags?.replace(/,/g, '') || '0', 10);
  const globalMinAvg = globalOptions.minAvg ? parseFloat(globalOptions.minAvg) : 0;
  const globalMaxAvg = globalOptions.maxAvg ? parseFloat(globalOptions.maxAvg) : Infinity;

  console.log(chalk.cyan.bold(`\n🔦 Starting Discovery for tag: "${tagName}"`));
  let targetMsg = `   Target: ${config && !globalOptions.cacheOnly ? `${config.lists.length} lists` : 'Book cache sync only'}, Min Tags: ${minTags}`;
  if (globalMinAvg > 0 || globalMaxAvg < Infinity) targetMsg += `, Global Avg: ${globalMinAvg}-${globalMaxAvg}`;
  console.log(chalk.gray(targetMsg));
  console.log(chalk.gray(`   Book cache starting size: ${initialCacheSize.toLocaleString()} books\n`));

  // 1. GLOBAL SHELF SCAN
  const shelfPageStart = parseInt(globalOptions.shelfPageStart || '1', 10);
  const shelfPageEnd = parseInt(globalOptions.shelfPageEnd || '25', 10);
  console.log(chalk.cyan.bold(`🔎 Step 1: Scanning global shelf "${tagName}" (pages ${shelfPageStart}-${shelfPageEnd})...`));
  const rawShelfBooks = await scrapeShelfBooks(tagName, minTags, shelfPageEnd, shelfPageStart);
  await syncBooksToCache(rawShelfBooks, bookCache);
  
  // Smart Deduplication: Treat different editions as the same book
  const shelfBooks: typeof rawShelfBooks = [];
  for (const book of rawShelfBooks) {
    if (!shelfBooks.some(sb => isSameBook(sb, book))) {
      shelfBooks.push(book);
    }
  }
  console.log(chalk.green.bold(`   ✅ Shelf scan complete. Found ${shelfBooks.length} unique books above threshold.\n`));

  // 2. METADATA SYNC (Fill in missing details for books that are still Unknown)
  const booksNeedingMetadata = shelfBooks.filter(sb => bookCache[sb.id]?.published === 'Unknown');
  console.log(chalk.cyan.bold(`🔄 Step 2: Ensuring metadata for ${shelfBooks.length} discovered books...`));
  if (booksNeedingMetadata.length === 0) {
    console.log(chalk.green.bold(`   ✅ All discovered books already have a publication year. Nothing to fetch.`));
  } else {
    console.log(chalk.gray(`   ${booksNeedingMetadata.length} of ${shelfBooks.length} books have an "Unknown" publication year in the cache (the shelf page did not include a year), so each is fetched individually to fill it in.`));
  }

  let syncCount = 0;
  for (let i = 0; i < shelfBooks.length; i++) {
    const sb = shelfBooks[i];
    const shelfPos = i + 1;
    
    // Check if we still need to fetch details (if shelf page didn't have the year)
    const cached = bookCache[sb.id];
    if (cached?.published === 'Unknown') {
      const avgStr = sb.avgRating ? `, Avg: ${sb.avgRating}` : '';
      console.log(chalk.gray(`   [${shelfPos}/${shelfBooks.length}] Fetching details for ${formatBookLink(sb.title, sb.id)} by ${sb.author} (Shelf Pos: ${shelfPos}, Tags: ${sb.tagCount}, Ratings: ${sb.ratings}${avgStr}, Pub: ${sb.published})`));
      const details = await scrapeBookDetails(sb.id, sb.title, sb.author);
      
      if (details.published && details.published !== 'Unknown') {
        cached.published = details.published;
        cached.lastUpdated = new Date().toISOString();
        if (details.title && details.title !== 'Unknown') cached.title = details.title;
        if (details.author && details.author !== 'Unknown') cached.author = details.author;
        
        syncCount++;
        if (syncCount % 10 === 0) await saveBookCache(bookCache);
        await delay(500, 1500);
      }
    }
  }
  await saveBookCache(bookCache);
  console.log(chalk.green.bold(`\n   ✅ Metadata sync complete. Fetched ${syncCount} missing book details.\n`));

  const finalCacheSize = Object.keys(bookCache).length;
  const newBooksCount = finalCacheSize - initialCacheSize;
  const countMsg = ` (${initialCacheSize.toLocaleString()} → ${finalCacheSize.toLocaleString()} books, +${newBooksCount.toLocaleString()} new books added)`;

  if (!config || globalOptions.cacheOnly) {
    if (globalOptions.cacheOnly && config) {
      console.log(chalk.gray(`   ⏩ Skipping list audits for "${tagName}" (cache-only mode enabled).`));
    }
    const completeMsg = `Discovery run complete for tag "${tagName}". Book cache updated${countMsg}.`;
    console.log(chalk.cyan.bold(`✨ ${completeMsg}`));
    if (newBooksCount > 0) {
      await appendToAuditReport('SUMMARY', completeMsg);
    }
    return;
  }

  const finalResults: DiscoveryResult[] = [];

  // 3. ITERATE THROUGH LISTS
  for (let i = 0; i < config.lists.length; i++) {
    const listEntry = config.lists[i];
    console.log(chalk.yellow.bold(`\n--------------------------------------------------`));
    console.log(chalk.yellow.bold(`📋 AUDIT [${i + 1}/${config.lists.length}]: ${listEntry.nickname} - ${listEntry.officialTitle} (ID: ${listEntry.id})`));
    console.log(chalk.yellow.bold(`--------------------------------------------------`));

    const criteria = listEntry.criteria;
    const minVal = criteria.min || 0;
    const maxVal = criteria.max || Infinity;
    const minYear = criteria.minYear || 0;
    const maxYear = criteria.maxYear || Infinity;
    const listMinTags = criteria.minTags || 0;
    const minAvg = Math.max(criteria.minAvg || 0, globalMinAvg);
    const maxAvg = Math.min(criteria.maxAvg || Infinity, globalMaxAvg);

    // Filter shelf books for this list's criteria FIRST
    const candidates = shelfBooks.map((sb, idx) => ({ book: sb, pos: idx + 1 })).filter(({ book }) => {
      const bookRatings = parseInt(book.ratings.replace(/,/g, ''), 10) || 0;

// mjf
   //   console.log(`avgRating=${book.avgRating}, tagCount=${book.tagCount}`);
      
      // Ratings check
      if (bookRatings < minVal || (maxVal < Infinity && bookRatings > maxVal)) return false;

      // Avg Rating check
      if (!book.avgRating) {
        if (minAvg > 0 || maxAvg < Infinity) return false;
      } else {
        const bookAvg = parseFloat(book.avgRating);
        if (bookAvg < minAvg || bookAvg > maxAvg) return false;
      }

      // Per-list Tag Count check
      if (listMinTags > 0 && (book.tagCount || 0) < listMinTags) return false;

      const cached = bookCache[book.id];
      const bookYear = cached ? getYear(cached.published) : null;
      if (minYear > 0 || maxYear < Infinity) {
        if (bookYear === null || bookYear < minYear || bookYear > maxYear) return false;
      }
      return true;
    });

    if (candidates.length === 0) {
      console.log(chalk.gray(`   ⏩ Skipping list: No discovered books meet the criteria for this category.`));
      continue;
    }

    const toAdd: string[] = [];

    // Fetch this specific list ONLY if we have candidates
    console.log(chalk.gray(`   📥 Fetching list content for ${candidates.length} candidate(s)...`));
    const listBooks = await scrapeListBooks(listEntry.id);
    console.log(chalk.gray(`   Found ${listBooks.length} books on list.`));

    for (const { book: sb, pos: shelfPos } of candidates) {
      const alreadyOnList = listBooks.some(lb => isSameBook(sb, lb));
      if (!alreadyOnList) {
        const cached = bookCache[sb.id];
        let pubInfo = '';
        if (cached && cached.published !== 'Unknown') {
          pubInfo = `, Pub: ${formatDate(cached.published)}`;
        }
        const avgStr = sb.avgRating ? `, Avg: ${sb.avgRating}` : '';

        const bookLink = formatBookLink(sb.title, sb.id);
        const msg = `[MISSING] ${bookLink} by ${sb.author} (Shelf Pos: ${shelfPos}, Tags: ${sb.tagCount}, Ratings: ${sb.ratings}${avgStr}${pubInfo})`;
        console.log(chalk.green.bold(`   ➕ ${msg}`));
        await appendToAuditReport(listEntry.officialTitle, msg);
        toAdd.push(bookLink);
      }
    }

    finalResults.push({ list: listEntry, toAdd });
    await delay(1000, 3000);
  }

  // FINAL GLOBAL SUMMARY
  console.log(chalk.cyan.bold(`\n\n==================================================`));
  console.log(chalk.cyan.bold(`🏁 FINAL DISCOVERY SUMMARY FOR "${tagName.toUpperCase()}"`));
  console.log(chalk.cyan.bold(`==================================================`));

  for (const res of finalResults) {
    if (res.toAdd.length === 0) continue;
    console.log(chalk.white.bold(`\n📌 ${res.list.nickname} (${res.list.officialTitle})`));
    if (res.toAdd.length > 0) {
      const msg = `   ✅ SHOULD ADD: ${res.toAdd.join(' and ')}`;
      console.log(chalk.green.bold(msg));
      await appendToAuditReport('SUMMARY', `[${res.list.nickname}] ${msg}`);
    }
  }

  await saveBookCache(bookCache);
  const endCacheSize = Object.keys(bookCache).length;
  const netAdded = endCacheSize - initialCacheSize;
  if (netAdded > 0) {
    const completeMsg = `Discovery run complete for tag "${tagName}". Book cache updated (${initialCacheSize.toLocaleString()} → ${endCacheSize.toLocaleString()} books, +${netAdded.toLocaleString()} new books added).`;
    await appendToAuditReport('SUMMARY', completeMsg);
  }
  console.log(chalk.cyan.bold(`\nDiscovery run complete. All results saved to auditReport.txt.`));
  console.log(chalk.green.bold(`   Book cache updated: ${initialCacheSize.toLocaleString()} → ${endCacheSize.toLocaleString()} books (+${netAdded.toLocaleString()} new books added).`));
}

export async function runBulkTagDiscovery(options: { start?: string, count?: string, minTags?: string, minAvg?: string, maxAvg?: string, audits?: boolean, cacheOnly?: boolean, pages?: string, shelfPages?: string }): Promise<void> {
  const startNum = parseInt(options.start || '1', 10);
  const countNum = parseInt(options.count || '10', 10);
  const cacheOnly = options.audits ? false : (options.cacheOnly !== undefined ? options.cacheOnly : true);

  if (isNaN(startNum) || startNum < 1) {
    throw new Error(`Invalid start shelf number: ${options.start}`);
  }
  if (isNaN(countNum) || countNum < 1) {
    throw new Error(`Invalid count/number of shelves: ${options.count}`);
  }

  // Parse --pages range (default 1-25)
  let pageStart = 1;
  let pageEnd = 25;
  if (options.pages) {
    const rangeMatch = options.pages.match(/^(\d+)(?:-(\d+))?$/);
    if (!rangeMatch) {
      throw new Error(`Invalid pages range: "${options.pages}". Use "N" or "N-M" (e.g. "1-25", "24-25", "24").`);
    }
    pageStart = parseInt(rangeMatch[1], 10);
    pageEnd = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : pageStart;
    if (isNaN(pageStart) || pageStart < 1 || isNaN(pageEnd) || pageEnd < pageStart) {
      throw new Error(`Invalid pages range: "${options.pages}". Start must be >= 1 and <= end.`);
    }
  }

  // Parse --shelfPages range (default 1-25) for each shelf's book pages
  let shelfPageStart = '1';
  let shelfPageEnd = '25';
  if (options.shelfPages) {
    const rangeMatch = options.shelfPages.match(/^(\d+)(?:-(\d+))?$/);
    if (!rangeMatch) {
      throw new Error(`Invalid shelf pages range: "${options.shelfPages}". Use "N" or "N-M" (e.g. "7-11", "1-10").`);
    }
    shelfPageStart = rangeMatch[1];
    shelfPageEnd = rangeMatch[2] || rangeMatch[1];
    const s = parseInt(shelfPageStart, 10);
    const e = parseInt(shelfPageEnd, 10);
    if (isNaN(s) || s < 1 || isNaN(e) || e < s) {
      throw new Error(`Invalid shelf pages range: "${options.shelfPages}". Start must be >= 1 and <= end.`);
    }
  }

  console.log(chalk.cyan.bold(`\n🌐 Fetching top shelves from pages ${pageStart}-${pageEnd} of https://www.goodreads.com/shelf...`));
  const allShelves: string[] = [];
  const seenShelves = new Set<string>();

  for (let page = pageStart; page <= pageEnd; page++) {
    console.log(chalk.gray(`   📄 Page ${page}...`));
    try {
      const pageShelves = await scrapeTopShelves(page);
      for (const shelf of pageShelves) {
        if (!seenShelves.has(shelf)) {
          seenShelves.add(shelf);
          allShelves.push(shelf);
        }
      }
      console.log(chalk.gray(`      Found ${pageShelves.length} shelves (${allShelves.length} unique total)`));
    } catch (err: any) {
      console.error(chalk.red.bold(`   ❌ Error fetching page ${page}:`), err.message);
    }
    if (page < pageEnd) {
      await delay(500, 1500);
    }
  }

  if (allShelves.length === 0) {
    throw new Error('No shelves discovered on any of the requested pages');
  }

  const startIndex = startNum - 1;
  const selectedShelves = allShelves.slice(startIndex, startIndex + countNum);

  console.log(chalk.green.bold(`\n📚 Discovered ${allShelves.length} total shelves across pages ${pageStart}-${pageEnd}.`));
  console.log(chalk.cyan.bold(`🎯 Processing ${selectedShelves.length} shelf/shelves (starting at shelf #${startNum}):`));
  selectedShelves.forEach((s, idx) => {
    console.log(chalk.gray(`   ${startNum + idx}. ${s}`));
  });
  console.log();

  for (let i = 0; i < selectedShelves.length; i++) {
    const shelfTag = selectedShelves[i];
    const currentNum = startNum + i;
    console.log(chalk.yellow.bold(`\n==================================================`));
    console.log(chalk.yellow.bold(`🚀 BULK TAG DISCOVERY [${i + 1}/${selectedShelves.length}] (Shelf #${currentNum}): "${shelfTag}"`));
    console.log(chalk.yellow.bold(`==================================================`));

    try {
      await runTagDiscovery(shelfTag, { ...options, cacheOnly, shelfPageStart, shelfPageEnd });
    } catch (err: any) {
      console.error(chalk.red.bold(`❌ Error running tag discovery for "${shelfTag}":`), err.message);
    }

    if (i < selectedShelves.length - 1) {
      await delay(1000, 3000);
    }
  }

  console.log(chalk.cyan.bold(`\n🎉 Bulk tag discovery complete for ${selectedShelves.length} shelves.`));
}
