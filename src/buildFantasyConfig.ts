import chalk from 'chalk';
import fs from 'fs-extra';
import * as cheerio from 'cheerio';
import { fetchWithRetry, delay } from './utils.js';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SNIPPETS = [
  {
    type: 'decade',
    html: `<a href="/list/show/79774">1930s</a>, <a href="/list/show/79807">1940s</a>, <a href="/list/show/75483">1950s</a>, <a href="/list/show/75425">1960s</a>, <a href="/list/show/1116">1970s</a>, <a href="/list/show/1117">1980s</a>, <a href="/list/show/1118">1990s</a>, <a href="/list/show/38609">2000s</a>, <a href="/list/show/38633">2010s</a>, <a href="/list/show/146629">2020s</a>`
  },
  {
    type: 'ratings',
    html: `<a href="/list/show/35857">More than 100000</a>, <a href="/list/show/46916">50000 to 99999</a>, <a href="/list/show/74893">25000 to 49999</a>, <a href="/list/show/76860">10000 to 24999</a>, <a href="/list/show/80066">1000 to 9999</a>, <a href="/list/show/79318">100 to 999</a>, <a href="/list/show/76987">Less than 100</a>`
  },
  {
    type: 'notable',
    html: `<a href="/list/show/88">Best Fantasy Books of the 21st Century </a>, <a href="/list/show/115751">Best Fantasy of the 20th Century</a>, <a href="/list/show/115805">Best Forgotten Fantasy of the 20th Century</a>`
  }
];

async function fetchOfficialTitle(listId: string): Promise<string> {
  const url = `https://www.goodreads.com/list/show/${listId}`;
  const response = await fetchWithRetry(url, { headers: { 'User-Agent': USER_AGENT } });
  const $ = cheerio.load(response.data);
  
  // Try several selectors often found on Listopia pages
  // Specifically exclude "Score" which is often part of the table header text if not careful
  let title = 
    $('.listTitleText').text().trim() || 
    $('h1').first().text().trim() || 
    $('title').text().replace(/Listopia - /i, '').trim();

  // If title starts with "Score" followed by whitespace or is just "Score", try to refine
  if (title.startsWith('Score')) {
    title = title.replace(/^Score\s+/, '').trim();
    if (!title || title === 'Score') {
        // Fallback to title tag if h1/listTitleText failed
        title = $('title').text().replace(/Listopia - /i, '').split('|')[0].trim();
    }
  }

  return title.replace(/\s*\(.*\)$/, '').replace(/\s*\(.*books\)$/i, '').trim();
}

function parseCriteria(text: string): any {
  const cleanText = text.toLowerCase().replace(/,/g, '').trim();
  const criteria: any = {};

  if (cleanText.includes('more than')) {
    const match = cleanText.match(/(\d+)/);
    if (match) criteria.min = parseInt(match[1], 10);
  } else if (cleanText.includes('less than')) {
    const match = cleanText.match(/(\d+)/);
    if (match) criteria.max = parseInt(match[1], 10);
  } else if (cleanText.includes('to') && !cleanText.includes('s')) {
    const parts = cleanText.split('to');
    const min = parseInt(parts[0].trim(), 10);
    const max = parseInt(parts[1].trim(), 10);
    if (!isNaN(min) && !isNaN(max)) {
      criteria.min = min;
      criteria.max = max;
    }
  } else if (cleanText.match(/(\d{4})s/)) {
    const match = cleanText.match(/(\d{4})/);
    if (match) {
      const year = parseInt(match[1], 10);
      criteria.minYear = year;
      criteria.maxYear = year + 9;
    }
  } else if (cleanText.includes('21st century')) {
    criteria.minYear = 2001;
    criteria.maxYear = 2100;
  } else if (cleanText.includes('20th century')) {
    criteria.minYear = 1901;
    criteria.maxYear = 2000;
  } else if (cleanText.match(/^\d{4}$/)) {
    const year = parseInt(cleanText, 10);
    criteria.minYear = year;
    criteria.maxYear = year;
  }
  return criteria;
}

async function buildFantasyConfig() {
  console.log(chalk.cyan.bold('🚀 Building Fantasy config from snippets...'));
  const lists = [];

  for (const snippet of SNIPPETS) {
    const $ = cheerio.load(snippet.html);
    const links = $('a').toArray();

    for (const el of links) {
      const $a = $(el);
      const nickname = $a.text().trim();
      const href = $a.attr('href') || '';
      const id = href.split('/').pop();
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
        // Small delay to be polite
        await delay(500, 1500);
      } catch (error) {
        console.error(chalk.red.bold(`   ❌ Failed to fetch title for ID ${id}`));
      }
    }
  }

  const config = { tag: 'fantasy', lists };
  await fs.ensureDir('tags');
  await fs.writeJson('tags/fantasy.json', config, { spaces: 2 });
  console.log(chalk.green.bold('\n✅ tags/fantasy.json created successfully!'));
}

buildFantasyConfig();
