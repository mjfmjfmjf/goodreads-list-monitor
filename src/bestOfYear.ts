import chalk from 'chalk';
import { scrapeListBooks } from './scraper.js';
import { loadBookCache, syncBooksToCache, loadAuthorCache, syncAuthorsToCache } from './storage.js';
import { delay } from './utils.js';

export const BEST_OF_YEAR_FIRST = 1980;
export const MAX_PAGES_PER_YEAR = 100;

export interface BestOfYearOptions {
  minYear?: string;
  maxYear?: string;
  delaySeconds?: string;
}

export function resolveYearRange(minYear?: string, maxYear?: string): { start: number; end: number } {
  const currentYear = new Date().getFullYear();
  const parsedMin = parseInt(minYear ?? '', 10);
  const parsedMax = parseInt(maxYear ?? '', 10);
  const start = Number.isFinite(parsedMin) ? parsedMin : BEST_OF_YEAR_FIRST;
  const end = Number.isFinite(parsedMax) ? parsedMax : currentYear;
  if (start > end) throw new Error(`--minYear ${start} is after --maxYear ${end}`);
  return { start, end };
}

// Books on a best-of-year list without Listopia pub metadata inherit the
// list's year: /list/best_of_year/2021 rows default to published "2021".
export function applyBestOfYearPublished<T extends { published?: string }>(books: T[], year: number): T[] {
  return books.map(b =>
    !b.published || b.published === 'Unknown' ? { ...b, published: String(year) } : b
  );
}

export async function runBestOfYear(options: BestOfYearOptions = {}): Promise<void> {
  const { start, end } = resolveYearRange(options.minYear, options.maxYear);
  const delaySec = parseFloat(options.delaySeconds || '2');

  console.log(chalk.cyan.bold(`\n🏆 Scraping Goodreads best-of-year lists ${start}–${end} (max ${MAX_PAGES_PER_YEAR} pages each)...\n`));

  const bookCache = await loadBookCache();
  const authorCache = await loadAuthorCache();

  let totalBooks = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  let yearsWithBooks = 0;

  for (let year = start; year <= end; year++) {
    console.log(chalk.cyan.bold(`📅 Best of ${year}`));
    try {
      const books = applyBestOfYearPublished(
        await scrapeListBooks(`best_of_year/${year}`, MAX_PAGES_PER_YEAR),
        year
      );
      if (books.length > 0) {
        const { inserted, updated } = await syncBooksToCache(books, bookCache);
        await syncAuthorsToCache(books, authorCache);
        console.log(chalk.green(`   Found ${books.length} books (+${inserted} new / ${updated} updated).`));
        totalBooks += books.length;
        totalInserted += inserted;
        totalUpdated += updated;
        yearsWithBooks++;
      } else {
        console.log(chalk.gray('   No books found.'));
      }
    } catch (error) {
      console.error(chalk.red.bold(`   ❌ Failed scraping year ${year}:`), (error as any).message);
    }
    if (year < end) await delay(delaySec * 1000, delaySec * 1000 + 1000);
  }

  console.log(chalk.cyan.bold(`\n✅ Done: ${totalBooks.toLocaleString()} book entries across ${yearsWithBooks}/${end - start + 1} year(s) — +${totalInserted.toLocaleString()} new / ${totalUpdated.toLocaleString()} updated.`));
}
