import chalk from 'chalk';
import { getDb } from './db.js';
import { loadTagBooks, TagBookRow } from './storage.js';

// Every tag harvest stops at the shelf cap (25 pages x 50 books = 1,250), so a
// tag's xref row count ABOVE that is harvest drift — extra (tag, position) rows
// left behind when an earlier harvest saw a different book set on the same page
// — not extra real coverage. Score every tag as if it held at most this many
// books, so a tag with 1,271 drift rows isn't ranked above a clean 1,250 harvest
// for drift alone. Scoring only: picking a tag still contributes ALL of its
// uncovered books, so the 100% coverage guarantee is untouched.
// (If the tag-recent-monitor is ever run with --shelfPages > 25, raise this.)
const BOOKS_PER_SHELF_PAGE = 50;
const MAX_PAGES_PER_HARVEST = 25;
export const SHELF_HARVEST_BOOK_CAP = BOOKS_PER_SHELF_PAGE * MAX_PAGES_PER_HARVEST; // 1,250

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

// Shared loader for both the `tag-coverage` report and the tag-recent-monitor
// (which needs the same set-cover order to decide which tags to tail-scrape).
// Materializes tag_books (1.55M rows) + one batched ratings join.
export interface TagCoverageInputs {
  rows: TagBookRow[];
  ratingsByBook: Map<string, number>;
}

export function loadTagCoverageInputs(): TagCoverageInputs {
  const rows = loadTagBooks();
  const db = getDb();
  const ratingsByBook = new Map<string, number>();
  const ratingRows = db.prepare(`
    SELECT DISTINCT t.book_id AS id, b.ratings AS ratings
    FROM tag_books t JOIN books b ON b.id = t.book_id
    WHERE b.ratings IS NOT NULL
  `).all() as { id: string; ratings?: number | null }[];
  for (const r of ratingRows) {
    if (r.ratings != null) ratingsByBook.set(r.id, Number(r.ratings));
  }
  return { rows, ratingsByBook };
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
  onPick?: (row: TagCoverageRow, index: number) => void,
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

  // Incremental greedy set-cover: keep a running count of not-yet-covered books
  // per tag and a reverse book->tags index, so each pick only touches the chosen
  // tag's books (and the tags losing a covered book) instead of rescanning every
  // tag's full list. Same pick order as a full rescan; ~6,000× fewer reads.
  const pendingCount = new Map<string, number>();
  const bookTags = new Map<string, string[]>();
  for (const [tag, books] of tagBooks) {
    // EXACT, never capped: this is a countdown of still-uncovered books, so
    // capping it here would drive it to 0 while uncovered books remain and stop
    // the greedy short of 100%. The harvest ceiling is applied to the SCORE
    // below instead.
    pendingCount.set(tag, books.size);
    for (const b of books) {
      const tags = bookTags.get(b);
      if (tags) tags.push(tag);
      else bookTags.set(b, [tag]);
    }
  }

  while (covered.size < totalBooks && chosen.length < limit) {
    let bestTag: string | null = null;
    let bestNew = -1;
    for (const [tag] of tagBooks) {
      if (used.has(tag)) continue;
      // Score is capped at the harvest ceiling (SHELF_HARVEST_BOOK_CAP) so
      // (tag, position) drift rows can't make a tag look more important than a
      // clean harvest. Only the RANKING is capped: the pick itself still
      // contributes every uncovered book, so `newBooks` can exceed the score
      // and total coverage still reaches 100%.
      const newCount = Math.min(pendingCount.get(tag) ?? 0, SHELF_HARVEST_BOOK_CAP);
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
        // Book b is now covered — every other tag holding it has one fewer
        // uncoverable book, so decrement their pending counts.
        for (const otherTag of bookTags.get(b) ?? []) {
          if (otherTag !== bestTag) pendingCount.set(otherTag, (pendingCount.get(otherTag) ?? 1) - 1);
        }
      }
    }
    const row: TagCoverageRow = {
      tag: bestTag,
      tagBooks: singleCount.get(bestTag) ?? 0,
      newBooks,
      cumulative: covered.size,
      pct: (covered.size / totalBooks) * 100,
      avgRatings: tagAvgRatings.get(bestTag),
    };
    chosen.push(row);
    if (onPick) onPick(row, chosen.length - 1);
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
  const candSize = Math.min(tagBooks.get(candidate)!.size, SHELF_HARVEST_BOOK_CAP);
  const curSize = Math.min(tagBooks.get(current)!.size, SHELF_HARVEST_BOOK_CAP);
  if (candSize !== curSize) return candSize > curSize;
  const candR = tagAvgRatings.get(candidate) ?? 0;
  const curR = tagAvgRatings.get(current) ?? 0;
  return candR > curR;
}

