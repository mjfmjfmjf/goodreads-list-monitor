import chalk from 'chalk';
import { loadBookCache } from './storage.js';
import type { CachedBook } from './storage.js';
import { normalizeAuthorName, looksLikeNameConcat } from './authorOrphans.js';

const formatNum = (n: number): string => n.toLocaleString('en-US');

export interface NewestYearBucket {
  label: string;
  min: number | null; // null => the catch-all (Other/Unknown) bucket
  max: number | null;
}

const MIN_YEAR = 1800;
const FUTURE_SLACK = 3;

// Extract a plausible publication year from a scraped date string ("1945",
// "2013.05.07", "2012.06.20"). Returns null when there's no valid 4-digit year.
export function extractYear(published: string | undefined | null): number | null {
  if (!published) return null;
  const m = String(published).match(/(\d{4})/);
  if (!m) return null;
  const y = Number(m[1]);
  if (y >= 1000 && y <= 2100) return y;
  return null;
}

export type AuthorNewestMode = 'year' | 'decade';
export type AuthorNewestSort = 'year' | 'count';

export interface AuthorNewestResult {
  buckets: NewestYearBucket[];
  counts: number[];
  totalAuthors: number;
  unknownAuthors: number;
  outOfRange: number;
  sort: AuthorNewestSort;
}

// Stable identity key for grouping books by author (authorId preferred, like
// the other author histograms; name only as a fallback label).
function authorKey(book: CachedBook): { key: string } {
  const name = normalizeAuthorName(book.author || 'Unknown');
  const id = book.authorId && String(book.authorId).length ? String(book.authorId) : undefined;
  return id ? { key: `id:${id}` } : { key: `name:${name}` };
}

// Map a year to its bucket identity (per-year, or floor-decade range).
function bucketFor(year: number, mode: AuthorNewestMode): { label: string; min: number; max: number } {
  if (mode === 'year') return { label: String(year), min: year, max: year };
  const start = Math.floor(year / 10) * 10;
  return { label: `${start}-${start + 9}`, min: start, max: start + 9 };
}

// For each author, the newest publication year across their cached books. An
// author's year is out-of-range/Unknown (counted in an "Other" catch-all bucket)
// when ALL their books have an unknown publication date, OR when their newest
// valid year is outside the window [MIN_YEAR, now + FUTURE_SLACK]. Otherwise
// ignore unknown-date books and use the max known year. Multi-author
// concatenated rows are skipped. `now` is injectable for tests.
export function computeAuthorsNewestYear(
  books: CachedBook[],
  mode: AuthorNewestMode = 'year',
  now: number = new Date().getFullYear(),
  sortMode: AuthorNewestSort = 'year'
): AuthorNewestResult {
  const maxYear = now + FUTURE_SLACK;

  const byAuthor = new Map<string, { newest: number; hasKnown: boolean }>();
  for (const book of books) {
    if (book.isBad) continue;
    if (looksLikeNameConcat(book.author)) continue;
    const { key } = authorKey(book);
    const year = extractYear(book.published);
    let entry = byAuthor.get(key);
    if (!entry) {
      entry = { newest: -1, hasKnown: false };
      byAuthor.set(key, entry);
    }
    if (year != null) {
      entry.hasKnown = true;
      if (year > entry.newest) entry.newest = year;
    }
  }

  // OTHERS: track each catch-all cause separately (all-unknown, pre-1800, future).
  const others = { unknown: 0, pre: 0, future: 0 };
  // known range buckets: label -> { min, max, count }
  const known = new Map<string, { min: number; max: number; count: number }>();
  for (const { newest, hasKnown } of byAuthor.values()) {
    if (!hasKnown) { others.unknown++; continue; }
    if (newest < MIN_YEAR) { others.pre++; continue; }
    if (newest > maxYear) { others.future++; continue; }
    const b = bucketFor(newest, mode);
    const e = known.get(b.label) || { min: b.min, max: b.max, count: 0 };
    e.count++;
    known.set(b.label, e);
  }

  const entries = [...known.entries()];
  if (sortMode === 'count') {
    entries.sort((a, b) => b[1].count - a[1].count);
  } else {
    entries.sort((a, b) => a[1].min - b[1].min);
  }

  const buckets: NewestYearBucket[] = entries.map(([label, e]) => ({ label, min: e.min, max: e.max }));
  const counts = entries.map(([, e]) => e.count);

  // Append each non-empty catch-all category as its own labeled row (last).
  if (others.unknown > 0) { buckets.push({ label: 'Unknown date', min: null, max: null }); counts.push(others.unknown); }
  if (others.pre > 0) { buckets.push({ label: `Pre-${MIN_YEAR}`, min: null, max: null }); counts.push(others.pre); }
  if (others.future > 0) { buckets.push({ label: `After ${maxYear}`, min: null, max: null }); counts.push(others.future); }

  return {
    buckets, counts,
    totalAuthors: byAuthor.size,
    unknownAuthors: others.unknown,
    outOfRange: others.pre + others.future,
    sort: sortMode,
  };
}

export async function runAuthorNewestYearHistogram(
  mode: AuthorNewestMode = 'year',
  sortMode: AuthorNewestSort = 'year'
): Promise<void> {
  const bookCache = await loadBookCache();
  const books = Object.values(bookCache);
  const { buckets, counts, totalAuthors, unknownAuthors, outOfRange } = computeAuthorsNewestYear(books, mode, new Date().getFullYear(), sortMode);

  console.log(chalk.cyan.bold('\n📅 Author Newest-Publication Histogram'));
  console.log(chalk.gray(mode === 'decade'
    ? '   For each author, the DECADE of their newest cached publication.'
    : '   For each author, the YEAR of their newest cached publication.'));
  console.log(chalk.gray(`   Authors: ${formatNum(totalAuthors)} — ${formatNum(unknownAuthors)} all-unknown date, ${formatNum(outOfRange)} out-of-range year.`));

  const LABEL = mode === 'decade' ? 'DECADE' : 'YEAR';
  const LW = Math.max(LABEL.length, ...buckets.map(b => b.label.length)) + 1;
  const CW = Math.max(5, ...counts.map(c => formatNum(c).length));
  const pctOf = (count: number) => totalAuthors > 0 ? ((count / totalAuthors) * 100).toFixed(1) + '%' : '0.0%';
  const PW = Math.max(1, ...counts.map(c => pctOf(c).length));

  const rule = '-'.repeat(LW + CW + PW + 7);
  console.log(chalk.gray(rule));
  console.log(chalk.white(`${LABEL.padEnd(LW)} | ${'COUNT'.padStart(CW)} | ${'%'.padStart(PW)}`));
  console.log(chalk.gray(rule));

  for (let i = 0; i < buckets.length; i++) {
    const count = counts[i];
    const isUnknown = buckets[i].min == null;
    const coloredCount = count > 0 ? chalk.yellow(formatNum(count).padStart(CW)) : chalk.gray(formatNum(count).padStart(CW));
    const pctStr = chalk.cyan(pctOf(count).padStart(PW));
    const label = isUnknown ? chalk.gray(buckets[i].label.padEnd(LW)) : chalk.white(buckets[i].label.padEnd(LW));
    console.log(`${label} | ${coloredCount} | ${pctStr}`);
  }

  console.log(chalk.gray(rule));
  console.log(chalk.cyan.bold(`Authors: ${formatNum(totalAuthors)}`));
}
