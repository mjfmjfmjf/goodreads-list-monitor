import chalk from 'chalk';
import { BrowserContext } from 'playwright';
import { getDb } from './db.js';
import { getBook, loadConfig, upsertBook, CachedBook } from './storage.js';
import { fetchWithRetry, httpCallInfo, isConnectivityError, withDbLockRetry } from './utils.js';
import { USER_AGENT } from './scraper.js';
import { BROWSER_PROFILE_DIR, checkBrowserLogin, launchBrowserProfile } from './browserSession.js';
import {
  buildCandidateQuery,
  classifyBookFetch,
  extractEditionsCount,
  parseBookPageFromHtml,
  parseSocialSignals,
  BookPageDetails,
  SocialSignals,
  FetchClass,
} from './bookPageParse.js';

// Pacing: uniform random 2000–4000 ms at millisecond precision (deliberately
// NOT utils.delay(), which inflates each range by ~1.5x and adds 100 ms).
const PACE_MIN_MS = 2000;
const PACE_MAX_MS = 4000;

export interface BrowserBookScrapeOptions {
  limit: number;
  minRatings?: number;
  skipHas: string[];
  sort: string;
  engine: 'axios' | 'browser';
  dryRun?: boolean;
  force?: boolean;
  cooldownMs?: number;
  maxConsecutiveThrottles?: number;
  helpText?: string;
}

export interface ScrapeRunSummary {
  total: number;
  processed: number;
  ok: number;
  throttled: number;
  missing: number;
  error: number;
  skipped: number;
  elapsedMs: number;
}

interface FetchResult {
  status?: number;
  body: string;
  error?: string;
}

