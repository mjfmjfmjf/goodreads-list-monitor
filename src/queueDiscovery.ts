import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { scrapeListBooks } from './scraper.js';
import { loadBookCache, CachedBook } from './storage.js';
import { ListEntry } from './tagConfig.js';
import { getYear, normalizeTitle, normalizeAuthor, formatDate, delay, formatBookLink } from './utils.js';
import { matchesRegex } from './bookMatch.js';
import { parseSeriesPos, matchesSeriesPos, SERIES_POS_STANDALONE, SERIES_POS_MULTI } from './seriesPos.js';
import { looksLikeNameConcat } from './authorOrphans.js';

const AUDIT_REPORT = path.join(process.cwd(), 'auditReport.txt');
const DEFAULT_BULK_CONFIG_FILE = path.join(process.cwd(), 'bulkAuditConfig.json');

interface DiscoveryResult {
  list: ListEntry;
  toAdd: string[];
}

function isSameBook(book1: { id: string, title: string, author: string }, book2: { id: string, title: string, author: string }): boolean {
  if (book1.id === book2.id) return true;
  
  const title1 = normalizeTitle(book1.title);
  const title2 = normalizeTitle(book2.title);
  const auth1 = normalizeAuthor(book1.author);
  const auth2 = normalizeAuthor(book2.author);
  
  return title1 === title2 && auth1 === auth2;
}

// Decide whether a discovery candidate is effectively already on the list.
// Two signals, either of which counts:
//  1. The list contains the same exact edition (by id) or a normalize-equal
//     title+author (isSameBook).
//  2. A harvested workId is available for BOTH the candidate edition and some
//     list book edition — same workId => same book under a different
//     edition/translation title (e.g. "Vindens skugga" vs "The Shadow of the
//     Wind"). This is what lets the queue make use of the workIds we harvest.
export function isAlreadyOnList(
  sb: { id: string; title: string; author: string },
  listBooks: { id: string; title: string; author: string }[],
  listWorkIds: ReadonlySet<string>,
  sbWorkId?: string,
): boolean {
  if (listBooks.some(lb => isSameBook(sb, lb))) return true;
  if (sbWorkId !== undefined && listWorkIds.has(sbWorkId)) return true;
  return false;
}

// Collect every workId we can attribute to a book already on the list. We try
// two ways, in order:
//  1. The exact list-book id is in our cache and carries a workId.
//  2. The list-book's authorId+title matches a cached edition of ours with a
//     workId. This matters because lists often show a DIFFERENT edition id than
//     the one we harvested, so the exact-id lookup misses even when we DO know
//     the work's workId from a sibling edition.
// Translations with different titles still can't be resolved without a workId
// on both sides, but this catches the common same-title/different-edition case.
export function resolveListWorkIds(
  listBooks: { id: string; authorId?: string; title: string }[],
  bookCache: Record<string, CachedBook>,
): Set<string> {
  const byAuthor = new Map<string, CachedBook[]>();
  for (const b of Object.values(bookCache)) {
    if (!b.authorId) continue;
    const arr = byAuthor.get(b.authorId);
    if (arr) arr.push(b);
    else byAuthor.set(b.authorId, [b]);
  }

  const workIds = new Set<string>();
  for (const lb of listBooks) {
    const exact = bookCache[lb.id]?.workId;
    if (exact) {
      workIds.add(exact);
      continue;
    }
    if (!lb.authorId) continue;
    const listTitle = normalizeTitle(lb.title);
    for (const cand of byAuthor.get(lb.authorId) ?? []) {
      if (cand.workId && normalizeTitle(cand.title) === listTitle) {
        workIds.add(cand.workId);
        break;
      }
    }
  }
  return workIds;
}

async function appendToAuditReport(listTitle: string, message: string): Promise<void> {
  const timestamp = new Date().toLocaleString();
  const entry = `[${timestamp}] [${listTitle}] ${message.trim()}\n`;
  await fs.appendFile(AUDIT_REPORT, entry);
}

