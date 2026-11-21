import * as cheerio from 'cheerio';
import chalk from 'chalk';
import { loadConfig, upsertShelfTagDirectory, type ShelfTagDirectoryRow } from './storage.ts';
import { USER_AGENT } from './scraper.ts';
import { delay, fetchWithRetry, httpCallInfo, parseDelayRange, withConnectivityProbe } from './utils.ts';

const TIMEOUT = 30_000;
const SHELF_TAGS_PER_PAGE = 100;

export interface ShelfTagDirectoryOptions {
  pages?: string; // "1-100" (default), or a single page like "7"
  dryRun?: boolean;
}

export interface ParsedShelfDirectoryPage {
  entries: ShelfTagDirectoryRow[];
  hasNext: boolean;
}

function safeDecodeSlug(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// The /shelf directory renders 100 shelves split across three floated columns.
// The HTML fills each column top-to-bottom before moving to the next, and the
// advertised book counts descend in that DOM order (verified against a live
// page: col 1 ranks 1–34, col 2 ranks 35–67, col 3 ranks 68–100). So DOM order
// is the directory rank; rank is the global position across paged results.
export function parseShelfDirectoryPage(html: string, page: number): ParsedShelfDirectoryPage {
  const $ = cheerio.load(html);
  const entries: ShelfTagDirectoryRow[] = [];

  $('div.shelfStat').each((_, element) => {
    const href = $(element).find('a[href*="/shelf/show/"]').first().attr('href') || '';
    const match = href.match(/\/shelf\/show\/([^?#]+)/);
    if (!match) return;
    const tag = safeDecodeSlug(match[1].trim()).toLowerCase();
    if (!tag) return;
    const countText = $(element).find('div.smallText.greyText').first().text();
    const countMatch = countText.match(/([\d,]+)\s*books?/i);
    entries.push({
      tagName: tag,
      bookCount: countMatch ? parseInt(countMatch[1].replace(/,/g, ''), 10) || 0 : 0,
      rank: (page - 1) * SHELF_TAGS_PER_PAGE + entries.length + 1,
      scrapedAt: '',
    });
  });

  const hasNext = $('a.next_page:not(.disabled), a[rel="next"]:not(.disabled)').first().length > 0;
  return { entries, hasNext };
}

function parsePageRange(range: string): { start: number; end: number } {
  const match = range.match(/^(\d+)(?:-(\d+))?$/);
  if (!match) throw new Error(`Invalid pages range "${range}". Use "N" or "N-M" (e.g. "1-100").`);
  const start = parseInt(match[1], 10);
  const end = parseInt(match[2] || match[1], 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) {
    throw new Error(`Invalid pages range "${range}". Start must be >= 1 and <= end.`);
  }
  return { start, end };
}

// Snapshot scrape of https://www.goodreads.com/shelf?page=N. One polite
// sequential GET per page, bounded retries, and a per-page delay; writes are
// single-statement autocommit upserts so concurrent crawlers are not blocked.
export async function runShelfTagDirectory(options: ShelfTagDirectoryOptions = {}): Promise<{ pages: number; tags: number }> {
  const { start, end } = parsePageRange(options.pages || '1-100');
  const [minDelay, maxDelay] = parseDelayRange(process.env.GR_SHELF_DIRECTORY_DELAY_MS, 1000, 2500);
  const configData = await loadConfig();
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
  if (configData.cookie) headers.Cookie = configData.cookie;
  const scrapedAt = new Date().toISOString();

  console.log(chalk.cyan.bold(`\n🏷️  shelf directory snapshot: pages ${start}-${end}${options.dryRun ? ' (DRY RUN)' : ''}`));
  console.log(chalk.gray(`   Capturing tag, # books, directory rank and scrape date. Delay ${minDelay}-${maxDelay}ms between pages.`));

  let pages = 0;
  let tags = 0;
  for (let page = start; page <= end; page++) {
    const url = `https://www.goodreads.com/shelf?page=${page}`;
    const pageStart = Date.now();
    let html: string;
    let status: number | undefined;
    try {
      const response = await withConnectivityProbe(
        () => fetchWithRetry(url, { headers, timeout: TIMEOUT }, 2),
        { label: `shelf directory page ${page}` },
      );
      html = String(response.data ?? '');
      status = response.status;
    } catch (error: any) {
      console.error(chalk.red.bold(`   ❌ shelf directory page ${page} failed:`), String(error?.message || error));
      break;
    }
    if (status && (status === 202 || status === 403 || status === 429)) {
      console.error(chalk.red.bold(`   🛑 Throttled (HTTP ${status}) on shelf directory page ${page} — stopping.`));
      break;
    }

    const parsed = parseShelfDirectoryPage(html, page);
    console.log(chalk.dim(`   ${httpCallInfo(status, html.length, Date.now() - pageStart, ['shelfDirectory', page], 'ok')}: ${parsed.entries.length} tag(s)`));
    if (parsed.entries.length === 0) {
      console.log(chalk.gray(`   (No shelf rows on page ${page} — end of directory or a challenged page. Stopping.)`));
      break;
    }

    pages++;
    tags += parsed.entries.length;
    if (!options.dryRun) {
      for (const entry of parsed.entries) entry.scrapedAt = scrapedAt;
      upsertShelfTagDirectory(parsed.entries);
    } else {
      const first = parsed.entries[0];
      const last = parsed.entries[parsed.entries.length - 1];
      console.log(chalk.gray(`   #${first.rank} ${first.tagName} (${first.bookCount.toLocaleString()} books) … #${last.rank} ${last.tagName} (${last.bookCount.toLocaleString()} books)`));
    }

    if (!parsed.hasNext || page >= end) break;
    await delay(minDelay, maxDelay);
  }

  console.log(chalk.green.bold(`\n✅ Shelf directory snapshot done: ${tags.toLocaleString()} tag(s) across ${pages} page(s)${options.dryRun ? ' (dry run — nothing saved)' : ' saved to shelf_tag_directory'}.`));
  return { pages, tags };
}
