import chalk from 'chalk';
import { loadState, loadBookCache } from './storage.js';
import { findCommonMonitoredBooks, printCommonMonitoredBooks } from './commonMonitoredBooks.js';
import { loadLibraryExport, loadLibraryExportCache, matchesReviewed, LibraryExport } from './libraryExport.js';
import { getYear, formatBookLink } from './utils.js';

export interface CommonUnreviewedMonitoredOptions {
  limit?: string;
  library?: string;
  export?: string;
  import?: string;
  terse?: boolean;
}

export async function runCommonUnreviewedMonitoredBooks(options: CommonUnreviewedMonitoredOptions = {}): Promise<void> {
  const limit = options.limit ? parseInt(options.limit, 10) : 20;
  const exportPath = options.export || options.import;

  let library: LibraryExport | null = null;
  if (exportPath) {
    library = await loadLibraryExport(exportPath, options.library);
  } else {
    library = await loadLibraryExportCache(options.library);
    if (!library) {
      console.error(chalk.red.bold('Error: No library export cache found. Run once with --export <path> (or --import <path>) to import + cache your Goodreads library export.'));
      process.exit(1);
    }
  }

  const state = await loadState();
  const bookCache = await loadBookCache();

  const result = findCommonMonitoredBooks(
    state,
    bookCache,
    limit,
    (bookId, book) => !matchesReviewed(library, bookId, book.title, book.author)
  );

  // Page counts: library export (all shelves, incl. unread to-read books) is the
  // primary source; fall back to whatever the book cache has captured via scraping.
  const libraryPages = new Map<string, number>();
  for (const entry of library.entries) {
    const p = parseInt((entry.pages || '').replace(/[^\d]/g, ''), 10);
    if (entry.id && p > 0) {
      const existing = libraryPages.get(entry.id) || 0;
      if (p > existing) libraryPages.set(entry.id, p);
    }
  }
  let fromLibrary = 0;
  for (const r of result.results) {
    if (r.book.pages === undefined) {
      const lp = libraryPages.get(r.bookId);
      if (lp) {
        r.book.pages = lp.toString();
        fromLibrary++;
      }
    }
  }

  const source = library.cachedAt
    ? `cached: ${library.sourcePath.split('/').pop()} (imported ${library.cachedAt.slice(0, 10)})`
    : library.sourcePath;
  console.log(chalk.gray(`   Exclude reviewed: yes (${source})`));
  if (fromLibrary > 0) {
    console.log(chalk.gray(`   Page counts from library export: ${fromLibrary} book${fromLibrary === 1 ? '' : 's'}`));
  }

  if (options.terse) {
    console.log(chalk.gray(`   Limit: Top ${limit} books`));
    for (let i = 0; i < result.results.length; i++) {
      const { book, listCount } = result.results[i];
      const year = getYear(book.published);
      const yearStr = year !== null ? year : 'Unknown';
      const pages = book.pages ? `${book.pages} pages` : 'N/A';
      console.log(
        `${(i + 1).toString().padStart(4, ' ')}. ${chalk.cyan.bold(formatBookLink(book.title, book.id))} by ${book.author} | Year: ${yearStr} | Pages: ${pages} | ${listCount} list${listCount === 1 ? '' : 's'}`
      );
    }
    return;
  }

  printCommonMonitoredBooks(result, '🔍 Most Common Unreviewed Monitored Books', limit);
}
