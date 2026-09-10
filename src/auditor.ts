import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { scrapeListBooks, scrapeBookDetails, scrapeShelfBooks } from './scraper.js';
import { loadState, saveState, loadBookCache, getBook, upsertBook, syncBooksToCache } from './storage.js';
import { getDb } from './db.js';
import { getYear, normalizeTitle, normalizeAuthor, formatDate, delay, formatBookLink, withDbLockRetryAsync } from './utils.js';
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
  belowTagShelves: number;
  failed?: boolean;
  tagSkipped?: boolean;
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

// ── DB-backed tag/shelf check (tag-audit functionality in bulk-audit) ──────
// Instead of scraping the shelf live, judge a book against the tag_books
// table: a book stays on the list if it was scraped shelved `shelved` times
// as the configured tag and that count meets the minimum.

// Best-known "shelved N times as <tag>" per book id, plus a work-level map so
// an edition-id mismatch between the shelf scrape and the list still resolves
// to the same book (via the books.work_id join).
export interface TagShelvesIndex {
  byBook: Map<string, number>;
  byWork: Map<string, number>;
}

export function buildTagShelvesIndex(
  tagRows: { book_id: string | number; shelved?: number | null }[],
  workRows: { book_id: string | number; work_id: string | number; shelved?: number | null }[]
): TagShelvesIndex {
  const byBook = new Map<string, number>();
  const byWork = new Map<string, number>();
  const takeMax = (m: Map<string, number>, key: string, val: number) => m.set(key, Math.max(m.get(key) ?? 0, val));
  for (const r of tagRows) {
    if (r.shelved == null) continue;
    takeMax(byBook, String(r.book_id), Number(r.shelved));
  }
  for (const r of workRows) {
    if (r.work_id == null || r.shelved == null) continue;
    takeMax(byWork, String(r.work_id), Number(r.shelved));
  }
  return { byBook, byWork };
}

// Times a book was shelved under the tag: book id directly, else the book's
// work id. `undefined` means the tag_books table has no record for the book.
export function tagShelvedCount(index: TagShelvesIndex, bookId: string, workId?: string): number | undefined {
  const direct = index.byBook.get(bookId);
  if (direct !== undefined) return direct;
  if (workId != null) return index.byWork.get(String(workId));
  return undefined;
}

export function findBelowTagShelves(
  books: { id: string | number }[],
  index: TagShelvesIndex,
  workIdByBook: Map<string, string>,
  minShelves: number
): { bookId: string; count?: number }[] {
  const out: { bookId: string; count?: number }[] = [];
  for (const book of books) {
    const id = String(book.id);
    const count = tagShelvedCount(index, id, workIdByBook.get(id));
    if (count !== undefined && count >= minShelves) continue;
    out.push({ bookId: id, count });
  }
  return out;
}

// Editions of the same Goodreads work usually share a normalized title+author.
// When a list book has no work id in `books`, resolve one from another row that
// does, so the work-level tag_books map still matches across edition mismatches.
export function resolveMissingWorkIds(
  books: { id: string | number; title: string; author?: string }[],
  knownWorkRows: { title: string; author?: string; work_id: string | number }[]
): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const r of knownWorkRows) {
    if (r.work_id == null || String(r.work_id) === '') continue;
    const key = `${normalizeTitle(r.title)}|${normalizeAuthor(r.author ?? '')}`;
    if (!byKey.has(key)) byKey.set(key, String(r.work_id));
  }
  const out = new Map<string, string>();
  for (const b of books) {
    const key = `${normalizeTitle(b.title)}|${normalizeAuthor(b.author ?? '')}`;
    const wid = byKey.get(key);
    if (wid) out.set(String(b.id), wid);
  }
  return out;
}

