import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { scrapeListBooks, scrapeBookDetails, scrapeShelfBooks } from './scraper.js';
import { loadState, saveState, loadBookCache, getBook, upsertBook, syncBooksToCache } from './storage.js';
import { getYear, normalizeTitle, normalizeAuthor, formatDate, delay, formatBookLink } from './utils.js';
import { RegexCriterion, matchesRegex } from './bookMatch.js';
import { parseSeriesPos, matchesSeriesPos, SERIES_POS_STANDALONE } from './seriesPos.js';

const AUDIT_REPORT = path.join(process.cwd(), 'auditReport.txt');

export interface AuditOptions {
  min?: string;
  max?: string;
  minYear?: string;
  maxYear?: string;
  tag?: string;
  minTags?: string;
  minAvg?: string;
  maxAvg?: string;
  titleRegex?: string;
  authorLastRegex?: string;
  authorFirstRegex?: string;
  seriesPos?: string;
}

export interface AuditResult {
  listId: string;
  listTitle: string;
  totalBooks: number;
  outliers: number;
  tooManyRatings: number;
  tooFewRatings: number;
  tooEarly: number;
  tooLate: number;
  tooLowAvg: number;
  tooHighAvg: number;
  regexMismatch: number;
  seriesPosMismatch: number;
  failed?: boolean;
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
  const maxRatings = options.max ? parseInt(options.max.replace(/,/g, ''), 10) : Infinity;
  const minTags = parseInt(options.minTags?.replace(/,/g, '') || '0', 10);
  const minYear = options.minYear ? parseInt(options.minYear, 10) : 0;
  const maxYear = options.maxYear ? parseInt(options.maxYear, 10) : Infinity;
  const minAvg = options.minAvg ? parseFloat(options.minAvg) : 0;
  const maxAvg = options.maxAvg ? parseFloat(options.maxAvg) : Infinity;

  console.log(chalk.cyan.bold(`\n🏷️ Starting Tag Audit for tag: "${tag}" against list: "${listTitle}"`));
  let criteriaMsg = `   Criteria: Min Ratings: ${minRatings}, Max Ratings: ${maxRatings}, Min Tags: ${minTags}`;
  if (minAvg > 0 || maxAvg < Infinity) criteriaMsg += `, Avg: ${minAvg}-${maxAvg}`;
  console.log(chalk.gray(`${criteriaMsg}\n`));

