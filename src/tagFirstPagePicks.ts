import chalk from 'chalk';
import { loadTagBooks, TagBookRow, loadBookCache, BookCache, CachedBook } from './storage.js';
import { loadLibraryExport, loadLibraryExportCache, matchesReviewed, LibraryExport } from './libraryExport.js';
import { getYear, formatBookLink } from './utils.js';

export interface TagFirstPagePicksOptions {
  limit?: string;
  library?: string;
  export?: string;
  import?: string;
  terse?: boolean;
  includeReviewed?: boolean;
}

export interface TagFirstPagePick {
  bookId: string;
  tagCount: number; // number of distinct tags where this book sits on the first page (position 1-50)
  tagNames: string[];
  book: CachedBook;
}

export interface TagFirstPageResult {
  results: TagFirstPagePick[];
  totalTags: number;
  totalDistinctBooks: number;
  uncached: number;
  excluded: number;
}

const FIRST_PAGE_MAX = 50;

// Books picked by breadth of tag exposure: count the distinct tags whose FIRST
// PAGE (position 1-50 on the tag's shelf) each cached book appears on. The most
// popular first-page books are the ones cropping up early across many tags.
export function findTagFirstPagePicks(
  rows: TagBookRow[],
  bookCache: BookCache,
  limit = 20,
  filter?: (bookId: string, book: CachedBook) => boolean
): TagFirstPageResult {
  const countMap = new Map<string, { count: number; tags: string[] }>();

  for (const row of rows) {
    if (row.position == null || row.position < 1 || row.position > FIRST_PAGE_MAX) continue;
    const entry = countMap.get(row.bookId) || { count: 0, tags: [] };
    entry.count++;
    entry.tags.push(row.tagName);
    countMap.set(row.bookId, entry);
  }

  const results: TagFirstPagePick[] = [];
  let uncached = 0;
  let excluded = 0;

  for (const [bookId, entry] of countMap) {
    const book = bookCache[bookId];
    if (!book) {
      uncached++;
      continue;
    }
    if (book.isBad || book.title === 'Unknown') continue;
    if (filter && !filter(bookId, book)) {
      excluded++;
      continue;
    }
    results.push({ bookId, tagCount: entry.count, tagNames: entry.tags, book });
  }

  const parseRatings = (r?: string): number => parseInt((r || '0').replace(/,/g, ''), 10) || 0;

  results.sort((a, b) => {
    if (b.tagCount !== a.tagCount) return b.tagCount - a.tagCount;
    const ra = parseRatings(a.book.ratings);
    const rb = parseRatings(b.book.ratings);
    if (rb !== ra) return rb - ra;
    return a.book.title.localeCompare(b.book.title);
  });

  return {
    results: results.slice(0, limit),
    totalTags: new Set(rows.filter(r => r.position != null && r.position >= 1 && r.position <= FIRST_PAGE_MAX).map(r => r.tagName)).size,
    totalDistinctBooks: countMap.size,
    uncached,
    excluded,
  };
}

export function printTagFirstPagePicks(result: TagFirstPageResult, title: string, limit: number): void {
  console.log(chalk.cyan.bold(`\n${title}`));
  console.log(chalk.gray(`   Tags with first-page data: ${result.totalTags}`));
  console.log(chalk.gray(`   Distinct books on a tag first page: ${result.totalDistinctBooks}`));
  console.log(chalk.gray(`   Limit: Top ${limit} books`));
  console.log(chalk.gray('------------------------------------------'));

  if (result.results.length === 0) {
    console.log(chalk.yellow('   No books found.'));
  }

  for (let i = 0; i < result.results.length; i++) {
    const { book, tagCount, tagNames } = result.results[i];
    const ratings = book.ratings ? `Ratings: ${chalk.yellow(book.ratings)}` : 'Ratings: N/A';
    const avg = book.avgRating ? `Avg: ${chalk.green.bold(book.avgRating)}` : 'Avg: N/A';
    const year = getYear(book.published);
    const yearStr = year !== null ? `Year: ${year}` : 'Year: N/A';
    const pages = book.pages ? `, Pages: ${book.pages}` : '';

    console.log(
      `${(i + 1).toString().padStart(4, ' ')}. ${chalk.cyan.bold(formatBookLink(book.title, book.id))}\n` +
      `      by ${book.author} | ${yearStr}${pages}, ${ratings}, ${avg}\n` +
      `      first page of ${tagCount} tag${tagCount === 1 ? '' : 's'}: ${tagNames.join(', ')}`
    );
  }

  console.log(chalk.gray('------------------------------------------'));
  const footerParts = [`Total books on tag first pages: ${result.totalDistinctBooks.toLocaleString()} (Displayed: ${result.results.length})`];
  if (result.uncached > 0) footerParts.push(`Not in cache: ${result.uncached.toLocaleString()}`);
  if (result.excluded > 0) footerParts.push(`Excluded (already reviewed): ${result.excluded.toLocaleString()}`);
  console.log(chalk.cyan(`${footerParts.join(', ')}`));
  console.log('');
}

export async function runTagFirstPagePicks(options: TagFirstPagePicksOptions = {}): Promise<void> {
  const limit = options.limit ? parseInt(options.limit, 10) : 20;
  const includeReviewed = options.includeReviewed === true;
  const exportPath = options.export || options.import;

  let library: LibraryExport | null = null;
  let filter: ((bookId: string, book: CachedBook) => boolean) | undefined;
  if (!includeReviewed) {
    if (exportPath) {
      library = await loadLibraryExport(exportPath, options.library);
    } else {
      library = await loadLibraryExportCache(options.library);
      if (!library) {
        console.error(chalk.red.bold('Error: No library export cache found. Run once with --export <path> (or --import <path>) to import + cache your Goodreads library export.'));
        process.exit(1);
      }
    }
    filter = (bookId, book) => !matchesReviewed(library!, bookId, book.title, book.author);
  }

  const rows = await loadTagBooks();
  const bookCache = await loadBookCache();

  const result = findTagFirstPagePicks(rows, bookCache, limit, filter);

  if (includeReviewed) {
    console.log(chalk.gray('   Exclude already-reviewed: no (--includeReviewed)'));
  } else {
    const source = library!.cachedAt
      ? `cached: ${library!.sourcePath.split('/').pop()} (imported ${library!.cachedAt.slice(0, 10)})`
      : library!.sourcePath;
    console.log(chalk.gray(`   Exclude already-reviewed: yes (${source})`));
  }

  if (options.terse) {
    console.log(chalk.gray(`   Limit: Top ${limit} books`));
    for (let i = 0; i < result.results.length; i++) {
      const { book, tagCount } = result.results[i];
      const year = getYear(book.published);
      const yearStr = year !== null ? year : 'Unknown';
      const pages = book.pages ? `${book.pages} pages` : 'N/A';
      console.log(
        `${(i + 1).toString().padStart(4, ' ')}. ${chalk.cyan.bold(formatBookLink(book.title, book.id))} by ${book.author} | Year: ${yearStr} | Pages: ${pages} | ${tagCount} tag${tagCount === 1 ? '' : 's'}`
      );
    }
    return;
  }

  printTagFirstPagePicks(result, '🔍 Most Popular First-Page Tag Books', limit);
}