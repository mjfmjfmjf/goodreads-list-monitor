import chalk from 'chalk';
import { Page } from 'playwright';
import { getBrowserContext, closeBrowserContext, runBrowserBookScrape, ScrapeRunSummary } from './browserBookScrape.ts';
import { connectivityProbeDefaults, isConnectivityError, httpCallInfo, parseDelayRange } from './utils.ts';

// The Giveaways feed is driven by Goodreads' AppSync `getGiveaways` query. The
// endpoint is the SAME one popular-by-date uses (spike-verified 2026/10/17); the
// api key is read from the page's `__NEXT_DATA__.props.pageProps.apiKey`. The
// listing is SERVER-rendered, so no getGiveaways request fires on plain load —
// we drive the whole pagination ourselves from inside the page with fetch().
const APPSYNC_URL = 'https://kxbwmqov6jgg3daaamb744ycu4.appsync-api.us-east-1.amazonaws.com/graphql';
const GIVEAWAY_URL = 'https://www.goodreads.com/giveaway?sort=recently_listed';

// Book-id only: the book detail page is the canonical source for all book-level
// data, so the listing is used purely to discover book ids. `details.book.legacyId`
// is the primary source (spike-verified selectable); the id embedded in the cover
// imageUrl is the fallback.
export function giveawaysQuery(sortEnum: string): string {
  return `query getGiveaways($nextPageToken: String, $limit: Int) {
  getGiveaways(
    getGiveawaysInput: { format: null, genre: "all", sort: ${sortEnum} }
    pagination: { after: $nextPageToken, limit: $limit }
  ) {
    totalCount
    pageInfo { hasNextPage nextPageToken }
    edges {
      node {
        legacyId
        details {
          format
          book { legacyId title imageUrl }
        }
      }
    }
  }
}`;
}

export interface GiveawaysOptions {
  limit: number;
  skipHas: string[];
  sort?: string;
  pages?: number;
  pageSize?: number;
  engine?: 'axios' | 'browser';
  dryRun?: boolean;
  noDetails?: boolean;
  force?: boolean;
  cooldownMs?: number;
  maxConsecutiveThrottles?: number;
}

export interface GiveawaysSummary {
  pagesFetched: number;
  giveawaysSeen: number;
  distinctBooks: number;
  totalCount?: number;
  throttled: boolean;
  detailSummary?: ScrapeRunSummary;
  elapsedMs: number;
}

export interface GiveawayRow {
  giveawayId: string;
  bookId: string | null;
  title: string;
  format?: string;
}

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

// UI sort label / enum → the AppSync enum value. Accepts either UX words or the
// enum itself (case-insensitive); unknown values fall back to RECENTLY_LISTED.
const SORT_ENUMS: Record<string, string> = {
  recent: 'RECENTLY_LISTED',
  recently_listed: 'RECENTLY_LISTED',
  ending: 'ENDING_SOON',
  ending_soon: 'ENDING_SOON',
  popular: 'POPULAR',
  featured: 'FEATURED',
};

export function sortToEnum(sort?: string): string {
  return SORT_ENUMS[String(sort ?? '').trim().toLowerCase()] ?? 'RECENTLY_LISTED';
}

// The numeric book id lives at the tail of the cover URL:
//   .../books/1715215178i/213082829.jpg  →  '213082829'
export function bookIdFromImageUrl(url?: string | null): string | null {
  const m = String(url ?? '').match(/\/books\/[^/]+\/(\d+)\.jpg/);
  return m ? m[1] : null;
}

// Prefer the giveaways edge's `details.book.legacyId`; fall back to the imageUrl.
export function bookIdFromGiveawayNode(node: any): string | null {
  const legacy = node?.details?.book?.legacyId;
  if (legacy !== undefined && legacy !== null && legacy !== '') return String(legacy);
  return bookIdFromImageUrl(node?.details?.book?.imageUrl);
}

// Flatten getGiveaways connections into giveaway rows (one per edge).
export function parseGiveawaysEdges(conns: any[]): GiveawayRow[] {
  const rows: GiveawayRow[] = [];
  for (const conn of conns ?? []) {
    for (const e of conn?.edges ?? []) {
      const node = e?.node;
      if (!node) continue;
      const giveawayId = node?.legacyId !== undefined && node?.legacyId !== null ? String(node.legacyId) : '';
      if (!giveawayId) continue;
      rows.push({
        giveawayId,
        bookId: bookIdFromGiveawayNode(node),
        title: node?.details?.book?.title ?? '',
        format: node?.details?.format ?? undefined,
      });
    }
  }
  return rows;
}

