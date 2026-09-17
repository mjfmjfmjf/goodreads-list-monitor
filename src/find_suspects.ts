import { iterateBooks } from './storage.js';

async function analyze() {
  let totalSuspects = 0;
  let recent2001 = 0;
  const suspects = [];

  for (const book of iterateBooks()) {
    // Check if published year is 2001
    const year = book.published ? parseInt(book.published.split('.')[0], 10) : null;
    if (year === 2001) {
      totalSuspects++;
      // Check if it was updated recently (e.g., after May 1, 2026)
      if (book.lastUpdated && book.lastUpdated.startsWith('2026-05')) {
        recent2001++;
        suspects.push({
          id: book.id,
          title: book.title,
          published: book.published,
          lastUpdated: book.lastUpdated
        });
      }
    }
  }

  console.log(`Total books in cache with year 2001: ${totalSuspects}`);
  console.log(`Of those, books recently updated in May 2026: ${recent2001}`);
  console.log('\nTop 20 most recent suspects:');
  console.log(suspects.slice(0, 20));
}

analyze();
