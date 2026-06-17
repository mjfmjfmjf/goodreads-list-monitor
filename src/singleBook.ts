import chalk from 'chalk';
import { scrapeBookDetails } from './scraper.js';
import { loadBookCache, saveBookCache, BookCache, CachedBook } from './storage.js';

export async function scrapeAndCacheBook(bookId: string, force = false, passedCache?: BookCache): Promise<CachedBook | null> {
  try {
    const bookCache = passedCache || await loadBookCache();
    const existing = bookCache[bookId];

    if (existing?.isBad && !force) {
      console.log(chalk.yellow(`   ⏩ Skipping "bad" book ID: ${bookId} (Fail count: ${existing.failCount || 0})`));
      return null;
    }

    console.log(chalk.cyan.bold(`\n📖 Processing book ID: ${bookId}...`));
    if (existing) {
      const avgStr = existing.avgRating ? `, Avg: ${existing.avgRating}` : '';
      console.log(chalk.gray(`   [Before] Published: ${existing.published}, Ratings: ${existing.ratings}${avgStr}`));
    }

    const details = await scrapeBookDetails(bookId, existing?.title, existing?.author, existing?.authorId);

    // Safer merging: never overwrite known good data with "Unknown" or "0"
    const newTitle = details.title || existing?.title || `Unknown Title [ID: ${bookId}]`;
    const newAuthor = details.author || existing?.author || 'Unknown Author';
    const newRatings = (details.ratings && details.ratings !== '0') ? details.ratings : (existing?.ratings || '0');
    const newAvgRating = details.avgRating || existing?.avgRating;
    const newPublished = (details.published && details.published !== 'Unknown') ? details.published : (existing?.published || 'Unknown');

    const failCount = details.isFailed ? (existing?.failCount || 0) + 1 : 0;
    const isBad = failCount >= 3;

    const updatedBook: CachedBook = {
      id: bookId,
      title: newTitle,
      author: newAuthor,
      authorId: details.authorId || existing?.authorId,
      ratings: newRatings,
      avgRating: newAvgRating,
      published: newPublished,
      lastUpdated: new Date().toISOString(),
      tags: existing?.tags || {},
      requiresAuth: details.requiresAuth || existing?.requiresAuth || false,
      isBad: isBad,
      failCount: failCount
    };

    bookCache[bookId] = updatedBook;

    // Only save immediately if we didn't receive a shared cache
    if (!passedCache) {
      await saveBookCache(bookCache);
    }

    if (details.isFailed) {
      console.log(chalk.red(`   ❌ Update failed. Fail count: ${failCount}${isBad ? ' (Marked as BAD)' : ''}`));
      return updatedBook;
    }

    const updated = bookCache[bookId];
    const pubChanged = existing?.published !== updated.published;
    const ratingsChanged = existing?.ratings !== updated.ratings;
    const avgChanged = existing?.avgRating !== updated.avgRating;
    const titleChanged = existing?.title !== updated.title;
    const authChanged = existing?.author !== updated.author;
    
    const hasChanges = pubChanged || ratingsChanged || avgChanged || titleChanged || authChanged;

    if (!hasChanges) {
      console.log(chalk.gray(`   ✅ No change: "${updated.title}"`));
    } else {
      const isFixed = existing?.published === 'Unknown' && updated.published !== 'Unknown';
      console.log(isFixed ? chalk.green.bold(`   ✅ FIXED: "${updated.title}"`) : chalk.green(`   ✅ Updated: "${updated.title}"`));
      
      if (titleChanged) console.log(chalk.yellow(`      Title:     ${existing?.title} -> ${updated.title}`));
      if (authChanged)  console.log(chalk.yellow(`      Author:    ${existing?.author} -> ${updated.author}`));
      if (pubChanged)   console.log(chalk.yellow(`      Published: ${existing?.published} -> ${updated.published}`));
      if (ratingsChanged) console.log(chalk.yellow(`      Ratings:   ${existing?.ratings} -> ${updated.ratings}`));
      if (avgChanged) console.log(chalk.yellow(`      Avg Rating: ${existing?.avgRating || 'None'} -> ${updated.avgRating}`));
    }
    
    if (updated.requiresAuth) {
      console.log(chalk.yellow(`   Note:      This book requires credentials to view.`));
    }
    
    return updatedBook;
  } catch (error) {
    console.error(chalk.red.bold(`\n❌ Failed to update book ${bookId}:`), (error as any).message);
    return null;
  }
}
