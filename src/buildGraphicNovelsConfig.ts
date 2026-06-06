import chalk from 'chalk';
import fs from 'fs-extra';
import * as cheerio from 'cheerio';
import { fetchWithRetry, delay } from './utils.js';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SNIPPETS = [
  {
    type: 'ratings',
    prefix: '',
    html: `
      <a href="/list/show/73088">All graphic novels with at least 25,000 ratings</a>
      <a href="/list/show/73202">All graphic novels with 10,000 and 24,999 ratings</a>
      <a href="/list/show/91245">All graphic novels with 5,000 and 9,999 ratings</a>
      <a href="/list/show/155141">All graphic novels with 3,000 and 4,999 ratings</a>
      <a href="/list/show/155022">All graphic novels with 2,000 and 2,999 ratings</a>
      <a href="/list/show/154990">All graphic novels with 1,000 and 1,999 ratings</a>
    `
  },
  {
    type: 'great-year',
    prefix: 'Great Graphic Novels ',
    html: `
      <a href="/list/show/230127">2026</a>, <a href="/list/show/219957">2025</a>, <a href="/list/show/194885">2024</a>, <a href="/list/show/182428">2023</a>, <a href="/list/show/169410">2022</a>, <a href="/list/show/155850">2021</a>, <a href="/list/show/143568">2020</a>
      <a href="/list/show/132268">2019</a>, <a href="/list/show/117512">2018</a>, <a href="/list/show/106204">2017</a>, <a href="/list/show/97045">2016</a>, <a href="/list/show/86117">2015</a>, <a href="/list/show/78551">2014</a>, <a href="/list/show/154696">2013</a>, <a href="/list/show/154752">2012</a>, <a href="/list/show/154778">2011</a>, <a href="/list/show/154976">2010</a>
      <a href="/list/show/175385">2009</a>, <a href="/list/show/182440">2008</a>, <a href="/list/show/219509">2007</a>, <a href="/list/show/232538">2006</a>, <a href="/list/show/232618">2005</a>
    `
  },
  {
    type: 'best-year',
    prefix: 'Best Comics and Graphic Novels ',
    html: `
      <a href="/list/show/230128">2026</a>, <a href="/list/show/219958">2025</a>, <a href="/list/show/198198">2024</a>, <a href="/list/show/184232">2023</a>, <a href="/list/show/171831">2022</a>, <a href="/list/show/162590">2021</a>, <a href="/list/show/161693">2020</a>
      <a href="/list/show/161694">2019</a>, <a href="/list/show/161696">2018</a>, <a href="/list/show/162592">2017</a>, <a href="/list/show/162591">2016</a>, <a href="/list/show/85659">2015</a>, <a href="/list/show/80904">2014</a>, <a href="/list/show/87819">2013</a>
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

  if (cleanText.includes('at least')) {
    const match = cleanText.match(/at least\s*(\d+)/) || cleanText.match(/(\d+)/);
    if (match) criteria.min = parseInt(match[1], 10);
  } else if (cleanText.includes('and') && cleanText.includes('rating')) {
    const matches = cleanText.match(/(\d+)/g);
    if (matches && matches.length >= 2) {
      criteria.min = parseInt(matches[0], 10);
      criteria.max = parseInt(matches[1], 10);
    }
  } else if (cleanText.match(/^\d{4}$/)) {
    const year = parseInt(cleanText, 10);
    criteria.minYear = year;
    criteria.maxYear = year;
  }
  return criteria;
}

async function buildGraphicNovelsConfig() {
  console.log(chalk.cyan.bold('🚀 Building Graphic Novels config from snippets...'));
  const lists = [];

  for (const snippet of SNIPPETS) {
    const $ = cheerio.load(snippet.html);
    const links = $('a').toArray();

    for (const el of links) {
      const $a = $(el);
      const originalText = $a.text().trim();
      const nickname = `${snippet.prefix}${originalText}`;
      const href = $a.attr('href') || '';
      const id = href.split('/').pop();
      if (!id) continue;
      
      const criteria = parseCriteria(originalText);

      console.log(chalk.gray(`   Fetching title for: "${nickname}" (ID: ${id})...`));
      try {
        const officialTitle = await fetchOfficialTitle(id);

        lists.push({
          nickname,
          officialTitle,
          id,
          url: `https://www.goodreads.com/list/show/${id}`,
          criteria
        });
        
        console.log(chalk.green(`      Found title: "${officialTitle}"`));
        // Small delay to be polite and avoid rate limits
        await delay(500, 1500);
      } catch (error) {
        console.error(chalk.red.bold(`   ❌ Failed to fetch title for ID ${id}`));
      }
    }
  }

  const config = { tag: 'graphic-novels', lists };
  await fs.ensureDir('tags');
  await fs.writeJson('tags/graphic-novels.json', config, { spaces: 2 });
  console.log(chalk.green.bold('\n✅ tags/graphic-novels.json created successfully!'));
}

buildGraphicNovelsConfig();
