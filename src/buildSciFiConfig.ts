import chalk from 'chalk';
import fs from 'fs-extra';
import * as cheerio from 'cheerio';
import { fetchWithRetry } from './utils.js';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SNIPPETS = [
  {
    type: 'decade',
    html: `<a href="/list/show/43374">1930s</a>, <a href="/list/show/40744">1940s</a>, <a href="/list/show/5152">1950s</a>, <a href="/list/show/5158">1960s</a>, <a href="/list/show/42069">1970s</a>, <a href="/list/show/42417">1980s</a>, <a href="/list/show/42875">1990s</a>, <a href="/list/show/43319">2000s</a>, <a href="/list/show/75182">2010s</a>, <a href="/list/show/146613">2020s</a>`
  },
  {
    type: 'year',
    html: `<a href="/list/show/196124">2023</a>, <a href="/list/show/196123">2022</a>, <a href="/list/show/171985">2021</a>, <a href="/list/show/155799">2020</a>, <a href="/list/show/155447">2019</a>, <a href="/list/show/155440">2018</a>, <a href="/list/show/155402">2017</a>, <a href="/list/show/155261">2016</a>, <a href="/list/show/155296">2015</a>, <a href="/list/show/155307">2014</a>, <a href="/list/show/155343">2013</a>, <a href="/list/show/155378">2012</a>, <a href="/list/show/155391">2011</a>, <a href="/list/show/155401">2010</a>`
  },
  {
    type: 'ratings',
    html: `<a href="/list/show/35776">100,000 and more</a>, <a href="/list/show/138257">50000 to 99999</a>, <a href="/list/show/39287">25000 to 49999</a>, <a href="/list/show/46769">10000 to 24999</a>, <a href="/list/show/77875">1000 to 9999</a>, <a href="/list/show/78128">100 to 999</a>, <a href="/list/show/79670">Less than 100</a>`
  }
];

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
  } else if (cleanText.includes('to') && !cleanText.includes('s')) {
    const parts = cleanText.split('to');
    criteria.min = parseInt(parts[0].trim(), 10);
    criteria.max = parseInt(parts[1].trim(), 10);
  } else if (cleanText.match(/(\d{4})s/)) {
    const match = cleanText.match(/(\d{4})/);
    if (match) {
      const year = parseInt(match[1], 10);
      criteria.minYear = year;
      criteria.maxYear = year + 9;
    }
  } else if (cleanText.match(/^\d{4}$/)) {
    const year = parseInt(cleanText, 10);
    criteria.minYear = year;
    criteria.maxYear = year;
  }
  return criteria;
}

async function buildSifFiConfig() {
  console.log(chalk.cyan.bold('🚀 Building Science Fiction config from snippets...'));
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
      const officialTitle = await fetchOfficialTitle(id);

      lists.push({
        nickname,
        officialTitle,
        id,
        url: `https://www.goodreads.com/list/show/${id}`,
        criteria
      });
      // Small delay to be polite
      await new Promise(r => setTimeout(res => r(res), 500));
    }
  }

  const config = { tag: 'science-fiction', lists };
  await fs.writeJson('tags/science-fiction.json', config, { spaces: 2 });
  console.log(chalk.green.bold('\n✅ tags/science-fiction.json created successfully!'));
}

buildSifFiConfig();
