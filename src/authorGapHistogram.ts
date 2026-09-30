import chalk from 'chalk';
import { iterateBooks } from './storage.js';
import type { CachedBook } from './storage.js';
import { normalizeAuthorName, looksLikeNameConcat } from './authorOrphans.js';

const formatNum = (n: number): string => n.toLocaleString('en-US');

const MIN_YEAR = 1800;
const FUTURE_SLACK = 3;
const GAP_WINDOW_YEARS = 40;
const GAP_CAP = GAP_WINDOW_YEARS;

export interface AuthorGapBucket {
  label: string;
  min: number | null; // gap in years; null => catch-all (Unknown date) bucket
  max: number | null;
}

export interface AuthorGapResult {
  buckets: AuthorGapBucket[];
  counts: number[];
  totalAuthors: number; // distinct authors seen (all buckets + exclusions)
  qualified: number;    // authors histogrammed into a gap bucket
  unknownAuthors: number;
  noGapAuthors: number; // single known publication year (excluded entirely)
  outOfRange: number;   // newest year outside the 40-year window
}

export function extractYear(published: string | undefined | null): number | null {
  if (!published) return null;
  const m = String(published).match(/(\d{4})/);
  if (!m) return null;
  const y = Number(m[1]);
  if (y >= 1000 && y <= 2100) return y;
  return null;
}

function authorKey(book: CachedBook): { key: string } {
  const name = normalizeAuthorName(book.author || 'Unknown');
  const id = book.authorId && String(book.authorId).length ? String(book.authorId) : undefined;
  return id ? { key: `id:${id}` } : { key: `name:${name}` };
}

// For each author, the largest gap (in years) between consecutive publication
// years across their whole career. An author qualifies only when their NEWEST
// book is within the last 40 years ([now - 40, now + FUTURE_SLACK]); their gap
// is then computed over ALL of their cached years, not just the window. Gap 0
// means 2+ books all published in the same year. Authors with a single known
// publication have no gap at all and are excluded entirely (counted in
// `noGapAuthors`). Authors whose books all lack a parseable year land in an
// "Unknown date" catch-all bucket. `now` and `cap` are injectable for tests.
export function computeAuthorMaxGap(
  books: Iterable<CachedBook>,
  now: number = new Date().getFullYear(),
  cap: number = GAP_CAP
): AuthorGapResult {
  const cutoff = now - GAP_WINDOW_YEARS;
  const maxYear = now + FUTURE_SLACK;

  const byAuthor = new Map<string, { years: Set<number>; knownCount: number }>();
  for (const book of books) {
    if (book.isBad) continue;
    if (looksLikeNameConcat(book.author)) continue;
    const { key } = authorKey(book);
    const year = extractYear(book.published);
    let entry = byAuthor.get(key);
    if (!entry) {
      entry = { years: new Set(), knownCount: 0 };
      byAuthor.set(key, entry);
    }
    if (year != null) {
      entry.years.add(year);
      entry.knownCount++;
    }
  }

  const gapCounts = new Array(cap + 1).fill(0) as number[];
  let tail = 0;
  let unknown = 0;
  let noGap = 0;
  let outOfRange = 0;

  for (const { years, knownCount } of byAuthor.values()) {
    if (knownCount === 0) { unknown++; continue; }
    const sorted = [...years].sort((a, b) => a - b);
    const newest = sorted[sorted.length - 1];
    if (newest < cutoff || newest < MIN_YEAR || newest > maxYear) { outOfRange++; continue; }
    if (knownCount < 2) { noGap++; continue; }
    let gap = 0;
    for (let i = 1; i < sorted.length; i++) {
      const d = sorted[i] - sorted[i - 1];
      if (d > gap) gap = d;
    }
    if (gap <= cap) gapCounts[gap]++;
    else tail++;
  }

  const buckets: AuthorGapBucket[] = [];
  const counts: number[] = [];
  for (let g = 0; g <= cap; g++) {
    if (gapCounts[g] > 0) {
      buckets.push({ label: String(g), min: g, max: g });
      counts.push(gapCounts[g]);
    }
  }
  if (tail > 0) {
    buckets.push({ label: `${cap + 1}+`, min: null, max: null });
    counts.push(tail);
  }
  if (unknown > 0) {
    buckets.push({ label: 'Unknown date', min: null, max: null });
    counts.push(unknown);
  }

  const qualified = byAuthor.size - unknown - noGap - outOfRange;

  return {
    buckets, counts,
    totalAuthors: byAuthor.size,
    qualified,
    unknownAuthors: unknown,
    noGapAuthors: noGap,
    outOfRange,
  };
}

export async function runAuthorGapHistogram(): Promise<void> {
  const { buckets, counts, totalAuthors, qualified, unknownAuthors, noGapAuthors, outOfRange } =
    computeAuthorMaxGap(iterateBooks());

  console.log(chalk.cyan.bold('\n📚 Author Publication-Gap Histogram'));
  console.log(chalk.gray('   For each author whose newest book is within the last 40 years, the largest'));
  console.log(chalk.gray('   gap (in years) between consecutive publication years across their whole career.'));
  console.log(chalk.gray(`   Gap 0 = all books in one year. Excluded: ${formatNum(totalAuthors - qualified - unknownAuthors)} (${formatNum(noGapAuthors)} single-publication, ${formatNum(outOfRange)} newest book outside the past 40y).`));

  const LABEL = 'GAP';
  const LW = Math.max(LABEL.length, ...buckets.map(b => b.label.length)) + 1;
  const CW = Math.max(5, ...counts.map(c => formatNum(c).length));
  // Gap buckets are % of the qualified cohort (authors whose newest book is in
  // the past 40y and who have a measurable gap); the Unknown-date catch-all is
  // % of ALL authors, mirroring the sibling newest-year histogram.
  const denominator = (i: number) => buckets[i].min == null ? totalAuthors : qualified;
  const pctOf = (count: number, i: number) => {
    const base = denominator(i);
    return base > 0 ? ((count / base) * 100).toFixed(1) + '%' : '0.0%';
  };
  const PW = Math.max(1, ...counts.map((c, i) => pctOf(c, i).length));

  const rule = '-'.repeat(LW + CW + PW + 7);
  console.log(chalk.gray(rule));
  console.log(chalk.white(`${LABEL.padEnd(LW)} | ${'COUNT'.padStart(CW)} | ${'%'.padStart(PW)}`));
  console.log(chalk.gray(rule));

  for (let i = 0; i < buckets.length; i++) {
    const count = counts[i];
    const label = buckets[i].min == null
      ? chalk.gray(buckets[i].label.padEnd(LW))
      : chalk.white(buckets[i].label.padEnd(LW));
    const coloredCount = count > 0 ? chalk.yellow(formatNum(count).padStart(CW)) : chalk.gray(formatNum(count).padStart(CW));
    const pctStr = chalk.green(pctOf(count, i).padStart(PW));
    console.log(`${label} | ${coloredCount} | ${pctStr}`);
  }

  console.log(chalk.gray(rule));
  console.log(chalk.gray(`Gap buckets = % of ${formatNum(qualified)} qualified authors (newest book within the past 40y, has a gap); "Unknown date" = % of all ${formatNum(totalAuthors)} authors.`));
  console.log(chalk.cyan.bold(`Authors: ${formatNum(totalAuthors)} — ${formatNum(qualified)} qualified`));
}