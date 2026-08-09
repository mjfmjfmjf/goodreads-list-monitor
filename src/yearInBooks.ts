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
import { groupFavoriteAuthors } from './favoriteAuthors.js';

export interface YearInBooksOptions {
  year?: string;
  export?: string;
  library?: string;
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

export const DIVIDER = '------------------------------------------';

export interface SectionContext {
  entries: LibraryEntry[];
  bookCache: BookCache;
  reviewYear: number;
}

export interface Section {
  key: string;
  title: string;
  render(ctx: SectionContext): Promise<string[]> | string[];
}

function parsePages(entry: LibraryEntry): number | undefined {
  const n = parseInt(entry.pages, 10);
  return isNaN(n) || n <= 0 ? undefined : n;
}

export function parseRating(entry: LibraryEntry): number | undefined {
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

export function renderStats(entries: LibraryEntry[]): string[] {
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

export function renderRatings(entries: LibraryEntry[]): string[] {
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
  } else {
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
  }

  lines.push(chalk.gray(DIVIDER));

  const reviewLens = entries.map(entry => entry.review.length).filter(n => n > 0);
  if (reviewLens.length === 0) {
    lines.push(chalk.gray('   (no reviews)'));
    return lines;
  }

  const sorted = [...reviewLens].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mean = Math.round(sorted.reduce((sum, n) => sum + n, 0) / sorted.length);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];

  lines.push(chalk.white.bold('   Review length (characters, trimmed):'));
  lines.push(`   Min: ${chalk.white(min.toLocaleString())}  |  Max: ${chalk.white(max.toLocaleString())}`);
  lines.push(`   Mean: ${chalk.white(mean.toLocaleString())}  |  Median: ${chalk.white(median.toLocaleString())} (from ${sorted.length.toLocaleString()} reviews)`);

  return lines;
}

function renderDistribution(ctx: SectionContext): string[] {
  const entries = ctx.entries;
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
  const upper = pubYearUpper(counts, ctx.reviewYear);
  const missingYears = missingPubYears(counts, ctx.reviewYear);
  if (missingYears.length) lines.push(chalk.yellow(`      Missing publication years 1961-${upper} (${missingYears.length}): ${missingYears.join(', ')}`));

  return lines;
}

async function renderFiveStar(ctx: SectionContext): Promise<string[]> {
  const entries = ctx.entries;
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

export function renderFavoriteAuthors(ctx: SectionContext): string[] {
  const entries = ctx.entries;
  const { rows } = groupFavoriteAuthors(entries);
  const qualified = rows.filter(r => r.books >= 3);
  const lines: string[] = [];

  const byBooks = [...qualified]
    .sort((a, b) => b.books - a.books || b.avg - a.avg || a.name.localeCompare(b.name))
    .slice(0, 10);
  const byAvg = [...qualified]
    .sort((a, b) => b.avg - a.avg || b.books - a.books || a.name.localeCompare(b.name))
    .slice(0, 10);

  lines.push(chalk.white.bold('   Top 10 by number of books (min 3):'));
  if (byBooks.length === 0) {
    lines.push(chalk.gray('      (none)'));
  } else {
    byBooks.forEach((row, i) => {
      lines.push(
        `${(i + 1).toString().padStart(6, ' ')}. ${chalk.white(row.name)} — Books: ${chalk.yellow(row.books.toLocaleString())}, Avg my rating: ${chalk.green.bold(row.avg.toFixed(2))}`
      );
    });
  }

  lines.push(chalk.gray(DIVIDER));

  lines.push(chalk.white.bold('   Top 10 by average rating (min 3):'));
  if (byAvg.length === 0) {
    lines.push(chalk.gray('      (none)'));
  } else {
    byAvg.forEach((row, i) => {
      lines.push(
        `${(i + 1).toString().padStart(6, ' ')}. ${chalk.white(row.name)} — Books: ${chalk.yellow(row.books.toLocaleString())}, Avg my rating: ${chalk.green.bold(row.avg.toFixed(2))}`
      );
    });
  }

  return lines;
}

export function renderBookshelves(ctx: SectionContext): string[] {
  const entries = ctx.entries;
  const counts = new Map<string, number>();
  let noShelfBooks = 0;

  for (const entry of entries) {
    const shelves = entry.bookshelves
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (shelves.length === 0) {
      noShelfBooks++;
      continue;
    }
    for (const shelf of shelves) counts.set(shelf, (counts.get(shelf) || 0) + 1);
  }

  if (counts.size === 0) return [chalk.gray('   (no bookshelves)')];

  const lines: string[] = [];
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [shelf, count] of sorted) {
    const pct = (count / entries.length) * 100;
    lines.push(`   ${chalk.white(shelf)}: ${chalk.yellow(count.toLocaleString())} (${pct.toFixed(1)}%)`);
  }
  if (noShelfBooks > 0) lines.push(chalk.gray(`   (${noShelfBooks.toLocaleString()} book${noShelfBooks === 1 ? '' : 's'} had no bookshelves)`));

  return lines;
}

export function renderPublishers(ctx: SectionContext): string[] {
  const entries = ctx.entries;
  const counts = new Map<string, number>();
  let noPublisherBooks = 0;

  for (const entry of entries) {
    const publisher = entry.publisher.replace(/\s+/g, ' ').trim();
    if (!publisher) {
      noPublisherBooks++;
      continue;
    }
    counts.set(publisher, (counts.get(publisher) || 0) + 1);
  }

  if (counts.size === 0) return [chalk.gray('   (no publishers)')];

  const lines: string[] = [];
  lines.push(`   Distinct publishers: ${chalk.white(counts.size.toLocaleString())}`);

  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = sorted.slice(0, 10);

  lines.push(chalk.gray(DIVIDER));
  lines.push(chalk.white.bold('   Top 10 by number of books:'));
  for (const [publisher, count] of top) {
    const pct = (count / entries.length) * 100;
    lines.push(`      ${chalk.white(publisher)}: ${chalk.yellow(count.toLocaleString())} (${pct.toFixed(1)}%)`);
  }
  if (noPublisherBooks > 0) lines.push(chalk.gray(`   (${noPublisherBooks.toLocaleString()} book${noPublisherBooks === 1 ? '' : 's'} had no publisher)`));

  return lines;
}

export const SECTIONS: Section[] = [
  { key: 'stats', title: '📊 Reading stats', render: (ctx) => renderStats(ctx.entries) },
  { key: 'ratings', title: '⭐ Ratings and reviews', render: (ctx) => renderRatings(ctx.entries) },
  { key: 'distribution', title: '📊 Distribution', render: renderDistribution },
  { key: 'five-star', title: '⭐ Five-star books', render: renderFiveStar },
  { key: 'favorite-authors', title: '🏆 Favorite authors', render: renderFavoriteAuthors },
  { key: 'bookshelves', title: '🏷️ Bookshelves', render: renderBookshelves },
  { key: 'publishers', title: '🏢 Publishers', render: renderPublishers }
];

export async function renderSections(sections: Section[], ctx: SectionContext): Promise<void> {
  for (const section of sections) {
    console.log(chalk.white.bold(`\n${section.title}`));
    console.log(chalk.gray(DIVIDER));
    for (const line of await section.render(ctx)) console.log(line);
  }

  console.log(chalk.gray(DIVIDER));
  console.log('');
}

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
  const ctx: SectionContext = { entries, bookCache, reviewYear: parseInt(year, 10) };

  console.log(chalk.cyan.bold(`\n📚 Year in Books — ${year}`));
  console.log(chalk.gray(`   ${entries.length.toLocaleString()} books read + reviewed (read shelf + review text, year from Date Read)`));
  console.log(chalk.gray(DIVIDER));

  await renderSections(SECTIONS, ctx);
}
