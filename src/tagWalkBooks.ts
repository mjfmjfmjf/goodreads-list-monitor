import chalk from 'chalk';
import { Page } from 'playwright';
import {
  getBrowserContext,
  processBook,
  ensureScrapeTables,
  closeBrowserContext,
  cooldown,
  pace,
} from './browserBookScrape.js';
import { listHtmlUsable, shouldSkipBook } from './listWalker.js';
import { httpCallInfo } from './utils.js';

export interface TagWalkBooksOptions {
  tag: string;
  limit: number;
  startPage?: number;
  maxPages?: number;
  skipHas: string[];
  dryRun?: boolean;
  force?: boolean;
  cooldownMs?: number;
  maxConsecutiveThrottles?: number;
}

export interface ShelfPageBook {
  position: number;
  bookId: string;
  title: string;
}

export interface ParsedShelfPage {
  title: string;
  books: ShelfPageBook[];
  hasNextPage: boolean;
  nextPageHref?: string;
  advertisedLastPage?: number;
}

export interface TagWalkSummary {
  pages: number;
  processed: number;
  ok: number;
  throttled: number;
  missing: number;
  error: number;
  skipped: number;
  capped: boolean;
}

const MAX_EMPTY_FETCHES = Math.max(1, Number(process.env.GOODREADS_MAX_EMPTY_FETCHES) || 3);
const BOOKS_PER_SHELF_PAGE = 50;

export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/^-+|-+$/g, '');
}

export function nextShelfPageNumber(href: string | undefined, current: number): number {
  const m = href?.match(/[?&]page=(\d+)/);
  return m ? parseInt(m[1], 10) : current + 1;
}

export function parseShelfPage(html: string, slug: string): ParsedShelfPage {
  const titleMatch = html.match(/<title>([^<]*)<\/title>/);
  const title = titleMatch ? titleMatch[1].replace(/\s*\| Goodreads\s*$/, '').trim() : 'Unknown Shelf';

  const books: ShelfPageBook[] = [];
  let idx = 0;
  while (true) {
    const start = html.indexOf('class="elementList"', idx);
    if (start === -1) break;
    const end = html.indexOf('class="elementList"', start + 1);
    const block = html.slice(start, end === -1 ? html.length : end);
    const link = block.match(/<a class="bookTitle"[^>]*href="\/book\/show\/(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    if (link) {
      const cleanTitle = link[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || 'Unknown Title';
      books.push({ position: books.length + 1, bookId: link[1], title: cleanTitle });
    }
    idx = start + 1;
  }

  const next = html.match(/<a[^>]*rel="next"[^>]*href="([^"]+)"/i);
  const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pageRe = new RegExp(`href="[^"]*\\/shelf\\/show\\/${esc}\\?page=(\\d+)`, 'gi');
  const pageNums = [...html.matchAll(pageRe)].map(m => parseInt(m[1], 10)).filter(n => Number.isFinite(n) && n > 0);

  return {
    title,
    books,
    hasNextPage: !!next,
    nextPageHref: next?.[1],
    advertisedLastPage: pageNums.length ? Math.max(...pageNums) : undefined,
  };
}

interface ShelfFetch {
  status?: number;
  html: string;
  error?: string;
}

