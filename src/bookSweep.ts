import chalk from 'chalk';
import * as cheerio from 'cheerio';
import fs from 'fs';
import { loadBookCache, getBook, upsertBook, loadConfig, BookCache } from './storage.js';
import { fetchWithRetry, formatBookLink } from './utils.js';
import { extractWorkId } from './scraper.js';

const LOG_FILE = 'bookSweep.log';

// Genres that appear in the site-wide nav on every Goodreads page — not book-specific
const NAV_GENRES = new Set([
  'Biography', 'Book Club', 'Fantasy', 'Food',
  'Graphic Novels', 'History', 'Nonfiction', 'Science', 'Science Fiction'
]);

function logToFile(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line);
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export interface ExtractedBookDetails {
  genres: string[];
  ratings?: string;
  avgRating?: string;
  published?: string;
  pages?: string;
}

export function extractBookDetailsFromHtml(html: string, bookId: string): ExtractedBookDetails {
  const $ = cheerio.load(html);
  const empty: ExtractedBookDetails = { genres: [] };
  const nextDataJson = $('#__NEXT_DATA__').html();
  if (!nextDataJson) return empty;

  try {
    const nextData = JSON.parse(nextDataJson);
    const apolloState = nextData.props?.pageProps?.apolloState || {};

    const bookKey = Object.keys(apolloState).find(k => {
      if (!k.startsWith('Book:')) return false;
      const bookData = apolloState[k];
      return bookData && (bookData.legacyId === parseInt(bookId, 10) || bookData.legacyId === bookId);
    });
    const bookData = bookKey ? apolloState[bookKey] : null;
    if (!bookData) return empty;

    // Genres
    const genreNames: string[] = [];
    if (bookData.bookGenres && Array.isArray(bookData.bookGenres)) {
      for (const bg of bookData.bookGenres) {
        const ref = bg.genre?.__ref;
        if (ref && apolloState[ref]?.name) {
          genreNames.push(apolloState[ref].name);
        }
      }
    }
    const genres = [...new Set(genreNames)].filter(g => !NAV_GENRES.has(g));

    // Ratings + avg rating from stats
    let ratings: string | undefined;
    let avgRating: string | undefined;
    let statsObj: any = null;
    if (bookData.stats?.__ref) {
      statsObj = apolloState[bookData.stats.__ref];
    } else if (bookData.stats) {
      statsObj = bookData.stats;
    }
    if (!statsObj && bookData.work?.__ref) {
      const workData = apolloState[bookData.work.__ref];
      if (workData) {
        if (workData.stats?.__ref) statsObj = apolloState[workData.stats.__ref];
        else if (workData.stats) statsObj = workData.stats;
      }
    }
    if (statsObj && statsObj.ratingsCount !== undefined) {
      ratings = statsObj.ratingsCount.toLocaleString('en-US');
      if (statsObj.averageRating !== undefined) {
        avgRating = statsObj.averageRating.toFixed(2);
      }
    }

    // Published date
    let published: string | undefined;
    if (bookData.work?.__ref) {
      const workData = apolloState[bookData.work.__ref];
      if (workData?.details?.publicationTime) {
        const date = new Date(workData.details.publicationTime);
        published = `${date.getFullYear()}.${(date.getMonth() + 1).toString().padStart(2, '0')}.${date.getDate().toString().padStart(2, '0')}`;
      }
    }
    if (!published && bookData.details?.publicationTime) {
      const date = new Date(bookData.details.publicationTime);
      published = `${date.getFullYear()}.${(date.getMonth() + 1).toString().padStart(2, '0')}.${date.getDate().toString().padStart(2, '0')}`;
    }

    // Pages
    let pages: string | undefined;
    const detailsRef = bookData.details?.__ref;
    const detailsObj = detailsRef ? apolloState[detailsRef] : bookData.details;
    if (detailsObj) {
      const numPages = detailsObj.numPages ?? detailsObj.pageCount;
      if (numPages !== undefined && numPages !== null) pages = String(numPages);
    }

    return { genres, ratings, avgRating, published, pages };
  } catch {
    return empty;
  }
}

export function extractGenresFromDom(html: string): string[] {
  const $ = cheerio.load(html);
  // Prefer the book's "Genres" section — only contains this book's genres
  const genresList = $('[data-testid="genresList"] a');
  if (genresList.length > 0) {
    const genres: string[] = [];
    genresList.each((_, el) => {
      const text = $(el).text().trim();
      if (text) genres.push(text);
    });
    return [...new Set(genres)];
  }
  // Fallback: genre links anywhere, minus nav genres
  const genres: string[] = [];
  $('a[href*="/genres/"]').each((_, el) => {
    const text = $(el).text().trim();
    if (text) genres.push(text);
  });
  return [...new Set(genres)].filter(g => !NAV_GENRES.has(g));
}

