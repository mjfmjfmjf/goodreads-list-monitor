import chalk from 'chalk';
import { scrapeShelfBooks } from './scraper.js';
import { matchesReviewed } from './libraryExport.js';
import { getLibrary } from './library.js';
import { getYear, formatBookLink } from './utils.js';

export interface NextBooksOptions {
  pages?: string;
  limit?: string;
  minTags?: string;
  export?: string;
}

export async function runNextBooks(tag: string, options: NextBooksOptions = {}): Promise<void> {
  const pages = parseInt(options.pages || '25', 10);
  const limit = parseInt(options.limit || '10', 10);
  const minTags = parseInt(options.minTags || '0', 10);

  const library = await getLibrary(options);

  console.log(chalk.cyan.bold(`\n📚 Next ${limit} unreviewed books from shelf "${tag}"`));
  console.log(chalk.gray(`   Scanning ${pages} page(s) of https://www.goodreads.com/shelf/show/${tag} (min tags: ${minTags}); already-reviewed books are skipped`));
  console.log(chalk.gray('------------------------------------------'));

  const shelfBooks = await scrapeShelfBooks(tag, minTags, pages);

  const found: typeof shelfBooks = [];
  let reviewedSkipped = 0;
  for (const book of shelfBooks) {
    if (matchesReviewed(library, book.id, book.title, book.author)) {
      reviewedSkipped++;
      continue;
    }
    found.push(book);
    if (found.length >= limit) break;
  }

  if (found.length === 0) {
    console.log(chalk.yellow(`   No unreviewed books found in the first ${shelfBooks.length} shelf books.`));
  }
  for (let i = 0; i < found.length; i++) {
    const book = found[i];
    const yearStr = book.published && book.published !== 'Unknown' ? `, Pub: ${getYear(book.published)}` : '';
    const avgStr = book.avgRating ? `, Avg: ${book.avgRating}` : '';
    console.log(
      `${(i + 1).toString().padStart(4, ' ')}. ${chalk.white(formatBookLink(book.title, book.id))} by ${book.author}` +
      ` (Ratings: ${book.ratings}${avgStr}${yearStr})`
    );
  }

  console.log(chalk.gray('------------------------------------------'));
  console.log(chalk.cyan(`Found ${found.length} unreviewed (scanned ${shelfBooks.length}; skipped ${reviewedSkipped.toLocaleString()} already-reviewed)\n`));
}