export interface CheckpointRow {
  book_id: string;
  status: FetchClass;
  http?: number;
  bytes?: number;
  elapsed_ms?: number;
  scraped_at: string;
  error?: string;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function pace(): Promise<void> {
  const ms = PACE_MIN_MS + Math.floor(Math.random() * (PACE_MAX_MS - PACE_MIN_MS + 1));
  console.log(chalk.gray(`   (Pacing ${(ms / 1000).toFixed(2)}s before next request...)`));
  await sleep(ms);
}

// Cooldown sleep with a visible countdown tick so a 60s wait never looks dead.
export async function cooldown(durationMs: number): Promise<void> {
  const end = Date.now() + durationMs;
  const retryAt = new Date(end).toLocaleTimeString();
  console.log(chalk.gray(`      (will retry at ${retryAt}; giving up after throttles persist)`));
  let lastTick = Date.now();
  while (Date.now() < end) {
    await sleep(1000);
    if (Date.now() - lastTick >= 10_000) {
      const left = Math.ceil((end - Date.now()) / 1000);
      console.log(chalk.gray(`      ...waiting ${left}s more`));
      lastTick = Date.now();
    }
  }
}

export function ensureScrapeTables(): void {
  // browser_scrape / book_page are created by the schema init in db.ts; kept
  // here for safety against older DB connections. CREATE IF NOT EXISTS is a
  // no-op when they already exist.
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_scrape (
      book_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      http INTEGER,
      bytes INTEGER,
      elapsed_ms INTEGER,
      scraped_at TEXT NOT NULL,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS book_page (
      book_id TEXT PRIMARY KEY,
      publisher TEXT,
      isbn13 TEXT,
      isbn10 TEXT,
      asin TEXT,
      format TEXT,
      language TEXT,
      description TEXT,
      series TEXT,
      reviews_count TEXT,
      ratings_dist TEXT,
      currently_reading INTEGER,
      to_read INTEGER,
      editions_count INTEGER,
      scraped_at TEXT NOT NULL
    );
  `);
}

export function getCheckpoint(bookId: string): CheckpointRow | undefined {
  return getDb().prepare('SELECT * FROM browser_scrape WHERE book_id = ?').get(bookId) as CheckpointRow | undefined;
}

function setCheckpoint(row: CheckpointRow): void {
  const db = getDb();
  withDbLockRetry(() => {
    db.prepare(`
      INSERT INTO browser_scrape (book_id, status, http, bytes, elapsed_ms, scraped_at, error)
      VALUES (@book_id, @status, @http, @bytes, @elapsed_ms, @scraped_at, @error)
      ON CONFLICT(book_id) DO UPDATE SET
        status=excluded.status, http=excluded.http, bytes=excluded.bytes,
        elapsed_ms=excluded.elapsed_ms, scraped_at=excluded.scraped_at, error=excluded.error
    `).run(row);
  });
}

function saveBookPage(bookId: string, parsed: BookPageDetails, socials: SocialSignals, editions?: number): void {
  const db = getDb();
  withDbLockRetry(() => {
    db.prepare(`
      INSERT INTO book_page (book_id, publisher, isbn13, isbn10, asin, format, language, description, series, reviews_count, ratings_dist, currently_reading, to_read, editions_count, scraped_at)
      VALUES (@book_id, @publisher, @isbn13, @isbn10, @asin, @format, @language, @description, @series, @reviews_count, @ratings_dist, @currently_reading, @to_read, @editions_count, @scraped_at)
      ON CONFLICT(book_id) DO UPDATE SET
        publisher=excluded.publisher, isbn13=excluded.isbn13, isbn10=excluded.isbn10,
        asin=excluded.asin, format=excluded.format, language=excluded.language,
        description=excluded.description, series=excluded.series, reviews_count=excluded.reviews_count,
        ratings_dist=excluded.ratings_dist, currently_reading=excluded.currently_reading,
        to_read=excluded.to_read, editions_count=excluded.editions_count, scraped_at=excluded.scraped_at
    `).run({
      book_id: bookId,
      publisher: parsed.publisher ?? null,
      isbn13: parsed.isbn13 ?? null,
      isbn10: parsed.isbn ?? null,
      asin: parsed.asin ?? null,
      format: parsed.format ?? null,
      language: parsed.language ?? null,
      description: parsed.description ?? null,
      series: parsed.series.length ? JSON.stringify(parsed.series) : null,
      reviews_count: parsed.reviewsCount ?? null,
      ratings_dist: parsed.ratingsCountDist ? JSON.stringify(parsed.ratingsCountDist) : null,
      currently_reading: socials.currentlyReading ?? null,
      to_read: socials.toRead ?? null,
      editions_count: editions ?? null,
      scraped_at: new Date().toISOString(),
    });
  });
}

function buildCachedBook(existing: CachedBook | null | undefined, parsed: BookPageDetails, bookId: string): CachedBook {
  const hasRatings = !!parsed.ratings && parsed.ratings !== '0';
  return {
    id: existing?.id ?? bookId,
    title: existing?.title || 'Unknown Title',
    author: existing?.author || 'Unknown Author',
    authorId: existing?.authorId,
    ratings: hasRatings ? parsed.ratings! : (existing?.ratings || '0'),
    avgRating: parsed.avgRating || existing?.avgRating,
    published: parsed.published && parsed.published !== 'Unknown' ? parsed.published : (existing?.published || 'Unknown'),
    pages: parsed.pages || existing?.pages,
    seriesPos: existing?.seriesPos,
    genres: parsed.genres.length ? parsed.genres : existing?.genres,
    lastUpdated: new Date().toISOString(),
    tags: existing?.tags || {},
    requiresAuth: existing?.requiresAuth || false,
    isBad: existing?.isBad || false,
    failCount: existing?.failCount,
    workId: parsed.workId || existing?.workId,
  };
}

async function fetchAxios(bookId: string): Promise<FetchResult> {
  const config = await loadConfig();
  const headers: any = { 'User-Agent': USER_AGENT };
  if (config.cookie) headers['Cookie'] = config.cookie;
  try {
    const response = await fetchWithRetry(
      `https://www.goodreads.com/book/show/${bookId}`,
      { headers, timeout: 30000 },
      1
    );
    return { status: response.status, body: typeof response.data === 'string' ? response.data : '' };
  } catch (error: any) {
    if (isConnectivityError(error)) return { body: '', error: error.message };
    const status = error?.response?.status ?? error?.status;
    const body = typeof error?.response?.data === 'string' ? error.response.data : '';
    if (status === 202 || status === 403 || status === 429) return { status: status ?? 403, body: '', error: error.message };
    return { status, body, error: error.message };
  }
}

let browserContext: BrowserContext | null = null;
let loginState: { loggedIn: boolean; checked: boolean } | null = null;

