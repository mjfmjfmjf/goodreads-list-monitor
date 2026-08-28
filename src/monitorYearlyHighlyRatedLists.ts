import chalk from 'chalk';
import { getDb } from './db.js';
import { loadState } from './storage.js';

export interface YearlyRow {
  year: number;
  maxAvg: number;
}

export interface YearlyCounts {
  year: number;
  gte44: number;
  gte45: number;
  gte46: number;
}

export interface StateListLike {
  title?: string;
  lastCount?: number;
}

// Aggregate distinct-work average-rating data into per-year counts at the
// 4.4 / 4.5 / 4.6 thresholds. Assumes `rows` already contains ONE row per
// distinct work (the representative edition's max avg rating and its year).
export function computeYearlyDistinctWorks(rows: YearlyRow[]): YearlyCounts[] {
  const byYear = new Map<number, YearlyCounts>();
  for (const { year, maxAvg } of rows) {
    let c = byYear.get(year);
    if (!c) {
      c = { year, gte44: 0, gte45: 0, gte46: 0 };
      byYear.set(year, c);
    }
    if (maxAvg >= 4.4) c.gte44++;
    if (maxAvg >= 4.5) c.gte45++;
    if (maxAvg >= 4.6) c.gte46++;
  }
  return [...byYear.values()].sort((a, b) => a.year - b.year);
}

// Map each monitored "Highest Rated Books of YYYY" list to its year, returning
// { year, lastCount }. Matches titles like "Highest Rated Books of 2024" or
// "Highest Rated Books of 2025 by avg rating".
export function mapYearListSizes(stateLists: Record<string, StateListLike>): Map<number, number> {
  const out = new Map<number, number>();
  for (const l of Object.values(stateLists)) {
    const m = (l.title || '').match(/^Highest Rated Books of (\d{4})/);
    if (m && l.lastCount != null) out.set(Number(m[1]), l.lastCount);
  }
  return out;
}

export async function runMonitorYearlyHighlyRatedLists(): Promise<void> {
  const db = getDb();

  const rows = db.prepare(`
    WITH ranked AS (
      SELECT
        CAST(substr(published, 1, 4) AS INTEGER) AS year,
        CAST(avg_rating AS REAL) AS avgRating,
        ROW_NUMBER() OVER (
          PARTITION BY work_id
          ORDER BY CAST(avg_rating AS REAL) DESC
        ) AS rn
      FROM books
      WHERE avg_rating IS NOT NULL AND avg_rating != ''
        AND CAST(ratings AS INTEGER) >= 1000
        AND work_id IS NOT NULL AND work_id != ''
        AND CAST(substr(published, 1, 4) AS INTEGER) BETWEEN 2012 AND 2026
    )
    SELECT year, avgRating AS maxAvg FROM ranked WHERE rn = 1
  `).all() as YearlyRow[];

  const state = await loadState();
  const listSizes = mapYearListSizes(state.lists || {});
  const counts = computeYearlyDistinctWorks(rows);

  console.log(chalk.cyan.bold('\n📊 Yearly highly-rated lists (distinct works by workId, ≥1000 ratings):'));
  console.log(chalk.gray('----------------------------------------------------------------------'));

  const col = (s: string, w: number): string => s.padStart(w);

  const W_YEAR = 6;
  const W_NUM = 5;
  const header = `${col('Year', W_YEAR)} | ${col('OnLst', W_NUM)} | ${col('4.4+', W_NUM)} | ${col('4.5+', W_NUM)} | ${col('4.6+', W_NUM)}`;
  const divider = `${'-'.repeat(W_YEAR)} | ${'-'.repeat(W_NUM)} | ${'-'.repeat(W_NUM)} | ${'-'.repeat(W_NUM)} | ${'-'.repeat(W_NUM)}`;
  console.log(header);
  console.log(chalk.gray(divider));

  const num = (n: number | undefined): string => (n == null ? '-' : String(n)).padStart(W_NUM);
  // Band a count against the target list-size range: green on-target, yellow
  // under (room to grow), red over (candidate for trimming).
  const band = (n: number | undefined): string => {
    const s = num(n);
    if (n == null) return s;
    const f = n >= 100 && n <= 200 ? chalk.green : n < 100 ? chalk.yellow : chalk.red;
    return f(s);
  };
  for (const c of counts) {
    const onList = listSizes.get(c.year);
    console.log(`${col(String(c.year), W_YEAR)} | ${band(onList)} | ${num(c.gte44)} | ${band(c.gte45)} | ${num(c.gte46)}`);
  }

  console.log(chalk.gray('\nOnLst = current list size (state.json lastCount);'), chalk.gray('4.4+/4.5+/4.6+ = distinct eligible works in the book cache.'));
  console.log(chalk.gray('Counts are lower bounds: they only include works whose workId has been harvested (~46.6% coverage).'));
  console.log();
}
