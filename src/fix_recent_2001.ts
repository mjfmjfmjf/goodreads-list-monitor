import fs from 'fs-extra';
import { scrapeBookDetails } from './scraper.js';
import { delay } from './utils.js';

async function fixSuspects() {
  const cache = await fs.readJson('booksCache.json');
  const ids = Object.keys(cache);
  
  // Find all books with a full YYYY.MM.DD date in 2001 that were updated recently
  const suspects = ids.filter(id => {
    const book = cache[id];
    const isFull2001 = book.published && book.published.startsWith('2001.') && book.published.length > 5;
    const isRecent = book.lastUpdated && book.lastUpdated.startsWith('2026-05');
    return isFull2001 && isRecent;
  });

  console.log(`🔍 Found ${suspects.length} suspect books with full 2001 dates updated recently.`);
  
  let incorrectCount = 0;
  let checkedCount = 0;

  // Let's check a sample or let's check them sequentially
  // To avoid hitting Goodreads too hard, we will check the first 25 suspects.
  // If the user wants to check all of them, they can run check-queue.
  const limit = Math.min(suspects.length, 30);
  console.log(`📊 Checking a sample of ${limit} suspects to determine the error rate...`);

  for (let i = 0; i < limit; i++) {
    const id = suspects[i];
    const book = cache[id];
    checkedCount++;

    try {
      const details = await scrapeBookDetails(id);
      const newPub = details.published || 'Unknown';

      if (newPub !== book.published) {
        incorrectCount++;
        console.log(`   ❌ WRONG: "${book.title}" (ID: ${id})`);
        console.log(`      Cached:  ${book.published}`);
        console.log(`      Actual:  ${newPub}`);
        
        // Update cache
        cache[id].published = newPub;
        if (details.ratings && details.ratings !== '0') {
          cache[id].ratings = details.ratings;
        }
        cache[id].lastUpdated = new Date().toISOString();
      } else {
        console.log(`   ✅ CORRECT: "${book.title}" is actually from ${book.published}`);
      }
      
      await delay(400, 1000);
    } catch (e) {
      console.error(`   ⚠️ Failed to check ID ${id}:`, (e as any).message);
    }
  }

  // Save changes if any
  await fs.writeJson('booksCache.json', cache, { spaces: 2 });

  console.log(`\n🏁 Sample Analysis Complete:`);
  console.log(`   - Suspects Checked: ${checkedCount}`);
  console.log(`   - Incorrectly Parsed: ${incorrectCount}`);
  
  const errorRate = checkedCount > 0 ? (incorrectCount / checkedCount) : 0;
  const estimatedTotal = Math.round(suspects.length * errorRate);
  console.log(`   - Estimated total incorrect 2001 books in cache: ~${estimatedTotal} out of the ${suspects.length} suspects.`);
}

fixSuspects();
