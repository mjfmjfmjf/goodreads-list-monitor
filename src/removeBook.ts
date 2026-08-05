import chalk from 'chalk';
import { loadBookCache, saveBookCache } from './storage.js';

export async function removeBookFromCache(bookIds: string[]): Promise<void> {
  const bookCache = await loadBookCache();
  let removedCount = 0;

  for (const bookId of bookIds) {
    const existing = bookCache[bookId];
    if (!existing) {
      console.log(chalk.yellow(`⚠️  Book ID ${bookId} not found in cache.`));
      continue;
    }

    console.log(chalk.red.bold(`🗑️  Removing: "${existing.title}" by ${existing.author} (ID: ${bookId})`));
    delete bookCache[bookId];
    removedCount++;
  }

  if (removedCount === 0) {
    return;
  }

  await saveBookCache(bookCache);
  console.log(chalk.green.bold(`\n✅ Removed ${removedCount} book(s) from cache.`));
}
