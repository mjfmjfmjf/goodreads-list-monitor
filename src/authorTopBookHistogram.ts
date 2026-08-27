import chalk from 'chalk';
import { loadBookCache, loadAuthorCache } from './storage.js';
import type { CachedBook } from './storage.js';
import { normalizeAuthorName } from './authorOrphans.js';

const formatNum = (n: number): string => n.toLocaleString('en-US');

export interface RatingBucket {
  label: string;
  min: number;
  max: number;
}

export interface AuthorTopBookHistogramOptions {
  topN?: string;
  minRatings?: string;
  maxRatings?: string;
}

// Custom collapsed brackets for THIS command (author top-book). Millions,
// thousands, and hundreds collapse into three wide bands; everything between
// stays granular to match the full ratings-histogram output. Kept local so
// this histogram can't inherit/drift from changes to the book-cache one.
export function buildAuthorBucketBuckets(): RatingBucket[] {
  const granular = (scale: number): RatingBucket[] => {
    const out: RatingBucket[] = [];
    for (let digit = 9; digit >= 1; digit--) {
      const min = digit * scale;
      const max = (digit + 1) * scale - 1;
      out.push({ label: `${formatNum(min)} to ${formatNum(max)}`, min, max });
    }
    return out;
  };

  // Millions collapse into a single wide band; hundreds of thousands down to
  // tens of thousands stay granular; then the thousands and hundreds bands
  // collapse; tens and units stay granular. Kept local (not shared with the
  // book-cache histogram) so the two can't drift.
  return [
    { label: '> 1,000,000', min: 1_000_000, max: Infinity },
    ...granular(100_000),
    ...granular(10_000),
    { label: '1,000 to 10,000', min: 1_000, max: 9_999 },
    { label: '100 to 1,000', min: 100, max: 999 },
    ...granular(10),
    ...Array.from({ length: 10 }, (_, k) => 9 - k).map(d => ({
      label: formatNum(d), min: d, max: d,
    })),
  ];
}

// A stable identity key for grouping books by author. authorId is the REAL join
// key between the book cache and author cache; the author name string is only a
// human label and is unreliable (whitespace + multi-author concatenation junk).
// Prefer id:{authorId}, falling back to name:{normalized} when there's no id.
function authorKey(book: CachedBook): { key: string; id?: string; name: string } {
  const name = normalizeAuthorName(book.author || 'Unknown');
  const id = book.authorId && String(book.authorId).length ? String(book.authorId) : undefined;
  return id ? { key: `id:${id}`, id, name } : { key: `name:${name}`, name };
}

// For each author in the book cache, find their highest-rated (largest rating
// count) book, then bin it into the collapsed brackets above.
export function computeAuthorTopBookHistogram(
  books: CachedBook[],
  knownAuthorNames: ReadonlySet<string> = new Set<string>(),
  knownAuthorIds: ReadonlySet<string> = new Set<string>()
): {
  counts: number[];
  totalAuthors: number;
  inAuthorCache: number;
  notInAuthorCache: number;
} {
  const buckets = buildAuthorBucketBuckets();
  const counts = new Array<number>(buckets.length).fill(0);

  // key -> { rating, id?, name }
  const topByAuthor = new Map<string, { rating: number; id?: string; name: string }>();
  for (const book of books) {
    const { key, id, name } = authorKey(book);
    const r = parseInt((book.ratings || '0').replace(/,/g, ''), 10) || 0;
    const prev = topByAuthor.get(key);
    if (!prev || r > prev.rating) topByAuthor.set(key, { rating: r, id, name });
  }

  for (const { rating } of topByAuthor.values()) {
    for (let i = 0; i < buckets.length; i++) {
      if (rating >= buckets[i].min && rating <= buckets[i].max) {
        counts[i]++;
        break;
      }
    }
  }

  let inAuthorCache = 0;
  let notInAuthorCache = 0;
  for (const { id, name } of topByAuthor.values()) {
    if ((id && knownAuthorIds.has(id)) || knownAuthorNames.has(name)) inAuthorCache++;
    else notInAuthorCache++;
  }

  return { counts, totalAuthors: topByAuthor.size, inAuthorCache, notInAuthorCache };
}