  try {
    // 1. Discovery Phase: Read the Tag/Shelf pages first
    console.log(chalk.cyan.bold(`🔎 Step 1: Discovering eligible books from shelf "${tag}"...`));
    const shelfBooks = await scrapeShelfBooks(tag, minTags, 25);
    await syncBooksToCache(shelfBooks, bookCache);
    
    // Filter shelf books by ratings, years, and average rating
    const eligibleShelfBooks = shelfBooks.filter(book => {
      const bookRatings = parseInt(book.ratings.replace(/,/g, ''), 10) || 0;
      if (bookRatings < minRatings) return false;
      if (bookRatings > maxRatings) return false;
      
      // Avg Rating check
      if (!book.avgRating) {
        if (minAvg > 0 || maxAvg < Infinity) return false;
      } else {
        const bookAvg = parseFloat(book.avgRating);
        if (bookAvg < minAvg || bookAvg > maxAvg) return false;
      }

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
        const avgStr = shelfBook.avgRating ? `, Avg: ${shelfBook.avgRating}` : '';
        const msg = `[MISSING] "${shelfBook.title}" by ${shelfBook.author} [ID: ${shelfBook.id}] (Tags: ${shelfBook.tagCount}, Ratings: ${shelfBook.ratings}${avgStr})`;
        console.log(chalk.green.bold(`   ➕ ${msg}`));
        await appendToAuditReport(listTitle, msg);
        toAdd.push(formatBookLink(shelfBook.title, shelfBook.id));
        updateCache(shelfBook, tag, bookCache);
      }
    }

    // Find books that SHOULD be removed
    for (const listBook of listBooks) {
      const foundOnShelf = shelfBooks.find(sb => isSameBook(listBook, sb));
      const bookRatings = parseInt(listBook.ratings.replace(/,/g, ''), 10) || 0;
      const bookAvg = listBook.avgRating ? parseFloat(listBook.avgRating) : 0;
      
      const tooFewRatings = minRatings > 0 && bookRatings < minRatings;
      const outsideAvg = (minAvg > 0 && bookAvg < minAvg) || (maxAvg < Infinity && bookAvg > maxAvg);
      const notOnShelf = !foundOnShelf;

      if (notOnShelf || tooFewRatings || outsideAvg) {
        let reason = '';
        if (tooFewRatings) reason = `TOO FEW RATINGS (${listBook.ratings} < ${minRatings})`;
        else if (outsideAvg) reason = `OUTSIDE AVG RATING (${listBook.avgRating || '0'} not in ${minAvg}-${maxAvg})`;
        else reason = 'Below tag threshold or not in top 25 shelf pages';

        const avgStr = listBook.avgRating ? `, Avg: ${listBook.avgRating}` : '';
        const msg = `[REMOVE] "${listBook.title}" by ${listBook.author} [ID: ${listBook.id}] (Reason: ${reason}${avgStr})`;
        console.log(chalk.red.bold(`   ❌ ${msg}`));
        await appendToAuditReport(listTitle, msg);
        toRemove.push(formatBookLink(listBook.title, listBook.id));
      }
    }

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
  // Merge onto the current DB row and persist just that row.
  const fresh = getBook(book.id);
  const entry = fresh ?? bookCache[book.id];
  if (!entry) {
    bookCache[book.id] = {
      id: book.id,
      title: book.title,
      author: book.author,
      ratings: book.ratings,
      avgRating: book.avgRating,
      published: book.published || 'Unknown',
      seriesPos: parseSeriesPos(book.title),
      lastUpdated: new Date().toISOString(),
      tags: {}
    };
  } else {
    // Sync other metadata if it was missing or updated
    if (entry.published === 'Unknown' && book.published && book.published !== 'Unknown') {
      entry.published = book.published;
    }
    if (entry.title === 'Unknown' && book.title !== 'Unknown') {
      entry.title = book.title;
    }
    if (entry.seriesPos === undefined || parseSeriesPos(book.title) !== entry.seriesPos) {
      entry.seriesPos = parseSeriesPos(book.title);
    }
    if (book.avgRating && entry.avgRating !== book.avgRating) {
      entry.avgRating = book.avgRating;
    }
    if (!entry.tags) entry.tags = {};
    entry.tags[tag] = book.tagCount;
    bookCache[book.id] = entry;
  }
  if (!bookCache[book.id].tags) bookCache[book.id].tags = {};
  bookCache[book.id].tags[tag] = book.tagCount;
  upsertBook(bookCache[book.id]);
}

export async function runAudit(listId: string, options: AuditOptions): Promise<AuditResult> {
  const state = await loadState();
  const bookCache = await loadBookCache();
  const listTitle = state.lists[listId]?.title || `List ${listId}`;
  
  const minRatings = options.min ? parseInt(options.min.replace(/,/g, ''), 10) : 0;
  const maxRatings = options.max ? parseInt(options.max.replace(/,/g, ''), 10) : Infinity;
  const minYear = options.minYear ? parseInt(options.minYear, 10) : 0;
  const maxYear = options.maxYear ? parseInt(options.maxYear, 10) : Infinity;
  const minAvg = options.minAvg ? parseFloat(options.minAvg) : 0;
  const maxAvg = options.maxAvg ? parseFloat(options.maxAvg) : Infinity;

  const regexCriterion: RegexCriterion = {
    titleRegex: options.titleRegex,
    authorLastRegex: options.authorLastRegex,
    authorFirstRegex: options.authorFirstRegex
  };
  const isRegexAudit = !!(regexCriterion.titleRegex || regexCriterion.authorLastRegex || regexCriterion.authorFirstRegex);
  for (const pattern of [regexCriterion.titleRegex, regexCriterion.authorLastRegex, regexCriterion.authorFirstRegex]) {
    if (pattern) new RegExp(pattern, 'i');
  }

  const isYearAudit = minYear > 0 || maxYear < Infinity;
  const isRatingsAudit = minRatings > 0 || maxRatings < Infinity;
  const isAvgAudit = minAvg > 0 || maxAvg < Infinity;
  const isSeriesPosAudit = options.seriesPos !== undefined && options.seriesPos !== '';
  const seriesPosTarget = isSeriesPosAudit ? parseFloat(options.seriesPos as string) : NaN;

  console.log(chalk.cyan.bold(`\n🔍 Starting Audit for: "${listTitle}"`));
  if (isYearAudit) console.log(chalk.gray(`   - Year Criteria: ${minYear} to ${maxYear === Infinity ? 'Any' : maxYear}`));
  if (isRatingsAudit) console.log(chalk.gray(`   - Ratings Criteria: ${minRatings} to ${maxRatings === Infinity ? 'Any' : maxRatings}`));
  if (isAvgAudit) console.log(chalk.gray(`   - Avg Rating Criteria: ${minAvg} to ${maxAvg === Infinity ? 'Any' : maxAvg}`));
  if (isSeriesPosAudit) console.log(chalk.gray(`   - Series Position: ${options.seriesPos} (equals)`));
  if (isRegexAudit) {
    const parts: string[] = [];
    if (regexCriterion.titleRegex) parts.push(`Title: /${regexCriterion.titleRegex}/`);
    if (regexCriterion.authorLastRegex) parts.push(`Author Last: /${regexCriterion.authorLastRegex}/`);
    if (regexCriterion.authorFirstRegex) parts.push(`Author First: /${regexCriterion.authorFirstRegex}/`);
    console.log(chalk.gray(`   - Regex Criteria: ${parts.join(', ')}`));
  }
  if (!isYearAudit && !isRatingsAudit && !isAvgAudit && !isRegexAudit && !isSeriesPosAudit) console.log(chalk.gray(`   - Mode: Harvesting metadata only`));

  const result: AuditResult = {
    listId,
    listTitle,
    totalBooks: 0,
    outliers: 0,
    tooManyRatings: 0,
    tooFewRatings: 0,
    tooEarly: 0,
    tooLate: 0,
    tooLowAvg: 0,
    tooHighAvg: 0,
    regexMismatch: 0,
    seriesPosMismatch: 0
  };

  try {
    const listBooks = await scrapeListBooks(listId);
    await syncBooksToCache(listBooks, bookCache);
    result.totalBooks = listBooks.length;
    
    let outliersFound = 0;
    const tooFewRatings: string[] = [];
    const tooManyRatings: string[] = [];
    const tooEarlyYears: string[] = [];
    const tooLateYears: string[] = [];
    const tooLowAvg: string[] = [];
    const tooHighAvg: string[] = [];
    const regexMismatch: string[] = [];
    const seriesPosMismatch: string[] = [];

    // Pre-index cache by normalized title for year lookups
    const titleCache: Record<string, string> = {};
    if (isYearAudit) {
      for (const b of Object.values(bookCache) as any[]) {
        if (b.published !== 'Unknown') {
          titleCache[`${normalizeTitle(b.title)}|${normalizeAuthor(b.author)}`] = b.published;
        }
      }
    }

    for (let i = 0; i < listBooks.length; i++) {
      const book = listBooks[i];
      const bookRatings = parseInt(book.ratings.replace(/,/g, ''), 10) || 0;
      
      // 1. RATINGS CHECK
      if (isRatingsAudit) {
        const tooFew = minRatings > 0 && bookRatings < minRatings;
        const tooMany = maxRatings < Infinity && bookRatings > maxRatings;
        if (tooFew || tooMany) {
          const reason = tooFew ? 'TOO FEW RATINGS' : 'TOO MANY RATINGS';
          const bookLink = formatBookLink(book.title, book.id);
          const authorStr = book.author ? ` by ${book.author}` : '';
          const avgStr = book.avgRating ? `, Avg: ${book.avgRating}` : '';
          console.log(chalk.red.bold(`   ❌ OUTLIER: [${reason}] ${bookLink}${authorStr} (Ratings: ${book.ratings}${avgStr}, Pos: ${book.position})`));
          await appendToAuditReport(listTitle, `[${reason}] ${book.title}${authorStr} [ID: ${book.id}] (${book.ratings} ratings${avgStr})`);
          outliersFound++;
          if (tooFew) tooFewRatings.push(bookLink);
          if (tooMany) tooManyRatings.push(bookLink);
        }
      }

      // 2. YEAR CHECK
      if (isYearAudit) {
        let bookData = bookCache[book.id];
        // If year unknown but we have it from list or other edition
        if (bookData?.published === 'Unknown' || !bookData) {
            const yearFromList = book.published !== 'Unknown' ? book.published : null;
            const titleAuthorKey = `${normalizeTitle(book.title)}|${normalizeAuthor(book.author)}`;
            const yearFromOtherEdition = titleCache[titleAuthorKey];
            const resolvedYear = yearFromList || yearFromOtherEdition;
            
            if (resolvedYear) {
                if (!bookData) {
                    bookCache[book.id] = {
                        id: book.id,
                        title: book.title,
                        author: book.author,
                        ratings: book.ratings,
                        published: resolvedYear,
                        seriesPos: parseSeriesPos(book.title),
                        lastUpdated: new Date().toISOString()
                    };
                } else {
                    bookData.published = resolvedYear;
                }
                bookData = bookCache[book.id];
            }
        }

        // Only fetch details if we STILL don't have the year and we are in year audit mode
        if (!bookData || bookData.published === 'Unknown') {
             console.log(chalk.gray(`   [${i + 1}/${listBooks.length}] Fetching missing year for: "${book.title.substring(0, 30)}..."`));
             const details = await scrapeBookDetails(book.id, book.title, book.author);
             // Preserve fields the list page doesn't carry; persist just this row.
             const fresh = getBook(book.id);
             bookCache[book.id] = {
                ...(fresh ?? {}),
                id: book.id,
                title: book.title !== 'Unknown' ? book.title : (fresh?.title || book.title),
                author: book.author !== 'Unknown Author' ? book.author : (fresh?.author || book.author),
                ratings: book.ratings && book.ratings !== '0' ? book.ratings : (fresh?.ratings || '0'),
                published: details.published || 'Unknown',
                seriesPos: parseSeriesPos(book.title) ?? fresh?.seriesPos,
                lastUpdated: new Date().toISOString(),
                tags: fresh?.tags || {},
                requiresAuth: details.requiresAuth
             };
             bookData = bookCache[book.id];
             upsertBook(bookCache[book.id]);
             await delay(500, 1500);
        }

        const bookYear = getYear(bookData.published);
        const isUnknown = bookData.published === 'Unknown';
        const tooEarly = !isUnknown && minYear > 0 && bookYear !== null && bookYear < minYear;
        const tooLate = !isUnknown && maxYear < Infinity && bookYear !== null && bookYear > maxYear;

        if (isUnknown || tooEarly || tooLate) {
          const reason = isUnknown ? 'UNKNOWN YEAR' : (tooEarly ? 'TOO EARLY' : 'TOO LATE');
          const bookLink = formatBookLink(book.title, book.id);
          const authorStr = book.author ? ` by ${book.author}` : '';
          const avgStr = bookData.avgRating ? `, Avg: ${bookData.avgRating}` : '';
          console.log(chalk.red.bold(`   ❌ OUTLIER: [${reason}] ${bookLink}${authorStr} (Published: ${bookData.published}${avgStr}, Pos: ${book.position})`));
          await appendToAuditReport(listTitle, `[${reason}] ${book.title}${authorStr} [ID: ${book.id}] (Published: ${bookData.published}${avgStr})`);
          outliersFound++;
          if (tooEarly || isUnknown) tooEarlyYears.push(bookLink);
          if (tooLate) tooLateYears.push(bookLink);
        }
      }

      // 3. AVG RATING CHECK
      if (isAvgAudit) {
        if (!book.avgRating) {
          const bookLink = formatBookLink(book.title, book.id);
          const authorStr = book.author ? ` by ${book.author}` : '';
          console.log(chalk.red.bold(`   ❌ OUTLIER: [MISSING AVG RATING] ${bookLink}${authorStr} (Pos: ${book.position})`));
          await appendToAuditReport(listTitle, `[MISSING AVG RATING] ${book.title}${authorStr} [ID: ${book.id}]`);
          outliersFound++;
          tooLowAvg.push(bookLink);
        } else {
          const avg = parseFloat(book.avgRating);
          const tooLow = minAvg > 0 && avg < minAvg;
          const tooHigh = maxAvg < Infinity && avg > maxAvg;
          if (tooLow || tooHigh) {
            const reason = tooLow ? 'LOW AVG RATING' : 'HIGH AVG RATING';
            const bookLink = formatBookLink(book.title, book.id);
            const authorStr = book.author ? ` by ${book.author}` : '';
            console.log(chalk.red.bold(`   ❌ OUTLIER: [${reason}] ${bookLink}${authorStr} (Avg: ${book.avgRating || 'None'}, Pos: ${book.position})`));
            await appendToAuditReport(listTitle, `[${reason}] ${book.title}${authorStr} [ID: ${book.id}] (Avg: ${book.avgRating || 'None'})`);
            outliersFound++;
            if (tooLow) tooLowAvg.push(bookLink);
            if (tooHigh) tooHighAvg.push(bookLink);
          }
        }
      }

      // 4. REGEX CHECK
      if (isRegexAudit && !matchesRegex(book, regexCriterion)) {
        const bookLink = formatBookLink(book.title, book.id);
        const authorStr = book.author ? ` by ${book.author}` : '';
        console.log(chalk.red.bold(`   ❌ OUTLIER: [REGEX MISMATCH] ${bookLink}${authorStr} (Pos: ${book.position})`));
        await appendToAuditReport(listTitle, `[REGEX MISMATCH] ${book.title}${authorStr} [ID: ${book.id}]`);
        outliersFound++;
        regexMismatch.push(bookLink);
      }

      // 5. SERIES POSITION CHECK (equality only)
      if (isSeriesPosAudit && !isNaN(seriesPosTarget)) {
        const bookSeriesPos = parseSeriesPos(book.title);
        if (!matchesSeriesPos(seriesPosTarget, bookSeriesPos)) {
          const actual = bookSeriesPos !== undefined ? `pos ${bookSeriesPos}` : 'standalone';
          const expected = seriesPosTarget === SERIES_POS_STANDALONE ? 'standalone' : `pos ${seriesPosTarget}`;
          const reason = `Expected ${expected}, got ${actual}`;
          const bookLink = formatBookLink(book.title, book.id);
          const authorStr = book.author ? ` by ${book.author}` : '';
          console.log(chalk.red.bold(`   ❌ OUTLIER: [SERIES POSITION] ${bookLink}${authorStr} (${reason}, Pos: ${book.position})`));
          await appendToAuditReport(listTitle, `[SERIES POSITION] ${book.title}${authorStr} [ID: ${book.id}] (${reason})`);
          outliersFound++;
          seriesPosMismatch.push(bookLink);
        }
      }
    }

    // Final consolidated report
    if (tooManyRatings.length > 0) console.log(chalk.magenta.bold(`\n🎓 ${tooManyRatings.join(' and ')} graduated (Too many ratings)`));
    if (tooFewRatings.length > 0) console.log(chalk.red.bold(`\n❌ Below ratings threshold: ${tooFewRatings.join(' and ')}`));
    if (tooEarlyYears.length > 0) console.log(chalk.red.bold(`\n❌ Too early: ${tooEarlyYears.join(' and ')}`));
    if (tooLateYears.length > 0) console.log(chalk.red.bold(`\n❌ Too late: ${tooLateYears.join(' and ')}`));
    if (tooLowAvg.length > 0) console.log(chalk.red.bold(`\n❌ Below avg rating threshold: ${tooLowAvg.join(' and ')}`));
    if (tooHighAvg.length > 0) console.log(chalk.red.bold(`\n❌ Above avg rating threshold: ${tooHighAvg.join(' and ')}`));
    if (regexMismatch.length > 0) console.log(chalk.red.bold(`\n❌ Regex mismatch: ${regexMismatch.join(' and ')}`));
    if (seriesPosMismatch.length > 0) console.log(chalk.red.bold(`\n❌ Wrong series position: ${seriesPosMismatch.join(' and ')}`));

    reportAuditSummary(outliersFound, listBooks.length);

    result.outliers = outliersFound;
    result.tooManyRatings = tooManyRatings.length;
    result.tooFewRatings = tooFewRatings.length;
    result.tooEarly = tooEarlyYears.length;
    result.tooLate = tooLateYears.length;
    result.tooLowAvg = tooLowAvg.length;
    result.tooHighAvg = tooHighAvg.length;
    result.regexMismatch = regexMismatch.length;
    result.seriesPosMismatch = seriesPosMismatch.length;

    return result;
  } catch (error) {
    console.error(chalk.red.bold(`\n❌ Audit failed:`), (error as any).message);
    result.failed = true;
    return result;
  }
}

async function harvestListOnly(listId: string, bookCache: any): Promise<void> {
  // Logic now merged into runAudit
}

async function runRatingsAudit(listId: string, listTitle: string, min: number, max: number, bookCache: any): Promise<void> {
  // Logic now merged into runAudit
}

async function runYearAudit(listId: string, listTitle: string, min: number, max: number, bookCache: any): Promise<void> {
  // Logic now merged into runAudit
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