export async function runTagCoverage(options: { limit?: string | number } = {}): Promise<void> {
  const limit = parseInt(String(options.limit ?? '20'), 10) || 20;

  console.log(chalk.gray('   Loading tag_books + ratings (single batched join)...'));
  const db = getDb();
  const { rows, ratingsByBook } = loadTagCoverageInputs();
  const genreSet = new Set<string>((db.prepare('SELECT name FROM genres').all() as any[]).map(r => r.name));
  const allTags = [...new Set(rows.map(r => r.tagName))];
  const totalBooks = new Set(rows.map(r => r.bookId)).size;

  // Approximate terminal display width: CJK and fullwidth chars occupy 2 columns.
  const charWidth = (ch: string): number =>
    /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE1F\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  const displayWidth = (s: string): number =>
    [...s].reduce((w, ch) => w + charWidth(ch), 0);
  const RANK_W = 3;
  const TAG_W = 14;
  const BOOKS_W = 10;
  const ADDED_W = 9;
  const MISS_W = 10;
  const RATING_W = 12;
  const PCT_W = 8;
  const COL_SP = 3;
  const divCols = 8;
  // Column width is fixed up front from ALL tags (not the chosen subset), so
  // rows can stream out as they are picked instead of buffering until 100%.
  const maxLen = Math.max(...allTags.map(t => displayWidth(t) + (genreSet.has(t) ? 8 : 0)), 'tag'.length);
  const padTag = (t: string) => t + ' '.repeat(Math.max(0, maxLen - displayWidth(t)));
  const padCell = (s: string, w: number) => s.padStart(w, ' ');
  const formatCompact = (n?: number): string => {
    if (n == null) return '—';
    return Math.round(n).toLocaleString('en-US');
  };

  console.log(chalk.cyan.bold('\n🏷️  Tag coverage — least number of tags that cover the most books'));
  console.log(chalk.gray('   Greedy set-cover: each row is the tag that adds the most new (uncovered) books.'));
  console.log(chalk.gray(`   ${totalBooks.toLocaleString()} unique books across ${allTags.length.toLocaleString()} tags`));
  console.log(chalk.gray(`   Showing up to ${limit} tags (or until 100% coverage)`));
  console.log(chalk.gray('------------------------------------------'));
  console.log('');

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
  const divider = chalk.gray('   ' + '-'.repeat(headerCells.length + COL_SP * (divCols - 1)));
  console.log(chalk.gray(header));
  console.log(divider);

  // Each row is printed the moment the greedy loop picks it, so with a big
  // --limit you see output streaming instead of one silent wait for the end.
  const thresholds = [50, 75, 90, 95, 99, 100];
  const crossed = new Set<number>();
  let scanStart = Date.now();
  let lastProgress = Date.now();

  console.log(chalk.gray('   Computing greedy set-cover (rows stream as they are picked)...'));
  const { rows: chosen, totalTags } = computeTagCoverage(rows, limit, ratingsByBook, (row, idx) => {
    const rank = String(idx + 1).padStart(RANK_W);
    const tagBooks = row.tagBooks.toLocaleString();
    const avgRatings = padCell(formatCompact(row.avgRatings), RATING_W);
    const combined = row.cumulative.toLocaleString();
    const missing = Math.max(0, totalBooks - row.cumulative).toLocaleString();

    let pctColored: string;
    if (row.pct >= 90) pctColored = chalk.green(padCell(row.pct.toFixed(1) + '%', PCT_W));
    else if (row.pct >= 70) pctColored = chalk.yellow(padCell(row.pct.toFixed(1) + '%', PCT_W));
    else pctColored = chalk.white(padCell(row.pct.toFixed(1) + '%', PCT_W));

    let marker = '';
    if (crossed.size < thresholds.length && row.pct >= thresholds[crossed.size]) {
      crossed.add(thresholds[crossed.size]);
      marker = `  🎯 ${thresholds[crossed.size]}%`;
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
    // Heartbeat: re-print the progress line once a minute so long runs show
    // they are alive even while the next rank takes a while to compute.
    if (Date.now() - lastProgress > 60_000) {
      lastProgress = Date.now();
      console.log(chalk.gray(`      … still scanning: ${idx + 1}/${Math.min(limit, allTags.length)} tags picked, ${row.cumulative.toLocaleString()} (${row.pct.toFixed(1)}%) covered…`));
    }
  });
  const mins = ((Date.now() - scanStart) / 1000).toFixed(1);

  console.log('');
  console.log(divider);
  console.log(chalk.gray('   books unique = number of books on that tag that appear in exactly one tag (tag-histogram "single")'));
  console.log(chalk.gray('   avg ratings = average rating count across the tag\'s books (tie-breaker when tags add the same new books)'));
  console.log(chalk.gray('   added = new (uncovered) books this tag adds beyond all prior tags'));
  console.log(chalk.gray('   combined = unique books covered after including this tag · coverage % = combined / all unique books'));
  console.log(chalk.gray('   missing = unique books still not covered after this tag (total unique books − combined)'));
  console.log(chalk.gray(`   ${totalBooks.toLocaleString()} unique books across ${totalTags.toLocaleString()} tags · set-cover picked ${chosen.length} tags in ${mins}s (incremental, streamed)`));
  const notPicked = Math.max(0, totalTags - chosen.length);
  const pct = chosen.length ? chosen[chosen.length - 1].pct : 0;
  if (pct >= 100) {
    console.log(chalk.gray(`   ${chosen.length.toLocaleString()} of ${totalTags.toLocaleString()} tags were needed to reach 100% coverage — ${notPicked.toLocaleString()} tags were never read.`));
  } else if (chosen.length >= limit) {
    console.log(chalk.gray(`   Stopped at the ${limit.toLocaleString()}-tag cap (--limit) with ${pct.toFixed(1)}% coverage — raise --limit to see more; the remaining ${notPicked.toLocaleString()} tags were not examined.`));
  }
  console.log();
}
