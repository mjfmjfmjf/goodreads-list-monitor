import chalk from 'chalk';
import { iterateBooks, getBook, upsertBook, countBooks } from './storage.js';
import { parseSeriesPos } from './seriesPos.js';

export async function runBackfillSeriesPos(): Promise<void> {
  const totalBooks = countBooks();

  let filled = 0;
  let corrected = 0;
  let cleared = 0;

  // Re-read each candidate fresh and write only rows that actually change,
  // so concurrent writers to other fields can't be clobbered.
  for (const snap of iterateBooks()) {
    if (!snap.title || snap.title === 'Unknown') continue;
    const book = getBook(snap.id);
    if (!book) continue;

    const parsed = parseSeriesPos(book.title);
    if (parsed === book.seriesPos) continue;

    if (parsed === undefined) {
      if (book.seriesPos !== undefined) cleared++;
    } else if (book.seriesPos === undefined) {
      filled++;
    } else {
      corrected++;
    }
    book.seriesPos = parsed;
    upsertBook(book);
  }

  console.log(chalk.cyan.bold(`\n🔄 Series Position Backfill Complete: ${totalBooks.toLocaleString()} books in DB`));
  console.log(chalk.gray('----------------------------------------------------------------------'));
  console.log(`   Filled: ${chalk.yellow(filled)} books (parseable position now stored)`);
  console.log(`   Corrected: ${chalk.yellow(corrected)} books (stale value replaced with fresh parse)`);
  console.log(`   Cleared: ${chalk.yellow(cleared)} books (stale value removed, title now parses to standalone)`);
  console.log(chalk.gray('   Books with Unknown titles were left untouched.'));
  console.log(chalk.gray('----------------------------------------------------------------------'));
  console.log(chalk.green.bold(`   Cache saved to booksCache.json`));
}
