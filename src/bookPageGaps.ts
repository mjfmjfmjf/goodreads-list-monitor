import chalk from 'chalk';
import { getDb } from './db.js';

export interface BookPageGapOptions {
  /** Pool size: the top-N book editions by ratings to inspect (default 100000). */
  top?: number;
  /** How many top missing works to list (default 50). */
  limit?: number;
}

export interface BookPageGapStats {
  /** Requested scan size (after clamp to the book cache size). */
  scanTop: number;
  /** Ratings count of the Nth biggest book edition (the cutoff). */
  cutoffRatings: number | null;
  /** Book editions actually scanned (== scanTop, unless the cache is smaller). */
  scannedEditions: number;
  /** Distinct works found by collapsing editions on normalized title+author. */
  uniqueWorks: number;
  /** Works where at least one edition has a book_page row. */
  coveredWorks: number;
  /** Works where NO edition has a book_page row. */
  missingWorks: number;
}

export interface MissingWorkRow {
  /** Rank among missing works, ordered by the work's top ratings. */
  rank: number;
  /** Highest-rated uncovered edition id (what to feed the next scrape). */
  topId: string;
  title: string;
  author: string;
  ratings: number;
  avgRating: number | null;
  /** Editions scanned for this work. */
  editions: number;
  coveredEditions: number;
  uncoveredEditions: number;
}

interface TopBookRow {
  id: string;
  title: string;
  author: string;
  ratings: number;
  avgRating: number | null;
  covered: boolean;
}