export interface BookSweepOptions {
  limit?: string;
  minRatings?: string;
  delay?: string;
  delayJitter?: string;
  throttleSleep?: string;
}

export async function runBookSweep(options: BookSweepOptions = {}): Promise<void> {
  const limit = parseInt(options.limit || '100', 10);
  const minRatings = parseInt(options.minRatings || '1000', 10);
  const delaySec = parseInt(options.delay || '30', 10);
  const jitterMs = parseInt(options.delayJitter || '0', 10) * 1000;
  const throttleSleepSec = parseInt(options.throttleSleep || '300', 10);

  const cache = await loadBookCache();
  const config = await loadConfig();

  // Filter: has enough ratings AND (no genres yet OR no workId yet)
  const candidates = Object.values(cache).filter(book => {
    const ratings = parseInt((book.ratings || '0').replace(/,/g, ''), 10);
    const needsGenres = !book.genres || book.genres.length === 0;
    return ratings >= minRatings && (needsGenres || !book.workId);
  });

  console.log(chalk.cyan(`Found ${candidates.length} books with ≥${minRatings} ratings missing genres or workId.`));
  logToFile(`Starting book sweep: limit=${limit}, minRatings=${minRatings}, delay=${delaySec}s, jitter=${jitterMs / 1000}s, throttleSleep=${throttleSleepSec}s, candidates=${candidates.length}`);

  if (candidates.length === 0) {
    console.log(chalk.green('Nothing to do.'));
    return;
  }

  const shuffled = shuffle([...candidates]);
  const toProcess = shuffled.slice(0, limit);
  console.log(chalk.cyan(`Will attempt to process ${toProcess.length} books.\n`));

  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Referer': 'https://www.goodreads.com/',
    'Sec-Ch-Ua': '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"macOS"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1'
  };
  if (config.cookie) headers['Cookie'] = config.cookie;

  let processed = 0;
  let throttled = 0;
  let failed = 0;
  let consecutiveThrottled = 0;

  for (const book of toProcess) {
    processed++;
    const url = `https://www.goodreads.com/book/show/${book.id}`;
    const bookLink = formatBookLink(book.title, book.id);

    console.log(chalk.white(`[${processed}/${toProcess.length}] ${bookLink} by ${book.author}`));
    console.log(chalk.gray(`  Fetching ${url}`));

    try {
      const response = await fetchWithRetry(url, { headers, timeout: 30000 }, 1);
      const status = response.status;
      const bodyLen = typeof response.data === 'string' ? response.data.length : 0;

      // Show status code for every response
      const statusColor = status === 200 ? chalk.green : (status === 202 ? chalk.red : chalk.yellow);
      console.log(statusColor(`  HTTP ${status} (${bodyLen} bytes)`));
      logToFile(`${status} ${bodyLen}B ${book.id} "${book.title}"`);

      // Throttle detection: 202/403/429, or 200 with suspiciously small body
      const isThrottled = status === 202 || status === 403 || status === 429;
      const isSuspicious = status !== 200 || bodyLen < 10000;
      if (isThrottled || isSuspicious) {
        throttled++;
        consecutiveThrottled++;
        if (consecutiveThrottled >= 2) {
          console.log(chalk.red.bold(`\n🛑 Throttled twice in a row — exiting.`));
          logToFile(`THROTTLE EXIT (2nd consecutive) — HTTP ${status} on ${book.id}`);
          break;
        }
        console.log(chalk.yellow.bold(`\n⚠️  Throttled (HTTP ${status}, ${bodyLen} bytes). Sleeping ${throttleSleepSec}s and retrying...`));
        logToFile(`THROTTLE #${throttled} — HTTP ${status} ${bodyLen}B on ${book.id}, sleeping ${throttleSleepSec}s`);
        await new Promise(r => setTimeout(r, throttleSleepSec * 1000));
        processed--;
        continue;
      }

      // Extract all book details from the JSON blob
      const details = extractBookDetailsFromHtml(response.data, book.id);
      // Prefer DOM genres (more accurate — avoids nav genre contamination)
      let genres = extractGenresFromDom(response.data);
      if (genres.length === 0) {
        genres = details.genres;
      }
      // Work id groups all editions of a title under one key
      const workId = extractWorkId(typeof response.data === 'string' ? response.data : '');

      // Update cache — only improve, never overwrite good data with bad
      const entry = getBook(book.id) ?? cache[book.id];
      cache[book.id] = entry;
      const parseNum = (s?: string) => parseInt((s || '0').replace(/,/g, ''), 10) || 0;
      let updatedFields: string[] = [];

      // Snapshot old values for comparison
      const oldRatings = entry.ratings;
      const oldAvg = entry.avgRating;
      const oldPub = entry.published;
      const oldPages = entry.pages;

      if (genres.length > 0) {
        entry.genres = genres;
        updatedFields.push('genres');
      }
      if (details.ratings && parseNum(details.ratings) > parseNum(entry.ratings)) {
        entry.ratings = details.ratings;
        updatedFields.push('ratings');
      }
      if (details.avgRating && (!entry.avgRating || parseFloat(details.avgRating) > parseFloat(entry.avgRating))) {
        entry.avgRating = details.avgRating;
        updatedFields.push('avgRating');
      }
      if (details.published && (entry.published === 'Unknown' || !entry.published)) {
        entry.published = details.published;
        updatedFields.push('published');
      }
      if (details.pages && !entry.pages) {
        entry.pages = details.pages;
        updatedFields.push('pages');
      }
      if (workId && !entry.workId) {
        entry.workId = workId;
        updatedFields.push('workId');
      }

      if (updatedFields.length > 0) {
        entry.lastUpdated = new Date().toISOString();
        upsertBook(entry);
      }

      // Show genres
      const genreStr = genres.length > 0 ? genres.join(', ') : '(none)';
      console.log(chalk.green(`  Genres: ${genreStr}`));

      // Show cache-vs-scrape comparison for updated fields
      const changes: string[] = [];
      if (updatedFields.includes('ratings')) changes.push(`Ratings: ${oldRatings} → ${entry.ratings}`);
      if (updatedFields.includes('avgRating')) changes.push(`Avg: ${oldAvg || '?'} → ${entry.avgRating}`);
      if (updatedFields.includes('published')) changes.push(`Pub: ${oldPub || '?'} → ${entry.published}`);
      if (updatedFields.includes('pages')) changes.push(`Pages: ${oldPages || '?'} → ${entry.pages}`);
      if (updatedFields.includes('workId')) changes.push(`WorkId: ${entry.workId}`);
      if (changes.length > 0) {
        console.log(chalk.cyan(`  Updated: ${changes.join(' | ')}`));
      }

      logToFile(`BOOK ${book.id} "${book.title}" genres=${genres.join('; ')} updated=${updatedFields.join(',')}`);
      consecutiveThrottled = 0;
    } catch (error: any) {
      const status = error?.response?.status || error?.status;
      console.log(chalk.red(`  ✗ Error: status=${status || 'none'}, msg=${error?.message || error}`));
      logToFile(`ERROR ${status || 'none'} ${book.id} "${book.title}" ${error?.message || error}`);

      // Any throttle-like status: log and exit
      if (status === 202 || status === 403 || status === 429) {
        throttled++;
        consecutiveThrottled++;
        if (consecutiveThrottled >= 2) {
          console.log(chalk.red.bold(`\n🛑 Throttled twice in a row — exiting.`));
          logToFile(`THROTTLE EXIT (2nd consecutive) — HTTP ${status} on ${book.id}`);
          break;
        }
        console.log(chalk.yellow.bold(`\n⚠️  Throttled (HTTP ${status}). Sleeping ${throttleSleepSec}s and retrying...`));
        logToFile(`THROTTLE #${throttled} — HTTP ${status} on ${book.id}, sleeping ${throttleSleepSec}s`);
        await new Promise(r => setTimeout(r, throttleSleepSec * 1000));
        processed--;
        continue;
      }
      failed++;
    }

    // Sleep between requests (skip sleep after the last one or after throttle exit)
    if (processed < toProcess.length) {
      const jitter = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
      const sleepMs = delaySec * 1000 + jitter;
      console.log(chalk.gray(`  Sleeping ${(sleepMs / 1000).toFixed(1)}s...`));
      await new Promise(r => setTimeout(r, sleepMs));
    }
  }

  console.log(chalk.cyan.bold(`\nGenre harvest complete.`));
  console.log(chalk.white(`  Processed: ${processed}`));
  console.log(chalk.white(`  Failed:    ${failed}`));
  console.log(chalk.white(`  Throttled: ${throttled}`));
  logToFile(`DONE processed=${processed} failed=${failed} throttled=${throttled}`);
}
