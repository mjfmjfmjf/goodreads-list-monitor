import chalk from 'chalk';
import fs from 'fs-extra';
import * as cheerio from 'cheerio';
import { fetchWithRetry, delay } from './utils.js';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SNIPPETS = [
  {
    type: 'ratings',
    html: `<a href="/list/show/36384">All non fiction with at least 100,000 ratings</a>
<a href="/list/show/43611">All non fiction at 50,000 to 99,999 ratings</a>
<a href="/list/show/76386">All non fiction at 25,000 to 49,999 ratings</a>
<a href="/list/show/82859">All non fiction at 10,000 to 24,999 ratings</a>`
  },
  {
    type: 'decade',
    html: `<a href="/list/show/132669">2020s</a>, <a href="/list/show/120171">2010s</a>, <a href="/list/show/120170">2000s</a>
<a href="/list/show/120213">1990s</a>, <a href="/list/show/120214">1980s</a>, <a href="/list/show/120215">1970s</a>, <a href="/list/show/120216">1960s</a>, <a href="/list/show/120133">1950s</a>
<a href="/list/show/120135">1940s</a>, <a href="/list/show/120165">1930s</a>, <a href="/list/show/120222">1920s</a>`
  },
  {
    type: 'year',
    html: `<a href="/list/show/232675">2026</a>, <a href="/list/show/205271">2025</a>, <a href="/list/show/188486">2024</a>, <a href="/list/show/180239">2023</a>, <a href="/list/show/161620">2022</a>, <a href="/list/show/150576">2021</a>, <a href="/list/show/132668">2020</a>
<a href="/list/show/125154">2019</a>, <a href="/list/show/120402">2018</a>, <a href="/list/show/119684">2017</a>, <a href="/list/show/120417">2016</a>, <a href="/list/show/119758">2015</a>, <a href="/list/show/119765">2014</a>, <a href="/list/show/119917">2013</a>, <a href="/list/show/119918">2012</a>, <a href="/list/show/119919">2011</a>, <a href="/list/show/119976">2010</a>
<a href="/list/show/119975">2009</a>, <a href="/list/show/119974">2008</a>, <a href="/list/show/119973">2007</a>, <a href="/list/show/119972">2006</a>, <a href="/list/show/119971">2005</a>, <a href="/list/show/119970">2004</a>, <a href="/list/show/119969">2003</a>`
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

  if (cleanText.includes('at least')) {
    const match = cleanText.match(/(\d+)/);
    if (match) criteria.min = parseInt(match[1], 10);
  } else if (cleanText.includes('to') && !cleanText.includes('s')) {
    const parts = cleanText.split('to');
    const minMatch = parts[0].match(/(\d+)/);
    const maxMatch = parts[1].match(/(\d+)/);
    if (minMatch) criteria.min = parseInt(minMatch[1], 10);
    if (maxMatch) criteria.max = parseInt(maxMatch[1], 10);
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

async function buildNonfictionConfig() {
  console.log(chalk.cyan.bold('🚀 Building "non-fiction" config from snippets...'));
  const lists = [];

  for (const snippet of SNIPPETS) {
    const $ = cheerio.load(snippet.html);
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
        await delay(1000, 3000); 
      } catch (error) {
        console.error(chalk.red.bold(`   ❌ Failed to fetch title for ID ${id}:`), (error as any).message);
      }
    }
  }

  const config = { tag: 'non-fiction', lists };
  await fs.writeJson('tags/non-fiction.json', config, { spaces: 2 });
  console.log(chalk.green.bold('\n✅ tags/non-fiction.json created successfully!'));
}

buildNonfictionConfig();
