import chalk from 'chalk';
import { getDb } from './db.js';
import { loadTagBooks, TagBookRow } from './storage.js';

export interface TagHistogramRow {
  tag: string;
  total: number;
  singleTag: number;
  pct: number; // 0-100 for singleTag
  upTo2: number; // books on 1 or 2 tags
  pctUpTo2: number; // 0-100 for upTo2
  ratingsMin?: number;
  ratingsMax?: number;
  ratingsAvg?: number;
  shelvesMin?: number;
  shelvesMax?: number;
}

export interface TagHistogramResult {
  rows: TagHistogramRow[];
  totalRows: number;
}

// For each tag, compute the share of books that are shelved under that tag
// AND under no other tag (i.e. they appear in exactly one distinct tag in
// tag_books). start of a broader tag-analysis command. Optionally enrich with
// min/max/avg rating counts per tag via a bookId -> ratings map.
export function computeTagHistogram(rows: TagBookRow[], ratingsByBook?: Map<string, number>): TagHistogramResult {
  const bookTagCount = new Map<string, number>();
  const tagBooks = new Map<string, Set<string>>();
  const tagShelved = new Map<string, Map<string, number>>();

  for (const row of rows) {
    bookTagCount.set(row.bookId, (bookTagCount.get(row.bookId) ?? 0) + 1);
    if (!tagBooks.has(row.tagName)) tagBooks.set(row.tagName, new Set());
    tagBooks.get(row.tagName)!.add(row.bookId);
    if (row.shelved != null) {
      if (!tagShelved.has(row.tagName)) tagShelved.set(row.tagName, new Map());
      tagShelved.get(row.tagName)!.set(row.bookId, row.shelved);
    }
  }

  const result: TagHistogramRow[] = [];
  for (const [tag, books] of tagBooks) {
    const total = books.size;
    let singleTag = 0;
    let upTo2 = 0;
    let ratingsMin: number | undefined;
    let ratingsMax: number | undefined;
    let ratingsSum = 0;
    let ratingsCount = 0;
    const shelvedByBook = tagShelved.get(tag);
    let shelvesMin: number | undefined;
    let shelvesMax: number | undefined;
    for (const bookId of books) {
      const tagCount = bookTagCount.get(bookId) ?? 0;
      if (tagCount === 1) singleTag++;
      if (tagCount <= 2) upTo2++;
      const r = ratingsByBook?.get(bookId);
      if (r != null && r > 0) {
        if (ratingsMin === undefined || r < ratingsMin) ratingsMin = r;
        if (ratingsMax === undefined || r > ratingsMax) ratingsMax = r;
        ratingsSum += r;
        ratingsCount++;
      }
      const s = shelvedByBook?.get(bookId);
      if (s != null) {
        if (shelvesMin === undefined || s < shelvesMin) shelvesMin = s;
        if (shelvesMax === undefined || s > shelvesMax) shelvesMax = s;
      }
    }
    const pct = total > 0 ? (singleTag / total) * 100 : 0;
    const pctUpTo2 = total > 0 ? (upTo2 / total) * 100 : 0;
    result.push({
      tag,
      total,
      singleTag,
      pct,
      upTo2,
      pctUpTo2,
      ratingsMin,
      ratingsMax,
      ratingsAvg: ratingsCount > 0 ? ratingsSum / ratingsCount : undefined,
      shelvesMin,
      shelvesMax,
    });
  }

  result.sort((a, b) => a.pct - b.pct || b.total - a.total);

  return { rows: result, totalRows: rows.length };
}

function formatPct(pct: number): string {
  return pct.toFixed(1).padStart(5) + '%';
}

function formatNum(n?: number): string {
  return n != null ? n.toLocaleString() : '—';
}

export type TagHistogramSortKey =
  | 'pct'
  | 'pct2'
  | 'single'
  | 'upTo2'
  | 'total'
  | 'tag'
  | 'ratings'
  | 'shelves';

const SORT_KEY_ALIASES: Record<string, TagHistogramSortKey> = {
  pct: 'pct',
  single: 'single',
  singlepct: 'pct',
  up2: 'upTo2',
  upto2: 'upTo2',
  pct2: 'pct2',
  pctupto2: 'pct2',
  total: 'total',
  tag: 'tag',
  ratings: 'ratings',
  shelves: 'shelves',
};

// Sort value for a histogram row given a sort key. Percentages sort ascending
// (lower = fewer single/up-to-2-only books, the exploratory default); everything
// else sorts descending by magnitude. `tag` is a string.
function sortValue(row: TagHistogramRow, key: TagHistogramSortKey): number {
  switch (key) {
    case 'pct': return row.pct;
    case 'pct2': return row.pctUpTo2;
    case 'single': return row.singleTag;
    case 'upTo2': return row.upTo2;
    case 'total': return row.total;
    case 'ratings': return row.ratingsAvg ?? -1;
    case 'shelves': return row.shelvesMax ?? -1;
    case 'tag': return 0;
  }
}

function compareRows(a: TagHistogramRow, b: TagHistogramRow, key: TagHistogramSortKey): number {
  if (key === 'tag') return a.tag.localeCompare(b.tag);
  const av = sortValue(a, key);
  const bv = sortValue(b, key);
  if (key === 'pct' || key === 'pct2') {
    return av - bv || b.total - a.total;
  }
  return bv - av;
}

export function parseTagHistogramSortKey(sortBy: string): TagHistogramSortKey {
  const key = SORT_KEY_ALIASES[sortBy.trim().toLowerCase()];
  if (key) return key;
  throw new Error(`Unknown sortBy "${sortBy}". Expected one of: pct, pct2, single, upTo2, total, ratings, shelves, tag`);
}