// Strips a trailing "(Series, #N)"-style parenthetical and common edition /
// format suffixes so different editions of the same work collapse to one key.
const SERIES_SUFFIX_RE = /^(.+?)\s*\((?:[^()]*?\s#\s*\d+|.*?[Ee]dition)[^)]*\)\s*(?:\[[^\]]*\]\s*)*$/;
const EDITION_SUFFIX_RE = /\s*(?:\([^()]*?\)|\[[^\]]*\])\s*$/;

export function workKey(title: string, author: string): string {
  const normalized = title
    .replace(SERIES_SUFFIX_RE, '$1')
    .replace(EDITION_SUFFIX_RE, '')
    .replace(/\s+/g, ' ')
    .replace(/[’‘]/g, "'")
    .trim()
    .toLowerCase();
  return `${author.trim().toLowerCase()}\u001f${normalized}`;
}

export function hasBookPageTable(): boolean {
  const db = getDb();
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='book_page'`).get();
}

function scanTopBooks(top: number): TopBookRow[] {
  const db = getDb();
  const poolCount = Number((db.prepare(`SELECT COUNT(*) AS c FROM books`).get() as any).c);
  const scanTop = Math.max(1, Math.min(Math.floor(top), poolCount));
  const rows = db.prepare(`
    SELECT b.id, b.title, b.author, b.ratings, b.avg_rating,
           CASE WHEN bp.book_id IS NULL THEN 0 ELSE 1 END AS covered
    FROM books b
    LEFT JOIN book_page bp ON bp.book_id = b.id
    ORDER BY b.ratings DESC, b.id
    LIMIT ?
  `).all(scanTop) as any[];
  return rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    author: r.author as string,
    ratings: Number(r.ratings) || 0,
    avgRating: r.avg_rating != null ? Number(r.avg_rating) : null,
    covered: !!r.covered,
  }));
}

export function computeBookPageGapStats(top: number): BookPageGapStats {
  const books = scanTopBooks(top);
  const cutoff = books[books.length - 1];
  const byWork = new Map<string, MissingWorkRow>();
  for (const b of books) {
    const key = workKey(b.title, b.author);
    const w = byWork.get(key);
    if (w) {
      w.editions += 1;
      if (b.covered) w.coveredEditions += 1;
      else w.uncoveredEditions += 1;
      if (!b.covered && b.ratings > w.ratings) {
        w.ratings = b.ratings;
        w.avgRating = b.avgRating;
        w.title = b.title;
        w.topId = b.id;
      }
    } else {
      byWork.set(key, {
        rank: byWork.size,
        topId: b.id,
        title: b.title,
        author: b.author,
        ratings: b.ratings,
        avgRating: b.avgRating,
        editions: 1,
        coveredEditions: b.covered ? 1 : 0,
        uncoveredEditions: b.covered ? 0 : 1,
      });
    }
  }
  const works = [...byWork.values()];
  const coveredWorks = works.filter((w) => w.coveredEditions > 0).length;
  return {
    scanTop: books.length,
    cutoffRatings: cutoff ? cutoff.ratings : null,
    scannedEditions: books.length,
    uniqueWorks: works.length,
    coveredWorks,
    missingWorks: works.length - coveredWorks,
  };
}

export function listMissingTopBooks(top: number, limit: number): MissingWorkRow[] {
  const books = scanTopBooks(top);
  const byWork = new Map<string, MissingWorkRow>();
  for (const b of books) {
    const key = workKey(b.title, b.author);
    const w = byWork.get(key);
    if (w) {
      w.editions += 1;
      if (b.covered) w.coveredEditions += 1;
      else w.uncoveredEditions += 1;
      if (!b.covered && b.ratings > w.ratings) {
        w.ratings = b.ratings;
        w.avgRating = b.avgRating;
        w.title = b.title;
        w.topId = b.id;
      }
    } else {
      byWork.set(key, {
        rank: byWork.size,
        topId: b.id,
        title: b.title,
        author: b.author,
        ratings: b.ratings,
        avgRating: b.avgRating,
        editions: 1,
        coveredEditions: b.covered ? 1 : 0,
        uncoveredEditions: b.covered ? 0 : 1,
      });
    }
  }
  return [...byWork.values()]
    .filter((w) => w.coveredEditions === 0)
    .sort((a, b) => b.ratings - a.ratings || a.title.localeCompare(b.title))
    .slice(0, Math.max(1, Math.floor(limit)))
    .map((w, i) => ({ ...w, rank: i + 1 }));
}

export async function runBookPageGaps(options: BookPageGapOptions = {}): Promise<void> {
  const top = options.top ?? 100000;
  const limit = options.limit ?? 50;

  if (!hasBookPageTable()) {
    console.error(chalk.red.bold('The book_page table does not exist — no browser book-page scrapes have run yet.'));
    return;
  }

  const stats = computeBookPageGapStats(top);
  console.log(chalk.cyan.bold(`\n📊 Top-${stats.scanTop.toLocaleString()} books by ratings vs. browser book-page coverage:`));
  console.log(chalk.gray('----------------------------------------------------------------------'));
  console.log(chalk.gray(`  pool                : top ${stats.scannedEditions.toLocaleString()} book editions by ratings`));
  console.log(
    `  cut-off ratings     : ` +
    (stats.cutoffRatings != null
      ? chalk.yellow(stats.cutoffRatings.toLocaleString().padStart(7)) + chalk.gray(`  (the ${stats.scannedEditions.toLocaleString()}-th biggest book edition)`)
      : chalk.gray('n/a'))
  );
  console.log(chalk.gray(`  distinct works      : ${stats.uniqueWorks.toLocaleString()}  ${chalk.gray(`(editions of the same book collapse to one work)`)}`));
  const coveredPct = stats.uniqueWorks > 0 ? ((stats.coveredWorks / stats.uniqueWorks) * 100).toFixed(1) : '0.0';
  console.log(`  covered works       : ${chalk.yellow(stats.coveredWorks.toLocaleString().padStart(7))} ${chalk.gray(`(${coveredPct}%)`)}`);
  const missingPct = stats.uniqueWorks > 0 ? ((stats.missingWorks / stats.uniqueWorks) * 100).toFixed(1) : '0.0';
  console.log(`  missing works       : ${chalk.yellow(stats.missingWorks.toLocaleString().padStart(7))} ${chalk.gray(`(${missingPct}%)`)}`);

  if (stats.missingWorks === 0) {
    console.log();
    return;
  }

  const missingWorks = listMissingTopBooks(stats.scanTop, limit);
  console.log(chalk.cyan.bold(`\nTop ${Math.min(limit, stats.missingWorks).toLocaleString()} uncovered works by ratings`));
  console.log(chalk.gray('----------------------------------------------------------------------'));
  console.log(
    `  ${'rank'.padEnd(6)} ${'ratings'.padStart(11)} ${'avg'.padStart(5)}  ${'bookId'.padEnd(10)}  title — author` + chalk.gray(`   (editions)`));
  for (const w of missingWorks) {
    const avg = w.avgRating != null ? w.avgRating.toFixed(2) : '—';
    const title = w.title.length > 58 ? w.title.slice(0, 57) + '…' : w.title;
    const editionsNote = w.editions > 1 ? ` (${w.editions} editions, ${w.uncoveredEditions} uncovered)` : '';
    console.log(
      `  ${String(w.rank).padEnd(6)} ${chalk.yellow(String(w.ratings).padStart(11))}` +
      `  ${chalk.gray(avg.padStart(5))}  ${chalk.gray(w.topId.padEnd(10))}  ${title} — ${w.author}` +
      chalk.gray(editionsNote)
    );
  }
  console.log();
}