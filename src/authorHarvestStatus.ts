import chalk from 'chalk';
import { loadAuthorCache } from './storage.js';
import { getDb } from './db.js';

export interface HarvestBuckets {
  total: number;
  harvested: number;
  never: number;
  fresh1: number;
  fresh2: number;
  fresh7: number;
  fresh30: number;
  stale30: number;
  noTimestamp: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function computeHarvestBuckets(
  entries: { hasStats: boolean; lastSeen?: string }[],
  now: number = Date.now()
): HarvestBuckets {
  const b: HarvestBuckets = { total: entries.length, harvested: 0, never: 0, fresh1: 0, fresh2: 0, fresh7: 0, fresh30: 0, stale30: 0, noTimestamp: 0 };
  for (const e of entries) {
    if (!e.hasStats) {
      b.never++;
      continue;
    }
    b.harvested++;
    if (!e.lastSeen) {
      b.noTimestamp++;
      continue;
    }
    const ageDays = (now - new Date(e.lastSeen).getTime()) / DAY_MS;
    if (!(isFinite(ageDays)) || ageDays < 0) { b.noTimestamp++; continue; }
    if (ageDays < 1) b.fresh1++;
    else if (ageDays < 2) b.fresh2++;
    else if (ageDays < 7) b.fresh7++;
    else if (ageDays < 30) b.fresh30++;
    else b.stale30++;
  }
  return b;
}

function fmtLine(label: string, n: number, total: number): string {
  const pct = total > 0 ? ((n / total) * 100).toFixed(1) : '0.0';
  return `  ${label.padEnd(28, ' ')} : ${chalk.yellow(String(n.toLocaleString()).padStart(8))}  ${chalk.cyan(pct.padStart(5) + '%')}`;
}

export async function runAuthorHarvestStatus(): Promise<void> {
  const authorCache = await loadAuthorCache();
  const buckets = computeHarvestBuckets(
    Object.values(authorCache).map(e => ({ hasStats: !!(e.numRatings || e.averageRating || e.numReviews || e.numShelves), lastSeen: e.lastSeen }))
  );

  console.log(chalk.cyan.bold('\n👤 Author harvest status:\n'));
  console.log(fmtLine('total authors', buckets.total, buckets.total));
  console.log(fmtLine('harvested (has stats)', buckets.harvested, buckets.total));
  console.log(chalk.gray('  freshness of harvested authors (last_seen age):'));
  console.log(fmtLine('  < 1 day ago', buckets.fresh1, buckets.harvested));
  console.log(fmtLine('  1–2 days ago', buckets.fresh2, buckets.harvested));
  console.log(fmtLine('  2–7 days ago', buckets.fresh7, buckets.harvested));
  console.log(fmtLine('  7–30 days ago', buckets.fresh30, buckets.harvested));
  console.log(fmtLine('  > 30 days ago', buckets.stale30, buckets.harvested));
  if (buckets.noTimestamp > 0) console.log(fmtLine('  (no timestamp)', buckets.noTimestamp, buckets.harvested));
  console.log(fmtLine('never harvested', buckets.never, buckets.total));
  if (buckets.never > 0) {
    console.log(chalk.gray(`\n  → harvest them: ./authorRescan.sh --rescanMissing --sortBy numRatings --limit 500`));
  }

  // Preview of never-harvested authors ranked by their best book's ratings
  const db = getDb();
  const rows = db.prepare(`
    SELECT a.name, MAX(CAST(b.ratings AS INTEGER)) AS best, COUNT(*) AS nbooks
    FROM authors a JOIN books b ON b.author_id = a.id
    WHERE COALESCE(a.num_ratings, 0) = 0 AND a.average_rating IS NULL
    GROUP BY a.name ORDER BY best DESC LIMIT 15
  `).all() as { name: string; best: number; nbooks: number }[];

  if (rows.length > 0) {
    console.log(chalk.cyan.bold(`\n🏆 Top never-harvested authors (by best book ratings):\n`));
    let rank = 1;
    for (const r of rows) {
      console.log(`  ${chalk.white.bold(String(rank++).padStart(2))}. ${r.name} ${chalk.gray(`— best book ${r.best.toLocaleString()} ratings · ${r.nbooks} book(s) in cache`)}`);
    }
  }
  console.log();
}
