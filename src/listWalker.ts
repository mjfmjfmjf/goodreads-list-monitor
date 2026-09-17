import chalk from 'chalk';
import { BrowserContext, Page } from 'playwright';
import { createInterface } from 'readline';
import { getDb } from './db.js';
import { getBook, CachedBook } from './storage.js';
import { withDbLockRetry, httpCallInfo } from './utils.js';
import {
  getBrowserContext,
  processBook,
  getCheckpoint,
  ensureScrapeTables,
  closeBrowserContext,
  sleep,
  pace,
  cooldown,
  CheckpointRow,
} from './browserBookScrape.js';
import {
  ChainLink,
  MAX_LIST_PAGE_NUMBER,
  parseListPage,
  resolveNextChainLink,
} from './listPageParse.js';

const MIN_USABLE_LIST_HTML = 1000;
const MAX_EMPTY_FETCHES = Math.max(1, Number(process.env.GOODREADS_MAX_EMPTY_FETCHES) || 3);
// Challenge/interstitial shells are compact; real list pages are always larger.
const MAX_CHALLENGE_PAGE_BYTES = 64 * 1024;

export interface ListWalkerOptions {
  list: string;
  direction: 'desc' | 'asc';
  limit: number;
  maxLists: number;
  skipHas: string[];
  relistDays: number;
  force?: boolean;
  dryRun?: boolean;
  cooldownMs?: number;
  maxConsecutiveThrottles?: number;
  followChain?: boolean;
}

export interface WalkerSummary {
  listsWalked: number;
  listsSkipped: number;
  processed: number;
  ok: number;
  throttled: number;
  missing: number;
  error: number;
  skipped: number;
  captcha: number;
  capped: boolean;
  chainEnd: boolean;
}

interface ListWalkRow {
  list_id: string;
  title: string;
  status: string;
  current_page: number;
  next_list_id?: string;
  next_list_label?: string;
  total_pages?: number;
  total_books?: number;
  walkable_books?: number;
  resume_pos?: number | null;
  scraped_at: string;
}

function parseListInput(list: string): { listId: string } {
  if (/^\d+$/.test(list)) return { listId: list };
  const m = list.match(/[\/=]list\/show\/(\d+)/) ?? list.match(/(\d+)/);
  if (!m) throw new Error(`Cannot parse a list id from: ${list}`);
  return { listId: m[1] };
}

function listUrl(listId: string, pageNum: number): string {
  const base = `https://www.goodreads.com/list/show/${listId}`;
  return pageNum > 1 ? `${base}?page=${pageNum}` : base;
}

export function listHtmlUsable(html: string): boolean {
  return html.trim().length >= MIN_USABLE_LIST_HTML;
}

// A human-verification / CAPTCHA page parked in the headed browser tab needs a
// real person — and crucially must NOT be re-navigated (each page.goto resets
// the challenge). Detect it early so the walk can stop and wait for a solve.
// Challenge shells and interstitials are COMPACT pages (< 64KB); real list
// pages are 100KB+ even when light. Matching the marker anywhere in a multi-hundred-KB
// document false-positives on legit pages whose JS bundles merely embed the word,
// so a marker only counts on a small page.
export function isCaptchaPage(html: string): boolean {
  if (!html || html.length >= MAX_CHALLENGE_PAGE_BYTES) return false;
  return /verify you are human|are you a human|route through the captcha|captcha|challenges?\.cloudflare\.com|aws waf certification|unusual traffic/i.test(html);
}

// Quiet, blocking wait for a single Enter press. Used to hand control back to
// the user while a CAPTCHA is showing in the Chromium window.
export function waitForEnter(): Promise<void> {
  return new Promise<void>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', () => {
      rl.close();
      resolve();
    });
  });
}