// Open the headed window from the persistent profile. Login is verified ONCE
// here against the hub page header (the signed-in /user/show/<id>-… profile
// link appears on every Goodreads page) and reported to the user; the profile
// is only logged-in if `npm run browser-login` was run at least once (injecting
// config.json cookies into the browser does NOT work — Amazon/Goodreads auth
// cookies carry Secure/HttpOnly flags that a pasted name/value string cannot
// reproduce, and the browser silently ignores them).
export async function getBrowserContext(): Promise<BrowserContext> {
  if (browserContext) return browserContext;
  console.log(chalk.cyan('   Opening the headed Goodreads window (persistent profile)...'));
  console.log(chalk.gray(`   Profile: ${BROWSER_PROFILE_DIR}`));
  browserContext = await launchBrowserProfile();
  const login = await checkBrowserLogin(browserContext);
  loginState = login;
  if (!login.checked) {
    console.log(chalk.yellow('   ⚠️  Could not verify login state on the hub page (network/throttle) — proceeding; editions count may be unavailable.'));
  } else if (login.loggedIn) {
    console.log(chalk.green(`   ✓ Session verified: signed in as ${login.profileHref ?? 'a Goodreads user'}`));
  } else {
    console.log(chalk.yellow('   ⚠️  Browser session is logged OUT — editions count and to-read diffs will be unavailable (genres/ISBNs still parse).'));
    console.log(chalk.yellow('      Fix: run `npm run browser-login` once to sign into the persistent profile.'));
  }
  return browserContext;
}

