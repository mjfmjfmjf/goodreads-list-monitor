import chalk from 'chalk';
import { scrapeBookDetails } from './scraper.js';
import { loadBookCache, saveBookCache } from './storage.js';

export async function scrapeAndCacheBook(bookId: string): Promise<void> {
  try {
    const bookCache = await loadBookCache();
    const existing = bookCache[bookId];

    console.log(chalk.cyan.bold(`\n📖 Processing book ID: ${bookId}...`));
    if (existing) {
      console.log(chalk.gray(`   [Before] Published: ${existing.published}, Ratings: ${existing.ratings}`));
    }

    const details = await scrapeBookDetails(bookId);

    bookCache[bookId] = {
      id: bookId,
      title: details.title || existing?.title || `Unknown Title [ID: ${bookId}]`,
      author: details.author || existing?.author || 'Unknown Author',
      ratings: details.ratings || existing?.ratings || '0',
      published: details.published || 'Unknown',
      lastUpdated: new Date().toISOString(),
      tags: existing?.tags || {},
      requiresAuth: details.requiresAuth || false
    };

    await saveBookCache(bookCache);

    const updated = bookCache[bookId];
    const pubChanged = existing?.published !== updated.published;
    const ratingsChanged = existing?.ratings !== updated.ratings;
    const titleChanged = existing?.title !== updated.title;
    const authChanged = existing?.author !== updated.author;
    
    const hasChanges = pubChanged || ratingsChanged || titleChanged || authChanged;

    if (!hasChanges) {
      console.log(chalk.gray(`   ✅ No change: "${updated.title}"`));
    } else {
      const isFixed = existing?.published === 'Unknown' && updated.published !== 'Unknown';
      console.log(isFixed ? chalk.green.bold(`   ✅ FIXED: "${updated.title}"`) : chalk.green(`   ✅ Updated: "${updated.title}"`));
      
      if (titleChanged) console.log(chalk.yellow(`      Title:     ${existing?.title} -> ${updated.title}`));
      if (authChanged)  console.log(chalk.yellow(`      Author:    ${existing?.author} -> ${updated.author}`));
      if (pubChanged)   console.log(chalk.yellow(`      Published: ${existing?.published} -> ${updated.published}`));
      if (ratingsChanged) console.log(chalk.yellow(`      Ratings:   ${existing?.ratings} -> ${updated.ratings}`));
    }
    
    if (updated.requiresAuth) {
      console.log(chalk.yellow(`   Note:      This book requires credentials to view.`));
    }
  } catch (error) {
    console.error(chalk.red.bold(`\n❌ Failed to update book ${bookId}:`), (error as any).message);
  }
}
