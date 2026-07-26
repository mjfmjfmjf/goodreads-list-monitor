import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import * as cheerio from 'cheerio';
import axios from 'axios';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const htmlSnippet = `
<a href="/list/show/153860">Top 100 Highest Rated Books with at least 10000 Ratings (fiction or memoir, one per series)</a>
<a href="/list/show/205516">Average Rating of 4.6 and above with at least 3000 ratings</a>
<a href="/list/show/165317">Average Rating of 4.5 and above with at least 3000 ratings</a>
<a href="/list/show/10198">Average Rating of 4.5 and above with at least 100 ratings</a>
<a href="/list/show/74717">Average Rating of 4.3 and above with at least 1000 ratings</a>
<a href="/list/show/24320">Average Rating of 4.2 and above with at least 1000 ratings</a>
<a href="/list/show/165313">Average Rating of 4.0 and above with at least 30000 ratings</a>
<a href="/list/show/75146">Average Rating of 4.0 and above with at least 1000 ratings</a>
<a href="/list/show/177670">Average Rating of 4.0 and above, 100 to 999 ratings, and published before 2001</a>
<a href="/list/show/13035">Average Rating of 3.99 and below</a>
<a href="/list/show/24328">Average Rating below 3.6</a>
<a href="/list/show/23974">Average Rating of 3.0 and below with at least 100 ratings</a>
<a href="/list/show/165146">Average Rating of 4.5 and above and with 10 to 99 ratings</a>
`;

export interface AuditCriteria {
  min?: number;
  max?: number;
  minYear?: number;
  maxYear?: number;
  minTags?: number;
  minAvg?: number;
  maxAvg?: number;
}

export interface ListEntry {
  nickname: string;
  officialTitle: string;
  id: string;
  url: string;
  criteria: AuditCriteria;
}

async function fetchOfficialTitle(listId: string): Promise<string> {
  const url = `https://www.goodreads.com/list/show/${listId}`;
  const response = await axios.get(url, { headers: { 'User-Agent': USER_AGENT } });
  const $ = cheerio.load(response.data);
  return $('h1').text().trim().replace(/\s*\(.*\)$/, '');
}

function parseCriteria(text: string): AuditCriteria {
  const cleanText = text.toLowerCase().replace(/,/g, '');
  const criteria: AuditCriteria = {};

  // 1. Average Rating Parsing
  if (cleanText.includes('average rating') || cleanText.includes('rated')) {
    const aboveMatch = cleanText.match(/average rating of ([\d.]+)\s+(and above|or above)/) || cleanText.match(/average rating ([\d.]+)\s+(and above|or above)/) || cleanText.match(/highest rated/);
    const belowInclusiveMatch = cleanText.match(/average rating of ([\d.]+)\s+and below/) || cleanText.match(/average rating ([\d.]+)\s+and below/);
    const belowExclusiveMatch = cleanText.match(/average rating below ([\d.]+)/);
    
    if (aboveMatch) {
      if (aboveMatch[0] === 'highest rated') {
         // No specific minAvg, but marked as rated
      } else {
        criteria.minAvg = parseFloat(aboveMatch[1]);
      }
    } else if (belowInclusiveMatch) {
      criteria.maxAvg = parseFloat(belowInclusiveMatch[1]);
    } else if (belowExclusiveMatch) {
      criteria.maxAvg = parseFloat((parseFloat(belowExclusiveMatch[1]) - 0.01).toFixed(2));
    }
  }

  // 2. Ratings Count Parsing
  if (cleanText.includes('ratings') || cleanText.includes('rated')) {
    const atLeastMatch = cleanText.match(/at least (\d+)\s+ratings/) || cleanText.match(/at least (\d+)\s+rated/);
    const rangeMatch = cleanText.match(/(\d+)\s+to\s+(\d+)\s+ratings/) || cleanText.match(/with\s+(\d+)\s+to\s+(\d+)\s+ratings/);
    
    if (atLeastMatch) {
      criteria.min = parseInt(atLeastMatch[1], 10);
    } else if (rangeMatch) {
      criteria.min = parseInt(rangeMatch[1], 10);
      criteria.max = parseInt(rangeMatch[2], 10);
    }
  }

  // 3. Year/Decade Parsing
  const beforeMatch = cleanText.match(/published before (\d{4})/);
  if (beforeMatch) {
    criteria.maxYear = parseInt(beforeMatch[1], 10) - 1;
  }

  return criteria;
}

async function buildConfig() {
  console.log(chalk.cyan.bold('🚀 Building bulkAvgRatings.json...'));
  const $ = cheerio.load(htmlSnippet);
  const listEntries: ListEntry[] = [];

  const links = $('a').toArray();
  for (const el of links) {
    const $a = $(el);
    const href = $a.attr('href') || '';
    const nickname = $a.text().trim();
    
    const idMatch = href.match(/\/list\/show\/(\d+)/);
    if (!idMatch) continue;
    const listId = idMatch[1];
    
    try {
      console.log(chalk.gray(`   Processing: ${nickname} (ID: ${listId})...`));
      let officialTitle = await fetchOfficialTitle(listId);
      if (officialTitle === 'Score' || !officialTitle) {
        officialTitle = nickname;
      }
      const criteria = parseCriteria(nickname);

      listEntries.push({
        nickname,
        officialTitle,
        id: listId,
        url: `https://www.goodreads.com/list/show/${listId}`,
        criteria
      });
    } catch (e: any) {
      console.error(chalk.red(`   Failed on list ID ${listId}:`), e.message || e);
    }
  }

  await fs.writeJson(path.join(process.cwd(), 'bulkAvgRatings.json'), listEntries, { spaces: 2 });
  console.log(chalk.green.bold('\n✅ bulkAvgRatings.json created successfully!'));
}

buildConfig().catch(err => {
  console.error(chalk.red.bold('Build failed:'), err);
  process.exit(1);
});