async function fetchBrowser(bookId: string): Promise<FetchResult> {
  const context = await getBrowserContext();
  const page = await context.newPage();
  try {
    page.setDefaultTimeout(30000);
    const response = await page.goto(`https://www.goodreads.com/book/show/${bookId}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(1200);
    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(
        b => (b.getAttribute('aria-label') || '') === 'Book details and editions'
      );
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });
    if (clicked) await page.waitForTimeout(400);
    const body = await page.content();
    return { status: response?.status(), body };
  } catch (error: any) {
    return { body: '', error: String(error?.message || error) };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function processBook(
  bookId: string,
  engine: 'axios' | 'browser'
): Promise<{ checkpoint: CheckpointRow; parsed?: BookPageDetails }> {
  const start = Date.now();
  const fetchResult = engine === 'browser' ? await fetchBrowser(bookId) : await fetchAxios(bookId);
  const elapsedMs = Date.now() - start;
  const networkError = !!fetchResult.error && fetchResult.status === undefined;
  const cls = classifyBookFetch({
    httpStatus: fetchResult.status,
    bytes: fetchResult.body.length,
    html: fetchResult.body || undefined,
    networkError,
  });
  const checkpoint: CheckpointRow = {
    book_id: bookId,
    status: cls,
    http: fetchResult.status,
    bytes: fetchResult.body.length,
    elapsed_ms: elapsedMs,
    scraped_at: new Date().toISOString(),
    error: fetchResult.error,
  };
  let parsed: BookPageDetails | undefined;
  if (cls === 'ok' && fetchResult.body) {
    parsed = parseBookPageFromHtml(fetchResult.body, bookId);
    const socials = parseSocialSignals(fetchResult.body);
    const editions = extractEditionsCount(fetchResult.body);
    const existing = getBook(bookId);
    withDbLockRetry(() => upsertBook(buildCachedBook(existing, parsed!, bookId)));
    saveBookPage(bookId, parsed, socials, editions);
  }
  setCheckpoint(checkpoint);
  return { checkpoint, parsed };
}

const STATUS_COLOR: Record<FetchClass, (s: string) => string> = {
  ok: chalk.green,
  throttled: chalk.yellow,
  missing: chalk.magenta,
  error: chalk.red,
};

export async function runBrowserBookScrape(options: BrowserBookScrapeOptions): Promise<ScrapeRunSummary> {
  const strict = process.env.GOODREADS_STRICT_THROTTLE === '1';
  const cooldownMs = options.cooldownMs ?? 60_000;
  const engine = options.engine || 'browser';

  console.log(chalk.cyan.bold(`\n🌐 browser-book-scrape: engine=${engine} skipHas=[${options.skipHas.join(', ')}] sort=${options.sort} limit=${options.limit}`));
  if (engine === 'browser') console.log(chalk.gray('   (headed Chromium window — one at a time, 2–4s pacing)'));

  const { sql, params } = buildCandidateQuery({
    skipHas: options.skipHas,
    minRatings: options.minRatings,
    sort: options.sort,
    limit: options.limit,
  });

  const db = getDb();
  const candidates = db.prepare(sql).all(...params) as { id: string; title: string; ratings: number }[];
  console.log(chalk.gray(`   Backlog: ${candidates.length} candidate(s) matching criteria`));

  if (options.dryRun) {
    for (const c of candidates) {
      console.log(`   ${c.id}\t${String(c.ratings).padStart(9)}\t${c.title}`);
    }
    console.log(chalk.gray('   (--dryRun: no network, no tables, no DB writes)'));
    return { total: candidates.length, processed: 0, ok: 0, throttled: 0, missing: 0, error: 0, skipped: 0, elapsedMs: 0 };
  }

  ensureScrapeTables();

  if (candidates.length === 0) {
    console.log(chalk.green('   Nothing to do — no books match the skip criteria.'));
    return { total: 0, processed: 0, ok: 0, throttled: 0, missing: 0, error: 0, skipped: 0, elapsedMs: 0 };
  }

  const runStart = Date.now();
  const maxThrottles = Math.max(0, options.maxConsecutiveThrottles ?? 2);
  const summary: ScrapeRunSummary = { total: candidates.length, processed: 0, ok: 0, throttled: 0, missing: 0, error: 0, skipped: 0, elapsedMs: 0 };
  let consecutiveThrottles = 0;

  for (const [index, candidate] of candidates.entries()) {
    const num = index + 1;
    if (!options.force) {
      const prior = getCheckpoint(candidate.id);
      if (prior?.status === 'ok') {
        summary.skipped++;
        console.log(chalk.gray(`   #${num}/${candidates.length} [skip] id=${candidate.id} "${candidate.title}" (already scraped; use --force to re-scrape)`));
        continue;
      }
    }

    console.log(chalk.cyan(`   #${num}/${candidates.length} Fetching id=${candidate.id} "${candidate.title}" (ratings=${candidate.ratings})...`));
    let result = await processBook(candidate.id, engine);
    summary.processed++;
    if (result.checkpoint.status === 'throttled' && !strict) {
      console.log(chalk.yellow(`   #${num}/${candidates.length} [throttled] id=${candidate.id} http=${result.checkpoint.http} — cooldown ${(cooldownMs / 1000).toFixed(0)}s then 1 retry...`));
      await cooldown(cooldownMs);
      result = await processBook(candidate.id, engine);
      summary.processed++;
    }

    const c = result.checkpoint;
    summary[c.status]++;
    const color = STATUS_COLOR[c.status];
    const genreInfo = result.parsed && result.parsed.genres.length ? ` genres=${result.parsed.genres.length}` : '';

    if (c.status === 'throttled') consecutiveThrottles++;
    else consecutiveThrottles = 0;
    const ratingInfo = String(candidate.ratings);
    console.log(color(
      `   #${num}/${candidates.length} ${httpCallInfo(c.http, c.bytes, c.elapsed_ms, ['bookId', candidate.id], c.status)} ratings=${ratingInfo}${genreInfo} "${candidate.title}"`
    ));
    if (c.error) console.log(chalk.gray(`      error: ${c.error.slice(0, 160)}`));

    if (c.status === 'throttled' && maxThrottles > 0 && consecutiveThrottles >= maxThrottles) {
      console.log(chalk.yellow(`   ⏸️  ${maxThrottles} consecutive throttles (cooldown/retry did not clear it) — stopping to avoid hammering Goodreads.`));
      console.log(chalk.red.bold('      Goodreads is currently serving HTTP 202 interstitials to this transport. Wait out the cooldown, or use --engine browser (one headed Chromium window, WAF-safe) for now.'));
      break;
    }
    if (c.status === 'throttled' && strict) {
      console.log(chalk.red.bold('   🛑 Throttled in strict mode (GOODREADS_STRICT_THROTTLE=1) — aborting run. Retry after a cooldown.'));
      break;
    }
    if (num < candidates.length) await pace();
  }

  summary.elapsedMs = Date.now() - runStart;
  const mins = (summary.elapsedMs / 60000).toFixed(1);
  console.log(chalk.cyan.bold(`\n   Done: ${summary.ok} ok, ${summary.throttled} throttled, ${summary.missing} missing, ${summary.error} error, ${summary.skipped} skipped (${summary.processed} requests) in ${mins}m.`));
  await closeBrowserContext();
  return summary;
}

export async function closeBrowserContext(): Promise<void> {
  if (!browserContext) return;
  await browserContext.close().catch(() => {});
  browserContext = null;
  loginState = null;
}