import chalk from 'chalk';
import { loadBookCache } from './storage.js';

export interface AvgHistogramOptions {
  step?: string;
  minRatings?: string;
  maxRatings?: string;
}

export async function runAvgHistogram(options: AvgHistogramOptions = {}): Promise<void> {
  const bookCache = await loadBookCache();
  const books = Object.values(bookCache);

  let rawStep = parseFloat(options.step || '0.01');
  if (isNaN(rawStep) || rawStep <= 0) rawStep = 0.01;
  // 0.01 or less means no grouping (each 0.01 value is its own bucket)
  const stepH = Math.max(1, Math.round(rawStep * 100));

  const minRatings = options.minRatings !== undefined ? parseInt(options.minRatings, 10) : null;
  const maxRatings = options.maxRatings !== undefined ? parseInt(options.maxRatings, 10) : null;

  const maxValueH = 500; // 5.00 in hundredths
  const bucketCount = Math.floor(maxValueH / stepH) + 1;

  const counts: number[] = new Array(bucketCount).fill(0);
  let noAvgCount = 0;
  let filteredCount = 0;

  for (const book of books) {
    if (!book.avgRating || book.avgRating === 'Unknown') {
      noAvgCount++;
      continue;
    }

    const numRatings = parseInt((book.ratings || '0').toString().replace(/,/g, ''), 10) || 0;
    if ((minRatings !== null && numRatings < minRatings) || (maxRatings !== null && numRatings > maxRatings)) {
      filteredCount++;
      continue;
    }

    const valueH = Math.round(parseFloat(book.avgRating) * 100);
    const idx = Math.floor(valueH / stepH);
    if (idx >= 0 && idx < bucketCount) counts[idx]++;
  }

  const rows: { label: string; count: number }[] = [];
  for (let i = 0; i < bucketCount; i++) {
    if (counts[i] === 0) continue; // ignore values with no books

    const startH = i * stepH;
    const endH = Math.min((i + 1) * stepH, maxValueH + 1) - 1;

    let label: string;
    if (stepH === 1 || startH === endH) {
      label = (startH / 100).toFixed(2);
    } else {
      label = `${(startH / 100).toFixed(2)} to ${(endH / 100).toFixed(2)}`;
    }

    rows.push({ label, count: counts[i] });
  }

  const totalCounted = rows.reduce((a, r) => a + r.count, 0);
  const maxLabelWidth = Math.max(...rows.map(r => r.label.length));

  const stepLabel = stepH === 1 ? '0.01 (no grouping)' : (stepH / 100).toFixed(2);

  console.log(chalk.cyan.bold('\n📊 Book Cache Average Rating Histogram:'));
  console.log(chalk.gray(`Step: ${stepLabel} (empty buckets hidden)`));
  console.log(chalk.gray('----------------------------------------------------------------------'));

  let runningFromTop = 0;
  let runningFromBottom = totalCounted;

  for (const row of rows) {
    const pct = totalCounted > 0 ? ((row.count / totalCounted) * 100).toFixed(2) : '0.00';
    const labelPadded = row.label.padEnd(maxLabelWidth, ' ');
    const countPadded = row.count.toLocaleString().padStart(7, ' ');
    const pctPadded = pct.padStart(6, ' ');

    runningFromTop += row.count;

    const countColored = chalk.yellow(countPadded);

    console.log(`${chalk.white(labelPadded)} : ${countColored} books (${chalk.cyan(pctPadded)}%) ` +
      `${chalk.magenta(runningFromTop.toLocaleString().padStart(8, ' '))} >= | ` +
      `${chalk.cyan(runningFromBottom.toLocaleString().padStart(8, ' '))} <=`);

    runningFromBottom -= row.count;
  }

  console.log(chalk.gray('----------------------------------------------------------------------'));
  console.log(chalk.cyan.bold(`Total books with avg rating: ${totalCounted.toLocaleString()}`));
  if (noAvgCount > 0) {
    console.log(chalk.yellow(`${noAvgCount.toLocaleString()} books have no average rating (excluded).`));
  }
  if (filteredCount > 0) {
    const minStr = minRatings !== null ? `min ${minRatings.toLocaleString()}` : '';
    const maxStr = maxRatings !== null ? `max ${maxRatings.toLocaleString()}` : '';
    console.log(chalk.yellow(`${filteredCount.toLocaleString()} books outside ratings filter (${[minStr, maxStr].filter(Boolean).join(', ')}) (excluded).`));
  }
  console.log(chalk.gray('Columns: count at this avg rating level | cumulative books with avg >= this level (>=) | cumulative books with avg <= this level (<=)'));
}
