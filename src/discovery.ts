import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { scrapeListBooks, scrapeShelfBooks, scrapeBookDetails } from './scraper.js';
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

export async function runTagDiscovery(tagName: string, globalOptions: { minTags?: string, minAvg?: string, maxAvg?: string }): Promise<void> {
  const configPath = path.join(process.cwd(), 'tags', `${tagName}.json`);
  if (!(await fs.pathExists(configPath))) {
    throw new Error(`Config file for tag "${tagName}" not found. Run tag-config first.`);
  }

  const config: TagConfig = await fs.readJson(configPath);
  const bookCache = await loadBookCache();
  const minTags = parseInt(globalOptions.minTags?.replace(/,/g, '') || '0', 10);
  const globalMinAvg = globalOptions.minAvg ? parseFloat(globalOptions.minAvg) : 0;
  const globalMaxAvg = globalOptions.maxAvg ? parseFloat(globalOptions.maxAvg) : Infinity;

  console.log(chalk.cyan.bold(`\n🔦 Starting Discovery for tag: "${tagName}"`));
  let targetMsg = `   Target: ${config.lists.length} lists, Min Tags: ${minTags}`;
  if (globalMinAvg > 0 || globalMaxAvg < Infinity) targetMsg += `, Global Avg: ${globalMinAvg}-${globalMaxAvg}`;
  console.log(chalk.gray(`${targetMsg}\n`));

  // 1. GLOBAL SHELF SCAN
  console.log(chalk.cyan.bold(`🔎 Step 1: Scanning global shelf "${tagName}" (Top 25 pages)...`));
  const rawShelfBooks = await scrapeShelfBooks(tagName, minTags, 25);
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
  console.log(chalk.cyan.bold(`🔄 Step 2: Ensuring metadata for ${shelfBooks.length} discovered books...`));
  let syncCount = 0;
  for (let i = 0; i < shelfBooks.length; i++) {
    const sb = shelfBooks[i];
    const shelfPos = i + 1;
    
    // Check if we still need to fetch details (if shelf page didn't have the year)
    const cached = bookCache[sb.id];
    if (cached?.published === 'Unknown') {
      process.stdout.write(chalk.gray(`   [${shelfPos}/${shelfBooks.length}] Fetching details for: "${sb.title.substring(0, 30)}..." \r`));
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

  const finalResults: DiscoveryResult[] = [];

  // 3. ITERATE THROUGH LISTS
  for (let i = 0; i < config.lists.length; i++) {
    const listEntry = config.lists[i];
    console.log(chalk.yellow.bold(`\n--------------------------------------------------`));
    console.log(chalk.yellow.bold(`📋 AUDIT [${i + 1}/${config.lists.length}]: ${listEntry.nickname} - ${listEntry.officialTitle}`));
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
      
      // Ratings check
      if (bookRatings < minVal || (maxVal < Infinity && bookRatings > maxVal)) return false;

      // Avg Rating check
      const bookAvg = book.avgRating ? parseFloat(book.avgRating) : 0;
      if (bookAvg < minAvg || (maxAvg < Infinity && bookAvg > maxAvg)) return false;

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
  console.log(chalk.cyan.bold(`\nDiscovery run complete. All results saved to auditReport.txt.`));
}
