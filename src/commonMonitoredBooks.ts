import chalk from 'chalk';
import { loadState, loadBookCache, State, BookCache, CachedBook } from './storage.js';
import { getYear, formatBookLink } from './utils.js';

export interface CommonMonitoredOptions {
  limit?: string;
}

export interface CommonMonitoredBook {
  bookId: string;
  listCount: number;
  listTitles: string[];
  book: CachedBook;
}

export interface CommonMonitoredResult {
  results: CommonMonitoredBook[];
  totalLists: number;
  totalDistinctBooks: number;
  uncached: number;
  excluded: number;
}

export function findCommonMonitoredBooks(
  state: State,
  bookCache: BookCache,
  limit = 20,
  filter?: (bookId: string, book: CachedBook) => boolean
): CommonMonitoredResult {
  const countMap = new Map<string, { count: number; listTitles: string[] }>();

  for (const list of Object.values(state.lists || {})) {
    const title = list.title || 'Unknown list';
    for (const bookId of list.seenBookIds || []) {
      const entry = countMap.get(bookId) || { count: 0, listTitles: [] };
      entry.count++;
      entry.listTitles.push(title);
      countMap.set(bookId, entry);
    }
  }

  const results: CommonMonitoredBook[] = [];
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
    results.push({ bookId, listCount: entry.count, listTitles: entry.listTitles, book });
  }

  const parseRatings = (r?: string): number => parseInt((r || '0').replace(/,/g, ''), 10) || 0;

  results.sort((a, b) => {
    if (b.listCount !== a.listCount) return b.listCount - a.listCount;
    const ra = parseRatings(a.book.ratings);
    const rb = parseRatings(b.book.ratings);
    if (rb !== ra) return rb - ra;
    return a.book.title.localeCompare(b.book.title);
  });

  return {
    results: results.slice(0, limit),
    totalLists: Object.keys(state.lists || {}).length,
    totalDistinctBooks: countMap.size,
    uncached,
    excluded
  };
}

export function printCommonMonitoredBooks(result: CommonMonitoredResult, title: string, limit: number): void {
  console.log(chalk.cyan.bold(`\n${title}`));
  console.log(chalk.gray(`   Monitored lists: ${result.totalLists}`));
  console.log(chalk.gray(`   Distinct books across lists: ${result.totalDistinctBooks}`));
  console.log(chalk.gray(`   Limit: Top ${limit} books`));
  console.log(chalk.gray('------------------------------------------'));

  if (result.results.length === 0) {
    console.log(chalk.yellow('   No books found.'));
  }

  for (let i = 0; i < result.results.length; i++) {
    const { book, listCount, listTitles } = result.results[i];
    const ratings = book.ratings ? `Ratings: ${chalk.yellow(book.ratings)}` : 'Ratings: N/A';
    const avg = book.avgRating ? `Avg: ${chalk.green.bold(book.avgRating)}` : 'Avg: N/A';
    const year = getYear(book.published);
    const yearStr = year !== null ? `Year: ${year}` : 'Year: N/A';
    const pages = book.pages ? `, Pages: ${book.pages}` : '';

    console.log(
      `${(i + 1).toString().padStart(4, ' ')}. ${chalk.cyan.bold(formatBookLink(book.title, book.id))}\n` +
      `      by ${book.author} | ${yearStr}${pages}, ${ratings}, ${avg}\n` +
      `      in ${listCount} list${listCount === 1 ? '' : 's'}: ${listTitles.join(', ')}`
    );
  }

  console.log(chalk.gray('------------------------------------------'));
  const footerParts = [
    `Total books with list counts: ${result.results.length.toLocaleString()} (Displayed: ${result.results.length}`
  ];
  if (result.uncached > 0) footerParts.push(`Not in cache: ${result.uncached.toLocaleString()}`);
  if (result.excluded > 0) footerParts.push(`Excluded: ${result.excluded.toLocaleString()}`);
  console.log(chalk.cyan(`${footerParts.join(', ')})`));
  console.log('');
}

export async function runCommonMonitoredBooks(options: CommonMonitoredOptions = {}): Promise<void> {
  const limit = options.limit ? parseInt(options.limit, 10) : 20;

  const state = await loadState();
  const bookCache = await loadBookCache();

  const result = findCommonMonitoredBooks(state, bookCache, limit);

  printCommonMonitoredBooks(result, '🔍 Most Common Monitored Books', limit);
}
