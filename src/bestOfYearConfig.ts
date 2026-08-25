import chalk from 'chalk';
import * as cheerio from 'cheerio';
import fs from 'fs-extra';
import path from 'path';
import { loadConfig } from './storage.js';
import { delay, fetchWithRetry } from './utils.js';
import { USER_AGENT } from './scraper.js';
import type { ListEntry } from './tagConfig.js';

const TIMEOUT = 30000;

// The "By year:" cross-links live in the descriptions of every list in the
// Best Books of <year> family. Each description links to neighboring years
// with either a /list/show/<id> or /list/best_of_year/<year> href.  The
// /list/show/<id> URLs are the canonical working ones for older years
// (1889–1979); /list/best_of_year/ works as an alias for 1980+.
export const BEST_OF_YEAR_SEEDS = [
  'https://www.goodreads.com/list/show/23568',
  'https://www.goodreads.com/list/best_of_year/1980',
  'https://www.goodreads.com/list/show/20637',
  'https://www.goodreads.com/list/show/21020',
  'https://www.goodreads.com/list/best_of_year/2015',
  'https://www.goodreads.com/list/best_of_year/2026',
];

export const FIRST_KNOWN_YEAR = 1889;

export interface YearLink {
  year: number;
  url: string;
}

export function extractYearLinks(html: string): YearLink[] {
  const $ = cheerio.load(String(html));
  const seen = new Map<number, string>();
  $('a').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!href.includes('/list/')) return;
    const text = $(el).text().trim();
    if (!/^\d{4}$/.test(text)) return;
    const year = parseInt(text, 10);
    if (seen.has(year)) return;
    // For best_of_year hrefs, derive URL from the text year (not the href
    // year) because some pages have mismatched hrefs (text "2013" → href
    // "best_of_year/2003").  For show/<id> hrefs the id is canonical.
    const boyMatch = href.match(/\/list\/best_of_year\//);
    if (boyMatch) {
      seen.set(year, `https://www.goodreads.com/list/best_of_year/${year}`);
    } else {
      const showMatch = href.match(/\/list\/show\/(\d+)/);
      if (showMatch) {
        seen.set(year, `https://www.goodreads.com/list/show/${showMatch[1]}`);
      }
    }
  });
  return [...seen.entries()]
    .map(([year, url]) => ({ year, url }))
    .sort((a, b) => a.year - b.year);
}

export function buildYearEntry(year: number, url: string): ListEntry {
  const idMatch = url.match(/\/list\/show\/(\d+)/);
  const id = idMatch ? idMatch[1] : `best_of_year/${year}`;
  return {
    id,
    nickname: `Best Books of ${year}`,
    officialTitle: `Best Books of ${year}`,
    url,
    criteria: { minYear: year, maxYear: year },
  };
}

export interface GenBestOfYearConfigOptions {
  out?: string;
  delaySeconds?: string;
}

export async function runGenBestOfYearConfig(options: GenBestOfYearConfigOptions = {}): Promise<void> {
  const outFile = path.resolve(process.cwd(), options.out || 'bulkBestBooksOfYear.json');
  const delaySec = parseFloat(options.delaySeconds || '2');

  const configData = await loadConfig();
  const headers: any = { 'User-Agent': USER_AGENT };
  if (configData.cookie) headers.Cookie = configData.cookie;

  console.log(chalk.cyan.bold(`\n🔗 Walking Best Books of <year> list cross-links into ${path.basename(outFile)}...\n`));

  // Resume from existing output if present.
  const discovered = new Map<number, string>();
  if (await fs.pathExists(outFile)) {
    const existing: ListEntry[] = await fs.readJson(outFile);
    for (const entry of existing) {
      const m = entry.id.match(/(?:best_of_year\/)?(\d{4})$/);
      if (m) discovered.set(parseInt(m[1], 10), entry.url);
    }
    if (discovered.size > 0) {
      console.log(chalk.gray(`   Resuming with ${discovered.size} year(s) already in ${path.basename(outFile)}`));
    }
  }

  const toFetch = [...BEST_OF_YEAR_SEEDS];

  const save = async () => {
    const entries = [...discovered.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([year, url]) => buildYearEntry(year, url));
    await fs.writeJson(outFile, entries, { spaces: 2 });
  };

  let fetches = 0;
  for (const url of toFetch) {
    let html = '';
    try {
      const response = await fetchWithRetry(url, { headers, timeout: TIMEOUT });
      html = String(response.data);
    } catch (error) {
      console.error(chalk.yellow(`   ⚠️ Fetch failed for ${url}: ${(error as any).message}`));
      continue;
    } finally {
      fetches++;
    }

    const links = extractYearLinks(html);
    let newCount = 0;
    for (const { year, url: canonical } of links) {
      if (!discovered.has(year)) {
        discovered.set(year, canonical);
        newCount++;
      }
    }

    await save();
    console.log(chalk.gray(
      `   [${fetches}/${toFetch.length}] ${url} → ${links.length} year-link(s) (${newCount} new) → saved ${discovered.size} year(s) total`
    ));
    if (toFetch.indexOf(url) < toFetch.length - 1) {
      await delay(delaySec * 1000, delaySec * 1000 + 1000);
    }
  }

  if (discovered.size === 0) {
    throw new Error('No year links discovered — markup may have drifted or seeds failed to fetch.');
  }

  const years = [...discovered.keys()].sort((a, b) => a - b);
  const entries = years.map(y => buildYearEntry(y, discovered.get(y)!));
  await fs.writeJson(outFile, entries, { spaces: 2 });

  const minYear = years[0];
  const maxYear = years[years.length - 1];
  const gaps: number[] = [];
  for (let y = minYear; y <= maxYear; y++) {
    if (!discovered.has(y)) gaps.push(y);
  }

  console.log(chalk.cyan.bold(`\n✅ Wrote ${entries.length} year lists (${minYear}–${maxYear}) to ${outFile}`));
  if (gaps.length > 0) {
    console.log(chalk.gray(`   Gaps within span (${gaps.length}): ${gaps.join(', ')}`));
  }
  console.log(chalk.gray(`   Pages fetched: ${fetches}; each entry has criteria.minYear = criteria.maxYear = its year.`));
}
