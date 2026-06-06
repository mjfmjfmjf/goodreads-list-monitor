import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { scrapeListBooks, scrapeBookDetails, scrapeShelfBooks } from './scraper.js';
import { loadState, saveState, loadBookCache, saveBookCache } from './storage.js';
import { getYear, normalizeTitle, normalizeAuthor, formatDate, delay, formatBookLink } from './utils.js';

const AUDIT_REPORT = path.join(process.cwd(), 'auditReport.txt');

export interface AuditOptions {
  min?: string;
  max?: string;
  minYear?: string;
  maxYear?: string;
  tag?: string;
  minTags?: string;
}

/**
 * Checks if two books are the same by comparing IDs or Normalized Title + Author
 */
function isSameBook(book1: { id: string, title: string, author: string }, book2: { id: string, title: string, author: string }): boolean {
  if (book1.id === book2.id) return true;
  
  const title1 = normalizeTitle(book1.title);
  const title2 = normalizeTitle(book2.title);
  const auth1 = normalizeAuthor(book1.author);
  const auth2 = normalizeAuthor(book2.author);
  
  return title1 === title2 && auth1 === auth2;
}

export async function runTagAudit(tag: string, listId: string, options: AuditOptions): Promise<void> {
  const state = await loadState();
  const bookCache = await loadBookCache();
  const listTitle = state.lists[listId]?.title || `List ${listId}`;
  
  const minRatings = parseInt(options.min?.replace(/,/g, '') || '0', 10);
  const minTags = parseInt(options.minTags?.replace(/,/g, '') || '0', 10);
  const minYear = options.minYear ? parseInt(options.minYear, 10) : 0;
  const maxYear = options.maxYear ? parseInt(options.maxYear, 10) : Infinity;

  console.log(chalk.cyan.bold(`\n🏷️ Starting Tag Audit for tag: "${tag}" against list: "${listTitle}"`));
  console.log(chalk.gray(`   Criteria: Min Ratings: ${minRatings}, Min Tags: ${minTags}\n`));

  try {
    // 1. Discovery Phase: Read the Tag/Shelf pages first
    console.log(chalk.cyan.bold(`🔎 Step 1: Discovering eligible books from shelf "${tag}"...`));
    const shelfBooks = await scrapeShelfBooks(tag, minTags, 25);
    
    // Filter shelf books by ratings and years (if provided)
    const eligibleShelfBooks = shelfBooks.filter(book => {
      const bookRatings = parseInt(book.ratings.replace(/,/g, ''), 10) || 0;
      if (bookRatings < minRatings) return false;
      
      if (minYear > 0 || maxYear < Infinity) {
        const cached = bookCache[book.id];
        const bookYear = cached ? getYear(cached.published) : null;
        if (bookYear !== null && (bookYear < minYear || bookYear > maxYear)) return false;
      }
      return true;
    });

    console.log(chalk.gray(`   Found ${eligibleShelfBooks.length} books on the shelf that meet all criteria.`));

    // 2. Verification Phase: Read the Listopia list
    console.log(chalk.cyan.bold(`\n📥 Step 2: Reading the Listopia list...`));
    const listBooks = await scrapeListBooks(listId);
    console.log(chalk.gray(`   Found ${listBooks.length} books currently on the list.`));

    const toAdd: string[] = [];
    const toRemove: string[] = [];

    // 3. Comparison Phase
    console.log(chalk.cyan.bold(`\n⚖️ Step 3: Comparing Shelf vs List...`));

    // Find books that SHOULD be added
    for (const shelfBook of eligibleShelfBooks) {
      const alreadyOnList = listBooks.some(lb => isSameBook(shelfBook, lb));
      
      if (!alreadyOnList) {
        const msg = `[MISSING] "${shelfBook.title}" by ${shelfBook.author} [ID: ${shelfBook.id}] (Tags: ${shelfBook.tagCount}, Ratings: ${shelfBook.ratings})`;
        console.log(chalk.green.bold(`   ➕ ${msg}`));
        await appendToAuditReport(listTitle, msg);
        toAdd.push(`[book:${shelfBook.title}|${shelfBook.id}]`);
        updateCache(shelfBook, tag, bookCache);
      }
    }

    // Find books that SHOULD be removed
    for (const listBook of listBooks) {
      const foundOnShelf = shelfBooks.find(sb => isSameBook(listBook, sb));
      const bookRatings = parseInt(listBook.ratings.replace(/,/g, ''), 10) || 0;
      
      const tooFewRatings = minRatings > 0 && bookRatings < minRatings;
      const notOnShelf = !foundOnShelf;

      if (notOnShelf || tooFewRatings) {
        let reason = '';
        if (tooFewRatings) reason = `TOO FEW RATINGS (${listBook.ratings} < ${minRatings})`;
        else reason = 'Below tag threshold or not in top 25 shelf pages';

        const msg = `[REMOVE] "${listBook.title}" by ${listBook.author} [ID: ${listBook.id}] (Reason: ${reason})`;
        console.log(chalk.red.bold(`   ❌ ${msg}`));
        await appendToAuditReport(listTitle, msg);
        toRemove.push(`[book:${listBook.title}|${listBook.id}]`);
      }
    }

    await saveBookCache(bookCache);

    // 4. Final Summary Statements
    if (toAdd.length > 0) {
      const msg = `\n✅ Books that should be ADDED (Meet criteria on shelf): ${toAdd.join(' and ')}`;
      console.log(chalk.green.bold(msg));
      await appendToAuditReport(listTitle, msg);
    }

    if (toRemove.length > 0) {
      const msg = `\n❌ Books that should be REMOVED (Not found in top 25 shelf pages or below threshold): ${toRemove.join(' and ')}`;
      console.log(chalk.red.bold(msg));
      await appendToAuditReport(listTitle, msg);
    }

    console.log(chalk.cyan.bold(`\n🏁 Tag audit complete. Found ${toAdd.length} to add and ${toRemove.length} to remove.`));

  } catch (error) {
    console.error(chalk.red.bold(`\n❌ Tag audit failed:`), (error as any).message);
  }
}