// Running counts matching ./ratingsHistogram.sh. Given per-bucket counts ordered
// high-to-low (idx 0 = highest band), at row i:
//   cumGE[i] = Σ counts[0..i]      (this band + every higher band) -> "CUM >="
//   cumLE[i] = Σ counts[i..end]     (this band + every lower band) -> "CUM <="
export function computeCumulatives(counts: number[]): { cumGE: number[]; cumLE: number[] } {
  const cumGE = new Array<number>(counts.length).fill(0);
  let a = 0;
  for (let i = 0; i < counts.length; i++) { a += counts[i]; cumGE[i] = a; }
  const cumLE = new Array<number>(counts.length).fill(0);
  let b = 0;
  for (let i = counts.length - 1; i >= 0; i--) { b += counts[i]; cumLE[i] = b; }
  return { cumGE, cumLE };
}

export async function runAuthorTopBookHistogram(): Promise<void> {
  const bookCache = await loadBookCache();
  const authorCache = await loadAuthorCache();
  const authorNames = new Set(Object.keys(authorCache));
  const authorIds = new Set(Object.values(authorCache).map(e => String(e.id)));

  const books = Object.values(bookCache);
  const buckets = buildAuthorBucketBuckets();
  const { counts, totalAuthors, inAuthorCache, notInAuthorCache } =
    computeAuthorTopBookHistogram(books, authorNames, authorIds);

  console.log(chalk.cyan.bold('\n🏆 Author Top-Book Ratings Histogram'));
  console.log(chalk.gray('   For each author, take their highest-rated book (by rating count) and bin it.'));
  console.log(chalk.gray(`   Authors: ${formatNum(totalAuthors)} — ${formatNum(inAuthorCache)} in author cache, ${formatNum(notInAuthorCache)} not.`));

  const LW = Math.max(...buckets.map(b => b.label.length)) + 1;
  const CW = Math.max(5, ...counts.map(c => formatNum(c).length));
  const pctOf = (count: number) =>
    totalAuthors > 0 ? ((count / totalAuthors) * 100).toFixed(1) + '%' : '0.0%';
  const PW = Math.max(4, ...counts.map(c => pctOf(c).length)); // header: %

  // Running counts. Buckets are ordered high-to-low (idx 0 = the
  // `> 1,000,000` band). `cumGE` builds up from the bottom of the table so at
  // row i it holds the sum of this band plus every lower (higher index) band
  // -> authors whose top book has >= this band's ratings (CUM >=). `cumLE`
  // Running counts, matching ./ratingsHistogram.sh's column semantics where
  // buckets are high-to-low (idx 0 = highest). At row i:
  //   CUM >= = Σ counts[0..i]  (this band + every higher band)
  //   CUM <= = Σ counts[i..end] (this band + every lower band)
  const cumGE = new Array<number>(buckets.length).fill(0);
  {
    let acc = 0;
    for (let i = 0; i < buckets.length; i++) {
      acc += counts[i];
      cumGE[i] = acc;
    }
  }
  const cumLE = new Array<number>(buckets.length).fill(0);
  {
    let acc = 0;
    for (let i = buckets.length - 1; i >= 0; i--) {
      acc += counts[i];
      cumLE[i] = acc;
    }
  }

  const FORW = Math.max('CUM >='.length, ...counts.map(c => formatNum(c).length));
  const rule = '-'.repeat(LW + CW + PW + FORW * 2 + 11);

  console.log(chalk.gray(rule));
  console.log(
    chalk.white(
      'RATING BRACKET'.padEnd(LW) + ' | ' +
      'COUNT'.padStart(CW) + ' | ' +
      '%'.padStart(PW) + ' | ' +
      'CUM >='.padStart(FORW) + ' | ' +
      'CUM <='.padStart(FORW)
    )
  );
  console.log(chalk.gray(rule));

  for (let i = 0; i < buckets.length; i++) {
    const count = counts[i];
    const countStr = formatNum(count).padStart(CW);
    const pctStr = pctOf(count).padStart(PW);
    const coloredCount = count > 0 ? chalk.yellow(countStr) : chalk.gray(countStr);
    const cumGEStr = chalk.magenta(formatNum(cumGE[i]).padStart(FORW));
    const cumLEStr = chalk.magenta(formatNum(cumLE[i]).padStart(FORW));
    console.log(
      `${chalk.white(buckets[i].label.padEnd(LW))} | ${coloredCount} | ${chalk.cyan(pctStr)} | ${cumGEStr} | ${cumLEStr}`
    );
  }

  console.log(chalk.gray(rule));
  console.log(chalk.cyan.bold(`Authors: ${formatNum(totalAuthors)}`));
}
