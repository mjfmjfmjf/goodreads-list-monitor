import chalk from 'chalk';
import { loadLibraryExportCache, backfillBookPagesFromLibrary } from './libraryExport.js';

export async function runBackfillPages(options: { library?: string } = {}): Promise<void> {
  if (options.library) {
    console.error(chalk.yellow('   Named libraries are someone else\'s export and never write into the shared book cache. Nothing to do.'));
    return;
  }

  const library = await loadLibraryExportCache();
  if (!library) {
    console.error(chalk.red.bold('No library export cache found. Run once with --export <path> (or --import <path>) to import + cache your Goodreads library export.'));
    return;
  }

  const result = await backfillBookPagesFromLibrary(library.entries);

  console.log(chalk.cyan.bold('\n📄 Book Cache Pages Backfill'));
  console.log(chalk.gray('----------------------------------------------------------------------'));
  console.log(`   Backfilled: ${chalk.yellow(result.updates.length)} books (library export page counts copied into booksCache.json)`);
  console.log(`   Kept existing: ${chalk.yellow(result.skippedExisting)} (cache already had a page count — never overwritten)`);
  console.log(`   No cache entry: ${chalk.yellow(result.skippedNoCache)} (book not in booksCache.json)`);
  console.log(chalk.gray('----------------------------------------------------------------------'));
  if (result.updates.length === 0) {
    console.log(chalk.gray('   Nothing new to fill — page counts are already up to date.'));
  } else {
    console.log(chalk.green.bold('   Cache saved to booksCache.json'));
  }
}
