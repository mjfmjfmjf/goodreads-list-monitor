import chalk from 'chalk';
import { getDb } from './db.js';
import { loadTagBooks, TagBookRow } from './storage.js';

export interface TagCoverageRow {
  tag: string;
  tagBooks: number; // number of books in this tag that appear in exactly one tag (single-tag count)
  newBooks: number; // unique books this tag adds that no prior tag covered
  cumulative: number; // total unique books covered after this tag
  pct: number; // 0-100 cumulative coverage of all unique books
  avgRatings?: number; // average rating count across the tag's books
}

export interface TagCoverageResult {
  rows: TagCoverageRow[];
  totalBooks: number; // unique books across all tags
  totalTags: number;
}

// Greedy approximate set-cover: repeatedly pick the tag that adds the most NEW
// (not-yet-covered) books, so the first few tags give the biggest jumps in
// coverage. Ties are broken by most unique books on the tag, then highest
// average rating count. Return one row per chosen tag (up to `limit`), each
// carrying the cumulative unique-books covered and the running % of all
// unique books.
export function computeTagCoverage(
  rows: TagBookRow[],
  limit: number,
  ratingsByBook?: Map<string, number>,
): TagCoverageResult {
  const tagBooks = new Map<string, Set<string>>();
  const bookTagCount = new Map<string, number>();
  const allBooks = new Set<string>();
  for (const row of rows) {
    if (!tagBooks.has(row.tagName)) tagBooks.set(row.tagName, new Set());
    tagBooks.get(row.tagName)!.add(row.bookId);
    if (!bookTagCount.has(row.bookId)) bookTagCount.set(row.bookId, 0);
    bookTagCount.set(row.bookId, bookTagCount.get(row.bookId)! + 1);
    allBooks.add(row.bookId);
  }

  const totalBooks = allBooks.size;
  const covered = new Set<string>();
  const chosen: TagCoverageRow[] = [];
  const used = new Set<string>();

  // For each tag, the count of its books that appear in exactly one distinct
  // tag (the tag-histogram "single" metric) — the distinctive size of the tag.
  const singleCount = new Map<string, number>();
  for (const [tag, books] of tagBooks) {
    let n = 0;
    for (const b of books) {
      if ((bookTagCount.get(b) ?? 0) === 1) n++;
    }
    singleCount.set(tag, n);
  }

  // For each tag, its average rating count (over books that have one).
  const tagAvgRatings = new Map<string, number>();
  if (ratingsByBook) {
    for (const [tag, books] of tagBooks) {
      let sum = 0;
      let n = 0;
      for (const b of books) {
        const r = ratingsByBook.get(b);
        if (r != null && r > 0) {
          sum += r;
          n++;
        }
      }
      if (n > 0) tagAvgRatings.set(tag, sum / n);
    }
  }

  while (covered.size < totalBooks && chosen.length < limit) {
    let bestTag: string | null = null;
    let bestNew = -1;
    for (const [tag, books] of tagBooks) {
      if (used.has(tag)) continue;
      let newCount = 0;
      for (const b of books) {
        if (!covered.has(b)) newCount++;
      }
      if (
        newCount > bestNew ||
        (newCount === bestNew && bestTag !== null && tieBreakWins(tag, bestTag, tagBooks, tagAvgRatings))
      ) {
        bestNew = newCount;
        bestTag = tag;
      }
    }
    if (bestTag === null || bestNew <= 0) break;
    used.add(bestTag);
    const tagSet = tagBooks.get(bestTag)!;
    let newBooks = 0;
    for (const b of tagSet) {
      if (!covered.has(b)) {
        covered.add(b);
        newBooks++;
      }
    }
    chosen.push({
      tag: bestTag,
      tagBooks: singleCount.get(bestTag) ?? 0,
      newBooks,
      cumulative: covered.size,
      pct: (covered.size / totalBooks) * 100,
      avgRatings: tagAvgRatings.get(bestTag),
    });
  }

  return { rows: chosen, totalBooks, totalTags: tagBooks.size };
}

// When two tags add the same number of new books, prefer the one with more
// unique books on it; if still tied, the one with the higher average ratings.
function tieBreakWins(
  candidate: string,
  current: string,
  tagBooks: Map<string, Set<string>>,
  tagAvgRatings: Map<string, number>,
): boolean {
  const candSize = tagBooks.get(candidate)!.size;
  const curSize = tagBooks.get(current)!.size;
  if (candSize !== curSize) return candSize > curSize;
  const candR = tagAvgRatings.get(candidate) ?? 0;
  const curR = tagAvgRatings.get(current) ?? 0;
  return candR > curR;
}

