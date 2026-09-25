import chalk from 'chalk';
import { getDb } from './db.js';
import { iterateBooks, streamRows } from './storage.js';

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

const KNOWN_TOTAL = 30_000_000;
const FIXED_MIN = 80_000;

const BUCKETS: RatingBucket[] = buildRatingBuckets();

// The bracket a ratings count falls into (shared by all the histograms so the
// bracket math can never drift apart). Every count maps to exactly one bucket;
// the last bucket (0 ratings) is the catch-all.
export function bucketIndexFor(ratings: number, buckets: RatingBucket[] = BUCKETS): number {
  for (let i = 0; i < buckets.length; i++) {
    const bucket = buckets[i];
    if (ratings >= bucket.min && ratings <= bucket.max) return i;
  }
  return buckets.length - 1;
}

export async function runRatingsHistogram(options: { onlyWorkId?: boolean } = {}): Promise<void> {
  let fullTotal = 0;

  // counts covers the displayed population (all books, or only work-id books).
  const counts: number[] = new Array(BUCKETS.length).fill(0);
  // fullCounts always covers every cached book — needed so the estimate footer
  // (scale factor / completeness) stays anchored to the whole cache even when
  // the histogram itself is restricted.
  const fullCounts: number[] = new Array(BUCKETS.length).fill(0);

  for (const book of iterateBooks()) {
    fullTotal++;
    const rawRatings = (book.ratings || '0').toString().replace(/,/g, '');
    const numRatings = parseInt(rawRatings, 10) || 0;

    const idx = bucketIndexFor(numRatings);
    fullCounts[idx]++;
    if (!options.onlyWorkId || book.workId) counts[idx]++;
  }

  const histogramTotal = options.onlyWorkId
    ? counts.reduce((a, b) => a + b, 0)
    : fullTotal;

  // Estimate model:
  //   >= FIXED_MIN ratings: cache is ~complete → use count directly.
  //   <  FIXED_MIN ratings: cache holds a fraction of the true population →
  //       scale up to reach KNOWN_TOTAL. The scale factor is always computed
  //       from the FULL cache (cache completeness is a property of the scrape,
  //       not of any displayed subset); the subset estimate then uses it to
  //       project its own below-fixed population to the real world.
  const firstFixedIdx = BUCKETS.findIndex(b => b.min >= FIXED_MIN);
  const atOrAboveFixed = firstFixedIdx >= 0
    ? (arr: number[]) => arr.slice(0, firstFixedIdx + 1).reduce((a, b) => a + b, 0)
    : () => 0;
  const fullAtOrAboveFixed = atOrAboveFixed(fullCounts);
  const fullBelowFixed = fullTotal - fullAtOrAboveFixed;
  const scaleFactor = fullBelowFixed > 0
    ? (KNOWN_TOTAL - fullAtOrAboveFixed) / fullBelowFixed
    : 1;

  const cacheAtOrAboveFixed = atOrAboveFixed(counts);
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

  const cachePctStr = (i: number) => ((histogramTotal > 0 ? counts[i] / histogramTotal * 100 : 0).toFixed(2) + '%');
  // COMP % = this bracket's cached count / this bracket's estimated count
  // (per-bracket completeness, not cumulative).
  const compPctStr = (i: number) => ((estimates[i] > 0 ? counts[i] / estimates[i] * 100 : 100).toFixed(2) + '%');

  const col = (val: string, width: number) => val.padStart(width);

  const LW = maxLabelWidth + 1;
  const CW = Math.max(5, ...counts.map(c => formatNum(c).length)); // header: COUNT
  const PW = Math.max(7, ...counts.map((_, i) => cachePctStr(i).length)); // header: CACHE %
  const EW = Math.max(8, ...estimates.map(e => formatNum(e).length)); // header: ESTIMATE
  const CPW = Math.max(6, ...estimates.map((_, i) => compPctStr(i).length)); // header: COMP %
  const CEW = Math.max(6, ...cumCounts.map(c => formatNum(c).length)); // header: CUM >=
  const ICEW = Math.max(6, ...cumCounts.map((c, i) => formatNum(histogramTotal - c + counts[i]).length)); // header: CUM <=
  const rule = '-'.repeat(LW + CW + PW + EW + CPW + CEW + ICEW + 9 * 2);

  console.log();
  console.log(chalk.cyan.bold('Book Cache Ratings Histogram'));
  if (options.onlyWorkId) {
    console.log(chalk.gray('   (books with a work id only)'));
  }
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
    const invCumCountStr = formatNum(histogramTotal - cumCounts[i] + count).padStart(ICEW);

    const countColored = count > 0 ? chalk.yellow(countStr) : chalk.gray(countStr);
    const estColored = est > 0 ? chalk.green(estStr) : chalk.gray(estStr);

    console.log(
      `${chalk.white(label)} | ${countColored} | ${chalk.cyan(pctStr)} | ${estColored} | ${chalk.cyan(compStr)} | ${chalk.magenta(cumCountStr)} | ${chalk.cyan(invCumCountStr)}`
    );
  }

  console.log(chalk.gray(rule));
  console.log(chalk.cyan.bold(`Total books in cache: ${formatNum(histogramTotal)}${options.onlyWorkId ? ' with a work id' : ''} | Estimated total: ~${formatNum(totalEst)}`));
  console.log(chalk.gray(`Scale factor for < ${formatNum(FIXED_MIN)} ratings: ×${scaleFactor.toFixed(1)} (cache completeness ~${(100 / scaleFactor).toFixed(1)}%)`));
}