function updateCache(book: any, tag: string, bookCache: any) {
  if (!bookCache[book.id]) {
    bookCache[book.id] = {
      id: book.id,
      title: book.title,
      author: book.author,
      ratings: book.ratings,
      published: 'Unknown',
      lastUpdated: new Date().toISOString(),
      tags: {}
    };
  }
  if (!bookCache[book.id].tags) bookCache[book.id].tags = {};
  bookCache[book.id].tags[tag] = book.tagCount;
}

export async function runAudit(listId: string, options: AuditOptions): Promise<void> {
  const state = await loadState();
  const bookCache = await loadBookCache();
  const listTitle = state.lists[listId]?.title || `List ${listId}`;
  
  const isYearMode = options.minYear !== undefined || options.maxYear !== undefined;

  console.log(chalk.cyan.bold(`\n🔍 Starting Audit for: "${listTitle}"`));
  if (isYearMode) {
    const minYear = options.minYear ? parseInt(options.minYear, 10) : 0;
    const maxYear = options.maxYear ? parseInt(options.maxYear, 10) : Infinity;
    console.log(chalk.gray(`   Mode: Publishing Year Audit (${minYear} to ${maxYear === Infinity ? 'Any' : maxYear})\n`));
    await runYearAudit(listId, listTitle, minYear, maxYear, bookCache);
  } else {
    const minRatings = options.min ? parseInt(options.min.replace(/,/g, ''), 10) : 0;
    const maxRatings = options.max ? parseInt(options.max.replace(/,/g, ''), 10) : Infinity;
    console.log(chalk.gray(`   Mode: Ratings Audit (${minRatings} to ${maxRatings === Infinity ? 'Any' : maxRatings})\n`));
    await runRatingsAudit(listId, listTitle, minRatings, maxRatings, bookCache);
  }
}

