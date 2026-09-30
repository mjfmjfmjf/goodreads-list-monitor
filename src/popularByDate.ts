import chalk from 'chalk';
import { Page } from 'playwright';
import { getDb } from './db.js';
import { getBrowserContext, closeBrowserContext, runBrowserBookScrape, ScrapeRunSummary } from './browserBookScrape.js';
import { connectivityProbeDefaults, isConnectivityError, withDbLockRetry } from './utils.js';

// AWS AppSync fetch fallback for the getTopList query. The live endpoint + API
// key are ALWAYS captured from the page's own traffic at runtime (the automatic
// `getBasicGenres` request fires on every load) — this constant is only used if
// that capture somehow misses.
const APPSYNC_URL = 'https://kxbwmqov6jgg3daaamb744ycu4.appsync-api.us-east-1.amazonaws.com/graphql';

// Single getTopList query covering both edge shapes Goodreads emits:
//  - month pages (`books-by-release-date-2026-9`): TopListBookEdge → node.legacyId
//  - year pages  (`works-by-release-date-2012`):    TopListWorkEdge → node.details.bestBook.legacyId
// Pagination chains the server-returned nextPageToken (a hex-encoded
// {"topListKey":...,"rank":N} blob) until hasNextPage=false; a full page is
// 14 fetches × 15 = ~200 books.
const GET_TOP_LIST_QUERY = `query getTopList(
  $name: String!
  $period: String!
  $location: String!
  $nextPageToken: String
  $limit: Int
) {
  getTopList(
    getTopListInput: { name: $name, period: $period, location: $location }
    pagination: { after: $nextPageToken, limit: $limit }
  ) {
    name period location
    pageInfo { hasNextPage nextPageToken __typename }
    edges {
      ... on TopListBookEdge {
        rank count __typename
        node { legacyId title __typename work { id stats { ratingsCount textReviewsCount averageRating } } }
      }
      ... on TopListWorkEdge {
        rank count __typename
        node {
          id __typename
          stats { ratingsCount textReviewsCount averageRating }
          details { bestBook { legacyId title __typename } }
        }
      }
      ... on TopListUserEdge { rank count __typename node { name } }
      __typename
    }
    __typename
  }
}`;

export interface PopularByDateOptions {
  year?: number;
  month?: number;
  yearBack?: number;
  monthBack?: number;
  limit: number;
  skipHas: string[];
  skipDays: number;
  force?: boolean;
  dryRun?: boolean;
  noDetails?: boolean;
  pages?: number;
  cooldownMs?: number;
  maxConsecutiveThrottles?: number;
  engine?: 'axios' | 'browser';
}

export interface PopularByDateSummary {
  pagesWalked: number;
  booksEnumerated: number;
  pagesSkipped: number;
  pagesNotFound: number;
  listingAdded: number;
  detailSummary?: ScrapeRunSummary;
  elapsedMs: number;
}

interface EnumeratedRow {
  book_id: string;
  rank: number;
  count: number;
  title: string;
  work_id?: string;
  stats_ratings?: number;
  stats_reviews?: number;
  stats_avg?: number;
}

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

// 'YYYY' for a year page, 'YYYY-M' for a month page (bare month, no leading zero).
export function pageKeyFor(year: number, month?: number): string {
  return month ? `${year}-${month}` : `${year}`;
}

export function topListNameFor(pageKey: string): string {
  const m = pageKey.match(/^(\d{4})-(\d+)$/);
  return m ? `books-by-release-date-${m[1]}-${m[2]}` : `works-by-release-date-${pageKey}`;
}

export function pageUrlFor(pageKey: string): string {
  const m = pageKey.match(/^(\d{4})-(\d+)$/);
  return m
    ? `https://www.goodreads.com/book/popular_by_date/${m[1]}/${m[2]}`
    : `https://www.goodreads.com/book/popular_by_date/${pageKey}`;
}

