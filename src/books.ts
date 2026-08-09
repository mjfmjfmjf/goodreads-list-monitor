import chalk from 'chalk';
import path from 'path';
import { loadBookCache, CachedBook } from './storage.js';
import { RegexCriterion, matchesRegex } from './bookMatch.js';
import { getYear, formatBookLink } from './utils.js';
import { loadLibraryExport, loadLibraryExportCache, matchesReviewed, LibraryExport } from './libraryExport.js';

export interface BooksOptions {
  pattern?: string;
  title?: string;
  authorLast?: string;
  authorFirst?: string;
  sort?: string;
  limit?: string;
  minRatings?: string;
  maxRatings?: string;
  minYear?: string;
  maxYear?: string;
  asc?: boolean;
  desc?: boolean;
  includeBad?: boolean;
  excludeReviewed?: boolean;
  export?: string;
  library?: string;
}

type SortField = 'ratings' | 'avgRating' | 'year' | 'title' | 'author';

const SORT_FIELDS: SortField[] = ['ratings', 'avgRating', 'year', 'title', 'author'];

const SORT_LABELS: Record<SortField, string> = {
  ratings: 'Number of Ratings',
  avgRating: 'Average Rating',
  year: 'Publication Year',
  title: 'Title',
  author: 'Author'
};

const parseNum = (s?: string): number => parseInt((s || '0').replace(/,/g, ''), 10) || 0;

