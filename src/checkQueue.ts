import chalk from 'chalk';
import { loadBookCache } from './storage.js';
import { scrapeAndCacheBook } from './singleBook.js';
import { getYear } from './utils.js';

export interface CheckQueueOptions {
  force?: boolean;
  since?: string; // YYYYMMDDHHMM
  until?: string; // YYYYMMDDHHMM
}

function parseCustomDate(str: string): Date | null {
  if (!/^\d{12}$/.test(str)) return null;
  const year = parseInt(str.substring(0, 4), 10);
  const month = parseInt(str.substring(4, 6), 10) - 1;
  const day = parseInt(str.substring(6, 8), 10);
  const hour = parseInt(str.substring(8, 10), 10);
  const min = parseInt(str.substring(10, 12), 10);
  return new Date(year, month, day, hour, min);
}

export async function runCheckQueue(options: CheckQueueOptions = {}): Promise<void> {
  const bookCache = await loadBookCache();
  
  const sinceDate = options.since ? parseCustomDate(options.since) : null;
  const untilDate = options.until ? parseCustomDate(options.until) : null;

  if (options.since && !sinceDate) {
    console.error(chalk.red.bold(`Invalid "since" format: ${options.since}. Expected YYYYMMDDHHMM.`));
    return;
  }
  if (options.until && !untilDate) {
    console.error(chalk.red.bold(`Invalid "until" format: ${options.until}. Expected YYYYMMDDHHMM.`));
    return;
  }

  const idsToCheck = Object.keys(bookCache).filter(id => {
    const book = bookCache[id];
    
    // 1. Time Range Filter (Highest priority if provided)
    if (sinceDate || untilDate) {
      if (!book.lastUpdated) return false;
      const lastUpdated = new Date(book.lastUpdated);
      
      if (sinceDate && lastUpdated < sinceDate) return false;
      if (untilDate && lastUpdated > untilDate) return false;
      
      return true;
    }

    if (options.force) return true;

    const year = getYear(book.published);

    // 2. Explicitly Unknown
    if (book.published === 'Unknown' || year === null) return true;

    // 3. Suspiciously low years that match our Y.MM.DD pattern 
    // (Likely parsing artifacts like 2.02.02 from 'Feb 2, 2021')
    if (year < 100 && /^\d{1,2}\.\d{2}\.\d{2}$/.test(book.published)) return true;

    return false;
  });

  if (idsToCheck.length === 0) {
    console.log(chalk.green.bold('\n✅ No books matching criteria found in cache.'));
    return;
  }

  let modeDesc = '';
  if (sinceDate || untilDate) {
    modeDesc = ` (TIME RANGE: ${options.since || 'START'} to ${options.until || 'NOW'})`;
  } else if (options.force) {
    modeDesc = ' (FORCE MODE)';
  }

  console.log(chalk.cyan.bold(`\n📋 Found ${idsToCheck.length} books to process in the queue${modeDesc}...`));

  for (let i = 0; i < idsToCheck.length; i++) {
    const id = idsToCheck[i];
    console.log(chalk.gray(`\n[${i + 1}/${idsToCheck.length}] Processing book ID: ${id}`));
    await scrapeAndCacheBook(id);
  }

  console.log(chalk.green.bold('\n🏁 Queue processing complete!'));
}
