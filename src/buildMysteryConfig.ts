import chalk from 'chalk';
import fs from 'fs-extra';
import * as cheerio from 'cheerio';
import { fetchWithRetry, delay } from './utils.js';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SNIPPETS = [
  {
    type: 'notable',
    html: `<a href="/list/show/142746">Best Mysteries of the 21st Century</a>
<a href="/list/show/142806">Best Mysteries of the 20th Century</a>
<a href="/list/show/142751">Popular Highly Rated Mystery</a>`
  },
  {
    type: 'decade',
    html: `<a href="/list/show/142702">1960</a>, <a href="/list/show/26791">1970</a>, <a href="/list/show/26786">1980</a>, <a href="/list/show/26742">1990</a>, <a href="/list/show/79359">2000</a>, <a href="/list/show/79879">2010</a>, <a href="/list/show/179830">2020</a>`
  },
  {
    type: 'ratings',
    html: `<a href="/list/show/195574">100,000 or more</a>
<a href="/list/show/79160">50,000 to 99,999</a>
<a href="/list/show/80850">25,000 to 49,999</a>
<a href="/list/show/142774">10,000 to 24,999</a>`
  }
];

async function fetchOfficialTitle(listId: string): Promise<string> {
  const url = `https://www.goodreads.com/list/show/${listId}`;
  const response = await fetchWithRetry(url, { headers: { 'User-Agent': USER_AGENT } });
  const $ = cheerio.load(response.data);
  
  let title = 
    $('.listTitleText').text().trim() || 
    $('h1').first().text().trim() || 
    $('title').text().replace(/Listopia - /i, '').trim();

  if (title.startsWith('Score')) {
    title = title.replace(/^Score\s+/, '').trim();
    if (!title || title === 'Score') {
        title = $('title').text().replace(/Listopia - /i, '').split('|')[0].trim();
    }
  }

  return title.replace(/\s*\(.*\)$/, '').replace(/\s*\(.*books\)$/i, '').trim();
}

function parseCriteria(text: string): any {
  const cleanText = text.toLowerCase().replace(/,/g, '').trim();
  const criteria: any = {};

  if (cleanText.includes('more') || cleanText.includes('or more')) {
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

async function buildMysteryConfig() {
  console.log(chalk.cyan.bold('🚀 Building Mystery config from snippets...'));
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
        await delay(500, 1500);
      } catch (error) {
        console.error(chalk.red.bold(`   ❌ Failed to fetch title for ID ${id}`));
      }
    }
  }

  const config = { tag: 'mystery', lists };
  await fs.ensureDir('tags');
  await fs.writeJson('tags/mystery.json', config, { spaces: 2 });
  console.log(chalk.green.bold('\n✅ tags/mystery.json created successfully!'));
}

buildMysteryConfig();
