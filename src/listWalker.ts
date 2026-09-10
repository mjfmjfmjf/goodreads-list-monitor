import chalk from 'chalk';
import { BrowserContext, Page } from 'playwright';
import { getDb } from './db.js';
import { getBook, CachedBook } from './storage.js';
import { withDbLockRetry } from './utils.js';
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

interface ListWalkerOptions {
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
}

interface WalkerSummary {
  listsWalked: number;
  listsSkipped: number;
  processed: number;
  ok: number;
  throttled: number;
  missing: number;
  error: number;
  skipped: number;
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

async function fetchListPage(page: Page, listId: string, pageNum: number): Promise<ListFetch> {
  try {
    page.setDefaultTimeout(30000);
    const response = await page.goto(listUrl(listId, pageNum), { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const html = await page.content();
    const status = response?.status();
    if (status === 202 || status === 403 || status === 429) return { status, html: '', error: `Received ${status} interstitial` };
    return { status, html };
  } catch (error: any) {
    return { html: '', error: String(error?.message || error) };
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
    missing: 0, error: 0, skipped: 0, capped: false, chainEnd: false,
  };

  if (!options.dryRun) {
    ensureScrapeTables();
  }
  ensureListTables();

  await getBrowserContext();

  let currentListId: string | undefined = startListId;
  const started = Date.now();

  try {
    while (currentListId && summary.listsWalked < (options.maxLists > 0 ? options.maxLists : Number.MAX_SAFE_INTEGER)) {
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
  console.log(chalk.cyan.bold(`\n   Done: ${summary.ok} ok, ${summary.throttled} throttled, ${summary.missing} missing, ${summary.error} error, ${summary.skipped} skipped, ${summary.listsWalked} lists (${summary.listsSkipped} skipped) in ${mins}m.`));
  if (summary.capped) console.log(chalk.gray(`   Stopped: reached the ${options.limit}-book limit. Re-run to continue from the checkpoint.`));
  if (summary.chainEnd) console.log(chalk.green('   Chain completed: reached the end of the rating-range chain.'));
  return summary;
}

async function walkOneList(
  page: Page,
  listId: string,
  options: ListWalkerOptions,
  summary: WalkerSummary,
  strict: boolean,
  cooldownMs: number,
  maxThrottles: number
): Promise<{ nextListId?: string; chainEnd: boolean }> {
  const prior = getListWalkRow(listId);
  if (prior?.status === 'done' && !options.force) {
    const ageDays = prior.scraped_at ? (Date.now() - Date.parse(prior.scraped_at)) / 86_400_000 : Infinity;
    if (options.relistDays <= 0 || ageDays < options.relistDays) {
      summary.listsSkipped++;
      console.log(chalk.gray(`   📖 list ${listId} [skip] "${prior.title}" (scraped ${prior.scraped_at.slice(0, 10)}, ${prior.walkable_books ?? prior.total_books ?? '?'}/${prior.total_books ?? '?'} books; use --relist-days ${Math.ceil(ageDays) + 1} or --force to re-walk)`));
      return { nextListId: prior.next_list_id, chainEnd: false };
    }
    console.log(chalk.gray(`   ↻ list ${listId} "${prior.title}" last scraped ${prior.scraped_at.slice(0, 10)} (${Math.floor(ageDays)} days ago) — re-walking (--relist-days ${options.relistDays})`));
  }

  summary.listsWalked++;

  let pageNum = prior?.status === 'started' && !options.force ? Math.max(1, prior.current_page ?? 1) : 1;
  const resumePage = prior?.status === 'started' && !options.force ? pageNum : 0;
  const resumePos = prior?.status === 'started' && !options.force ? (prior.resume_pos ?? 0) : 0;
  let chainLinks: ChainLink[] = [];
  let consecutiveThrottles = 0;
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
      summary.error++;
      console.log(chalk.red(`   ❌ list ${listId} page ${pageNum} fetch error: ${fetch.error.slice(0, 140)}`));
      if (!options.dryRun) setListWalkRow({ list_id: listId, status: 'error', current_page: pageNum });
      return { chainEnd: false };
    }

    const parsed = parseListPage(fetch.html);
    chainLinks = parsed.chainLinks.length ? parsed.chainLinks : chainLinks;
    currentTitle = parsed.title;
    currentTotals = { totalPages: parsed.totalPages, totalBooks: parsed.totalBooks, walkableBooks: parsed.walkableBooks };
    console.log(chalk.cyan(`   📖 list ${listId} "${parsed.title}" — page ${pageNum} (${parsed.books.length} entries)${resumePage > 0 && pageNum === resumePage && resumePos > 0 ? `, resuming after position ~${resumePos}` : ''}`));

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
        `   ✓ [${result.checkpoint.status}] ${book.bookId} http=${result.checkpoint.http ?? '-'} ${String(result.checkpoint.elapsed_ms ?? 0).padStart(5)}ms "${book.title.slice(0, 60)}"`
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
    const next = resolveNextChainLink(chainLinks, listId, options.direction);
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
    } else {
      console.log(chalk.green(`   ✓ ${listId} done — no further ${options.direction === 'desc' ? 'lower' : 'higher'} rating-range list (chain end).`));
      summary.chainEnd = true;
    }
    return { nextListId: next?.listId, chainEnd: summary.chainEnd };
  }
  return { chainEnd: false };
}

function shouldSkipBook(bookId: string, options: ListWalkerOptions): string | null {
  const prior = getCheckpoint(bookId);
  if (prior?.status === 'ok' && !options.force) return 'already-scraped';
  const existing = getBook(bookId);
  if (!options.force && options.skipHas.length > 0 && options.skipHas.every(c => hasField(existing, c))) {
    return `has-${options.skipHas.join(',')}`;
  }
  return null;
}