async function runRatingsAudit(listId: string, listTitle: string, min: number, max: number, bookCache: any): Promise<void> {
  try {
    const listBooks = await scrapeListBooks(listId);
    let outliersFound = 0;
    const graduatedBooks: string[] = [];
    const tooFewBooks: string[] = [];

    for (const book of listBooks) {
      const bookRatings = parseInt(book.ratings.replace(/,/g, ''), 10) || 0;
      
      const tooFew = min > 0 && bookRatings < min;
      const tooMany = max < Infinity && bookRatings > max;

      if (tooFew || tooMany) {
        const reason = tooFew ? 'TOO FEW RATINGS' : 'TOO MANY RATINGS';
        
        // Check cache for publication date
        const cached = bookCache[book.id];
        const pubInfo = (cached && cached.published !== 'Unknown') ? `, Pub: ${formatDate(cached.published)}` : '';
        const url = `https://www.goodreads.com/book/show/${book.id}`;

        const bookLink = formatBookLink(book.title, book.id);
        const msg = `[${reason}] ${bookLink} by ${book.author} (Ratings: ${book.ratings}${pubInfo}, Pos: ${book.position})`;
        
        console.log(chalk.red.bold(`   ❌ OUTLIER: ${msg}`));
        console.log(chalk.gray(`      URL: ${url}`));
        
        await appendToAuditReport(listTitle, msg);
        outliersFound++;

        if (tooMany) graduatedBooks.push(bookLink);
        if (tooFew) tooFewBooks.push(bookLink);
      }
    }

    if (graduatedBooks.length > 0) {
      const graduatedMsg = `\n🎓 ${graduatedBooks.join(' and ')} graduated`;
      console.log(chalk.magenta.bold(graduatedMsg));
      await appendToAuditReport(listTitle, `GRADUATED MESSAGE: ${graduatedMsg}`);
    }
    
    if (tooFewBooks.length > 0) {
      const tooFewMsg = `\n❌ Books will be removed for being below ${min} ratings: ${tooFewBooks.join(' and ')}`;
      console.log(chalk.red.bold(tooFewMsg));
      await appendToAuditReport(listTitle, tooFewMsg);
    }

    reportAuditSummary(outliersFound, listBooks.length);
  } catch (error) {
    console.error(chalk.red.bold(`\n❌ Ratings audit failed:`), (error as any).message);
  }
}

