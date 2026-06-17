import chalk from 'chalk';
import fs from 'fs-extra';
import * as cheerio from 'cheerio';
import { fetchWithRetry, delay } from './utils.js';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SNIPPET = `<a href="/list/show/141019">10,000 to 15,000</a>, <a href="/list/show/141016">15,000 to 20,000</a>, <a href="/list/show/141024">20,000 to 25,000</a>, <a href="/list/show/141025">25,000 to 30,000</a>, 
<a href="/list/show/141027">30,000 to 40,000</a>, <a href="/list/show/141032">40,000 to 50,000</a>, <a href="/list/show/141033">50,000 to 60,000</a>, <a href="/list/show/141034">60,000 to 70,000</a>, 
<a href="/list/show/141035">70,000 to 80,000</a>, <a href="/list/show/39332">80,000 to 89,999</a>, <a href="/list/show/117368">90,000 to 99,999</a>, <a href="/list/show/35708">100,000 to 149,999</a>, 
<a href="/list/show/117146">150,000 to 199,999</a>, <a href="/list/show/36647">200,000 to 499,999</a>, <a href="/list/show/35177">500,000 to 999,999</a>, <a href="/list/show/35080">1,000,000 and more</a>`;

async function fetchOfficialTitle(listId: string): Promise<string> {
  const url = `https://www.goodreads.com/list/show/${listId}`;
  const response = await fetchWithRetry(url, { headers: { 'User-Agent': USER_AGENT } });
  const $ = cheerio.load(response.data);
  return $('h1').text().trim().replace(/\s*\(.*\)$/, '');
}

function parseCriteria(text: string): any {
  const cleanText = text.toLowerCase().replace(/,/g, '');
  const criteria: any = {};

  if (cleanText.includes('and more')) {
    const match = cleanText.match(/(\d+)/);
    if (match) criteria.min = parseInt(match[1], 10);
  } else if (cleanText.includes('less than')) {
    const match = cleanText.match(/(\d+)/);
    if (match) criteria.max = parseInt(match[1], 10);
  } else if (cleanText.includes('to')) {
    const parts = cleanText.split('to');
    criteria.min = parseInt(parts[0].trim(), 10);
    criteria.max = parseInt(parts[1].trim(), 10);
  }
  return criteria;
}

async function buildToReadConfig() {
  console.log(chalk.cyan.bold('🚀 Building "to-read" config from snippets...'));
  const lists = [];

  const $ = cheerio.load(SNIPPET);
  const links = $('a').toArray();

  for (const el of links) {
    const $a = $(el);
    const nickname = $a.text().trim();
    const href = $a.attr('href') || '';
    const idMatch = href.match(/(\d+)$/);
    const id = idMatch ? idMatch[1] : null;
    if (!id) continue;
    
    const criteria = parseCriteria(nickname);

    console.log(chalk.gray(`   Fetching title for: ${nickname} (ID: ${id})...`));
    try {
      const officialTitle = await fetchOfficialTitle(id);

      lists.push({
        nickname,
        officialTitle,
        id,
        url: `https://www.goodreads.com/list/show/${id}`,
        criteria
      });
    } catch (error) {
      console.error(chalk.red.bold(`   ❌ Failed to fetch title for ID ${id}`));
    }
    
    await delay(500, 500);
  }

  const config = { tag: 'to-read', lists };
  await fs.writeJson('tags/to-read.json', config, { spaces: 2 });
  console.log(chalk.green.bold('\n✅ tags/to-read.json created successfully!'));
}

buildToReadConfig();