// Build the ordered page-key walk list, strictly newest→oldest: for each year,
// its month pages inside the month window (descending) come first, then that
// year's page, then the next year. So the walk reads 2026-9..2026-1, 2026,
// 2025-12..2025-1, 2025, ... — month pages only exist for roughly the last 2
// years; older years emit just their year page.
export function buildPageKeys(opts: Pick<PopularByDateOptions, 'year' | 'month' | 'yearBack' | 'monthBack'>, now = new Date()): string[] {
  const anchorYear = opts.year ?? now.getFullYear();
  const anchorMonth = opts.month ?? now.getMonth() + 1;
  const yearBack = Math.max(0, opts.yearBack ?? 0);
  const monthBack = Math.max(0, opts.monthBack ?? 1);

  const minPageYear = anchorYear - yearBack;
  let bottomYear = anchorYear;
  let bottomMonth = anchorMonth;
  {
    let y = anchorYear;
    let m = anchorMonth;
    for (let i = 1; i < monthBack; i++) {
      m -= 1;
      if (m < 1) {
        m = 12;
        y -= 1;
      }
    }
    bottomYear = y;
    bottomMonth = m;
  }

  const keys: string[] = [];
  for (let y = anchorYear; y >= Math.min(minPageYear, bottomYear); y--) {
    if (y >= bottomYear) {
      const maxMonth = y === anchorYear ? anchorMonth : 12;
      const minMonth = y === bottomYear ? bottomMonth : 1;
      for (let m = maxMonth; m >= minMonth; m--) {
        keys.push(pageKeyFor(y, m));
      }
    }
    if (y >= minPageYear) keys.push(pageKeyFor(y));
  }
  return keys;
}

// Client-side 404 pages return HTTP 200 with an empty Apollo state.
export function isClient404(title: string): boolean {
  return /404/.test(title);
}

// Parse getTopList payloads (array of pages) into BookOrWork rows.
export function parseTopListRows(pages: any[]): EnumeratedRow[] {
  const rows: EnumeratedRow[] = [];
  for (const tl of pages ?? []) {
    for (const e of tl?.edges ?? []) {
      if (e?.__typename === 'TopListBookEdge') {
        const bookId = e.node.legacyId;
        if (bookId === undefined || bookId === null || bookId === '') continue;
        rows.push({
          book_id: String(bookId),
          rank: e.rank ?? 0,
          count: e.count ?? 0,
          title: e.node.title ?? '',
          work_id: e.node.work?.id,
          stats_ratings: e.node.work?.stats?.ratingsCount,
          stats_reviews: e.node.work?.stats?.textReviewsCount,
          stats_avg: e.node.work?.stats?.averageRating,
        });
      } else if (e?.__typename === 'TopListWorkEdge') {
        const bookId = e.node.details?.bestBook?.legacyId;
        if (bookId === undefined || bookId === null || bookId === '') continue;
        rows.push({
          book_id: String(bookId),
          rank: e.rank ?? 0,
          count: e.count ?? 0,
          title: e.node.details?.bestBook?.title ?? '',
          work_id: e.node.id,
          stats_ratings: e.node.stats?.ratingsCount,
          stats_reviews: e.node.stats?.textReviewsCount,
          stats_avg: e.node.stats?.averageRating,
        });
      }
    }
  }
  return rows.filter(r => !!r.book_id && r.book_id !== 'undefined');
}

