import chalk from 'chalk';
import { loadBookCache } from './storage.js';

interface RatingBucket {
  label: string;
  min: number;
  max: number;
}

const BUCKETS: RatingBucket[] = [
  { label: '10,000,000+', min: 10000000, max: Infinity },
  { label: '9,000,000 to 9,999,999', min: 9000000, max: 9999999 },
  { label: '8,000,000 to 8,999,999', min: 8000000, max: 8999999 },
  { label: '7,000,000 to 7,999,999', min: 7000000, max: 7999999 },
  { label: '6,000,000 to 6,999,999', min: 6000000, max: 6999999 },
  { label: '5,000,000 to 5,999,999', min: 5000000, max: 5999999 },
  { label: '4,000,000 to 4,999,999', min: 4000000, max: 4999999 },
  { label: '3,000,000 to 3,999,999', min: 3000000, max: 3999999 },
  { label: '2,000,000 to 2,999,999', min: 2000000, max: 2999999 },
  { label: '1,000,000 to 1,999,999', min: 1000000, max: 1999999 },
  { label: '900,000 to 999,999', min: 900000, max: 999999 },
  { label: '800,000 to 899,999', min: 800000, max: 899999 },
  { label: '700,000 to 799,999', min: 700000, max: 799999 },
  { label: '600,000 to 699,999', min: 600000, max: 699999 },
  { label: '500,000 to 599,999', min: 500000, max: 599999 },
  { label: '400,000 to 499,999', min: 400000, max: 499999 },
  { label: '300,000 to 399,999', min: 300000, max: 399999 },
  { label: '200,000 to 299,999', min: 200000, max: 299999 },
  { label: '100,000 to 199,999', min: 100000, max: 199999 },
  { label: '90,000 to 99,999', min: 90000, max: 99999 },
  { label: '80,000 to 89,999', min: 80000, max: 89999 },
  { label: '70,000 to 79,999', min: 70000, max: 79999 },
  { label: '60,000 to 69,999', min: 60000, max: 69999 },
  { label: '50,000 to 59,999', min: 50000, max: 59999 },
  { label: '40,000 to 49,999', min: 40000, max: 49999 },
  { label: '30,000 to 39,999', min: 30000, max: 39999 },
  { label: '20,000 to 29,999', min: 20000, max: 29999 },
  { label: '10,000 to 19,999', min: 10000, max: 19999 },
  { label: '9,000 to 9,999', min: 9000, max: 9999 },
  { label: '8,000 to 8,999', min: 8000, max: 8999 },
  { label: '7,000 to 7,999', min: 7000, max: 7999 },
  { label: '6,000 to 6,999', min: 6000, max: 6999 },
  { label: '5,000 to 5,999', min: 5000, max: 5999 },
  { label: '4,000 to 4,999', min: 4000, max: 4999 },
  { label: '3,000 to 3,999', min: 3000, max: 3999 },
  { label: '2,000 to 2,999', min: 2000, max: 2999 },
  { label: '1,000 to 1,999', min: 1000, max: 1999 },
  { label: '900 to 999', min: 900, max: 999 },
  { label: '800 to 899', min: 800, max: 899 },
  { label: '700 to 799', min: 700, max: 799 },
  { label: '600 to 699', min: 600, max: 699 },
  { label: '500 to 599', min: 500, max: 599 },
  { label: '400 to 499', min: 400, max: 499 },
  { label: '300 to 399', min: 300, max: 399 },
  { label: '200 to 299', min: 200, max: 299 },
  { label: '100 to 199', min: 100, max: 199 },
  { label: '90 to 99', min: 90, max: 99 },
  { label: '80 to 89', min: 80, max: 89 },
  { label: '70 to 79', min: 70, max: 79 },
  { label: '60 to 69', min: 60, max: 69 },
  { label: '50 to 59', min: 50, max: 59 },
  { label: '40 to 49', min: 40, max: 49 },
  { label: '30 to 39', min: 30, max: 39 },
  { label: '20 to 29', min: 20, max: 29 },
  { label: '10 to 19', min: 10, max: 19 },
  { label: '0 to 9', min: 0, max: 9 },
];

export async function runSummaryRatings(options: { hideZero?: boolean } = {}): Promise<void> {
  const bookCache = await loadBookCache();
  const books = Object.values(bookCache);
  const totalBooks = books.length;

  const counts: number[] = new Array(BUCKETS.length).fill(0);

  for (const book of books) {
    const rawRatings = (book.ratings || '0').toString().replace(/,/g, '');
    const numRatings = parseInt(rawRatings, 10) || 0;

    for (let i = 0; i < BUCKETS.length; i++) {
      const bucket = BUCKETS[i];
      if (numRatings >= bucket.min && numRatings <= bucket.max) {
        counts[i]++;
        break;
      }
    }
  }

  const maxCount = Math.max(...counts, 1);
  const maxLabelWidth = Math.max(...BUCKETS.map(b => b.label.length));

  console.log(chalk.cyan.bold('\n📊 Book Cache Ratings Histogram:'));
  console.log(chalk.gray('----------------------------------------------------------------------'));

  for (let i = 0; i < BUCKETS.length; i++) {
    const bucket = BUCKETS[i];
    const count = counts[i];

    if (options.hideZero && count === 0) continue;

    const pct = totalBooks > 0 ? ((count / totalBooks) * 100).toFixed(2) : '0.00';
    const labelPadded = bucket.label.padEnd(maxLabelWidth, ' ');
    const countPadded = count.toLocaleString().padStart(7, ' ');
    const pctPadded = pct.padStart(6, ' ');

    const barLen = Math.round((count / maxCount) * 30);
    const bar = '█'.repeat(barLen);

    const countColored = count > 0 ? chalk.yellow(countPadded) : chalk.gray(countPadded);
    const barColored = chalk.green(bar);

    console.log(`${chalk.white(labelPadded)} : ${countColored} books (${chalk.cyan(pctPadded)}%) ${barColored}`);
  }

  console.log(chalk.gray('----------------------------------------------------------------------'));
  console.log(chalk.cyan.bold(`Total books in cache: ${totalBooks.toLocaleString()}`));
}
