import chalk from 'chalk';
import { scrapeListBooks } from './scraper.js';
import { loadBookCache, syncBooksToCache, loadAuthorCache, syncAuthorsToCache } from './storage.js';

async function harvestList(listId: string) {
  if (!listId) {
    console.error(chalk.red.bold('Error: Please provide a list ID.'));
    console.log(chalk.gray('Usage: ./harvestList.sh [listId]'));
    process.exit(1);
  }

  console.log(chalk.cyan.bold(`\n📥 Starting metadata harvest for list: ${listId}`));

  try {
    const bookCache = await loadBookCache();
    const authorCache = await loadAuthorCache();

    console.log(chalk.gray(`   Reading list pages...`));
    const listBooks = await scrapeListBooks(listId);
    
    console.log(chalk.green(`   Found ${listBooks.length} books. Syncing to cache...`));
    
    // Sync both book and author caches
    await syncBooksToCache(listBooks, bookCache);
    await syncAuthorsToCache(listBooks, authorCache);

    console.log(chalk.cyan.bold(`\n✅ Harvest complete!`));
    console.log(chalk.gray(`   Updated metadata for ${listBooks.length} books in booksCache.json`));
  } catch (error) {
    console.error(chalk.red.bold(`\n❌ Harvest failed:`), (error as any).message);
    process.exit(1);
  }
}

const listId = process.argv[2];
harvestList(listId).catch(err => {
  console.error(err);
  process.exit(1);
});