function fmt(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── DB helpers ───────────────────────────────────────────────────────────────

export function upsertPopularByDateBooks(pageKey: string, rows: EnumeratedRow[], scrapedAt: string): { inserted: number; total: number } {
  const db = getDb();
  const before = (db.prepare('SELECT COUNT(*) AS c FROM popular_by_date_book WHERE page_key = ?').get(pageKey) as any)?.c ?? 0;
  withDbLockRetry(() => {
    const stmt = db.prepare(`
      INSERT INTO popular_by_date_book (page_key, book_id, rank, title, work_id, stats_ratings, stats_reviews, stats_avg, scraped_at)
      VALUES (@page_key, @book_id, @rank, @title, @work_id, @stats_ratings, @stats_reviews, @stats_avg, @scraped_at)
      ON CONFLICT(page_key, book_id) DO UPDATE SET
        rank=excluded.rank, title=excluded.title, work_id=excluded.work_id,
        stats_ratings=excluded.stats_ratings, stats_reviews=excluded.stats_reviews,
        stats_avg=excluded.stats_avg, scraped_at=excluded.scraped_at
    `);
    for (const r of rows) {
      stmt.run({
        page_key: pageKey,
        book_id: r.book_id,
        rank: r.rank ?? null,
        title: r.title ?? null,
        work_id: r.work_id ?? null,
        stats_ratings: r.stats_ratings ?? null,
        stats_reviews: r.stats_reviews ?? null,
        stats_avg: r.stats_avg ?? null,
        scraped_at: scrapedAt,
      });
    }
    // Self-heal: a listing title is the real release title, so recover books
    // whose row is still the old 'Unknown Title' placeholder (e.g. scraped by a
    // parser that predates title extraction). Only touches ids in this page's
    // listing; single statement, autocommit.
    const selfHeal = db.prepare(`
      UPDATE books
      SET title = (SELECT p.title FROM popular_by_date_book p
                   WHERE p.book_id = books.id AND p.title IS NOT NULL AND p.title != ''
                   LIMIT 1)
      WHERE title IN ('Unknown Title', 'Unknown')
        AND id IN (SELECT book_id FROM popular_by_date_book WHERE page_key = ? AND title IS NOT NULL AND title != '')
    `);
    selfHeal.run(pageKey);
  });
  const after = (db.prepare('SELECT COUNT(*) AS c FROM popular_by_date_book WHERE page_key = ?').get(pageKey) as any)?.c ?? 0;
  return { inserted: Math.max(0, after - before), total: after };
}

export function latestPageScrape(pageKey: string): string | undefined {
  const row = getDb().prepare('SELECT MAX(scraped_at) AS at FROM popular_by_date_book WHERE page_key = ?').get(pageKey) as { at?: string } | undefined;
  return row?.at;
}

// Skip a page whose listing was scraped within the last skipDays days.
export function shouldSkipPage(lastScraped: string, now: string, skipDays: number): boolean {
  if (skipDays <= 0) return false;
  const ageMs = Date.parse(now) - Date.parse(lastScraped);
  return Number.isFinite(ageMs) && ageMs <= skipDays * 24 * 60 * 60 * 1000;
}

export function distinctIdsFromRows(rows: EnumeratedRow[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows ?? []) {
    if (r?.book_id && r.book_id !== 'undefined' && !seen.has(r.book_id)) {
      seen.add(r.book_id);
      out.push(r.book_id);
    }
  }
  return out;
}

export function distinctBookIdsFromPages(pageKeys: string[]): string[] {
  const db = getDb();
  if (!pageKeys.length) return [];
  const ph = pageKeys.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT book_id, MIN(rank) AS best_rank FROM popular_by_date_book WHERE page_key IN (${ph}) GROUP BY book_id ORDER BY best_rank`)
    .all(...pageKeys) as { book_id: string }[];
  return rows.map(r => r.book_id);
}

// ── Page walker ──────────────────────────────────────────────────────────────

interface AppSyncMeta {
  url: string;
  apiKey: string;
}

async function captureAppSyncMeta(page: Page): Promise<AppSyncMeta> {
  const meta: AppSyncMeta = { url: '', apiKey: '' };
  page.on('request', req => {
    if (!meta.url || !meta.apiKey) {
      if (req.url().includes('appsync')) {
        const apiKey = req.headers()['x-api-key'];
        if (apiKey) {
          meta.url = req.url();
          meta.apiKey = apiKey;
        }
      }
    }
  });
  return meta;
}

interface PageWalkResult {
  rows: EnumeratedRow[];
  notFound?: boolean;
  throttled?: boolean;
  http?: number;
  bytes?: number;
  fetches?: number;
  error?: string;
  errorCode?: string;
}

export async function walkPopularByDatePage(page: Page, pageKey: string, maxPages: number): Promise<PageWalkResult> {
  const meta = await captureAppSyncMeta(page);
  const url = pageUrlFor(pageKey);
  const name = topListNameFor(pageKey);

  let response;
  try {
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (error: any) {
    return { rows: [], error: String(error?.message || error), errorCode: error?.code };
  }
  await page.waitForTimeout(2500);

  const title = await page.title().catch(() => '');
  if (isClient404(title)) return { rows: [], notFound: true };
  if (response && (response.status() === 202 || response.status() === 403 || response.status() === 429)) {
    return { rows: [], throttled: true, http: response.status() };
  }

  const endpoint = meta.url || APPSYNC_URL;
  const apiKey = meta.apiKey || (await page.evaluate(() => {
    const el = document.getElementById('__NEXT_DATA__');
    try {
      return el ? JSON.parse(el.textContent ?? '{}')?.props?.pageProps?.apiKey : undefined;
    } catch {
      return undefined;
    }
  }).catch(() => undefined));
  if (!apiKey) {
    return { rows: [], error: 'could not discover AppSync API key from the page traffic or __NEXT_DATA__' };
  }

  let result;
  try {
    result = await page.evaluate(
      async ({ endpoint, apiKey, name, query, maxPages }) => {
        const vars: any = { name, period: 'A', location: 'ALL', limit: 15, nextPageToken: null };
        const pages: any[] = [];
        let httpStatus = 200;
        let bytes = 0;
        let fetches = 0;
        for (let i = 0; i < maxPages; i++) {
          const body = {
            operationName: 'getTopList',
            variables: JSON.parse(JSON.stringify(vars)),
            extensions: { clientLibrary: { name: '@apollo/client', version: '4.1.6' } },
            query,
          };
          try {
            const resp = await fetch(endpoint, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
              body: JSON.stringify(body),
            });
            if (!resp.ok) {
              httpStatus = resp.status;
              break;
            }
            const raw = await resp.text();
            bytes += new TextEncoder().encode(raw).length;
            fetches++;
            const json = JSON.parse(raw);
            const tl = json?.data?.getTopList;
            if (!tl) break;
            pages.push(tl);
            if (!tl.pageInfo?.hasNextPage || !tl.pageInfo.nextPageToken) break;
            vars.nextPageToken = tl.pageInfo.nextPageToken;
            if ((tl.edges?.length ?? 0) === 0) break;
            await new Promise(r => setTimeout(r, 250));
          } catch (err: any) {
            httpStatus = err?.name === 'AbortError' ? 0 : httpStatus !== 200 ? httpStatus : 0;
            break;
          }
        }
        return { pages, httpStatus, bytes, fetches };
      },
      { endpoint, apiKey, name, query: GET_TOP_LIST_QUERY, maxPages }
    );
  } catch (error: any) {
    return { rows: [], error: String(error?.message || error), errorCode: error?.code };
  }

  if (result.httpStatus === 202 || result.httpStatus === 403 || result.httpStatus === 429) {
    return { rows: [], throttled: true, http: result.httpStatus };
  }
  if (result.httpStatus === 0) {
    return { rows: [], error: 'in-page getTopList fetch failed' };
  }
  const rows = parseTopListRows(result.pages);
  if (!rows.length) return { rows: [], notFound: true };
  return { rows, http: result.httpStatus, bytes: result.bytes, fetches: result.fetches };
}

// ── Main entry ────────────────────────────────────────────────────────────────

function mergeDetailTotals(summary: PopularByDateSummary, d: ScrapeRunSummary): void {
  const t = summary.detailSummary ?? {
    total: 0, processed: 0, ok: 0, throttled: 0, missing: 0, error: 0, skipped: 0, elapsedMs: 0, booksAdded: 0, authorsAdded: 0,
  };
  t.total += d.total;
  t.processed += d.processed;
  t.ok += d.ok;
  t.throttled += d.throttled;
  t.missing += d.missing;
  t.error += d.error;
  t.skipped += d.skipped;
  t.elapsedMs += d.elapsedMs;
  t.booksAdded = (t.booksAdded ?? 0) + (d.booksAdded ?? 0);
  t.authorsAdded = (t.authorsAdded ?? 0) + (d.authorsAdded ?? 0);
  summary.detailSummary = t;
}

export async function runPopularByDate(options: PopularByDateOptions): Promise<PopularByDateSummary> {
  const strict = process.env.GOODREADS_STRICT_THROTTLE === '1';
  const cooldownMs = options.cooldownMs ?? 60_000;
  const maxThrottles = Math.max(0, options.maxConsecutiveThrottles ?? 2);
  const maxPages = Math.max(1, options.pages ?? 30);
  const skipDays = options.skipDays ?? 7;

  const pageKeys = buildPageKeys(options);
  console.log(chalk.cyan.bold(`\n📅 popular-by-date: ${pageKeys.length} page(s) to walk (${pageKeys.join(', ')})`));
  console.log(chalk.gray(`   skip pages listed < ${skipDays}d ago${skipDays <= 0 ? ' (skip disabled)' : ''}${options.dryRun ? ' · DRY RUN — enumerate only, no writes' : options.noDetails ? ' · enumerate only (--no-details)' : ''}`));

  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS popular_by_date_book (
      page_key TEXT NOT NULL,
      book_id TEXT NOT NULL,
      rank INTEGER,
      title TEXT,
      work_id TEXT,
      stats_ratings INTEGER,
      stats_reviews INTEGER,
      stats_avg REAL,
      scraped_at TEXT NOT NULL,
      PRIMARY KEY (page_key, book_id)
    );
  `);

  const start = Date.now();
  const summary: PopularByDateSummary = { pagesWalked: 0, booksEnumerated: 0, pagesSkipped: 0, pagesNotFound: 0, listingAdded: 0, elapsedMs: 0 };
  const now = new Date().toISOString();
  const walkedKeys: string[] = [];
  let consecutiveThrottles = 0;

  if (pageKeys.length > 0) {
    const context = await getBrowserContext();
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    try {
      for (const key of pageKeys) {
        if (!options.force && !options.dryRun) {
          const lastScraped = latestPageScrape(key);
          if (lastScraped && shouldSkipPage(lastScraped, now, skipDays)) {
            summary.pagesSkipped++;
            console.log(chalk.gray(`   [skip] page=${key} — listed within the last ${skipDays}d; use --force to re-walk`));
            continue;
          }
        }

        summary.pagesWalked++;
        console.log(chalk.cyan(`   Walking page=${key} → ${pageUrlFor(key)}...`));
        if (walkedKeys.length > 0) {
          const pMs = 1500 + Math.floor(Math.random() * 2000);
          console.log(chalk.gray(`   (Pacing ${(pMs / 1000).toFixed(2)}s before next page...)`));
          await sleep(pMs);
        }
        let result = await walkPopularByDatePage(page, key, maxPages);
        if (result.throttled && !strict) {
          console.log(chalk.yellow(`   [throttled] page=${key} http=${result.http} — cooldown ${(cooldownMs / 1000).toFixed(0)}s then 1 retry...`));
          await sleep(cooldownMs);
          result = await walkPopularByDatePage(page, key, maxPages);
        }
        if (result.error || result.throttled) {
          const reason = result.throttled ? `throttled (http=${result.http})` : String(result.error).slice(0, 160);
          const color = result.throttled ? chalk.yellow : chalk.red;
          console.log(color(`   [${result.throttled ? 'throttled' : 'error'}] page=${key} — ${reason}`));
          if (result.errorCode && isConnectivityError({ code: result.errorCode })) {
            const { waitMs, probes } = connectivityProbeDefaults();
            let recovered = false;
            for (let probe = 1; probe <= probes; probe++) {
              console.log(chalk.yellow(`   ⚠️  page=${key} hit a network error (${result.errorCode}) — Goodreads unreachable, likely a temporary blip. Waiting ${Math.round(waitMs / 1000)}s, then probing (${probe}/${probes})...`));
              await sleep(waitMs);
              result = await walkPopularByDatePage(page, key, maxPages);
              if (!(result.errorCode && isConnectivityError({ code: result.errorCode }))) {
                recovered = true;
                break;
              }
            }
            if (!recovered) {
              console.log(chalk.red.bold('   ✂️  Network error — aborting with progress saved (loss of connection is not a page defect).'));
              break;
            }
          }
          if (result.throttled) {
            if (strict) {
              console.log(chalk.red.bold('   🛑 Throttled in strict mode (GOODREADS_STRICT_THROTTLE=1) — aborting run.'));
              break;
            }
            consecutiveThrottles++;
            if (maxThrottles > 0 && consecutiveThrottles >= maxThrottles) {
              console.log(chalk.yellow(`   ⏸️  ${maxThrottles} consecutive throttles — stopping to avoid hammering Goodreads.`));
              break;
            }
            continue;
          }
          continue;
        }

        if (result.notFound) {
          summary.pagesNotFound++;
          console.log(chalk.gray(`   [404] page=${key} — client-side 404 (out of range); skipping`));
          continue;
        }

        consecutiveThrottles = 0;
        summary.booksEnumerated += result.rows.length;
        walkedKeys.push(key);
        console.log(chalk.green(`   ✓ page=${key} → ${result.rows.length} books (rank ${result.rows[0]?.rank ?? '-'}–${result.rows[result.rows.length - 1]?.rank ?? '-'}) · http=${result.http ?? 200} · ${result.fetches ?? 0} fetches · ${fmtBytes(result.bytes ?? 0)}`));
        if (options.dryRun) {
          for (const r of result.rows) {
            console.log(`      ${String(r.rank).padStart(4)}\t${r.book_id}\t${r.title}`);
          }
        } else {
          const u = upsertPopularByDateBooks(key, result.rows, now);
          summary.listingAdded += u.inserted;
          // Interleave the detail scrape right after this page's listing —
          // walk a list, read its books, move to the next list (human-like),
          // instead of grinding all lists then all books.
          const pageIds = distinctIdsFromRows(result.rows).slice(0, options.limit);
          if (pageIds.length > 0) {
            console.log(chalk.cyan.bold(`\n📚 Page detail scrape for ${key}: ${pageIds.length} book(s)...`));
            const titles = new Map<string, string>();
            const ratings = new Map<string, number>();
            for (const r of result.rows) {
              titles.set(r.book_id, r.title ?? '');
              ratings.set(r.book_id, r.stats_ratings ?? 0);
            }
            const d = await runBrowserBookScrape({
              limit: options.limit,
              skipHas: options.skipHas,
              sort: 'ratingsDesc',
              engine: options.engine ?? 'browser',
              force: options.force,
              cooldownMs: options.cooldownMs,
              maxConsecutiveThrottles: options.maxConsecutiveThrottles,
              candidateBookIds: pageIds,
              candidateTitleByBook: titles,
              candidateRatingsByBook: ratings,
              closeContext: false,
            });
            mergeDetailTotals(summary, d);
          }
        }
      }
    } finally {
      await page.close().catch(() => {});
    }
  }

  // Phase B is interleaved per-page above (walk a list → scrape its books →
  // next list), so the browser context stays open for the whole run.

  await closeBrowserContext();
  summary.elapsedMs = Date.now() - start;
  const d = summary.detailSummary;
  const addedPart = d
    ? ` · +${d.booksAdded ?? 0} books · +${d.authorsAdded ?? 0} authors added`
    : '';
  console.log(chalk.cyan.bold(
    `\n   Done: ${summary.pagesWalked} pages walked, ${summary.booksEnumerated} books enumerated, ` +
    `${summary.pagesSkipped} skipped, ${summary.pagesNotFound} not-found, +${summary.listingAdded} new listing rows` +
    (d ? ` — details: ${d.ok} ok, ${d.throttled} throttled, ${d.missing} missing, ${d.error} error, ${d.skipped} skipped in ${fmt(d.elapsedMs)}` : '') +
    `${addedPart} (${fmt(summary.elapsedMs)}).`
  ));
  return summary;
}