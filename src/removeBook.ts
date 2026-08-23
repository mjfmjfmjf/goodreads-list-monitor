import chalk from 'chalk';
import { getBook, deleteBook } from './storage.js';

export async function removeBookFromCache(bookIds: string[]): Promise<void> {
  let removedCount = 0;

  for (const bookId of bookIds) {
    const existing = getBook(bookId);
    if (!existing) {
      console.log(chalk.yellow(`⚠️  Book ID ${bookId} not found in cache.`));
      continue;
    }

    console.log(chalk.red.bold(`🗑️  Removing: "${existing.title}" by ${existing.author} (ID: ${bookId})`));
    deleteBook(bookId);
    removedCount++;
  }

  if (removedCount === 0) {
    return;
  }

  console.log(chalk.green.bold(`\n✅ Removed ${removedCount} book(s) from cache.`));
}
