import chalk from 'chalk';
import { buildRatingBuckets } from './summaryHistogram.js';
import { dayBuckets, weekBuckets, monthBuckets } from './booksAddedHistogram.js';
import { getDb } from './db.js';

const formatNum = (n: number): string => n.toLocaleString('en-US');

interface Period {
  label: string;
  start: string; // ISO date 'YYYY-MM-DD'
  end: string; // ISO date 'YYYY-MM-DD'
}

interface BookRow {
  ratings?: string | number | null;
  firstSeen?: string | null;
}

// Assign a rating to its bracket index (same brackets as ratingsHistogram).
function bucketIndexFor(ratings: string | number | null | undefined, buckets: { min: number; max: number }[]): number {
  const num = parseInt(String(ratings ?? '0').replace(/,/g, ''), 10) || 0;
  for (let i = 0; i < buckets.length; i++) {
    if (num >= buckets[i].min && num <= buckets[i].max) return i;
  }
  return buckets.length - 1;
}

// Build a day-resolution date → column index map from the period boundaries.
// Month periods key on 'YYYY-MM'; week/day periods key on 'YYYY-MM-DD'.
function colIndexByDate(periods: Period[], months: boolean): Map<string, number> {
  const map = new Map<string, number>();
  for (let c = 0; c < periods.length; c++) {
    const p = periods[c];
    const d = new Date(`${p.start}T00:00:00Z`);
    while (d.toISOString().slice(0, 10) <= p.end) {
      map.set(months ? d.toISOString().slice(0, 7) : d.toISOString().slice(0, 10), c);
      d.setUTCDate(d.getUTCDate() + 1);
    }
  }
  return map;
}

// Cumulative books per (column, bracket): cell [c][b] = books first seen on or
// before the end of period c whose current ratings fall in bracket b.
export function computeCumulativeGrid(
  periods: Period[],
  buckets: { min: number; max: number }[],
  books: BookRow[],
  months: boolean
): { counts: number[][]; totals: number[] } {
  const colIndex = colIndexByDate(periods, months);
  const perPeriod: number[][] = periods.map(() => new Array<number>(buckets.length).fill(0));
  for (const book of books) {
    const fs = book.firstSeen;
    if (!fs) continue;
    const key = months ? fs.slice(0, 7) : fs.slice(0, 10);
    const c = colIndex.get(key);
    if (c === undefined) continue;
    perPeriod[c][bucketIndexFor(book.ratings, buckets)]++;
  }

  const counts: number[][] = perPeriod.map(() => new Array<number>(buckets.length).fill(0));
  const run = new Array<number>(buckets.length).fill(0);
  for (let c = 0; c < periods.length; c++) {
    for (let b = 0; b < buckets.length; b++) {
      run[b] += perPeriod[c][b];
      counts[c][b] = run[b];
    }
  }
  const totals = counts.map(row => row.reduce((a, b) => a + b, 0));
  return { counts, totals };
}

export function runRatingsByDateHistogram(options: { days?: number; weeks?: number; months?: number } = {}): void {
  const db = getDb();

  const nDays = options.days ?? 0;
  const nWeeks = options.weeks ?? 0;
  const nMonths = options.months ?? 0;
  const modes = [nDays > 0, nWeeks > 0, nMonths > 0].filter(Boolean).length;
  if (modes > 1) {
    throw new Error('Pass only one of --days, --weeks, --months');
  }

  const buckets = buildRatingBuckets();
  let periods: Period[];
  let months = false;
  if (nWeeks > 0) periods = weekBuckets(nWeeks);
  else if (nMonths > 0) { periods = monthBuckets(nMonths); months = true; }
  else periods = dayBuckets(nDays > 0 ? nDays : 7);

  const totalBooks = (db.prepare('SELECT COUNT(*) AS c FROM books').get() as any).c;
  const missing = (db.prepare('SELECT COUNT(*) AS c FROM books WHERE first_seen IS NULL OR first_seen = \'\'').get() as any).c;

  const rows = db.prepare('SELECT ratings, first_seen AS firstSeen FROM books').all() as BookRow[];
  const { counts, totals } = computeCumulativeGrid(periods, buckets, rows, months);

  // Column header labels: short dates ('09/01'), week starts, or 'YYYY-MM'.
  const headers = periods.map(p => months ? p.label : p.label.slice(5).replace('-', '/'));
  const CW = Math.max(7, ...headers.map(h => h.length), ...totals.map(t => formatNum(t).length));
  const LW = Math.max(...buckets.map(b => b.label.length)) + 1;
  const rule = '-'.repeat(LW + (CW + 3) * headers.length + 1);

  console.log();
  console.log(chalk.cyan.bold('Books in DB by rating range, cumulative to each period'));
  console.log(chalk.gray(`   Periods: ${periods.length} × last ${periods.length} ${months ? 'months' : nWeeks > 0 ? 'weeks (Monday-start)' : 'days'} (${periods[0].start} → ${periods[periods.length - 1].end})`));
  console.log(chalk.gray(rule));
  console.log(chalk.white('RATING BRACKET'.padEnd(LW) + ' | ' + headers.map(h => h.padStart(CW)).join(' | ')));
  console.log(chalk.gray(rule));

  for (let b = 0; b < buckets.length; b++) {
    const label = buckets[b].label.padEnd(LW);
    const cells = counts.map((col, c) => {
      const v = formatNum(col[b]).padStart(CW);
      return col[b] > 0 ? chalk.yellow(v) : chalk.gray(v);
    });
    console.log(`${chalk.white(label)} | ${cells.join(' | ')}`);
  }

  console.log(chalk.gray(rule));
  console.log(chalk.white('TOTAL'.padEnd(LW) + ' | ' + totals.map(t => chalk.magenta(formatNum(t).padStart(CW))).join(' | ')));
  console.log(chalk.gray(rule));
  console.log(chalk.cyan.bold(`Total books in DB: ${formatNum(totalBooks)}`));
  console.log(chalk.gray(
    `   Each column is the count of books first seen by the end of that period, bucketed by their current ratings (first_seen is backfilled from last_updated for pre-existing rows).`
  ));
  if (missing > 0) {
    console.log(chalk.gray(`   First-seen unknown for ${formatNum(missing)} books — excluded from every column.`));
  }
}