function sortBooks(books: CachedBook[], sortBy: 'year' | 'ratings' | 'avg'): CachedBook[] {
  return [...books].sort((a, b) => {
    if (sortBy === 'year') {
      const yearA = getYear(a.published) ?? Infinity;
      const yearB = getYear(b.published) ?? Infinity;
      if (yearA !== yearB) return yearA - yearB;
    } else if (sortBy === 'avg') {
      const avgA = parseFloat(a.avgRating || '0');
      const avgB = parseFloat(b.avgRating || '0');
      if (avgA !== avgB) return avgB - avgA;
    }
    
    const ratingsA = parseInt(a.ratings.replace(/,/g, ''), 10) || 0;
    const ratingsB = parseInt(b.ratings.replace(/,/g, ''), 10) || 0;
    return ratingsB - ratingsA;
  });
}

// Prune discovery candidates so we only propose ONE book per work (the
// highest-rated edition) and never propose obvious data-quality junk.
export function pruneCandidates(candidates: CachedBook[]): CachedBook[] {
  // 1. Drop run-together multi-author concatenations (e.g. "Mark TwainGeorge
  //    Eliot", "Charles DickensWilhelm HauffE.T.A. HoffmannLudwig Bechstein") —
  //    these are cache artifacts, not clean books the user wants to queue.
  const clean = candidates.filter(c => !looksLikeNameConcat(c.author));

  const ratingsOf = (c: CachedBook): number => parseInt(c.ratings.replace(/,/g, ''), 10) || 0;
  const normKey = (c: CachedBook): string => `${normalizeTitle(c.title)}|${normalizeAuthor(c.author)}`;
  const keepBest = (m: Map<string, CachedBook>, k: string, c: CachedBook): void => {
    const prev = m.get(k);
    if (!prev || ratingsOf(c) > ratingsOf(prev)) m.set(k, c);
  };

  // 2. Collapse by normalized title+author. normalizeAuthor already strips
  //    trailing "(Narrator)"/"(Translator)" etc., so "Jim Gaffigan" and
  //    "Jim Gaffigan(Narrator)" merge here — even when one of them lacks a
  //    cached workId (this is what catches the Dad Is Fat edition pair).
  const byTitle = new Map<string, CachedBook>();
  for (const c of clean) keepBest(byTitle, normKey(c), c);

  // 3. Then merge any survivors that share a workId — catches editions of the
  //    same work whose titles differ (e.g. "The Adventures of Tom Sawyer" vs
  //    "Las aventuras de Tom Sawyer"), keeping the highest-rated.
  const merged: CachedBook[] = [];
  const seenWork = new Set<string>();
  for (const c of byTitle.values()) {
    const existing = c.workId ? merged.find(m => m.workId === c.workId) : undefined;
    if (existing) {
      if (ratingsOf(c) > ratingsOf(existing)) merged[merged.indexOf(existing)] = c;
      continue;
    }
    merged.push(c);
    if (c.workId) seenWork.add(c.workId);
  }
  return merged;
}

