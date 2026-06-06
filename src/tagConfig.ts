import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import * as cheerio from 'cheerio';
import { scrapeListDescription } from './scraper.js';
import { fetchWithRetry } from './utils.js';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface AuditCriteria {
  min?: number;
  max?: number;
  minYear?: number;
  maxYear?: number;
  minTags?: number;
}

export interface ListEntry {
  nickname: string;
  officialTitle: string;
  id: string;
  url: string;
  criteria: AuditCriteria;
}

export interface TagConfig {
  tag: string;
  lists: ListEntry[];
}

export async function generateTagConfig(hubListId: string, tagName: string): Promise<void> {
  console.log(chalk.cyan.bold(`🚀 Generating detailed config for tag "${tagName}" using hub list ${hubListId}...`));
  
  const html = await scrapeListDescription(hubListId);
  if (!html) {
    throw new Error('Could not find list description on the provided hub page.');
  }

  const $ = cheerio.load(html);
  const listEntries: ListEntry[] = [];

  const links = $('a').toArray();
  console.log(chalk.gray(`   Found ${links.length} potential list links. Fetching official titles...`));

  for (const el of links) {
    const $a = $(el);
    const href = $a.attr('href') || '';
    const nickname = $a.text().trim();
    
    const idMatch = href.match(/\/list\/show\/(\d+)/);
    if (!idMatch) continue;
    const listId = idMatch[1];
    const url = `https://www.goodreads.com/list/show/${listId}`;

    const criteria = parseCriteria(nickname);
    if (!criteria) continue; // Skip links that don't look like rating or year links

    try {
      console.log(chalk.gray(`      Processing: ${nickname} (ID: ${listId})...`));
      // We need the official title. For speed, we'll try a quick fetch of the list page.
      const officialTitle = await fetchOfficialTitle(listId);

      listEntries.push({
        nickname,
        officialTitle,
        id: listId,
        url,
        criteria
      });
    } catch (error) {
      console.error(chalk.yellow.bold(`      ⚠️ Could not fetch title for ${listId}, skipping.`));
    }
  }

  const config: TagConfig = { tag: tagName, lists: listEntries };
  const configPath = path.join(process.cwd(), 'tags', `${tagName}.json`);
  
  await fs.writeJson(configPath, config, { spaces: 2 });
  
  console.log(chalk.green.bold(`\n✅ Detailed config saved to: ${configPath}`));
  console.log(chalk.gray(`   Parsed ${listEntries.length} lists with criteria and official titles.`));
}

async function fetchOfficialTitle(listId: string): Promise<string> {
  const url = `https://www.goodreads.com/list/show/${listId}`;
  const response = await fetchWithRetry(url, { headers: { 'User-Agent': USER_AGENT } });
  const $ = cheerio.load(response.data);
  return $('h1').text().trim().replace(/\s*\(.*\)$/, ''); // Remove the "(123 books)" part
}

function parseCriteria(text: string): AuditCriteria | null {
  const cleanText = text.toLowerCase().replace(/,/g, '');
  const criteria: AuditCriteria = {};
  let found = false;

  // 1. Ratings Parsing
  if (cleanText.includes('and more')) {
    const match = cleanText.match(/(\d+)/);
    if (match) { criteria.min = parseInt(match[1], 10); found = true; }
  } else if (cleanText.includes('less than')) {
    const match = cleanText.match(/(\d+)/);
    if (match) { criteria.max = parseInt(match[1], 10); found = true; }
  } else if (cleanText.includes('to') && !cleanText.includes('s')) { // "50 to 99" but not "2000 to 2009"
    const parts = cleanText.split('to');
    const min = parseInt(parts[0].trim(), 10);
    const max = parseInt(parts[1].trim(), 10);
    if (!isNaN(min) && !isNaN(max)) {
      criteria.min = min;
      criteria.max = max;
      found = true;
    }
  }

  // 2. Year/Decade Parsing
  const decadeMatch = cleanText.match(/(\d{4})s/);
  if (decadeMatch) {
    const startYear = parseInt(decadeMatch[1], 10);
    criteria.minYear = startYear;
    criteria.maxYear = startYear + 9;
    found = true;
  } else {
    const yearMatch = cleanText.match(/^(\d{4})$/);
    if (yearMatch) {
      const year = parseInt(yearMatch[1], 10);
      criteria.minYear = year;
      criteria.maxYear = year;
      found = true;
    } else if (cleanText.match(/^\d{4} to \d{4}$/)) { // "2000 to 2009"
        const parts = cleanText.split('to');
        criteria.minYear = parseInt(parts[0].trim(), 10);
        criteria.maxYear = parseInt(parts[1].trim(), 10);
        found = true;
    }
  }

  return found ? criteria : null;
}
