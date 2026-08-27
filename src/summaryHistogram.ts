import chalk from 'chalk';
import { loadBookCache } from './storage.js';

interface RatingBucket {
  label: string;
  min: number;
  max: number;
}

const formatNum = (n: number): string => n.toLocaleString('en-US');

export function buildRatingBuckets(): RatingBucket[] {
  const buckets: RatingBucket[] = [{ label: '10,000,000+', min: 10000000, max: Infinity }];

  const scales = [1000000, 100000, 10000, 1000, 100, 10];
  for (const scale of scales) {
    for (let digit = 9; digit >= 1; digit--) {
      const min = digit * scale;
      const max = (digit + 1) * scale - 1;
      buckets.push({ label: `${formatNum(min)} to ${formatNum(max)}`, min, max });
    }
  }

  for (let i = 9; i >= 0; i--) {
    buckets.push({ label: formatNum(i), min: i, max: i });
  }
  return buckets;
}

const KNOWN_TOTAL = 15_000_000;
const FIXED_MIN = 80_000;

const BUCKETS: RatingBucket[] = buildRatingBuckets();

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

  // Estimate model:
  //   >= FIXED_MIN ratings: cache is 99.9–100% complete → use cache count directly.
  //   <  FIXED_MIN ratings: cache is ~4% complete → scale up to reach KNOWN_TOTAL.
  const firstFixedIdx = BUCKETS.findIndex(b => b.min >= FIXED_MIN);
  const cacheAtOrAboveFixed = firstFixedIdx >= 0
    ? counts.slice(0, firstFixedIdx + 1).reduce((a, b) => a + b, 0)
    : 0;
  const cacheBelowFixedCount = totalBooks - cacheAtOrAboveFixed;
  const scaleFactor = cacheBelowFixedCount > 0
    ? (KNOWN_TOTAL - cacheAtOrAboveFixed) / cacheBelowFixedCount
    : 1;

  const estimates: number[] = counts.map((count, i) => {
    if (BUCKETS[i].min >= FIXED_MIN) return count;
    return Math.round(count * scaleFactor);
  });

  const totalEst = estimates.reduce((a, b) => a + b, 0);
  const maxLabelWidth = Math.max(...BUCKETS.map(b => b.label.length));

  const cumCounts: number[] = [];
  const cumEsts: number[] = [];
  let cc = 0;
  let ce = 0;
  for (let i = 0; i < BUCKETS.length; i++) {
    cc += counts[i];
    ce += estimates[i];
    cumCounts.push(cc);
    cumEsts.push(ce);
  }

  const cachePctStr = (i: number) => ((totalBooks > 0 ? counts[i] / totalBooks * 100 : 0).toFixed(2) + '%');
  const compPctStr = (i: number) => ((cumEsts[i] > 0 ? cumCounts[i] / cumEsts[i] * 100 : 100).toFixed(2) + '%');

  const col = (val: string, width: number) => val.padStart(width);

  const LW = maxLabelWidth + 1;
  const CW = Math.max(5, ...counts.map(c => formatNum(c).length)); // header: COUNT
  const PW = Math.max(7, ...counts.map((_, i) => cachePctStr(i).length)); // header: CACHE %
  const EW = Math.max(8, ...estimates.map(e => formatNum(e).length)); // header: ESTIMATE
  const CPW = Math.max(6, ...estimates.map((_, i) => compPctStr(i).length)); // header: COMP %
  const CEW = Math.max(6, ...cumCounts.map(c => formatNum(c).length)); // header: CUM >=
  const ICEW = Math.max(6, ...cumCounts.map((c, i) => formatNum(totalBooks - c + counts[i]).length)); // header: CUM <=
  const rule = '-'.repeat(LW + CW + PW + EW + CPW + CEW + ICEW + 9 * 2);

  console.log();
  console.log(chalk.cyan.bold('Book Cache Ratings Histogram'));
  console.log(chalk.gray(rule));
  console.log(
    chalk.white(
      'RATING BRACKET'.padEnd(LW) + ' | ' +
      col('COUNT', CW) + ' | ' +
      col('CACHE %', PW) + ' | ' +
      col('ESTIMATE', EW) + ' | ' +
      col('COMP %', CPW) + ' | ' +
      col('CUM >=', CEW) + ' | ' +
      col('CUM <=', ICEW)
    )
  );
  console.log(chalk.gray(rule));

  for (let i = 0; i < BUCKETS.length; i++) {
    const bucket = BUCKETS[i];
    const count = counts[i];
    const est = estimates[i];

    const label = bucket.label.padEnd(LW);
    const countStr = formatNum(count).padStart(CW);
    const pctStr = cachePctStr(i).padStart(PW);
    const estStr = formatNum(est).padStart(EW);
    const compStr = compPctStr(i).padStart(CPW);
    const cumCountStr = formatNum(cumCounts[i]).padStart(CEW);
    const invCumCountStr = formatNum(totalBooks - cumCounts[i] + count).padStart(ICEW);

    const countColored = count > 0 ? chalk.yellow(countStr) : chalk.gray(countStr);
    const estColored = est > 0 ? chalk.green(estStr) : chalk.gray(estStr);

    console.log(
      `${chalk.white(label)} | ${countColored} | ${chalk.cyan(pctStr)} | ${estColored} | ${chalk.cyan(compStr)} | ${chalk.magenta(cumCountStr)} | ${chalk.cyan(invCumCountStr)}`
    );
  }

  console.log(chalk.gray(rule));
  console.log(chalk.cyan.bold(`Total books in cache: ${formatNum(totalBooks)} | Estimated total: ~${formatNum(totalEst)}`));
  console.log(chalk.gray(`Scale factor for < ${formatNum(FIXED_MIN)} ratings: ×${scaleFactor.toFixed(1)} (cache completeness ~${(100 / scaleFactor).toFixed(1)}%)`));
}