async function runYearAudit(listId: string, listTitle: string, min: number, max: number, bookCache: any): Promise<void> {
  try {
    const listBooks = await scrapeListBooks(listId);
    let outliersFound = 0;
    const tooEarlyBooks: string[] = [];
    const tooLateBooks: string[] = [];

    // Pre-index cache by normalized title for faster lookups of other editions
    const titleCache: Record<string, string> = {};
    for (const b of Object.values(bookCache) as any[]) {
      if (b.published !== 'Unknown') {
        titleCache[`${normalizeTitle(b.title)}|${normalizeAuthor(b.author)}`] = b.published;
      }
    }

    for (let i = 0; i < listBooks.length; i++) {
      const book = listBooks[i];
      let bookData = bookCache[book.id];
      const titleAuthorKey = `${normalizeTitle(book.title)}|${normalizeAuthor(book.author)}`;

      // 1. If missing from cache or needs refresh
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const needsFetch = !bookData || (bookData.published === 'Unknown' && (!bookData.lastUpdated || bookData.lastUpdated < oneDayAgo));

      if (needsFetch) {
        const titleAuthorKey = `${normalizeTitle(book.title)}|${normalizeAuthor(book.author)}`;
        const yearFromList = book.published !== 'Unknown' ? book.published : null;
        const yearFromOtherEdition = titleCache[titleAuthorKey];
        const resolvedYear = yearFromList || yearFromOtherEdition;

        if (resolvedYear) {
          bookCache[book.id] = {
            id: book.id,
            title: book.title,
            author: book.author,
            ratings: book.ratings,
            published: resolvedYear,
            lastUpdated: new Date().toISOString(),
            tags: bookData?.tags || {}
          };
          bookData = bookCache[book.id];
        } else {
          console.log(chalk.gray(`   [${i + 1}/${listBooks.length}] Fetching missing year info for: "${book.title.substring(0, 30)}..."`));
          const details = await scrapeBookDetails(book.id);
          
          bookCache[book.id] = {
            id: book.id,
            title: book.title,
            author: book.author,
            ratings: book.ratings,
            published: details.published || 'Unknown',
            lastUpdated: new Date().toISOString(),
            tags: bookData?.tags || {},
            requiresAuth: details.requiresAuth || false
          };
          bookData = bookCache[book.id];
          if (i % 10 === 0) await saveBookCache(bookCache);
          await delay(500, 1500);
        }
      }

      const bookYear = getYear(bookData.published);
      const isUnknown = bookData.published === 'Unknown';
      const tooEarly = !isUnknown && min > 0 && bookYear !== null && bookYear < min;
      const tooLate = !isUnknown && max < Infinity && bookYear !== null && bookYear > max;

      if (isUnknown || tooEarly || tooLate) {
        const reason = isUnknown ? 'UNKNOWN YEAR' : (tooEarly ? 'TOO EARLY' : 'TOO LATE');
        const pageInfo = book.page ? `, Page: ${book.page}` : '';
        const authInfo = bookData.requiresAuth ? ' [AUTH REQ]' : '';
        const url = `https://www.goodreads.com/book/show/${book.id}`;
        
        const bookLink = formatBookLink(book.title, book.id);
        const msg = `[${reason}]${authInfo} ${bookLink} by ${book.author} (Published: ${bookData.published}, Ratings: ${book.ratings}, Pos: ${book.position}${pageInfo})`;
        
        if (isUnknown) {
          console.log(chalk.red.bold(`   🏗️ BROKEN BOOK: ${msg}`));
        } else {
          console.log(chalk.red.bold(`   ❌ OUTLIER: ${msg}`));
        }
        console.log(chalk.gray(`      URL: ${url}`));
        
        await appendToAuditReport(listTitle, msg);
        outliersFound++;

        if (isUnknown || tooEarly) tooEarlyBooks.push(bookLink);
        if (tooLate) tooLateBooks.push(bookLink);
      }
    }

    await saveBookCache(bookCache);

    if (tooEarlyBooks.length > 0) {
      const msg = `\n❌ Books will be removed for being before ${min}: ${tooEarlyBooks.join(' and ')}`;
      console.log(chalk.red.bold(msg));
      await appendToAuditReport(listTitle, msg);
    }
    if (tooLateBooks.length > 0) {
      const msg = `\n❌ Books will be removed for being after ${max}: ${tooLateBooks.join(' and ')}`;
      console.log(chalk.red.bold(msg));
      await appendToAuditReport(listTitle, msg);
    }

    reportAuditSummary(outliersFound, listBooks.length);
  } catch (error) {
    console.error(chalk.red.bold(`\n❌ Year audit failed:`), (error as any).message);
  }
}

function reportAuditSummary(outliers: number, total: number) {
  if (outliers === 0) {
    console.log(chalk.green.bold(`\n✅ Audit complete. All ${total} books meet the criteria.`));
  } else {
    console.log(chalk.yellow.bold(`\n⚠️ Audit complete. Found ${outliers} outliers out of ${total} books.`));
    console.log(chalk.gray(`   Details saved to auditReport.txt`));
  }
}

async function appendToAuditReport(listTitle: string, message: string): Promise<void> {
  const timestamp = new Date().toLocaleString();
  const entry = `[${timestamp}] [${listTitle}] ${message.trim()}\n`;
  await fs.appendFile(AUDIT_REPORT, entry);
}
