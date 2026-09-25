#!/bin/bash
# New-author arrival histogram, bucketed by hour (default) or day, from
# authors.first_seen.
#
# Usage:
#   ./authorHist.sh                         # all rows, by hour
#   ./authorHist.sh --by day                # bucket by day instead of hour
#   ./authorHist.sh 2026-08-20              # first_seen on/after this date
#   ./authorHist.sh 2026-08-20 2026-08-31   # date range (inclusive)
#   ./authorHist.sh --by day 2026-08-20 2026-08-31   # day buckets + range
#
# NOTE: first_seen was added mid-life and older rows were backfilled with
# `datetime(last_seen, '-1 day')`, so pre-~2026-08-20 buckets are synthetic
# proxies (a few giant spikes), not real arrival times. Resolution is only
# trustworthy once first_seen started being stamped live.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export NODE_PATH="$SCRIPT_DIR/node_modules"

USAGE() { cat <<'EOM'

Usage: ./authorHist.sh [--by hour|day] [FROM [TO]]

New-author arrival histogram from authors.first_seen, bucketed by hour
(default) or day.

Options:
  --by <hour|day>   bucket resolution (default: hour)
  -h, --help        show this usage message

Positional:
  FROM   only first_seen on/after this date (YYYY-MM-DD)
  TO     only first_seen before this date, inclusive (YYYY-MM-DD)

Examples:
  ./authorHist.sh                        # by hour, all rows
  ./authorHist.sh --by day               # by day, all rows
  ./authorHist.sh 2026-08-20             # by hour, from that date
  ./authorHist.sh --by day 2026-08-20 2026-08-31

NOTE: first_seen was added mid-life and older rows were backfilled with
datetime(last_seen, '-1 day'), so pre-~2026-08-20 buckets are synthetic
proxies, not real arrival times; only live-stamped rows are trustworthy.

EOM
}

# Shell-level pre-scan: print usage for -h/--help, and validate --by values.
for a in "$@"; do
  if [ "$a" = "-h" ] || [ "$a" = "--help" ]; then USAGE; exit 0; fi
done
prev=""
for a in "$@"; do
  if [ "$prev" = "--by" ]; then
    case "$a" in
      hour|day) ;;
      *) echo "error: unknown --by value \"$a\" (expected hour or day)." >&2; USAGE; exit 1 ;;
    esac
  fi
  prev="$a"
done

node - "$@" <<'EOF'
const Database = require('better-sqlite3');

(async () => {
const chalk = (await import('chalk')).default;
const formatNum = (n) => n.toLocaleString('en-US');

// Parse args: drop --by <hour|day> (anywhere), keep the remaining
// positionals as [from, to] dates.
const args = process.argv.slice(2);
let bucket = 'hour'; // 'hour' | 'day'
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--by') {
    bucket = (args[i + 1] || '').toLowerCase();
    i++;
  } else {
    rest.push(args[i]);
  }
}

const db = new Database(process.env.LOCAL_DB || require('path').join(process.cwd(), 'goodreads.db'));

const [from, to] = rest;
let where = 'first_seen IS NOT NULL AND first_seen != \'\'';
const params = {};
if (from) { where += ' AND first_seen >= @from'; params.from = from; }
if (to)   { where += ' AND first_seen < date(@to, \'1 day\')'; params.to = to; }

const fmt = bucket === 'day' ? "%Y-%m-%d" : "%Y-%m-%d %H:00";
const label = bucket === 'day' ? 'day' : 'hour';

// Window bounds: explicit FROM/TO, else the data's own min/max first_seen.
const bounds = db.prepare(
  `SELECT MIN(strftime('${fmt}', first_seen)) AS mn, MAX(strftime('${fmt}', first_seen)) AS mx
   FROM authors WHERE first_seen IS NOT NULL AND first_seen != ''`
).get();
const startLabel = from || bounds.mn;
const endLabel = to || bounds.mx;

const totalAuthors = Number((db.prepare('SELECT COUNT(*) AS c FROM authors').get()).c);
const beforeWindow = Number((db.prepare(
  `SELECT COUNT(*) AS c FROM authors WHERE first_seen IS NOT NULL AND first_seen != '' AND strftime('${fmt}', first_seen) < ?`
).get(startLabel)).c);

// Contiguous bucket series (every period, even zero-added), oldest first.
const buckets = [];
{
  const toIso = (lb) =>
    bucket === 'day'
      ? `${lb}T00:00:00Z`
      : `${lb.slice(0, 10)}T${(lb.slice(11, 13) || '00')}:00:00Z`;
  const start = new Date(toIso(startLabel));
  const end = new Date(toIso(endLabel));
  const step = bucket === 'day' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  for (let t = start.getTime(); t <= end.getTime(); t += step) {
    const d = new Date(t);
    const iso = bucket === 'day'
      ? d.toISOString().slice(0, 10)
      : `${d.toISOString().slice(0, 10)} ${String(d.getUTCHours()).padStart(2, '0')}:00`;
    buckets.push({ label: iso, added: 0, total: 0, avgRatings: 0, maxRatings: 0 });
  }
}
const byLabel = new Map(buckets.map(b => [b.label, b]));