// ── Coverage compare histogram ───────────────────────────────────────
// Same rating brackets, but each row splits the cache by coverage subset:
//   ALL    — every cached book
//   WORK-ID — cached books that have a work id (books.work_id)
//   WORKS   — distinct works, one representative edition each (books.is_work_rep)
//   FIELD  — cached books present in the book_page field-coverage cache
// The % columns are WITHIN-bracket coverage: what share of that bracket's
// cached books has a work id / is a distinct work / has a field-coverage row.
// This exposes whether coverage is biased toward popular (high-ratings) books
// or representative of the full distribution.

export interface CoverageBook {
  id: string;
  ratings?: string | number | null;
  workId?: string | null;
  workRep?: boolean;
}

export interface CoverageCounts {
  all: number[];
  work: number[];
  works: number[];
  field: number[];
  totalAll: number;
  totalWork: number;
  totalWorks: number;
  totalField: number;
}

export function buildCoverageCounts(
  books: Iterable<CoverageBook>,
  fieldIds: ReadonlySet<string>,
  buckets: RatingBucket[] = BUCKETS,
): CoverageCounts {
  const all = new Array<number>(buckets.length).fill(0);
  const work = new Array<number>(buckets.length).fill(0);
  const works = new Array<number>(buckets.length).fill(0);
  const field = new Array<number>(buckets.length).fill(0);
  let totalAll = 0;
  let totalWork = 0;
  let totalWorks = 0;
  let totalField = 0;

  for (const book of books) {
    const rawRatings = (book.ratings || '0').toString().replace(/,/g, '');
    const idx = bucketIndexFor(parseInt(rawRatings, 10) || 0, buckets);
    all[idx]++;
    totalAll++;
    if (book.workId) {
      work[idx]++;
      totalWork++;
    }
    if (book.workRep) {
      works[idx]++;
      totalWorks++;
    }
    if (book.id && fieldIds.has(book.id)) {
      field[idx]++;
      totalField++;
    }
  }

  return { all, work, works, field, totalAll, totalWork, totalWorks, totalField };
}

