import { scrapeBookDetails } from './scraper.js';
import { delay } from './utils.js';
import { iterateBooks, upsertBook, type CachedBook } from './storage.js';

async function fixSuspects() {
  // Collect only the suspect books (a tiny set) while streaming the table.
  const suspects: CachedBook[] = [];
  for (const book of iterateBooks()) {
    const isFull2001 = book.published && book.published.startsWith('2001.') && book.published.length > 5;
    const isRecent = book.lastUpdated && book.lastUpdated.startsWith('2026-05');
    if (isFull2001 && isRecent) suspects.push(book);
  }

  console.log(`🔍 Found ${suspects.length} suspect books with full 2001 dates updated recently.`);
  
  let incorrectCount = 0;
  let checkedCount = 0;

  // Let's check a sample or let's check them sequentially
  // To avoid hitting Goodreads too hard, we will check the first 25 suspects.
  // If the user wants to check all of them, they can run check-queue.
  const limit = Math.min(suspects.length, 30);
  console.log(`📊 Checking a sample of ${limit} suspects to determine the error rate...`);

  for (let i = 0; i < limit; i++) {
    const book = suspects[i];
    checkedCount++;

    try {
      const details = await scrapeBookDetails(book.id, book.title, book.author);
      const newPub = details.published || 'Unknown';

      if (newPub !== book.published) {
        incorrectCount++;
        console.log(`   ❌ WRONG: "${book.title}" (ID: ${book.id})`);
        console.log(`      Cached:  ${book.published}`);
        console.log(`      Actual:  ${newPub}`);
        
        // Update cache
        book.published = newPub;
        if (details.ratings && details.ratings !== '0') {
          book.ratings = details.ratings;
        }
        book.lastUpdated = new Date().toISOString();
        upsertBook(book);
      } else {
        console.log(`   ✅ CORRECT: "${book.title}" is actually from ${book.published}`);
      }
      
      await delay(400, 1000);
    } catch (e) {
      console.error(`   ⚠️ Failed to check ID ${book.id}:`, (e as any).message);
    }
  }

  // Save changes if any
  console.log(`\n🏁 Sample Analysis Complete:`);
  console.log(`   - Suspects Checked: ${checkedCount}`);
  console.log(`   - Incorrectly Parsed: ${incorrectCount}`);
  
  const errorRate = checkedCount > 0 ? (incorrectCount / checkedCount) : 0;
  const estimatedTotal = Math.round(suspects.length * errorRate);
  console.log(`   - Estimated total incorrect 2001 books in cache: ~${estimatedTotal} out of the ${suspects.length} suspects.`);
}

fixSuspects();