export async function runQueueDiscovery(
  customConfigFile?: string,
  globalOptions: { sortBy?: string; minAvg?: string; maxAvg?: string; listId?: string } = {}
): Promise<void> {
  const configFile = customConfigFile ? path.resolve(process.cwd(), customConfigFile) : DEFAULT_BULK_CONFIG_FILE;

  if (!(await fs.pathExists(configFile))) {
    throw new Error(`Bulk config file not found at: ${configFile}. Run gen-bulk-config first.`);
  }

  let lists: ListEntry[] = await fs.readJson(configFile);
  if (globalOptions.listId) {
    lists = lists.filter(l => l.id === globalOptions.listId);
    if (lists.length === 0) {
      throw new Error(`List ID "${globalOptions.listId}" not found in config file: ${path.basename(configFile)}`);
    }
  }
  const bookCache = await loadBookCache();
  const allCachedBooks = Object.values(bookCache);

  const sortBy = (globalOptions.sortBy || 'ratings') as 'year' | 'ratings' | 'avg';
  const globalMinAvg = globalOptions.minAvg ? parseFloat(globalOptions.minAvg) : 0;
  const globalMaxAvg = globalOptions.maxAvg ? parseFloat(globalOptions.maxAvg) : Infinity;

  console.log(chalk.cyan.bold(`\n🔦 Starting Queue Discovery`));
  console.log(chalk.gray(`   Config: ${path.basename(configFile)}`));
  console.log(chalk.gray(`   Sort By: ${sortBy}`));
  if (globalMinAvg > 0 || globalMaxAvg < Infinity) {
    console.log(chalk.gray(`   Global Avg: ${globalMinAvg}-${globalMaxAvg}`));
  }
  console.log(chalk.gray(`   Total cached books: ${allCachedBooks.length}\n`));

  const finalResults: DiscoveryResult[] = [];
  let totalMissing = 0;

  for (let i = 0; i < lists.length; i++) {
    const listEntry = lists[i];
    console.log(chalk.yellow.bold(`\n--------------------------------------------------`));
    console.log(chalk.yellow.bold(`📋 DISCOVER [${i + 1}/${lists.length}]: ${listEntry.nickname} - ${listEntry.officialTitle} (ID: ${listEntry.id})`));
    console.log(chalk.yellow.bold(`--------------------------------------------------`));

    const criteria = listEntry.criteria;
    const minVal = criteria.min || 0;
    const maxVal = criteria.max || Infinity;
    const minYear = criteria.minYear || 0;
    const maxYear = criteria.maxYear || Infinity;
    const minAvg = Math.max(criteria.minAvg || 0, globalMinAvg);
    const maxAvg = Math.min(criteria.maxAvg || Infinity, globalMaxAvg);

    // Show the active filter conditions, mirroring the audit command output
    if (minVal > 0 || maxVal < Infinity) console.log(chalk.gray(`   - Ratings Criteria: ${minVal} to ${maxVal === Infinity ? 'Any' : maxVal}`));
    if (minYear > 0 || maxYear < Infinity) console.log(chalk.gray(`   - Year Criteria: ${minYear} to ${maxYear === Infinity ? 'Any' : maxYear}`));
    if (minAvg > 0 || maxAvg < Infinity) console.log(chalk.gray(`   - Avg Rating Criteria: ${minAvg} to ${maxAvg === Infinity ? 'Any' : maxAvg}`));
    if (criteria.seriesPos !== undefined) {
      const seriesPosLabel = criteria.seriesPos === SERIES_POS_STANDALONE
        ? 'standalone'
        : criteria.seriesPos === SERIES_POS_MULTI
          ? 'multi-volume (boxed set)'
          : `pos ${criteria.seriesPos}`;
      console.log(chalk.gray(`   - Series Position: ${seriesPosLabel} (equals)`));
    }
    const regexParts: string[] = [];
    if (criteria.titleRegex) regexParts.push(`Title: /${criteria.titleRegex}/`);
    if (criteria.authorLastRegex) regexParts.push(`Author Last: /${criteria.authorLastRegex}/`);
    if (criteria.authorFirstRegex) regexParts.push(`Author First: /${criteria.authorFirstRegex}/`);
    if (regexParts.length > 0) console.log(chalk.gray(`   - Regex Criteria: ${regexParts.join(', ')}`));

    // Filter cached books for this list's criteria
    const candidates = allCachedBooks.filter(book => {
      if (book.isBad) return false;
      if (!book.title || book.title === 'Unknown') return false;

      // Ratings check
      const bookRatings = parseInt(book.ratings.replace(/,/g, ''), 10) || 0;
      if (bookRatings < minVal || bookRatings > maxVal) return false;

      // Avg Rating check
      if (!book.avgRating) {
        if (minAvg > 0 || maxAvg < Infinity) return false;
      } else {
        const bookAvg = parseFloat(book.avgRating);
        if (bookAvg < minAvg || bookAvg > maxAvg) return false;
      }

      // Year check
      const bookYear = getYear(book.published);
      if (minYear > 0 || maxYear < Infinity) {
        if (bookYear === null || bookYear < minYear || bookYear > maxYear) return false;
      }

      // Regex check
      const regexCriterion = {
        titleRegex: criteria.titleRegex,
        authorLastRegex: criteria.authorLastRegex,
        authorFirstRegex: criteria.authorFirstRegex
      };
      if (!matchesRegex(book, regexCriterion)) return false;

      // Series position check
      if (criteria.seriesPos !== undefined) {
        const bookSeriesPos = parseSeriesPos(book.title) ?? book.seriesPos;
        if (!matchesSeriesPos(criteria.seriesPos, bookSeriesPos)) return false;
      }

      return true;
    });

    if (candidates.length === 0) {
      console.log(chalk.gray(`   ⏩ Skipping list: No cached books meet the criteria for this category.`));
      continue;
    }

    // Sort the candidate books
    const sortedCandidates = sortBooks(candidates, sortBy);

    // Drop multi-author concatenation junk and collapse duplicate editions of
    // the same work down to one, so the queue proposes each work only once
    // instead of surfacing editions that would show as duplicates if added.
    const prunedCandidates = pruneCandidates(sortedCandidates);

    const toAdd: string[] = [];

    console.log(chalk.gray(`   📥 Fetching list content to check against ${prunedCandidates.length} candidate(s)...`));
    const listBooks = await scrapeListBooks(listEntry.id);
    console.log(chalk.gray(`   Found ${listBooks.length} books on list.`));

    // Resolve every list book to a workId via the cache. Editions/translations
    // of one work share the same Goodreads workId, so once we've harvested a
    // workId for ANY edition of a book already on the list, we can recognize a
    // differently-titled candidate edition (e.g. "Vindens skugga" vs "The
    // Shadow of the Wind") as already-on-list instead of proposing it as missing.
    const listWorkIds = resolveListWorkIds(listBooks, bookCache);

    for (const sb of prunedCandidates) {
      const sbWorkId = bookCache[sb.id]?.workId;
      const alreadyOnList = isAlreadyOnList(sb, listBooks, listWorkIds, sbWorkId);
      if (!alreadyOnList) {
        const pubInfo = sb.published !== 'Unknown' ? `, Pub: ${formatDate(sb.published)}` : '';
        const avgStr = sb.avgRating ? `, Avg: ${sb.avgRating}` : '';
        const bookLink = formatBookLink(sb.title, sb.id);
        const workStr = sbWorkId ? ` · work:${sbWorkId}` : '';
        const msg = `[MISSING] ${bookLink} by ${sb.author} (Ratings: ${sb.ratings}${avgStr}${pubInfo})${workStr}`;
        console.log(chalk.green.bold(`   ➕ ${msg}`));
        await appendToAuditReport(listEntry.officialTitle, msg);
        toAdd.push(bookLink);
      }
    }

    if (toAdd.length > 0) {
      finalResults.push({ list: listEntry, toAdd });
      totalMissing += toAdd.length;
      console.log(chalk.green.bold(`   🔍 Found ${toAdd.length} missing entr${toAdd.length === 1 ? 'y' : 'ies'} for this list.`));
    } else {
      console.log(chalk.gray(`   ✅ No missing entries for this list.`));
    }

    await delay(1000, 3000);
  }

  // FINAL GLOBAL SUMMARY
  console.log(chalk.cyan.bold(`\n\n==================================================`));
  console.log(chalk.cyan.bold(`🏁 FINAL QUEUE DISCOVERY SUMMARY`));
  console.log(chalk.cyan.bold(`   Total missing entries found: ${totalMissing}`));
  console.log(chalk.cyan.bold(`==================================================`));

  if (finalResults.length === 0) {
    console.log(chalk.green.bold('\n   ✅ No missing books found for any of the lists!'));
  } else {
    for (const res of finalResults) {
      console.log(chalk.white.bold(`\n📌 ${res.list.nickname} (${res.list.officialTitle})`));
      const msg = `   Scale of additions needed: ${res.toAdd.length} books`;
      console.log(chalk.yellow(msg));
      const listMsg = `   ✅ SHOULD ADD: ${res.toAdd.join(' and ')}`;
      console.log(chalk.green.bold(listMsg));
      await appendToAuditReport('SUMMARY', `[${res.list.nickname}] ${listMsg}`);
    }
  }

  console.log(chalk.cyan.bold(`\nQueue discovery complete. All results saved to auditReport.txt.`));
}
