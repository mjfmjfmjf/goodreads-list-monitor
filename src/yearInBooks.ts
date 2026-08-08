import chalk from 'chalk';
import { LibraryExport, LibraryEntry } from './libraryExport.js';
import {
  getLibrary,
  reviewedInYear,
  charCounts,
  charBucket,
  publishedCounts,
  missingLetters,
  missingPubYears,
  pubYearUpper,
  mostRecentReviewYear,
  renderCharCountLines,
  renderPublishedYearLines,
  parseYear,
  CharField
} from './library.js';
import { loadBookCache, BookCache } from './storage.js';
import { getYear, formatBookLink } from './utils.js';

export interface YearInBooksOptions {
  year?: string;
  export?: string;
}

const CHAR_FIELDS: CharField[] = ['title', 'authorLast', 'authorFirst'];

const FIELD_HEADERS: Record<CharField, string> = {
  title: 'Title first letter',
  authorLast: 'Author last name',
  authorFirst: 'Author first name'
};

const STAR_LABELS: Record<number, string> = {
  5: 'five-star',
  4: 'four-star',
  3: 'three-star',
  2: 'two-star',
  1: 'one-star'
};

const DIVIDER = '------------------------------------------';

interface SectionContext {
  library: LibraryExport;
  year: string;
  bookCache: BookCache;
}

interface Section {
  key: string;
  title: string;
  render(ctx: SectionContext): Promise<string[]> | string[];
}

function parsePages(entry: LibraryEntry): number | undefined {
  const n = parseInt(entry.pages, 10);
  return isNaN(n) ? undefined : n;
}

function parseRating(entry: LibraryEntry): number | undefined {
  const v = parseFloat(entry.myRating);
  if (isNaN(v) || v === 0) return undefined;
  return v;
}

function exampleText(entries: LibraryEntry[], bucketOf: (entry: LibraryEntry) => string): Map<string, string> {
  const map = new Map<string, string>();
  const sorted = [...entries].sort((a, b) => a.dateRead.localeCompare(b.dateRead));
  for (const entry of sorted) {
    const bucket = bucketOf(entry);
    if (!map.has(bucket)) map.set(bucket, ` — "${entry.title}" by ${entry.author}`);
  }
  return map;
}

function renderStats(entries: LibraryEntry[]): string[] {
  const lines: string[] = [];
  lines.push(`   Books read: ${chalk.white(entries.length.toLocaleString())}`);

  const withPages = entries
    .map(entry => ({ entry, pages: parsePages(entry) }))
    .filter((x): x is { entry: LibraryEntry; pages: number } => x.pages !== undefined);

  if (withPages.length > 0) {
    const totalPages = withPages.reduce((sum, x) => sum + x.pages, 0);
    const missingPages = entries.length - withPages.length;
    const countNote = missingPages > 0 ? ` (${missingPages} books had no page count)` : '';
    lines.push(`   Pages read: ${chalk.white(totalPages.toLocaleString())}${chalk.gray(countNote)}`);

    const sorted = [...withPages].sort((a, b) => a.pages - b.pages);
    const shortest = sorted[0];
    const longest = sorted[sorted.length - 1];
    lines.push(`   Shortest: ${chalk.white(`${shortest.entry.title} by ${shortest.entry.author}`)} — ${shortest.pages} pages`);
    lines.push(`   Longest: ${chalk.white(`${longest.entry.title} by ${longest.entry.author}`)} — ${longest.pages} pages`);

    const mean = Math.round(totalPages / withPages.length);
    const sortedPages = sorted.map(x => x.pages);
    const mid = Math.floor(sortedPages.length / 2);
    const median = sortedPages.length % 2 === 0
      ? Math.round((sortedPages[mid - 1] + sortedPages[mid]) / 2)
      : sortedPages[mid];
    lines.push(`   Mean page length: ${chalk.white(mean.toLocaleString())}  |  Median: ${chalk.white(median.toLocaleString())}`);
  } else {
    lines.push(chalk.gray('   (no books with page counts)'));
  }

  return lines;
}

function renderRatings(entries: LibraryEntry[]): string[] {
  const lines: string[] = [];
  const hist = new Map<number, number>();
  const ratings: number[] = [];
  for (const entry of entries) {
    const rating = parseRating(entry);
    if (rating === undefined) continue;
    ratings.push(rating);
    hist.set(rating, (hist.get(rating) || 0) + 1);
  }

  if (ratings.length === 0) {
    lines.push(chalk.gray('   (no rated books)'));
    return lines;
  }

  const buckets = Array.from(hist.keys()).sort((a, b) => b - a);
  const starText = buckets
    .map(star => {
      const n = hist.get(star) || 0;
      const label = STAR_LABELS[star] ?? `${star}-star`;
      return `${n.toLocaleString()} ${label}${n === 1 ? '' : 's'}`;
    })
    .join(', ');
  lines.push(`   ${chalk.white(starText)}`);

  const average = ratings.reduce((sum, r) => sum + r, 0) / ratings.length;
  lines.push(`   Average rating: ${chalk.white(average.toFixed(2))} (${ratings.length.toLocaleString()} rated)`);

  return lines;
}

