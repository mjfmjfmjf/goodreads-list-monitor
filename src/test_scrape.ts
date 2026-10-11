import { scrapeBookDetails } from './scraper.ts';

async function test() {
  const details = await scrapeBookDetails('1');
  console.log('Scraped Details:', details);
}

test();
