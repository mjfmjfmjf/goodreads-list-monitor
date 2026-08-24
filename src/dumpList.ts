import chalk from 'chalk';
import * as cheerio from 'cheerio';
import { loadConfig } from './storage.js';
import { delay, fetchWithRetry } from './utils.js';
import { USER_AGENT } from './scraper.js';

const TIMEOUT = 30000;

export interface DumpListOptions {
  grep?: string;
  maxPages?: string;
  delaySeconds?: string;
}

interface ListRow {
  position: number;
  page: number;
  title: string;
  author: string;
}

export function parseListPage($: cheerio.CheerioAPI): { title: string; author: string }[] {
  const rows: { title: string; author: string }[] = [];
  $('tr[itemscope][itemtype="http://schema.org/Book"]').each((_, el) => {
    const $el = $(el);
    const $title = $el.find('a.bookTitle');
    const title = ($title.find('span[itemprop="name"]').text() || $title.text()).trim();
    const author = $el.find('a.authorName').first().text().trim();
    if (title) rows.push({ title, author });
  });
  return rows;
}

function listUrl(listId: string, page: number): string {
  if (/^\d+$/.test(listId)) return `https://www.goodreads.com/list/show/${listId}?page=${page}`;
  return `https://www.goodreads.com/list/show/${listId}?page=${page}`;
}

export async function runDumpList(listArg: string, options: DumpListOptions = {}): Promise<void> {
  const listId = listArg.includes('/')
    ? listArg.replace(/.*\/list\/show\//, '').replace(/[?#].*$/, '')
    : listArg;

  const maxPages = parseInt(options.maxPages || '0', 10) || Infinity;
  const delaySec = parseFloat(options.delaySeconds || '2');
  const needle = options.grep ? options.grep.toLowerCase() : null;

  const configData = await loadConfig();
  const headers: any = { 'User-Agent': USER_AGENT };
  if (configData.cookie) headers.Cookie = configData.cookie;

  console.log(chalk.cyan.bold(`\n📄 Dumping list ${listId}${needle ? ` (grep: "${options.grep}")` : ''}...\n`));

  const all: ListRow[] = [];
  let page = 1;
  let position = 0;

  while (page <= maxPages) {
    let response;
    try {
      response = await fetchWithRetry(listUrl(listId, page), { headers, timeout: TIMEOUT });
    } catch (error) {
      console.error(chalk.red.bold(`   ❌ Fetch failed on page ${page}: ${(error as any).message}`));
      break;
    }
    const $ = cheerio.load(String(response.data));
    const rows = parseListPage($);

    if (rows.length === 0) {
      if (page === 1) console.error(chalk.red.bold(`   ❌ No book rows found — bad list id or unexpected markup.`));
      break;
    }

    for (const row of rows) {
      position++;
      all.push({ position, page, ...row });
      if (!needle || row.title.toLowerCase().includes(needle) || row.author.toLowerCase().includes(needle)) {
        console.log(
          `${chalk.gray(`p${page}`)} ${chalk.white.bold(`#${position}`)} ${row.title} ${chalk.gray('by')} ${chalk.cyan(row.author)}`
        );
      }
    }

    process.stdout.write(chalk.gray(`   [page ${page}: ${rows.length} rows]\n`));
    const hasNext = $('a[rel="next"], .pagination a.next_page').length > 0;
    if (!hasNext) break;
    page++;
    await delay(delaySec * 1000, delaySec * 1000 + 1000);
  }

  console.log(chalk.cyan.bold(`\n📊 ${all.length.toLocaleString()} entries across ${Math.min(page, maxPages)} page(s).`));
}
