import chalk from 'chalk';
import { getDb } from './db.js';

const formatNum = (n: number): string => n.toLocaleString('en-US');

interface PeriodBucket {
  label: string;
  start: string; // ISO date 'YYYY-MM-DD' (inclusive)
  end: string; // ISO date 'YYYY-MM-DD' (inclusive)
  added: number;
  total: number;
}

// Most recent Monday on or before `date`, as an ISO date string.
function mondayOf(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 0=Mon .. 6=Sun
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

function monthStart(dateIso: string): string {
  return dateIso.slice(0, 7) + '-01';
}

// Build the last `n` day buckets ending today (inclusive), oldest first.
export function dayBuckets(n: number, todayIso: string = new Date().toISOString().slice(0, 10)): PeriodBucket[] {
  const out: PeriodBucket[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(`${todayIso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    const iso = d.toISOString().slice(0, 10);
    out.push({ label: iso, start: iso, end: iso, added: 0, total: 0 });
  }
  return out;
}

// Most recent `n` weeks, bucket = Monday-week, oldest first.
export function weekBuckets(n: number, todayIso: string = new Date().toISOString().slice(0, 10)): PeriodBucket[] {
  const endMonday = mondayOf(todayIso);
  const out: PeriodBucket[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const start = new Date(`${endMonday}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 7 * i);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);
    const startIso = start.toISOString().slice(0, 10);
    out.push({ label: startIso, start: startIso, end: end.toISOString().slice(0, 10), added: 0, total: 0 });
  }
  return out;
}

// Most recent `n` months, bucket = calendar month, oldest first.
export function monthBuckets(n: number, todayIso: string = new Date().toISOString().slice(0, 10)): PeriodBucket[] {
  const now = todayIso ? new Date(`${todayIso.slice(0, 7)}-01T00:00:00Z`) : new Date();
  const out: PeriodBucket[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
    const startIso = start.toISOString().slice(0, 7) + '-01';
    out.push({ label: startIso.slice(0, 7), start: startIso, end: end.toISOString().slice(0, 10), added: 0, total: 0 });
  }
  return out;
}

export function runBooksAddedHistogram(options: { days?: number; weeks?: number; months?: number } = {}): void {
  const db = getDb();

  const nDays = options.days ?? 0;
  const nWeeks = options.weeks ?? 0;
  const nMonths = options.months ?? 0;
  const modes = [nDays > 0, nWeeks > 0, nMonths > 0].filter(Boolean).length;
  if (modes > 1) {
    throw new Error('Pass only one of --days, --weeks, --months');
  }

  let buckets: PeriodBucket[];
  let unit: string;
  if (nWeeks > 0) { buckets = weekBuckets(nWeeks); unit = 'week'; }
  else if (nMonths > 0) { buckets = monthBuckets(nMonths); unit = 'month'; }
  else { buckets = dayBuckets(nDays > 0 ? nDays : 7); unit = 'day'; }

  const totalBooks = (db.prepare('SELECT COUNT(*) AS c FROM books').get() as any).c;
  const missing = (db.prepare('SELECT COUNT(*) AS c FROM books WHERE first_seen IS NULL OR first_seen = \'\'').get() as any).c;
  const first = (db.prepare('SELECT MIN(first_seen) AS m FROM books WHERE first_seen IS NOT NULL AND first_seen != \'\'').get() as any).m;

  const windowStart = buckets[0].start;
  const beforeWindow = (db.prepare(
    `SELECT COUNT(*) AS c FROM books WHERE first_seen IS NOT NULL AND first_seen != '' AND first_seen < ?`
  ).get(windowStart) as any).c;

  // Grouped additions within the window, keyed by the padded bucket-start date.
  const grouped = db.prepare(
    `SELECT date(first_seen) AS d, COUNT(*) AS c FROM books
     WHERE first_seen IS NOT NULL AND first_seen != '' AND first_seen >= ? AND date(first_seen) <= ?
     GROUP BY date(first_seen)`
  ).all(windowStart, buckets[buckets.length - 1].end) as { d: string; c: number }[];

  const dayToBucket = new Map<string, PeriodBucket>();
  for (const b of buckets) {
    const d = new Date(`${b.start}T00:00:00Z`);
    while (d.toISOString().slice(0, 10) <= b.end) {
      if (unit === 'month') dayToBucket.set(d.toISOString().slice(0, 7), b);
      else dayToBucket.set(d.toISOString().slice(0, 10), b);
      d.setUTCDate(d.getUTCDate() + 1);
    }
  }
  for (const r of grouped) {
    const key = unit === 'month' ? r.d.slice(0, 7) : r.d;
    const b = dayToBucket.get(key);
    if (b) b.added += r.c;
  }

  // Running cumulative: books first seen anywhere before this period, plus all
  // additions in this and earlier periods of the window.
  let running = beforeWindow;
  for (const b of buckets) {
    running += b.added;
    b.total = running;
  }

  let totalsAdded = 0;
  for (const b of buckets) totalsAdded += b.added;

  const pctOf = (n: number) => (totalBooks > 0 ? (n / totalBooks * 100).toFixed(1) + '%' : '0.0%');

  const LW = Math.max(6, ...buckets.map(b => b.label.length)) + 1;
  const AW = Math.max(5, ...buckets.map(b => formatNum(b.added).length)); // header: ADDED
  const TW = Math.max(5, ...buckets.map(b => formatNum(b.total).length)); // header: TOTAL
  const PW = Math.max(5, ...buckets.map(b => pctOf(b.total).length)); // header: OF DB
  const rule = '-'.repeat(LW + AW + TW + PW + 3 * 3);

  console.log();
  console.log(chalk.cyan.bold('Books in the DB by first-seen period'));
  console.log(chalk.gray(`   Period: last ${buckets.length} ${unit}${buckets.length > 1 ? 's' : ''} (${buckets[0].label} → ${buckets[buckets.length - 1].label})`));
  console.log(chalk.gray(rule));
  console.log(
    chalk.white('PERIOD'.padEnd(LW) + ' | ' +
      'ADDED'.padStart(AW) + ' | ' +
      'TOTAL'.padStart(TW) + ' | ' +
      'OF DB'.padStart(PW))
  );
  console.log(chalk.gray(rule));

  for (const b of buckets) {
    const added = formatNum(b.added).padStart(AW);
    const total = formatNum(b.total).padStart(TW);
    const pct = pctOf(b.total).padStart(PW);
    const addedColored = b.added > 0 ? chalk.yellow(added) : chalk.gray(added);
    console.log(
      `${chalk.white(b.label.padEnd(LW))} | ${addedColored} | ${chalk.magenta(total)} | ${chalk.cyan(pct)}`
    );
  }

  console.log(chalk.gray(rule));
  console.log(chalk.cyan.bold(`Total books in DB: ${formatNum(totalBooks)}`));
  console.log(chalk.gray(
    `   ${formatNum(totalsAdded)} added in the window · ${formatNum(beforeWindow)} predate the window (cumulative, not in-window counts)`
  ));
  if (missing > 0) {
    console.log(chalk.gray(`   First-seen unknown for ${formatNum(missing)} books (${pctOf(missing)} of DB) — excluded from the totals above`));
  }
  if (first) console.log(chalk.gray(`   Earliest first_seen: ${first.slice(0, 10)}`));
}