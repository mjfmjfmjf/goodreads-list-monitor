import { scrapeBookDetails } from './scraper.js';

async function test() {
  const details = await scrapeBookDetails('216819743');
  console.log('Scraped Details:', details);
}

test();