function renderDistribution(ctx: SectionContext): string[] {
  const entries = reviewedInYear(ctx.library, ctx.year);
  const lines: string[] = [];

  CHAR_FIELDS.forEach((field, i) => {
    if (i > 0) lines.push(chalk.gray(DIVIDER));
    lines.push(chalk.white.bold(`   ${FIELD_HEADERS[field]}:`));
    const examples = exampleText(entries, entry => charBucket(entry, field));
    lines.push(...renderCharCountLines(entries, field, bucket => examples.get(bucket) || ''));
    const missing = missingLetters(charCounts(entries, field));
    if (missing.length) lines.push(chalk.yellow(`      Missing (${missing.length}): ${missing.join(', ')}`));
  });

  lines.push(chalk.gray(DIVIDER));
  lines.push(chalk.white.bold('   Publication year:'));
  const pubExamples = exampleText(entries, entry => parseYear(entry.published) ?? 'Unknown');
  lines.push(...renderPublishedYearLines(entries, bucket => pubExamples.get(bucket) || ''));
  const counts = publishedCounts(entries);
  const upper = pubYearUpper(counts, parseInt(ctx.year, 10));
  const missingYears = missingPubYears(counts, parseInt(ctx.year, 10));
  if (missingYears.length) lines.push(chalk.yellow(`      Missing publication years 1961-${upper} (${missingYears.length}): ${missingYears.join(', ')}`));

  return lines;
}

async function renderFiveStar(ctx: SectionContext): Promise<string[]> {
  const entries = reviewedInYear(ctx.library, ctx.year);
  const fives = entries.filter(entry => parseRating(entry) === 5);
  if (fives.length === 0) return [chalk.gray('   (none)')];

  return fives.map((entry, i) => {
    const book = ctx.bookCache[entry.id];
    const ratings = book && book.ratings && book.ratings !== '0' ? `Ratings: ${chalk.yellow(book.ratings)}` : 'Ratings: N/A';
    const avg = book?.avgRating ? `Avg: ${chalk.green.bold(book.avgRating)}` : 'Avg: N/A';
    const pubStr = book?.published || entry.published || '';
    const year = getYear(pubStr);
    const yearStr = year !== null ? `Year: ${year}` : 'Year: N/A';
    return (
      `${(i + 1).toString().padStart(4, ' ')}. ${chalk.white(formatBookLink(entry.title, entry.id))}\n` +
      `      by ${entry.author} | ${yearStr}, ${ratings}, ${avg}`
    );
  });
}

const SECTIONS: Section[] = [
  { key: 'stats', title: '📊 Reading stats', render: (ctx) => renderStats(reviewedInYear(ctx.library, ctx.year)) },
  { key: 'ratings', title: '⭐ Ratings', render: (ctx) => renderRatings(reviewedInYear(ctx.library, ctx.year)) },
  { key: 'distribution', title: '📊 Distribution', render: renderDistribution },
  { key: 'five-star', title: '⭐ Five-star books', render: renderFiveStar }
];

export async function runYearInBooks(options: YearInBooksOptions = {}): Promise<void> {
  const library = await getLibrary(options);

  let year = options.year || '';
  if (!year) {
    year = mostRecentReviewYear(library);
    console.log(chalk.gray(`   (No --year given; using most recent review year: ${year})`));
  }
  if (!/^\d{4}$/.test(year)) {
    console.error(chalk.red.bold(`Error: Invalid year "${year}". Use --year <YYYY> or a cached library with Date Read values.`));
    process.exit(1);
  }

  const entries = reviewedInYear(library, year);
  if (entries.length === 0) {
    console.log(chalk.yellow(`   No books read + reviewed in ${year}.`));
    return;
  }

  const bookCache = await loadBookCache();
  const ctx: SectionContext = { library, year, bookCache };

  console.log(chalk.cyan.bold(`\n📚 Year in Books — ${year}`));
  console.log(chalk.gray(`   ${entries.length.toLocaleString()} books read + reviewed (read shelf + review text, year from Date Read)`));
  console.log(chalk.gray(DIVIDER));

  for (const section of SECTIONS) {
    console.log(chalk.white.bold(`\n${section.title}`));
    console.log(chalk.gray(DIVIDER));
    for (const line of await section.render(ctx)) console.log(line);
  }

  console.log(chalk.gray(DIVIDER));
  console.log('');
}
