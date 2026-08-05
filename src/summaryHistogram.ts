import chalk from 'chalk';
import { loadBookCache } from './storage.js';

interface RatingBucket {
  label: string;
  min: number;
  max: number;
}

const formatNum = (n: number): string => n.toLocaleString('en-US');

function buildBuckets(): RatingBucket[] {
  const buckets: RatingBucket[] = [{ label: '10,000,000+', min: 10000000, max: Infinity }];

  // For each order of magnitude, 9 buckets (digit 1-9), e.g. 9M-10M ... 1M-2M
  const scales = [1000000, 100000, 10000, 1000, 100, 10];
  for (const scale of scales) {
    for (let digit = 9; digit >= 1; digit--) {
      const min = digit * scale;
      const max = (digit + 1) * scale - 1;
      buckets.push({ label: `${formatNum(min)} to ${formatNum(max)}`, min, max });
    }
  }

  buckets.push({ label: '0 to 9', min: 0, max: 9 });
  return buckets;
}

const BUCKETS: RatingBucket[] = buildBuckets();

export async function runRatingsHistogram(): Promise<void> {
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

  const maxLabelWidth = Math.max(...BUCKETS.map(b => b.label.length));

  console.log(chalk.cyan.bold('\n📊 Book Cache Ratings Histogram:'));
  console.log(chalk.gray('----------------------------------------------------------------------'));

  let runningFromTop = 0;
  let runningFromBottom = counts.reduce((a, b) => a + b, 0);

  for (let i = 0; i < BUCKETS.length; i++) {
    const bucket = BUCKETS[i];
    const count = counts[i];

    const pct = totalBooks > 0 ? ((count / totalBooks) * 100).toFixed(2) : '0.00';
    const labelPadded = bucket.label.padEnd(maxLabelWidth, ' ');
    const countPadded = count.toLocaleString().padStart(7, ' ');
    const pctPadded = pct.padStart(6, ' ');

    runningFromTop += count;

    const countColored = count > 0 ? chalk.yellow(countPadded) : chalk.gray(countPadded);

    console.log(`${chalk.white(labelPadded)} : ${countColored} books (${chalk.cyan(pctPadded)}%) ` +
      `${chalk.magenta(runningFromTop.toLocaleString().padStart(8, ' '))} >= | ` +
      `${chalk.cyan(runningFromBottom.toLocaleString().padStart(8, ' '))} <=`);

    runningFromBottom -= count;
  }

  console.log(chalk.gray('----------------------------------------------------------------------'));
  console.log(chalk.cyan.bold(`Total books in cache: ${totalBooks.toLocaleString()}`));
  console.log(chalk.gray('Columns: count at this rating level | cumulative books with AT LEAST this many ratings (>=) | cumulative books with AT MOST this many ratings (<=)'));
}