export function renderCoverageHistogram(c: CoverageCounts, buckets: RatingBucket[] = BUCKETS): string[] {
  const lines: string[] = [];
  const col = (val: string, width: number) => val.padStart(width);
  const pct = (part: number, whole: number) => (whole > 0 ? ((part / whole) * 100).toFixed(1) : '0.0') + '%';

  const maxLabelWidth = Math.max(...buckets.map(b => b.label.length));
  const LW = maxLabelWidth + 1;
  const AW = Math.max(7, ...c.all.map(x => formatNum(x).length)); // header: ALL
  const WW = Math.max(7, ...c.work.map(x => formatNum(x).length)); // header: WORK-ID
  const W2W = Math.max(7, ...c.works.map(x => formatNum(x).length)); // header: WORKS
  const FW = Math.max(7, ...c.field.map(x => formatNum(x).length)); // header: FIELD
  const PW = Math.max(8, ...buckets.map((_, i) => pct(c.work[i], c.all[i]).length)); // header: %WORKID
  const P2W = Math.max(8, ...buckets.map((_, i) => pct(c.works[i], c.all[i]).length)); // header: %WORKS
  const FPW = Math.max(7, ...buckets.map((_, i) => pct(c.field[i], c.all[i]).length)); // header: %FIELD
  const rule = '-'.repeat(LW + AW + WW + W2W + FW + PW + P2W + FPW + 6 * 2);

  lines.push('');
  lines.push(chalk.cyan.bold('Book Cache Ratings Coverage by Subset'));
  lines.push(chalk.gray('   ALL = cached books · WORK-ID = has a work id · WORKS = distinct works (de-duplicated) · FIELD = has a book_page field-coverage row'));
  lines.push(chalk.gray(rule));
  lines.push(
    chalk.white(
      'RATING BRACKET'.padEnd(LW) + ' | ' +
      col('ALL', AW) + ' | ' +
      col('WORK-ID', WW) + ' | ' +
      col('WORKS', W2W) + ' | ' +
      col('FIELD', FW) + ' | ' +
      col('%WORKID', PW) + ' | ' +
      col('%WORKS', P2W) + ' | ' +
      col('%FIELD', FPW)
    )
  );
  lines.push(chalk.gray(rule));

  for (let i = 0; i < buckets.length; i++) {
    const label = buckets[i].label.padEnd(LW);
    const all = c.all[i];
    const work = c.work[i];
    const works = c.works[i];
    const field = c.field[i];
    const allStr = all > 0 ? chalk.yellow(formatNum(all).padStart(AW)) : chalk.gray(formatNum(all).padStart(AW));
    const workStr = work > 0 ? chalk.green(formatNum(work).padStart(WW)) : chalk.gray(formatNum(work).padStart(WW));
    const worksStr = works > 0 ? chalk.green(formatNum(works).padStart(W2W)) : chalk.gray(formatNum(works).padStart(W2W));
    const fieldStr = field > 0 ? chalk.green(formatNum(field).padStart(FW)) : chalk.gray(formatNum(field).padStart(FW));
    lines.push(
      `${chalk.white(label)} | ${allStr} | ${workStr} | ${worksStr} | ${fieldStr} | ${chalk.cyan(pct(work, all).padStart(PW))} | ${chalk.cyan(pct(works, all).padStart(P2W))} | ${chalk.cyan(pct(field, all).padStart(FPW))}`
    );
  }

  lines.push(chalk.gray(rule));
  lines.push(chalk.cyan.bold(
    `Total: cache ${formatNum(c.totalAll)} | work-id ${formatNum(c.totalWork)} (${pct(c.totalWork, c.totalAll)} of cache) | works ${formatNum(c.totalWorks)} (${pct(c.totalWorks, c.totalAll)} of cache) | field ${formatNum(c.totalField)} (${pct(c.totalField, c.totalAll)} of cache)`
  ));
  return lines;
}

export async function runRatingsCoverageHistogram(): Promise<void> {
  const fieldIds = new Set(
    (getDb().prepare('SELECT book_id FROM book_page').all() as Array<{ book_id: string }>).map(r => r.book_id)
  );
  const rows = streamRows<{ id: string | number; work_id: string | null; ratings: number | null; is_work_rep: number | null }>(
    'SELECT id, ratings, work_id, is_work_rep FROM books'
  );
  function* mapRows() {
    for (const r of rows) {
      yield {
        id: String(r.id),
        ratings: r.ratings,
        workId: r.work_id || undefined,
        workRep: !!r.is_work_rep,
      };
    }
  }
  const counts = buildCoverageCounts(mapRows(), fieldIds);
  for (const line of renderCoverageHistogram(counts)) console.log(line);
}