export async function runBooks(options: BooksOptions = {}): Promise<void> {
  const sortBy = (options.sort || 'ratings') as SortField;
  if (!SORT_FIELDS.includes(sortBy)) {
    console.error(chalk.red.bold(`Error: --sort must be one of: ${SORT_FIELDS.join(', ')}`));
    process.exit(1);
  }

  let library: LibraryExport | null = null;
  if (options.export) {
    library = await loadLibraryExport(options.export, options.library);
  } else if (options.excludeReviewed) {
    library = await loadLibraryExportCache(options.library);
    if (!library) {
      console.error(chalk.red.bold('Error: No library export cache found. Run once with --export <path> (or --import <path>) to import + cache your Goodreads library export.'));
      process.exit(1);
    }
  }

  const criterion: RegexCriterion = {};
  if (options.title) criterion.titleRegex = options.title;
  if (options.authorLast) criterion.authorLastRegex = options.authorLast;
  if (options.authorFirst) criterion.authorFirstRegex = options.authorFirst;
  if (!options.title && !options.authorLast && !options.authorFirst && options.pattern) {
    criterion.titleRegex = options.pattern;
  }

  let regexError: string | null = null;
  try {
    for (const pattern of [criterion.titleRegex, criterion.authorLastRegex, criterion.authorFirstRegex]) {
      if (pattern) new RegExp(pattern, 'i');
    }
  } catch (error: any) {
    regexError = error.message;
  }
  if (regexError) {
    console.error(chalk.red.bold(`Error: Invalid regex: ${regexError}`));
    process.exit(1);
  }

  const minRatings = options.minRatings !== undefined ? parseNum(options.minRatings) : 0;
  const maxRatings = options.maxRatings !== undefined ? parseNum(options.maxRatings) : Infinity;
  const minYear = options.minYear ? parseInt(options.minYear, 10) : 0;
  const maxYear = options.maxYear ? parseInt(options.maxYear, 10) : Infinity;
  const limit = options.limit ? parseInt(options.limit, 10) : 100;

  const bookCache = await loadBookCache();
  const books = Object.values(bookCache) as CachedBook[];

  const matched: CachedBook[] = [];
  let reviewedExcluded = 0;
  for (const book of books) {
    if (book.isBad && !options.includeBad) continue;
    if (book.title === 'Unknown') continue;

    const ratings = parseNum(book.ratings);
    if (ratings < minRatings || ratings > maxRatings) continue;

    const year = getYear(book.published);
    if (minYear > 0 || maxYear < Infinity) {
      if (year === null || year < minYear || year > maxYear) continue;
    }

    if (!matchesRegex(book, criterion)) continue;
    if (library && options.excludeReviewed && matchesReviewed(library, book.id, book.title, book.author)) {
      reviewedExcluded++;
      continue;
    }
    matched.push(book);
  }

  const valueOf = (book: CachedBook): number | string => {
    switch (sortBy) {
      case 'ratings': return parseNum(book.ratings);
      case 'avgRating': return parseFloat(book.avgRating || '0');
      case 'year': return getYear(book.published) ?? 0;
      case 'title': return (book.title || '').toLowerCase();
      case 'author': return (book.author || '').toLowerCase();
    }
  };

  const naturalDirection = sortBy === 'title' || sortBy === 'author' ? 'asc' : 'desc';
  const direction = options.asc ? 'asc' : (options.desc ? 'desc' : naturalDirection);

  matched.sort((a, b) => {
    const va = valueOf(a);
    const vb = valueOf(b);
    let cmp = 0;
    if (typeof va === 'number' && typeof vb === 'number') {
      cmp = va - vb;
    } else {
      cmp = String(va).localeCompare(String(vb));
    }
    if (cmp === 0) cmp = parseNum(b.ratings) - parseNum(a.ratings);
    if (cmp === 0) cmp = (a.title || '').localeCompare(b.title || '');
    return direction === 'asc' ? cmp : -cmp;
  });

  const countToDisplay = Math.min(matched.length, limit);

  const parts: string[] = [];
  if (criterion.titleRegex) parts.push(`Title: /${criterion.titleRegex}/`);
  if (criterion.authorLastRegex) parts.push(`Author Last Name: /${criterion.authorLastRegex}/`);
  if (criterion.authorFirstRegex) parts.push(`Author First Name: /${criterion.authorFirstRegex}/`);

  console.log(chalk.cyan.bold('\n📚 Book Cache Search'));
  console.log(chalk.gray(`   Match: ${parts.length ? parts.join(' AND ') : 'all books'}`));
  let criteriaMsg = `   Min Ratings: ${minRatings.toLocaleString()}`;
  if (maxRatings < Infinity) criteriaMsg += `, Max Ratings: ${maxRatings.toLocaleString()}`;
  if (minYear > 0 || maxYear < Infinity) criteriaMsg += `, Year: ${minYear}-${maxYear === Infinity ? 'Any' : maxYear}`;
  console.log(chalk.gray(criteriaMsg));
  if (library && options.excludeReviewed) {
    const source = library.cachedAt
      ? `cached: ${path.basename(library.sourcePath)} (imported ${library.cachedAt.slice(0, 10)})`
      : `from ${library.sourcePath}`;
    console.log(chalk.gray(`   Exclude reviewed: yes (${source})`));
  }
  console.log(chalk.gray(`   Sort: ${SORT_LABELS[sortBy]} (${direction}) | Limit: top ${limit}`));
  console.log(chalk.gray('------------------------------------------'));

  if (countToDisplay === 0) {
    console.log(chalk.yellow('   No books found matching the criteria.'));
  }

  for (let i = 0; i < countToDisplay; i++) {
    const book = matched[i];
    const ratings = book.ratings ? `Ratings: ${chalk.yellow(book.ratings)}` : 'Ratings: N/A';
    const avg = book.avgRating ? `Avg: ${chalk.green.bold(book.avgRating)}` : 'Avg: N/A';
    const year = getYear(book.published);
    const yearStr = year !== null ? `Year: ${year}` : 'Year: N/A';

    console.log(
      `${(i + 1).toString().padStart(4, ' ')}. ${chalk.white(formatBookLink(book.title, book.id))}\n` +
      `      by ${book.author} | ${yearStr}, ${ratings}, ${avg}`
    );
  }

  console.log(chalk.gray('------------------------------------------'));
  let footerMsg = `Total books matching: ${matched.length.toLocaleString()} (Displayed: ${countToDisplay})`;
  if (library && options.excludeReviewed) footerMsg += ` | Excluded (already reviewed): ${reviewedExcluded.toLocaleString()}`;
  console.log(chalk.cyan(`${footerMsg}\n`));
}