export async function runTagCoverage(options: { limit?: string | number } = {}): Promise<void> {
  const limit = parseInt(String(options.limit ?? '20'), 10) || 20;

  const rows = await loadTagBooks();
  const db = getDb();
  const genreSet = new Set<string>((db.prepare('SELECT name FROM genres').all() as any[]).map(r => r.name));
  const ids = [...new Set(rows.map(r => r.bookId))];
  const ratingsByBook = new Map<string, number>();
  for (const id of ids) {
    const row = db.prepare('SELECT ratings FROM books WHERE id = ?').get(id) as any;
    if (row && row.ratings != null) ratingsByBook.set(id, Number(row.ratings));
  }
  const { rows: chosen, totalBooks, totalTags } = computeTagCoverage(rows, limit, ratingsByBook);

  console.log(chalk.cyan.bold('\n🏷️  Tag coverage — least number of tags that cover the most books'));
  console.log(chalk.gray('   Greedy set-cover: each row is the tag that adds the most new (uncovered) books.'));
  console.log(chalk.gray(`   ${totalBooks.toLocaleString()} unique books across ${totalTags.toLocaleString()} tags`));
  console.log(chalk.gray(`   Showing up to ${limit} tags (or until 100% coverage)`));
  console.log(chalk.gray('------------------------------------------'));
  console.log('');

  if (chosen.length === 0) {
    console.log(chalk.yellow('   (no tag books loaded)'));
    return;
  }

  const maxLen = Math.max(...chosen.map(r => r.tag.length + (genreSet.has(r.tag) ? 8 : 0)), 'tag'.length);
  const RANK_W = 3;
  const TAG_W = 14;
  const BOOKS_W = 10;
  const ADDED_W = 9;
  const MISS_W = 10;
  const RATING_W = 12;
  const PCT_W = 8;
  const COL_SP = 3;
  const padTag = (t: string) => t.padEnd(maxLen, ' ');
  const padCell = (s: string, w: number) => s.padStart(w, ' ');
  const formatCompact = (n?: number): string => {
    if (n == null) return '—';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
    return String(n);
  };

  const headerCells = [
    padCell('#', RANK_W),
    padTag('tag'),
    padCell('books unique', BOOKS_W),
    padCell('avg ratings', RATING_W),
    padCell('added', ADDED_W),
    padCell('combined', TAG_W),
    padCell('missing', MISS_W),
    padCell('coverage %', PCT_W),
  ].join(' '.repeat(COL_SP));
  const header = `   ${headerCells}`;
  const divCols = 8;
  const divider = chalk.gray('   ' + '-'.repeat(headerCells.length + COL_SP * (divCols - 1)));
  console.log(chalk.gray(header));
  console.log(divider);

  // Mark rows that cross notable coverage thresholds (50/75/90/95/99%).
  const thresholds = [50, 75, 90, 95, 99, 100];
  let nextThreshold = 0;
  const crossed = new Set<number>();

  for (let idx = 0; idx < chosen.length; idx++) {
    const row = chosen[idx];
    const rank = String(idx + 1).padStart(RANK_W);
    const tagBooks = row.tagBooks.toLocaleString();
    const avgRatings = padCell(formatCompact(row.avgRatings), RATING_W);
    const combined = row.cumulative.toLocaleString();
    const missing = Math.max(0, totalBooks - row.cumulative).toLocaleString();

    let pctColored: string;
    if (row.pct >= 99) pctColored = chalk.green(padCell(row.pct.toFixed(1) + '%', PCT_W));
    else if (row.pct >= 90) pctColored = chalk.green(padCell(row.pct.toFixed(1) + '%', PCT_W));
    else if (row.pct >= 70) pctColored = chalk.yellow(padCell(row.pct.toFixed(1) + '%', PCT_W));
    else pctColored = chalk.white(padCell(row.pct.toFixed(1) + '%', PCT_W));

    let marker = '';
    while (nextThreshold < thresholds.length && row.pct >= thresholds[nextThreshold]) {
      if (!crossed.has(thresholds[nextThreshold])) {
        crossed.add(thresholds[nextThreshold]);
        marker = `  🎯 ${thresholds[nextThreshold]}%`;
      }
      nextThreshold++;
    }

    const line = [
      padCell(rank, RANK_W),
      padTag(genreSet.has(row.tag) ? `${row.tag} (genre)` : row.tag),
      padCell(tagBooks, BOOKS_W),
      avgRatings,
      padCell(row.newBooks.toLocaleString(), ADDED_W),
      padCell(combined, TAG_W),
      padCell(missing, MISS_W),
      pctColored,
    ].join(' '.repeat(COL_SP));
    console.log(`   ${line}${marker}`);
  }

  console.log(divider);
  console.log(chalk.gray('   books unique = number of books on that tag that appear in exactly one tag (tag-histogram "single")'));
  console.log(chalk.gray('   avg ratings = average rating count across the tag\'s books (tie-breaker when tags add the same new books)'));
  console.log(chalk.gray('   added = new (uncovered) books this tag adds beyond all prior tags'));
  console.log(chalk.gray('   combined = unique books covered after including this tag · coverage % = combined / all unique books'));
  console.log(chalk.gray('   missing = unique books still not covered after this tag (total unique books − combined)'));
  console.log();
}
