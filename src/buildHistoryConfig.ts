import chalk from 'chalk';
import fs from 'fs-extra';
import * as cheerio from 'cheerio';
import { fetchWithRetry, delay } from './utils.js';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const YEAR_SNIPPET = `<a href="/list/show/232571">2026</a>, <a href="/list/show/205266">2025</a>, <a href="/list/show/188485">2024</a>, <a href="/list/show/180236">2023</a>, <a href="/list/show/161626">2022</a>, <a href="/list/show/150583">2021</a>, <a href="/list/show/132673">2020</a>
<a href="/list/show/125366">2019</a>, <a href="/list/show/120552">2018</a>, <a href="/list/show/120834">2017</a>, <a href="/list/show/120833">2016</a>, <a href="/list/show/120832">2015</a>, <a href="/list/show/120832">2014</a>, <a href="/list/show/120921">2013</a>, <a href="/list/show/120924">2012</a>, <a href="/list/show/120923">2011</a>, <a href="/list/show/120925">2010</a>`;

async function fetchOfficialTitle(listId: string): Promise<string> {
  const url = `https://www.goodreads.com/list/show/${listId}`;
  const response = await fetchWithRetry(url, { headers: { 'User-Agent': USER_AGENT } });
  const $ = cheerio.load(response.data);
  return $('h1').text().trim().replace(/\s*\(.*\)$/, '');
}

async function buildHistoryConfig() {
  console.log(chalk.cyan.bold('🚀 Building "history" config...'));
  const lists = [];

  // 1. Add Main List
  const mainListId = '108393';
  console.log(chalk.gray(`   Fetching title for Main List (ID: ${mainListId})...`));
  const mainTitle = await fetchOfficialTitle(mainListId);
  lists.push({
    nickname: 'Main',
    officialTitle: mainTitle,
    id: mainListId,
    url: `https://www.goodreads.com/list/show/${mainListId}`,
    criteria: {
      min: 5000,
      minTags: 500
    }
  });
  await delay(1000, 2000);

  // 2. Add Yearly Lists
  const $ = cheerio.load(YEAR_SNIPPET);
  const links = $('a').toArray();

  for (const el of links) {
    const $a = $(el);
    const year = $a.text().trim();
    const href = $a.attr('href') || '';
    const idMatch = href.match(/(\d+)$/);
    const id = idMatch ? idMatch[1] : null;
    if (!id) continue;

    console.log(chalk.gray(`   Fetching title for: ${year} (ID: ${id})...`));
    try {
      const officialTitle = await fetchOfficialTitle(id);
      lists.push({
        nickname: year,
        officialTitle,
        id,
        url: `https://www.goodreads.com/list/show/${id}`,
        criteria: {
          minYear: parseInt(year, 10),
          maxYear: parseInt(year, 10)
        }
      });
      await delay(1000, 3000);
    } catch (error) {
      console.error(chalk.red.bold(`   ❌ Failed to fetch title for ID ${id}`));
    }
  }

  const config = { tag: 'history', lists };
  await fs.writeJson('tags/history.json', config, { spaces: 2 });
  console.log(chalk.green.bold('\n✅ tags/history.json created successfully!'));
}

buildHistoryConfig();
