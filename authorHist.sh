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
let where = 'first_seen IS NOT NULL';
const params = {};
if (from) { where += ' AND first_seen >= @from'; params.from = from; }
if (to)   { where += ' AND first_seen < date(@to, \'1 day\')'; params.to = to; }

const fmt = bucket === 'day' ? "%Y-%m-%d" : "%Y-%m-%d %H:00";
const label = bucket === 'day' ? 'day' : 'hour';

const rows = db.prepare(`
  SELECT strftime('${fmt}', first_seen) AS bucket, COUNT(*) AS c
  FROM authors WHERE ${where}
  GROUP BY bucket ORDER BY bucket
`).all(params);

const total = rows.reduce((s, r) => s + r.c, 0);
const width = 60;
const max = Math.max(...rows.map(r => r.c));
const range = from ? (to ? `${from}..${to}` : `${from}..`) : 'all rows';
console.log(`new authors per ${label} (${range}) — total ${total.toLocaleString()}:`);
for (const r of rows) {
  const bar = '#'.repeat(Math.round((r.c / max) * width));
  console.log(String(r.bucket).padEnd(17) + ' ' + String(r.c).padStart(6) + ' ' + bar);
}
EOF
