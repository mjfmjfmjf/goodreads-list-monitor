import chalk from 'chalk';
import * as cheerio from 'cheerio';
import fs from 'fs';
import { loadBookCache, saveBookCache, loadConfig, BookCache } from './storage.js';
import { fetchWithRetry } from './utils.js';

const LOG_FILE = 'genreHarvest.log';

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

export function extractGenresFromHtml(html: string, bookId: string): string[] {
  const $ = cheerio.load(html);
  const nextDataJson = $('#__NEXT_DATA__').html();
  if (!nextDataJson) return [];

  try {
    const nextData = JSON.parse(nextDataJson);
    const apolloState = nextData.props?.pageProps?.apolloState || {};

    // Find the Book key matching this ID
    const bookKey = Object.keys(apolloState).find(k => {
      if (!k.startsWith('Book:')) return false;
      const bookData = apolloState[k];
      return bookData && (bookData.legacyId === parseInt(bookId, 10) || bookData.legacyId === bookId);
    });
    const bookData = bookKey ? apolloState[bookKey] : null;
    if (!bookData) return [];

    // Extract genre names from bookGenres array
    const genreNames: string[] = [];
    if (bookData.bookGenres && Array.isArray(bookData.bookGenres)) {
      for (const bg of bookData.bookGenres) {
        const ref = bg.genre?.__ref;
        if (ref && apolloState[ref]?.name) {
          genreNames.push(apolloState[ref].name);
        }
      }
    }

    return [...new Set(genreNames)].filter(g => !NAV_GENRES.has(g));
  } catch {
    return [];
  }
}

export function extractGenresFromDom(html: string): string[] {
  const $ = cheerio.load(html);
  const genres: string[] = [];
  $('a[href*="/genres/"]').each((_, el) => {
    const text = $(el).text().trim();
    if (text) genres.push(text);
  });
  return [...new Set(genres)].filter(g => !NAV_GENRES.has(g));
  return [...new Set(genres)];
}

export interface GenreHarvestOptions {
  limit?: string;
  minRatings?: string;
  delay?: string;
  delayJitter?: string;
}

export async function runGenreHarvest(options: GenreHarvestOptions = {}): Promise<void> {
  const limit = parseInt(options.limit || '100', 10);
  const minRatings = parseInt(options.minRatings || '1000', 10);
  const delaySec = parseInt(options.delay || '30', 10);
  const jitterMs = parseInt(options.delayJitter || '0', 10) * 1000;

  const cache = await loadBookCache();
  const config = await loadConfig();

  // Filter: has enough ratings AND no genres yet
  const candidates = Object.values(cache).filter(book => {
    const ratings = parseInt((book.ratings || '0').replace(/,/g, ''), 10);
    return ratings >= minRatings && (!book.genres || book.genres.length === 0);
  });

  console.log(chalk.cyan(`Found ${candidates.length} books with ≥${minRatings} ratings and no genres.`));
  logToFile(`Starting genre harvest: limit=${limit}, minRatings=${minRatings}, delay=${delaySec}s, jitter=${jitterMs / 1000}s, candidates=${candidates.length}`);

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

  for (const book of toProcess) {
    processed++;
    const url = `https://www.goodreads.com/book/show/${book.id}`;
    const label = `[${processed}/${toProcess.length}] ${book.title} (ID: ${book.id}, ${book.ratings} ratings)`;

    console.log(chalk.white(`${label}`));
    console.log(chalk.gray(`  Fetching ${url}`));

    try {
      const response = await fetchWithRetry(url, { headers, timeout: 30000 }, 1);
      const status = response.status;
      const bodyLen = typeof response.data === 'string' ? response.data.length : 0;

      logToFile(`OK  ${status} ${bodyLen}B ${book.id} "${book.title}"`);

      if (status !== 200 || bodyLen < 10000) {
        console.log(chalk.yellow(`  ⚠ Unexpected response: status=${status}, length=${bodyLen}. Skipping.`));
        logToFile(`SKIP ${status} ${bodyLen}B ${book.id} — too small or non-200`);
        failed++;
        // Throttled — log and exit
        if (status === 202 || status === 403 || status === 429) {
          console.log(chalk.red.bold(`\n🛑 Throttled (HTTP ${status}). Logging and exiting.`));
          logToFile(`THROTTLE EXIT — HTTP ${status} on ${book.id}`);
          break;
        }
        continue;
      }

      // Try JSON blob first, then DOM fallback
      let genres = extractGenresFromHtml(response.data, book.id);
      if (genres.length === 0) {
        genres = extractGenresFromDom(response.data);
      }

      if (genres.length > 0) {
        console.log(chalk.green(`  ✓ Genres: ${genres.join(', ')}`));
        cache[book.id].genres = genres;
        cache[book.id].lastUpdated = new Date().toISOString();
        await saveBookCache(cache);
        logToFile(`GENRES ${book.id} "${book.title}" → ${genres.join('; ')}`);
      } else {
        console.log(chalk.yellow(`  ⚠ No genres found on page.`));
        logToFile(`NOGENRES ${book.id} "${book.title}"`);
      }
    } catch (error: any) {
      const status = error?.response?.status || error?.status;
      console.log(chalk.red(`  ✗ Error: status=${status || 'none'}, msg=${error?.message || error}`));
      logToFile(`ERROR ${status || 'none'} ${book.id} "${book.title}" ${error?.message || error}`);

      // Any throttle-like status: log and exit
      if (status === 202 || status === 403 || status === 429) {
        throttled++;
        console.log(chalk.red.bold(`\n🛑 Throttled (HTTP ${status}). Logging and exiting.`));
        logToFile(`THROTTLE EXIT — HTTP ${status} on ${book.id}`);
        break;
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
