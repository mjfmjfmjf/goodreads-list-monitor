import chalk from 'chalk';
import fs from 'fs-extra';
import * as cheerio from 'cheerio';
import { fetchWithRetry, delay } from './utils.js';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SNIPPETS = [
  {
    type: 'ratings',
    html: `
      <a href="/list/show/82189">50,000 or more</a>, 
      <a href="/list/show/83395">25,000 to 49,999</a>, 
      <a href="/list/show/83396">10,000 to 24,999</a>, 
      <a href="/list/show/83398">5,000 to 9,999</a>, 
      <a href="/list/show/84056">2,500 to 4,999</a>, 
      <a href="/list/show/84053">1,500 to 2,499</a>, 
      <a href="/list/show/84054">1,000 to 1,499</a>, 
      <a href="/list/show/84055">500 to 999</a>, 
      <a href="/list/show/83399">less than 500</a>
    `
  },
  {
    type: 'year',
    html: `
      <a href="/list/show/157669">2021</a>, 
      <a href="/list/show/135608">2020</a>, 
      <a href="/list/show/125377">2019</a>, 
      <a href="/list/show/125145">2018</a>
    `
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

  if (cleanText.includes('more than') || cleanText.includes('or more')) {
    const match = cleanText.match(/(\d+)/);
    if (match) criteria.min = parseInt(match[1], 10);
  } else if (cleanText.includes('less than') || cleanText.includes('under')) {
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
  } else if (cleanText.match(/^\d{4}$/)) {
    const year = parseInt(cleanText, 10);
    criteria.minYear = year;
    criteria.maxYear = year;
  }
  return criteria;
}

async function buildBiographyConfig() {
  console.log(chalk.cyan.bold('🚀 Building Biography config from snippets...'));
  const lists = [];

  for (const snippet of SNIPPETS) {
    const $ = cheerio.load(snippet.html);
    const links = $('a').toArray();

    for (const el of links) {
      const $a = $(el);
      const nickname = $a.text().trim();
      const href = $a.attr('href') || '';
      const id = href.split('/').filter(Boolean).pop()?.split('.')[0];
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

  const config = { tag: 'biography', lists };
  await fs.ensureDir('tags');
  await fs.writeJson('tags/biography.json', config, { spaces: 2 });
  console.log(chalk.green.bold('\n✅ tags/biography.json created successfully!'));
}

buildBiographyConfig();