export function ensureListTables(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS list_walk (
      list_id TEXT PRIMARY KEY,
      title TEXT,
      status TEXT NOT NULL,
      current_page INTEGER,
      next_list_id TEXT,
      next_list_label TEXT,
      total_pages INTEGER,
      total_books INTEGER,
      walkable_books INTEGER,
      resume_pos INTEGER,
      scraped_at TEXT NOT NULL
    );
  `);
  const cols = db.prepare('PRAGMA table_info(list_walk)').all() as { name: string }[];
  const have = new Set(cols.map(c => c.name));
  if (!have.has('total_pages')) db.exec('ALTER TABLE list_walk ADD COLUMN total_pages INTEGER');
  if (!have.has('total_books')) db.exec('ALTER TABLE list_walk ADD COLUMN total_books INTEGER');
  if (!have.has('walkable_books')) db.exec('ALTER TABLE list_walk ADD COLUMN walkable_books INTEGER');
  if (!have.has('resume_pos')) db.exec('ALTER TABLE list_walk ADD COLUMN resume_pos INTEGER');
}

export function getListWalkRow(listId: string): ListWalkRow | undefined {
  return getDb().prepare('SELECT * FROM list_walk WHERE list_id = ?').get(listId) as ListWalkRow | undefined;
}

export function setListWalkRow(row: Partial<ListWalkRow> & { list_id: string; status: string }): void {
  const db = getDb();
  withDbLockRetry(() => {
    db.prepare(`
      INSERT INTO list_walk (list_id, title, status, current_page, next_list_id, next_list_label, total_pages, total_books, walkable_books, resume_pos, scraped_at)
      VALUES (@list_id, @title, @status, @current_page, @next_list_id, @next_list_label, @total_pages, @total_books, @walkable_books, @resume_pos, @scraped_at)
      ON CONFLICT(list_id) DO UPDATE SET
        title=excluded.title, status=excluded.status, current_page=excluded.current_page,
        next_list_id=excluded.next_list_id, next_list_label=excluded.next_list_label,
        total_pages=excluded.total_pages, total_books=excluded.total_books,
        walkable_books=excluded.walkable_books,
        resume_pos=excluded.resume_pos,
        scraped_at=excluded.scraped_at
    `).run({
      list_id: row.list_id,
      title: row.title ?? null,
      status: row.status,
      current_page: row.current_page ?? 1,
      next_list_id: row.next_list_id ?? null,
      next_list_label: row.next_list_label ?? null,
      total_pages: row.total_pages ?? null,
      total_books: row.total_books ?? null,
      walkable_books: row.walkable_books ?? null,
      resume_pos: row.resume_pos ?? null,
      scraped_at: new Date().toISOString(),
    });
  });
}

interface ListFetch {
  status?: number;
  html: string;
  error?: string;
}

const NAV_TIMEOUT_MS = 45_000;
const HANG_RETRY_MS = Math.max(1000, parseInt(process.env.GOODREADS_HANG_RETRY_MS ?? '60000', 10) || 60_000);

async function fetchListPage(page: Page, listId: string, pageNum: number): Promise<ListFetch> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = (async () => {
    const response = await page.goto(listUrl(listId, pageNum), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(1200);
    const html = await page.content();
    const status = response?.status();
    if (status === 202 || status === 403 || status === 429) return { status, html: '', error: `Received ${status} interstitial` };
    return { status, html };
  })();
  try {
    return await Promise.race<Promise<ListFetch>>([
      attempt,
      new Promise<ListFetch>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`fetchListPage hung > ${NAV_TIMEOUT_MS / 1000}s (Goodreads page hang)`)), NAV_TIMEOUT_MS);
      }),
    ]) as ListFetch;
  } catch (error: any) {
    return { html: '', error: String(error?.message || error) };
  } finally {
    if (timer) clearTimeout(timer);
    attempt.catch(() => {});
  }
}

function hasField(existing: CachedBook | undefined, criteria: string): boolean {
  if (!existing) return false;
  if (criteria === 'genres') return !!(existing.genres && existing.genres.length > 0);
  if (criteria === 'work-id') return !!existing.workId;
  if (criteria === 'tags') return !!(existing.tags && Object.keys(existing.tags).length > 0);
  return false;
}

function nextPageNumber(href: string | undefined, current: number): number {
  const m = href?.match(/[?&]page=(\d+)/);
  return m ? parseInt(m[1], 10) : current + 1;
}

const BOOK_STATUS_COLOR: Record<string, (s: string) => string> = {
  ok: chalk.green,
  throttled: chalk.yellow,
  missing: chalk.magenta,
  error: chalk.red,
};

export async function runListWalker(options: ListWalkerOptions): Promise<WalkerSummary> {
  const strict = process.env.GOODREADS_STRICT_THROTTLE === '1';
  const cooldownMs = options.cooldownMs ?? 60_000;
  const maxThrottles = Math.max(0, options.maxConsecutiveThrottles ?? 2);
  const { listId: startListId } = parseListInput(options.list);

  console.log(chalk.cyan.bold(`\n📚 list-walk: start=${startListId} direction=${options.direction} skipHas=[${options.skipHas.join(', ')}] limit=${options.limit} maxLists=${options.maxLists}`));
  console.log(chalk.gray('   headed Chromium window (logged-in) — walks each list top-to-bottom, then follows the description chain link'));

  const summary: WalkerSummary = {
    listsWalked: 0, listsSkipped: 0, processed: 0, ok: 0, throttled: 0,
    missing: 0, error: 0, skipped: 0, captcha: 0, capped: false, chainEnd: false,
  };

  if (!options.dryRun) {
    ensureScrapeTables();
  }
  ensureListTables();

  await getBrowserContext();

  let currentListId: string | undefined = startListId;
  const started = Date.now();
  const visitedInRun = new Set<string>();

  try {
    while (currentListId && summary.listsWalked < (options.maxLists > 0 ? options.maxLists : Number.MAX_SAFE_INTEGER)) {
      if (visitedInRun.has(currentListId)) {
        console.log(chalk.yellow(`   🔁 chain wrapped — list ${currentListId} was already ${visitedInRun.size > 1 ? 'visited during this run' : 'the starting list'}. Stopping the walk rather than cycling.`));
        break;
      }
      visitedInRun.add(currentListId);
      const page = await (await getBrowserContext()).newPage();
      try {
        const { nextListId, chainEnd } = await walkOneList(page, currentListId, options, summary, strict, cooldownMs, maxThrottles);
        summary.chainEnd = chainEnd;
        if (summary.capped) break;
        currentListId = nextListId;
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await closeBrowserContext();
  }

  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log(chalk.cyan.bold(`\n   Done: ${summary.ok} ok, ${summary.throttled} throttled, ${summary.missing} missing, ${summary.error} error, ${summary.skipped} skipped, ${summary.captcha} captcha, ${summary.listsWalked} lists (${summary.listsSkipped} skipped) in ${mins}m.`));
  if (summary.capped) console.log(chalk.gray(`   Stopped: reached the ${options.limit}-book limit. Re-run to continue from the checkpoint.`));
  if (summary.chainEnd) console.log(chalk.green('   Chain completed: reached the end of the rating-range chain.'));
  return summary;
}

export interface ListScrapeSkip {
  title: string;
  scrapedAt: string;
  booksNote: string;
  relistHint: number;
}

// Pure skip decision for a list whose list_walk row is already 'done' and
// fresh enough (or --force). Pure DB read — NO network. Called up front by the
// harvest loop so already-scraped lists are filtered out before the browser is
// even opened, and re-checked inside walkOneList as the walk starts.
export function listScrapeSkip(listId: string, options: Pick<ListWalkerOptions, 'force' | 'relistDays'>): ListScrapeSkip | null {
  const prior = getListWalkRow(listId);
  if (!prior || prior.status !== 'done' || options.force) return null;
  const ageDays = prior.scraped_at ? (Date.now() - Date.parse(prior.scraped_at)) / 86_400_000 : Infinity;
  if (options.relistDays > 0 && ageDays >= options.relistDays) return null; // re-walk window open
  return {
    title: prior.title ?? listId,
    scrapedAt: (prior.scraped_at ?? '').slice(0, 10),
    booksNote: `${prior.walkable_books ?? prior.total_books ?? '?'}/${prior.total_books ?? '?'} books`,
    relistHint: Math.ceil(ageDays) + 1,
  };
}

export async function walkOneList(
  page: Page,
  listId: string,
  options: ListWalkerOptions,
  summary: WalkerSummary,
  strict: boolean,
  cooldownMs: number,
  maxThrottles: number
): Promise<{ nextListId?: string; chainEnd: boolean }> {
  const prior = getListWalkRow(listId);
  const skip = listScrapeSkip(listId, options);
  if (skip) {
    summary.listsSkipped++;
    console.log(chalk.gray(`   📖 list ${listId} [skip] "${skip.title}" (scraped ${skip.scrapedAt}, ${skip.booksNote}; use --relist-days ${skip.relistHint} or --force to re-walk)`));
    return { nextListId: prior?.next_list_id, chainEnd: false };
  }
  if (prior?.status === 'done') {
    const ageDays = prior.scraped_at ? (Date.now() - Date.parse(prior.scraped_at)) / 86_400_000 : Infinity;
    console.log(chalk.gray(`   ↻ list ${listId} "${prior.title ?? listId}" last scraped ${(prior.scraped_at ?? '').slice(0, 10)} (${Math.floor(ageDays)} days ago) — re-walking (--relist-days ${options.relistDays})`));
  }

  summary.listsWalked++;

  let pageNum = prior?.status === 'started' && !options.force ? Math.max(1, prior.current_page ?? 1) : 1;
  const resumePage = prior?.status === 'started' && !options.force ? pageNum : 0;
  const resumePos = prior?.status === 'started' && !options.force ? (prior.resume_pos ?? 0) : 0;

  console.log(chalk.cyan.bold(`\n   ➜ LIST START ${listId}${prior?.title ? ` "${prior.title}"` : ''} — direction=${options.direction}${resumePage > 0 ? `, resuming page ${resumePage}` : ''} (run #${summary.listsWalked})`));

  let chainLinks: ChainLink[] = [];
  let consecutiveThrottles = 0;
  let emptyFetches = 0;
  let capped = false;
  let currentTitle: string | undefined = prior?.title;
  let currentTotals: { totalPages: number; totalBooks?: number; walkableBooks: number } | undefined;

  const markStarted = (parsedPageNum: number, rp: number) => {
    if (!options.dryRun) {
      setListWalkRow({
        list_id: listId,
        status: 'started',
        title: currentTitle,
        current_page: parsedPageNum,
        total_pages: currentTotals?.totalPages,
        total_books: currentTotals?.totalBooks,
        walkable_books: currentTotals?.walkableBooks,
        resume_pos: rp,
      });
    }
  };

  const budgetExhausted = (): boolean => options.limit > 0 && summary.processed >= options.limit;

  const finishList = (): { nextListId?: string; chainEnd: boolean } => {
    const next = resolveNextChainLink(chainLinks, listId, options.direction);
    if (!options.dryRun) {
      // Fully walked every reachable page without the run budget forcing a
      // stop — the list is genuinely complete. Clear the per-book resume so
      // later runs skip it.
      setListWalkRow({
        list_id: listId,
        title: currentTitle ?? listId,
        status: 'done',
        current_page: pageNum,
        next_list_id: next?.listId,
        next_list_label: next?.label,
        total_pages: currentTotals?.totalPages,
        total_books: currentTotals?.totalBooks,
        walkable_books: currentTotals?.walkableBooks,
        resume_pos: null,
      });
    }
    if (next) {
      console.log(chalk.green(`   ➡️  ${listId} done → next chain list: ${next.label} (${next.listId})`));
    } else {
      console.log(chalk.green(`   ✓ ${listId} done — no further ${options.direction === 'desc' ? 'lower' : 'higher'} rating-range list (chain end).`));
      summary.chainEnd = true;
    }
    return { nextListId: next?.listId, chainEnd: summary.chainEnd };
  };

  while (!capped) {
    const fetch = await fetchListPage(page, listId, pageNum);
    // A human-verification page in the headed Chromium tab needs the user.
    // PAUSE: stop navigating (each goto resets the challenge) and quiet the
    // terminal so they can actually solve it; resume re-fetching the same page
    // after Enter. Each re-fetch is user-initiated, so pacing stays polite.
    while (isCaptchaPage(fetch.html)) {
      summary.captcha++;
      if (!process.stdin.isTTY) {
        console.log(chalk.yellow(`   🔒 CAPTCHA on list ${listId} page ${pageNum} but stdin isn't a TTY — cannot wait for a solve; treating as empty and moving on.`));
        fetch.html = '';
        break;
      }
      console.log(chalk.bold.red(`\n   🔒 CAPTCHA / human-verification detected on list ${listId} page ${pageNum}. The Chromium window is parked on the challenge.`));
      console.log(chalk.bold('      The walk is PAUSED so you can solve it. Press Enter here once the page loads.'));
      console.log(chalk.gray('      (If the page actually loaded normally — no challenge — just press Enter to continue.)'));
      await waitForEnter();
      Object.assign(fetch, await fetchListPage(page, listId, pageNum));
    }
    if ((fetch.status === 202 || fetch.status === 403 || fetch.status === 429) && !strict) {
      console.log(chalk.yellow(`   ⏳ list ${listId} page ${pageNum} [throttled] http=${fetch.status} — cooldown ${(cooldownMs / 1000).toFixed(0)}s then 1 retry...`));
      await cooldown(cooldownMs);
      const retry = await fetchListPage(page, listId, pageNum);
      if (!retry.html && !retry.status) {
        console.log(chalk.red(`   🛑 list ${listId} page ${pageNum} still throttled after retry — aborting walk.`));
        return { chainEnd: false };
      }
      // fall through with retry result
      Object.assign(fetch, retry);
    }
    if (strict && (fetch.status === 202 || fetch.status === 403 || fetch.status === 429)) {
      console.log(chalk.red.bold('   🛑 Throttled in strict mode (GOODREADS_STRICT_THROTTLE=1) — aborting walk.'));
      return { chainEnd: false };
    }
    if (fetch.error && !fetch.html) {
      const isHang = /hung|Timeout \d+ms exceeded/i.test(fetch.error);
      if (isHang && !strict) {
        console.log(chalk.yellow(`   ⏳ list ${listId} page ${pageNum} fetch hung > ${NAV_TIMEOUT_MS / 1000}s — Goodreads pages famously hang on their own; one patient ${(HANG_RETRY_MS / 1000).toFixed(0)}s retry, then moving on...`));
        await cooldown(HANG_RETRY_MS);
        const retry = await fetchListPage(page, listId, pageNum);
        if (retry.html || retry.status) Object.assign(fetch, retry);
        if (!fetch.html && !fetch.status) {
          summary.error++;
          console.log(chalk.red(`   ❌ list ${listId} page ${pageNum} still hung after a ${(HANG_RETRY_MS / 1000).toFixed(0)}s retry — marking [error] and aborting walk.`));
          if (!options.dryRun) setListWalkRow({ list_id: listId, status: 'error', current_page: pageNum });
          return { chainEnd: false };
        }
      } else {
        summary.error++;
        console.log(chalk.red(`   ❌ list ${listId} page ${pageNum} fetch error: ${fetch.error.slice(0, 140)}`));
        if (!options.dryRun) setListWalkRow({ list_id: listId, status: 'error', current_page: pageNum });
        return { chainEnd: false };
      }
    }

    if (listHtmlUsable(fetch.html)) {
      emptyFetches = 0;
    } else if (++emptyFetches >= MAX_EMPTY_FETCHES) {
      summary.error++;
      console.log(chalk.red(`   🛑 list ${listId} page ${pageNum} produced no usable HTML ${MAX_EMPTY_FETCHES} consecutive times${fetch.error ? ` (${fetch.error.slice(0, 120)})` : ''} — marking [error] and stopping the chain.`));
      if (!options.dryRun) setListWalkRow({ list_id: listId, status: 'error', current_page: pageNum, title: currentTitle });
      return { chainEnd: false };
    }

    const parsed = parseListPage(fetch.html);
    chainLinks = parsed.chainLinks.length ? parsed.chainLinks : chainLinks;
    currentTitle = parsed.title;
    currentTotals = { totalPages: parsed.totalPages, totalBooks: parsed.totalBooks, walkableBooks: parsed.walkableBooks };
    console.log(chalk.cyan(`   📖 list ${listId} "${parsed.title}" — page ${pageNum} (${parsed.books.length} entries)${resumePage > 0 && pageNum === resumePage && resumePos > 0 ? `, resuming after position ~${resumePos}` : ''}`));

    // A page with zero books is the real end of the list — Goodreads lists with
    // < 100 books have no pagination, and asking for page=2..N on them returns
    // empty pages that still parse as "has next" (markup quirk). Stop on empty
    // instead of walking phantom pages until a flaky navigation fails.
    if (parsed.books.length === 0) {
      if (pageNum > 1) {
        console.log(chalk.gray(`   ↛ list ${listId} page ${pageNum} returned 0 books — reached the real end after ${pageNum - 1} page${pageNum === 2 ? '' : 's'}.`));
      } else {
        console.log(chalk.yellow(`   ⚠️  list ${listId} page 1 returned 0 books — nothing to walk.`));
      }
      break;
    }

    // Goodreads renumbers positions to 1..N on every page. Convert the stored
    // global resume position to a per-page offset: page k starts at (k-1)*100+1.
    const globalOffset = (pageNum - 1) * 100;
    const effectiveResume = resumePage > 0 && pageNum === resumePage ? resumePos - globalOffset : 0;
    markStarted(pageNum, resumePos);

    for (const book of parsed.books) {
      if (options.limit > 0 && summary.processed >= options.limit) {
        capped = true;
        summary.capped = true;
        break;
      }
      if (effectiveResume > 0 && book.position <= effectiveResume) {
        continue;
      }
      const skipReason = shouldSkipBook(book.bookId, options);
      if (skipReason) {
        summary.skipped++;
        console.log(chalk.gray(`   - ${book.bookId}\t${book.title.slice(0, 60)} (${skipReason})`));
        markStarted(pageNum, globalOffset + book.position);
        continue;
      }

      console.log(chalk.cyan(`   → ${book.bookId} "${book.title.slice(0, 70)}" (list pos ${book.position})...`));
      let result = await processBook(book.bookId, 'browser');
      summary.processed++;
      if (result.checkpoint.status === 'throttled' && !strict) {
        console.log(chalk.yellow(`      [throttled] http=${result.checkpoint.http} — cooldown ${(cooldownMs / 1000).toFixed(0)}s then 1 retry...`));
        await cooldown(cooldownMs);
        result = await processBook(book.bookId, 'browser');
        summary.processed++;
      }
      summary[result.checkpoint.status]++;
      const color = BOOK_STATUS_COLOR[result.checkpoint.status] ?? ((s: string) => s);
      if (result.checkpoint.status === 'throttled') consecutiveThrottles++;
      else consecutiveThrottles = 0;
      console.log(color(
        `   ✓ ${httpCallInfo(result.checkpoint.http, result.checkpoint.bytes, result.checkpoint.elapsed_ms, ['bookId', book.bookId], result.checkpoint.status)} pos=${book.position} "${book.title.slice(0, 60)}"`
      ));
      // Book handled at this position — advance the global resume point.
      markStarted(pageNum, globalOffset + book.position);
      if (maxThrottles > 0 && consecutiveThrottles >= maxThrottles) {
        console.log(chalk.yellow(`   ⏸️  ${maxThrottles} consecutive throttles — stopping walk to avoid hammering Goodreads.`));
        capped = true;
        summary.capped = true;
        break;
      }
      await pace();
      if (options.limit > 0 && summary.processed >= options.limit) {
        capped = true;
        summary.capped = true;
        break;
      }
    }
    if (capped) break;

    if (parsed.hasNextPage && pageNum < MAX_LIST_PAGE_NUMBER) {
      pageNum = nextPageNumber(parsed.nextPageHref, pageNum);
      await pace();
    } else {
      if (parsed.hasNextPage) {
        console.log(chalk.gray(`   ↛ ${listId} stopped at Goodreads' ${MAX_LIST_PAGE_NUMBER}-page cap (list continues beyond it but is not reachable).`));
      }
      break;
    }
  }

  if (!capped) {
    const next = options.followChain === false ? undefined : resolveNextChainLink(chainLinks, listId, options.direction);
    const started = getListWalkRow(listId);
    if (!options.dryRun) {
      // Finished the whole list — clear the per-book resume point so a later
      // run treats it as complete (skip) rather than continuing mid-list.
      setListWalkRow({
        list_id: listId,
        title: started?.title ?? listId,
        status: 'done',
        current_page: pageNum,
        next_list_id: next?.listId,
        next_list_label: next?.label,
        total_pages: started?.total_pages,
        total_books: started?.total_books,
        walkable_books: started?.walkable_books,
        resume_pos: null,
      });
    }
    if (next) {
      console.log(chalk.green(`   ➡️  ${listId} done → next chain list: ${next.label} (${next.listId})`));
    } else if (options.followChain !== false) {
      console.log(chalk.green(`   ✓ ${listId} done — no further ${options.direction === 'desc' ? 'lower' : 'higher'} rating-range list (chain end).`));
      summary.chainEnd = true;
    }
    console.log(chalk.green.bold(`   ✔ LIST FINISHED ${listId} — ${summary.ok} ok / ${summary.throttled} throttled / ${summary.missing} missing / ${summary.error} err / ${summary.skipped} skip`));
    return { nextListId: next?.listId, chainEnd: summary.chainEnd };
  }
  return { chainEnd: false };
}

interface SkipBookOptions {
  force?: boolean;
  skipHas: string[];
}

export function shouldSkipBook(bookId: string, options: SkipBookOptions): string | null {
  const prior = getCheckpoint(bookId);
  if (prior?.status === 'ok' && !options.force) return 'already-scraped';
  const existing = getBook(bookId);
  if (!options.force && options.skipHas.length > 0 && options.skipHas.every(c => hasField(existing, c))) {
    return `has-${options.skipHas.join(',')}`;
  }
  return null;
}