export async function runTagAudit(tag: string, listId: string, options: AuditOptions): Promise<void> {
  // Guard against the #1 invocation mistake: swapping <tag> and <listId>.
  // Tags are shelf slugs ("space-opera"); list ids are numeric ("78971").
  const listIdIsPlausible = /^\d+$/.test(listId.trim()) || listId.includes('/');
  if (/^\d+$/.test(tag.trim()) || !listIdIsPlausible) {
    console.log(chalk.yellow.bold(`\n⚠️  tag-audit takes <tag> <listId> — TAG FIRST, then the list id.`));
    console.log(chalk.yellow(`   You passed tag="${tag}" listId="${listId}".`));
    if (/^\d+$/.test(tag.trim()) && !listIdIsPlausible) {
      console.log(chalk.yellow(`   Those look swapped — shelf "${tag}" is probably your list id, and "space-opera"-style names are tags.`));
      console.log(chalk.yellow(`   Correct: npm run tag-audit ${listId} ${tag} --min 1000 --minTags 10`));
    } else {
      console.log(chalk.yellow(`   The shelf "${tag}" is unlikely to exist; check the tag spelling and that the list id is numeric.`));
    }
    console.log('');
  }

  const state = await withDbLockRetryAsync(() => Promise.resolve(loadState()));
  const bookCache = await withDbLockRetryAsync(() => Promise.resolve(loadBookCache()));
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
    await withDbLockRetryAsync(() => syncBooksToCache(shelfBooks, bookCache));
    
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
        await updateCache(shelfBook, tag, bookCache);
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

async function updateCache(book: any, tag: string, bookCache: any) {
  // Merge onto the current DB row and persist just that row.
  const fresh = await withDbLockRetryAsync(() => Promise.resolve(getBook(book.id)));
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
  await withDbLockRetryAsync(() => Promise.resolve(upsertBook(bookCache[book.id])));
}

export async function runAudit(listId: string, options: AuditOptions): Promise<AuditResult> {
  const state = await withDbLockRetryAsync(() => Promise.resolve(loadState()));
  const bookCache = await withDbLockRetryAsync(() => Promise.resolve(loadBookCache()));
  const listTitle = state.lists[listId]?.title || `List ${listId}`;
  
  const minRatings = options.min ? parseInt(options.min.replace(/,/g, ''), 10) : 0;
  const maxRatings = options.max ? parseInt(options.max.replace(/,/g, ''), 10) : Infinity;
  const minYear = options.minYear ? parseInt(options.minYear, 10) : 0;
  const maxYear = options.maxYear ? parseInt(options.maxYear, 10) : Infinity;
  const minAvg = options.minAvg ? parseFloat(options.minAvg) : 0;
  const maxAvg = options.maxAvg ? parseFloat(options.maxAvg) : Infinity;
  const tag = options.tag?.trim();
  const isTagAudit = !!tag;
  const minShelves = isTagAudit ? parseInt(options.minTags?.replace(/,/g, '') || '0', 10) : 0;

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
  if (isTagAudit) console.log(chalk.gray(`   - Tag Shelf Criteria: "${tag}" shelved >= ${minShelves} times (checked against the tag_books DB)`));
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
  if (!isTagAudit && !isYearAudit && !isRatingsAudit && !isAvgAudit && !isRegexAudit && !isSeriesPosAudit) console.log(chalk.gray(`   - Mode: Harvesting metadata only`));

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
    seriesPosMismatch: 0,
    belowTagShelves: 0
  };

  // Load the tag_books shelf membership for the configured tag. Empty table for
  // this tag means it was never scraped → skip the criterion with a warning.
  let tagShelvesIndex: TagShelvesIndex | undefined;
  if (isTagAudit) {
    const db = getDb();
    const tagRows = db.prepare('SELECT book_id, shelved FROM tag_books WHERE tag_name = ?').all(tag!) as any[];
    if (tagRows.length === 0) {
      result.tagSkipped = true;
      console.log(chalk.yellow(`   ⚠️ Tag "${tag}" not yet scraped — skipping this list's tag check.`));
    } else {
      const workRows = db.prepare(
        'SELECT t.book_id, b.work_id, t.shelved FROM tag_books t JOIN books b ON b.id = t.book_id WHERE t.tag_name = ? AND b.work_id IS NOT NULL AND t.shelved IS NOT NULL'
      ).all(tag!) as any[];
      tagShelvesIndex = buildTagShelvesIndex(tagRows, workRows);
    }
  }

  try {
    const listBooks = await scrapeListBooks(listId);
    await withDbLockRetryAsync(() => syncBooksToCache(listBooks, bookCache));
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
    const belowTagShelves: string[] = [];

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
             const fresh = await withDbLockRetryAsync(() => Promise.resolve(getBook(book.id)));
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
             await withDbLockRetryAsync(() => Promise.resolve(upsertBook(bookCache[book.id])));
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

    // 6. TAG SHELF CHECK (DB-backed): a book stays on the list only if the
    // tag_books table shows it shelved as `<tag>` at least minShelves times.
    // Skipped entirely when the tag was never scraped (tagSkipped).
    if (isTagAudit && tagShelvesIndex) {
      const db = getDb();
      const workIdByBook = new Map<string, string>();
      const listIds = listBooks.map(b => String(b.id));
      for (let i = 0; i < listIds.length; i += 500) {
        const chunk = listIds.slice(i, i + 500);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = db.prepare(`SELECT id, work_id FROM books WHERE id IN (${placeholders})`).all(...chunk) as any[];
        for (const r of rows) {
          if (r.work_id != null) workIdByBook.set(String(r.id), String(r.work_id));
        }
      }

      // Editions of the same work can carry different ids on the shelf vs the
      // list (e.g. shelf edition 36510196 vs list edition 51964, both Old Man's
      // War). Resolve a work id for list books missing one by matching another
      // books-table row with the same normalized title+author that HAS a work id
      // — the tag_books work-level map then resolves the edition mismatch.
      const missingWork = listBooks.filter(b => !workIdByBook.has(String(b.id)));
      if (missingWork.length > 0) {
        const workIdCandidates = (titles: string[]): any[] => {
          const out: any[] = [];
          for (let i = 0; i < titles.length; i += 500) {
            const chunk = titles.slice(i, i + 500);
            const ph = chunk.map(() => '?').join(',');
            out.push(...(db.prepare(
              `SELECT DISTINCT title, author, work_id FROM books WHERE work_id IS NOT NULL AND work_id != '' AND title IN (${ph})`
            ).all(...chunk) as any[]));
          }
          return out;
        };
        for (const [id, wid] of resolveMissingWorkIds(
          missingWork,
          workIdCandidates([...new Set(missingWork.map(b => b.title))])
        )) {
          workIdByBook.set(id, wid);
        }

        // Second pass: the shelf scrape may store a bare title ("Cibola Burn")
        // while the list records "Cibola Burn (Expanse, #4)". Match on the
        // normalized title prefix, then normalize in JS to confirm the author.
        const stillMissing = missingWork.filter(b => !workIdByBook.has(String(b.id)));
        if (stillMissing.length > 0) {
          const prefixRows: any[] = [];
          for (const b of stillMissing) {
            prefixRows.push(...(db.prepare(
              `SELECT DISTINCT title, author, work_id FROM books WHERE work_id IS NOT NULL AND work_id != '' AND title LIKE ?`
            ).all(normalizeTitle(b.title) + '%') as any[]));
          }
          for (const [id, wid] of resolveMissingWorkIds(stillMissing, prefixRows)) {
            workIdByBook.set(id, wid);
          }
        }
      }

      console.log(chalk.cyan.bold(`\n🏷️ Step: Checking ${listBooks.length} books against tag_books for "${tag}" (>= ${minShelves} shelves)...`));
      const outliers = findBelowTagShelves(listBooks, tagShelvesIndex, workIdByBook, minShelves);
      const byId = new Map(outliers.map(o => [o.bookId, o] as const));
      for (const book of listBooks) {
        const out = byId.get(String(book.id));
        if (!out) continue;
        const reason = out.count === undefined
          ? `NOT SHELVED AS "${tag}" (no tag_books row)`
          : `SHELVED ${out.count} < ${minShelves}`;
        const bookLink = formatBookLink(book.title, book.id);
        const authorStr = book.author ? ` by ${book.author}` : '';
        console.log(chalk.red.bold(`   ❌ OUTLIER: [${reason}] ${bookLink}${authorStr} (Pos: ${book.position})`));
        await appendToAuditReport(listTitle, `[${reason}] ${book.title}${authorStr} [ID: ${book.id}]`);
        outliersFound++;
        belowTagShelves.push(bookLink);
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
    if (belowTagShelves.length > 0) console.log(chalk.red.bold(`\n❌ Below "${tag}" shelf threshold: ${belowTagShelves.join(' and ')}`));

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
    result.belowTagShelves = belowTagShelves.length;

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