const grouped = db.prepare(`
  SELECT strftime('${fmt}', first_seen) AS b, COUNT(*) AS c, COALESCE(SUM(num_ratings), 0) AS sr, MAX(num_ratings) AS mr
  FROM authors WHERE ${where}
  GROUP BY b
`).all(params);

for (const r of grouped) {
  const b = byLabel.get(r.b);
  if (b) {
    b.added += r.c;
    b.maxRatings = Math.max(b.maxRatings, r.mr || 0);
  }
}
// avgRatings = total ratings across the period's additions / the count.
{
  const sumMap = new Map();
  for (const r of grouped) {
    const prev = sumMap.get(r.b) || 0;
    sumMap.set(r.b, prev + r.sr);
  }
  for (const b of buckets) {
    b.avgRatings = b.added > 0 ? Math.round((sumMap.get(b.label) || 0) / b.added) : 0;
  }
}

// Running cumulative: baseline (before window) + additions up to each period.
let running = beforeWindow;
for (const b of buckets) {
  running += b.added;
  b.total = running;
}

let totalsAdded = 0;
for (const b of buckets) totalsAdded += b.added;

const pctOf = (n) => (totalAuthors > 0 ? (n / totalAuthors * 100).toFixed(1) + '%' : '0.0%');

const LW = Math.max(6, ...buckets.map(b => b.label.length)) + 1;
const AW = Math.max(5, ...buckets.map(b => formatNum(b.added).length));
const TW = Math.max(5, ...buckets.map(b => formatNum(b.total).length));
const PW = Math.max(5, ...buckets.map(b => pctOf(b.total).length));
const AVW = Math.max(7, ...buckets.map(b => formatNum(b.avgRatings).length));
const MXW = Math.max(7, ...buckets.map(b => formatNum(b.maxRatings).length));
const rule = '-'.repeat(LW + AW + TW + PW + AVW + MXW + 5 * 3);

const range = from ? (to ? `${from}..${to}` : `${from}..`) : 'all rows';
console.log();
console.log(chalk.cyan.bold(`New authors by first-seen ${label}`));
console.log(chalk.gray(`   Period: ${range} (${buckets[0] ? buckets[0].label : '?'} → ${buckets.length ? buckets[buckets.length - 1].label : '?'})`));
console.log(chalk.gray(rule));
console.log(
  chalk.white('PERIOD'.padEnd(LW) + ' | ' +
    'ADDED'.padStart(AW) + ' | ' +
    'TOTAL'.padStart(TW) + ' | ' +
    'OF DB'.padStart(PW) + ' | ' +
    'AVG RTG'.padStart(AVW) + ' | ' +
    'MAX RTG'.padStart(MXW))
);
console.log(chalk.gray(rule));

for (const b of buckets) {
  const added = formatNum(b.added).padStart(AW);
  const total = formatNum(b.total).padStart(TW);
  const pct = pctOf(b.total).padStart(PW);
  const avgCol = b.added > 0 ? chalk.green(formatNum(b.avgRatings).padStart(AVW)) : chalk.gray('0'.padStart(AVW));
  const maxCol = b.added > 0 ? chalk.yellow(formatNum(b.maxRatings).padStart(MXW)) : chalk.gray('—'.padStart(MXW));
  const addedColored = b.added > 0 ? chalk.white(added) : chalk.gray(added);
  console.log(
    `${chalk.white(b.label.padEnd(LW))} | ${addedColored} | ${chalk.magenta(total)} | ${chalk.cyan(pct)} | ${avgCol} | ${maxCol}`
  );
}

console.log(chalk.gray(rule));
console.log(chalk.cyan.bold(`Total authors in DB: ${formatNum(totalAuthors)}`));
console.log(chalk.gray(
  `   ${formatNum(totalsAdded)} added in the window · ${formatNum(beforeWindow)} predate the window (cumulative, not in-window counts)`
));
console.log(chalk.gray(`   AVG RTG / MAX RTG: average and max author ratings (num_ratings) among the authors ADDED that period (not cumulative)`));
const missing = Number((db.prepare('SELECT COUNT(*) AS c FROM authors WHERE first_seen IS NULL OR first_seen = \'\'').get()).c);
if (missing > 0) {
  console.log(chalk.gray(`   First-seen unknown for ${formatNum(missing)} authors — excluded from the totals above`));
}
})().catch(err => {
  console.error('authorHist failed:', err);
  process.exit(1);
});
EOF