async function fetchShelfPage(page: Page, slug: string, pageNum: number): Promise<ShelfFetch> {
  const NAV_TIMEOUT_MS = 45_000;
  const url = `https://www.goodreads.com/shelf/show/${slug}${pageNum > 1 ? `?page=${pageNum}` : ''}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = (async () => {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(1200);
    const html = await page.content();
    const status = response?.status();
    if (status === 202 || status === 403 || status === 429) return { status, html: '', error: `Received ${status} interstitial` };
    return { status, html };
  })();
  try {
    return await Promise.race<ShelfFetch>([
      attempt,
      new Promise<ShelfFetch>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`fetchShelfPage hung > ${NAV_TIMEOUT_MS / 1000}s (anti-bot redirect loop?)`)), NAV_TIMEOUT_MS);
      }),
    ]) as ShelfFetch;
  } catch (error: any) {
    return { html: '', error: String(error?.message || error) };
  } finally {
    if (timer) clearTimeout(timer);
    attempt.catch(() => {});
  }
}

const BOOK_STATUS_COLOR: Record<string, (s: string) => string> = {
  ok: chalk.green,
  throttled: chalk.yellow,
  missing: chalk.magenta,
  error: chalk.red,
};

export async function runTagWalkBooks(options: TagWalkBooksOptions): Promise<TagWalkSummary> {
  const strict = process.env.GOODREADS_STRICT_THROTTLE === '1';
  const slug = normalizeTag(options.tag);
  const limit = options.limit;
  const startPage = Math.max(1, options.startPage ?? 1);
  const maxPages = Math.max(1, options.maxPages ?? 25);
  const cooldownMs = options.cooldownMs ?? 60_000;
  const maxThrottles = Math.max(0, options.maxConsecutiveThrottles ?? 2);
  const skipHas = options.skipHas ?? [];
  const dryRun = !!options.dryRun;

  console.log(chalk.cyan.bold(`\n🏷️  walk-tag-books: tag="${slug}" skipHas=[${skipHas.join(', ')}] limit=${limit} pages ${startPage}-${startPage + maxPages - 1}${dryRun ? ' (DRY RUN)' : ''}`));
  console.log(chalk.gray('   headed Chromium window (logged-in) — walks the shelf top-to-bottom, harvesting every book'));

  const summary: TagWalkSummary = {
    pages: 0, processed: 0, ok: 0, throttled: 0, missing: 0, error: 0, skipped: 0, capped: false,
  };

  if (!dryRun) ensureScrapeTables();

  const context = await getBrowserContext();
  const started = Date.now();

  try {
    const page = await context.newPage();
    try {
      const seenPages = new Set<number>();
      let pageNum = startPage;
      let emptyFetches = 0;
      const lastPageCap = startPage + maxPages - 1;

      while (pageNum <= lastPageCap) {
        if (seenPages.has(pageNum)) {
          console.log(chalk.yellow(`   ↛ reached shelf page ${pageNum} again — stopping.`));
          break;
        }
        seenPages.add(pageNum);

        console.log(chalk.cyan(`   📖 shelf "${slug}" — page ${pageNum}...`));
        const fetch = await fetchShelfPage(page, slug, pageNum);
        if ((fetch.status === 202 || fetch.status === 403 || fetch.status === 429) && !strict) {
          console.log(chalk.yellow(`   ⏳ shelf ${slug} page ${pageNum} [throttled] http=${fetch.status} — cooldown ${(cooldownMs / 1000).toFixed(0)}s then 1 retry...`));
          await cooldown(cooldownMs);
          const retry = await fetchShelfPage(page, slug, pageNum);
          if (!retry.html && !retry.status) {
            console.log(chalk.red(`   🛑 shelf ${slug} page ${pageNum} still throttled after retry — aborting walk.`));
            break;
          }
          Object.assign(fetch, retry);
        }
        if (strict && (fetch.status === 202 || fetch.status === 403 || fetch.status === 429)) {
          console.log(chalk.red.bold('   🛑 Throttled in strict mode (GOODREADS_STRICT_THROTTLE=1) — aborting walk.'));
          break;
        }
        if (fetch.error && !fetch.html) {
          summary.error++;
          console.log(chalk.red(`   ❌ shelf ${slug} page ${pageNum} fetch error: ${fetch.error.slice(0, 140)}`));
          break;
        }
        if (listHtmlUsable(fetch.html)) {
          emptyFetches = 0;
        } else if (++emptyFetches >= MAX_EMPTY_FETCHES) {
          summary.error++;
          console.log(chalk.red(`   🛑 shelf ${slug} page ${pageNum} produced no usable HTML ${MAX_EMPTY_FETCHES} consecutive times${fetch.error ? ` (${fetch.error.slice(0, 120)})` : ''} — aborting walk.`));
          break;
        }

        const parsed = parseShelfPage(fetch.html, slug);
        summary.pages++;
        console.log(chalk.cyan(`   ✨ shelf "${parsed.title}" — page ${pageNum} (${parsed.books.length} books)`));
        if (parsed.books.length === 0) {
          console.log(chalk.gray(`   (No book rows on shelf page ${pageNum} — ${pageNum > startPage ? 'the shelf ended' : 'the tag may not exist or the page was throttled'}. Stopping.)`));
          break;
        }

        let consecutiveThrottles = 0;
        for (let i = 0; i < parsed.books.length; i++) {
          if (limit > 0 && summary.processed >= limit) {
            summary.capped = true;
            break;
          }
          const book = parsed.books[i];
          book.position = (pageNum - 1) * BOOKS_PER_SHELF_PAGE + (i + 1);
          const skipReason = shouldSkipBook(book.bookId, { force: options.force, skipHas });
          if (skipReason) {
            summary.skipped++;
            console.log(chalk.gray(`   - ${book.bookId}\t${book.title.slice(0, 60)} (${skipReason})`));
            continue;
          }
          if (dryRun) {
            summary.processed++;
            console.log(chalk.gray(`   · ${book.bookId} "${book.title.slice(0, 60)}" (shelf pos ${book.position}) — dry run, skip`));
            continue;
          }
          console.log(chalk.cyan(`   → ${book.bookId} "${book.title.slice(0, 70)}" (shelf pos ${book.position})...`));
          let result = await processBook(book.bookId, 'browser');
          summary.processed++;
          if (result.checkpoint.status === 'throttled' && !strict) {
            console.log(chalk.yellow(`      [throttled] http=${result.checkpoint.http} — cooldown ${(cooldownMs / 1000).toFixed(0)}s then 1 retry...`));
            await cooldown(cooldownMs);
            result = await processBook(book.bookId, 'browser');
            summary.processed++;
          }
          summary[result.checkpoint.status as keyof TagWalkSummary]++;
          if (result.checkpoint.status === 'throttled') consecutiveThrottles++;
          else consecutiveThrottles = 0;
          const color = BOOK_STATUS_COLOR[result.checkpoint.status] ?? ((s: string) => s);
          console.log(color(`   ✓ ${httpCallInfo(result.checkpoint.http, result.checkpoint.bytes, result.checkpoint.elapsed_ms, ['bookId', book.bookId], result.checkpoint.status)} pos=${book.position} "${book.title.slice(0, 60)}"`));
          if (maxThrottles > 0 && consecutiveThrottles >= maxThrottles) {
            console.log(chalk.yellow(`   ⏸️  ${maxThrottles} consecutive throttles — stopping walk to avoid hammering Goodreads.`));
            summary.capped = true;
            break;
          }
          await pace();
        }
        if (summary.capped) break;

        if (parsed.advertisedLastPage !== undefined && pageNum >= parsed.advertisedLastPage) {
          console.log(chalk.gray(`   ✓ reached the shelf's advertised last page (${parsed.advertisedLastPage}).`));
          break;
        }
        if (!parsed.hasNextPage) break;
        const nextPage = nextShelfPageNumber(parsed.nextPageHref, pageNum);
        if (nextPage !== pageNum + 1) {
          console.log(chalk.gray(`   ↛ next-page link lands on page ${nextPage}, not ${pageNum + 1} — stopping.`));
          break;
        }
        await pace();
        pageNum = nextPage;
      }
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    await closeBrowserContext();
  }

  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log(chalk.cyan.bold(`\n   Done: ${summary.ok} ok, ${summary.throttled} throttled, ${summary.missing} missing, ${summary.error} error, ${summary.skipped} skipped across ${summary.pages} page(s) in ${mins}m for tag "${slug}".`));
  if (summary.capped) console.log(chalk.gray(`   Stopped: reached the ${limit}-book limit. Re-run to continue; harvested books are checkpointed so they're skipped.`));
  return summary;
}