export async function runTagHistogram(options: { limit?: string; min?: string; asc?: boolean; sortBy?: string } = {}): Promise<void> {
  const rows = await loadTagBooks();
  const db = getDb();
  // Load rating counts for every book referenced in tag_books.
  const ids = [...new Set(rows.map(r => r.bookId))];
  const ratingsByBook = new Map<string, number>();
  for (const id of ids) {
    const row = db.prepare('SELECT ratings FROM books WHERE id = ?').get(id) as any;
    if (row && row.ratings != null) ratingsByBook.set(id, Number(row.ratings));
  }
  const hist = computeTagHistogram(rows, ratingsByBook);

  const limit = parseInt(options.limit || '25', 10);
  const min = parseInt(options.min || '0', 10);
  const sortBy = options.sortBy ? parseTagHistogramSortKey(options.sortBy) : 'pct';
  const asc = options.asc !== undefined ? !!options.asc : false;

  let shown = hist.rows.filter(r => r.total >= min);
  if (asc) {
    shown = [...shown].sort((a, b) => -compareRows(a, b, sortBy));
  } else {
    shown = [...shown].sort((a, b) => compareRows(a, b, sortBy));
  }
  shown = shown.slice(0, limit);

  console.log(chalk.cyan.bold(`\n📊 Tag histogram — books shelved under only one tag`));
  console.log(chalk.gray('----------------------------------------------------------------------'));
  console.log(chalk.gray(`   Rows: all tags in tag_books (${hist.rows.length.toLocaleString()} tags, ${hist.totalRows.toLocaleString()} tag-book memberships)`));
  console.log(chalk.gray(`   Showing up to ${limit} tags with at least ${min} book${min === 1 ? '' : 's'}; lower % = fewer single-tag-only books`));
  console.log(chalk.gray(`   Rating columns = min/max/avg count of ratings across the tag's books`));
  const isPctKey = sortBy === 'pct' || sortBy === 'pct2';
  const direction = isPctKey ? (asc ? 'descending' : 'ascending') : (asc ? 'ascending' : 'descending');
  console.log(chalk.gray(`   Sort: ${sortBy} (${direction}) · percent keys default to ascending (least first), count keys to descending`));
  console.log('');

  if (shown.length === 0) {
    console.log(chalk.yellow('   (no tags match the current filters)'));
    return;
  }

  const maxLen = Math.max(...shown.map(r => r.tag.length), 'tag'.length);
  const RATIO_W = 12;
  const PCT_W = 7;
  const RATING_W = 11;
  const COL_SP = 3;

  const padTag = (t: string) => t.padEnd(maxLen, ' ');
  const padCell = (s: string, w: number) => s.padStart(w, ' ');
  const pctCell = (row: TagHistogramRow, pct: number) => {
    const raw = formatPct(pct).padStart(PCT_W, ' '); // e.g. "  0.0%"
    return pct >= 90 ? chalk.green(raw) : pct >= 50 ? chalk.yellow(raw) : chalk.red(raw);
  };

  const headerCells = [
    padTag('tag'),
    padCell('single/total', RATIO_W),
    padCell('pct', PCT_W),
    padCell('<=2/total', RATIO_W),
    padCell('pct2', PCT_W),
    padCell('ratings min', RATING_W),
    padCell('ratings max', RATING_W),
    padCell('ratings avg', RATING_W),
    padCell('shelves min', RATING_W),
    padCell('shelves max', RATING_W),
  ].join(' '.repeat(COL_SP));
  const header = `   ${headerCells}`;
  const divider = chalk.gray('   ' + '-'.repeat(headerCells.length + COL_SP * 9));
  console.log(chalk.gray(header));
  console.log(divider);
  for (const row of shown) {
    const ratio = `${row.singleTag.toLocaleString()}/${row.total.toLocaleString()}`;
    const ratio2 = `${row.upTo2.toLocaleString()}/${row.total.toLocaleString()}`;
    const ratingsMin = row.ratingsMin != null ? row.ratingsMin.toLocaleString() : '—';
    const ratingsMax = row.ratingsMax != null ? row.ratingsMax.toLocaleString() : '—';
    const ratingsAvg = row.ratingsAvg != null ? Math.round(row.ratingsAvg).toLocaleString() : '—';
    const shelvesMin = row.shelvesMin != null ? row.shelvesMin.toLocaleString() : '—';
    const shelvesMax = row.shelvesMax != null ? row.shelvesMax.toLocaleString() : '—';
    const line = [
      padTag(row.tag),
      padCell(ratio, RATIO_W),
      pctCell(row, row.pct),
      padCell(ratio2, RATIO_W),
      pctCell(row, row.pctUpTo2),
      padCell(ratingsMin, RATING_W),
      padCell(ratingsMax, RATING_W),
      padCell(ratingsAvg, RATING_W),
      padCell(shelvesMin, RATING_W),
      padCell(shelvesMax, RATING_W),
    ].join(' '.repeat(COL_SP));
    console.log(`   ${line}`);
  }
  console.log(divider);
  console.log(chalk.gray('   single-tag = book appears in exactly one distinct tag in tag_books; <=2 = book appears in one or two tags.'));
  console.log(chalk.gray('   A low % means books in that tag tend to also live under other tags.'));
  console.log(chalk.gray('   shelves = number of times each book is shelved under that tag; min/max across the tag\'s books.'));
  console.log();
}