// Distinct, first-seen book ids (drops rows with no usable book id).
export function distinctBookIds(rows: GiveawayRow[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows ?? []) {
    const id = r?.bookId;
    if (id && id !== 'undefined' && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function fmt(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isThrottleStatus(status?: number): boolean {
  return status === 202 || status === 403 || status === 429;
}

// ── In-page fetch (one getGiveaways page) ────────────────────────────────────

interface GiveawaysPageResult {
  conn: any | null;
  httpStatus?: number;
  bytes?: number;
  ms?: number;
  error?: string;
  errorCode?: string;
}

async function fetchGiveawaysPage(
  page: Page,
  apiKey: string,
  token: string | null,
  limit: number,
  query: string
): Promise<GiveawaysPageResult> {
  try {
    return await page.evaluate(
      async ({ endpoint, apiKey, token, limit, query }) => {
        const t0 = performance.now();
        try {
          const resp = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
            body: JSON.stringify({
              operationName: 'getGiveaways',
              variables: { nextPageToken: token, limit },
              extensions: { clientLibrary: { name: '@apollo/client', version: '4.1.6' } },
              query,
            }),
          });
          const text = await resp.text();
          const ms = performance.now() - t0;
          const bytes = text.length;
          if (!resp.ok) return { httpStatus: resp.status, conn: null, ms, bytes };
          const json = JSON.parse(text);
          if (json?.errors) return { httpStatus: resp.status, conn: null, ms, bytes, error: JSON.stringify(json.errors).slice(0, 200) };
          return { httpStatus: resp.status, conn: json?.data?.getGiveaways ?? null, ms, bytes };
        } catch (err: any) {
          return { httpStatus: 0, conn: null, ms: performance.now() - t0, bytes: 0, error: String(err?.message || err) };
        }
      },
      { endpoint: APPSYNC_URL, apiKey, token, limit, query }
    );
  } catch (error: any) {
    return { conn: null, error: String(error?.message || error), errorCode: error?.code };
  }
}

// ── Main entry ───────────────────────────────────────────────────────────────

function mergeDetailTotals(summary: GiveawaysSummary, d: ScrapeRunSummary): void {
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

export async function runGiveaways(options: GiveawaysOptions): Promise<GiveawaysSummary> {
  const strict = process.env.GOODREADS_STRICT_THROTTLE === '1';
  const cooldownMs = options.cooldownMs ?? 60_000;
  const maxThrottles = Math.max(0, options.maxConsecutiveThrottles ?? 2);
  const maxPages = Math.max(1, options.pages ?? 130);
  const pageSize = Math.max(1, options.pageSize ?? 15);
  const sortEnum = sortToEnum(options.sort);
  const query = giveawaysQuery(sortEnum);

  console.log(chalk.cyan.bold(`\n🎁 giveaways: sort=${sortEnum} (${GIVEAWAY_URL})`));
  console.log(chalk.gray(`   up to ${maxPages} fetch(es) of ${pageSize} · ${options.dryRun ? 'DRY RUN — enumerate only, no writes' : options.noDetails ? 'enumerate only (--no-details)' : `detail-scrape up to ${options.limit} book(s)`}`));

  const start = Date.now();
  const summary: GiveawaysSummary = { pagesFetched: 0, giveawaysSeen: 0, distinctBooks: 0, throttled: false, elapsedMs: 0 };

  const context = await getBrowserContext();
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const rows: GiveawayRow[] = [];
  try {
    const resp = await page.goto(GIVEAWAY_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
    if (resp && isThrottleStatus(resp.status())) {
      console.log(chalk.yellow(`   [throttled] listing page http=${resp.status()} — Goodreads is throttling; stopping.`));
      summary.throttled = true;
      await page.close().catch(() => {});
      await closeBrowserContext();
      summary.elapsedMs = Date.now() - start;
      return summary;
    }

    const apiKey = await page.evaluate(() => {
      const el = document.getElementById('__NEXT_DATA__');
      try {
        return el ? JSON.parse(el.textContent ?? '{}')?.props?.pageProps?.apiKey : undefined;
      } catch {
        return undefined;
      }
    }).catch(() => undefined);
    if (!apiKey) {
      console.log(chalk.red.bold('   Could not discover the AppSync API key (__NEXT_DATA__.props.pageProps.apiKey). Run `npm run browser-login` if the session is stale, then retry.'));
      await page.close().catch(() => {});
      await closeBrowserContext();
      summary.elapsedMs = Date.now() - start;
      return summary;
    }

    let token: string | null = null;
    let consecutiveThrottles = 0;
    // Pace the feed like the sibling popular-by-date AppSync walker: ~120
    // sequential fetches must not hammer Goodreads. GR_FEED_DELAY_MS overrides
    // ("min,max").
    const [feedDelayMin, feedDelayMax] = parseDelayRange(process.env.GR_FEED_DELAY_MS, 1500, 3500);
    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      let result = await fetchGiveawaysPage(page, apiKey, token, pageSize, query);
      if (isThrottleStatus(result.httpStatus) && !strict) {
        console.log(chalk.yellow(`   [throttled] fetch #${pageNum} http=${result.httpStatus} — cooldown ${(cooldownMs / 1000).toFixed(0)}s then 1 retry...`));
        await sleep(cooldownMs);
        result = await fetchGiveawaysPage(page, apiKey, token, pageSize, query);
      }

      if (result.errorCode && isConnectivityError({ code: result.errorCode })) {
        const { waitMs, probes } = connectivityProbeDefaults();
        let recovered = false;
        for (let probe = 1; probe <= probes; probe++) {
          console.log(chalk.yellow(`   ⚠️  fetch #${pageNum} hit a network error (${result.errorCode}) — waiting ${Math.round(waitMs / 1000)}s, then probing (${probe}/${probes})...`));
          await sleep(waitMs);
          result = await fetchGiveawaysPage(page, apiKey, token, pageSize, query);
          if (!(result.errorCode && isConnectivityError({ code: result.errorCode }))) {
            recovered = true;
            break;
          }
        }
        if (!recovered) {
          console.log(chalk.red.bold('   ✂️  Network error — aborting with progress saved (loss of connection is not a feed defect).'));
          break;
        }
      }

      if (isThrottleStatus(result.httpStatus)) {
        summary.throttled = true;
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
      if (result.error || !result.conn) {
        console.log(chalk.red(`   ${httpCallInfo(result.httpStatus, result.bytes, result.ms, ['fetch', pageNum], 'error')} — ${String(result.error ?? 'no getGiveaways data').slice(0, 160)}`));
        break;
      }

      consecutiveThrottles = 0;
      const conn = result.conn;
      const pageRows = parseGiveawaysEdges([conn]);
      rows.push(...pageRows);
      summary.pagesFetched++;
      summary.giveawaysSeen += pageRows.length;
      summary.totalCount = conn.totalCount ?? summary.totalCount;
      const totalStr = summary.totalCount !== undefined ? `/${summary.totalCount}` : '';
      console.log(chalk.green(`   ✓ ${httpCallInfo(result.httpStatus ?? 200, result.bytes, result.ms, ['fetch', pageNum])} → ${pageRows.length} giveaways (seen ${summary.giveawaysSeen}${totalStr})`));

      if (!conn.pageInfo?.hasNextPage || !conn.pageInfo.nextPageToken) break;
      if ((conn.edges?.length ?? 0) === 0) break;
      token = conn.pageInfo.nextPageToken;
      const pMs = feedDelayMin + Math.floor(Math.random() * (feedDelayMax - feedDelayMin + 1));
      console.log(chalk.gray(`   (Pacing ${(pMs / 1000).toFixed(2)}s before next fetch...)`));
      await sleep(pMs);
    }
  } finally {
    await page.close().catch(() => {});
  }

  const bookIds = distinctBookIds(rows);
  summary.distinctBooks = bookIds.length;
  const missingCover = rows.filter(r => !r.bookId).length;
  console.log(chalk.cyan.bold(`\n   Enumerated ${summary.giveawaysSeen} giveaways → ${bookIds.length} distinct book id(s)` + (missingCover ? ` (${missingCover} skipped: no book id)` : '')));

  if (options.dryRun) {
    for (const r of rows) {
      console.log(`   ${r.giveawayId}\t${r.bookId ?? '(no book id)'}\t${r.title}`);
    }
  } else if (!options.noDetails && bookIds.length > 0) {
    const titleById = new Map<string, string>();
    for (const r of rows) {
      if (r.bookId && !titleById.has(r.bookId)) titleById.set(r.bookId, r.title);
    }
    console.log(chalk.cyan.bold(`\n📚 Detail scrape: up to ${Math.min(options.limit, bookIds.length)} book(s)...`));
    const d = await runBrowserBookScrape({
      limit: options.limit,
      skipHas: options.skipHas,
      sort: 'ratingsDesc',
      engine: options.engine ?? 'browser',
      force: options.force,
      cooldownMs: options.cooldownMs,
      maxConsecutiveThrottles: options.maxConsecutiveThrottles,
      candidateBookIds: bookIds,
      candidateTitleByBook: titleById,
      closeContext: false,
    });
    mergeDetailTotals(summary, d);
  }

  await closeBrowserContext();
  summary.elapsedMs = Date.now() - start;
  const d = summary.detailSummary;
  const addedPart = d ? ` · +${d.booksAdded ?? 0} books · +${d.authorsAdded ?? 0} authors added` : '';
  console.log(chalk.cyan.bold(
    `\n   Done: ${summary.pagesFetched} fetch(es), ${summary.giveawaysSeen} giveaways enumerated, ${summary.distinctBooks} distinct book id(s)` +
    (d ? ` — details: ${d.ok} ok, ${d.throttled} throttled, ${d.missing} missing, ${d.error} error, ${d.skipped} skipped in ${fmt(d.elapsedMs)}` : '') +
    `${addedPart} (${fmt(summary.elapsedMs)}).`
  ));
  return summary;
}
