import chalk from 'chalk';
import { getDb } from './db.ts';
import { withDbLockRetry } from './utils.ts';
import { ratingsStatsColumns, RatingsStatsColumns } from './ratingsStats.ts';

// Offline backfill: recompute the derived ratings statistics columns on
// book_page from each row's stored ratings_dist JSON. Rows without a
// distribution are left untouched. This is the one-time catch-up for rows that
// were written before the derived columns existed (and for any rows written by
// an importer/older binary); the live write paths recompute on every scrape.
interface BookPageRatingsRow extends RatingsStatsColumns {
  book_id: string;
  ratings_dist: string | null;
}

const DERIVED_COLUMNS = [
  'ratings_mean', 'ratings_median', 'ratings_mode', 'ratings_variance',
  'ratings_stddev', 'ratings_skewness', 'ratings_kurtosis', 'ratings_total',
] as const;

const PROGRESS_EVERY = 25_000;

// Keyset page size. Each chunk is read with .all() (fully consumed, statement
// closed) before any UPDATE runs, so peak memory is O(CHUNK) rather than the
// whole table. See the loop comment for why a single streaming pass can't write.
export const CHUNK = 5000;

function sameColumns(existing: RatingsStatsColumns, next: RatingsStatsColumns): boolean {
  for (const key of DERIVED_COLUMNS) {
    if (existing[key] !== next[key]) return false;
  }
  return true;
}

export async function runBackfillRatingsStats(): Promise<void> {
  const started = Date.now();
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) AS n FROM book_page').get() as { n: number }).n;
  const select = db.prepare(`
    SELECT book_id, ratings_dist, ratings_mean, ratings_median, ratings_mode,
           ratings_variance, ratings_stddev, ratings_skewness, ratings_kurtosis, ratings_total
    FROM book_page
    WHERE book_id > ?
    ORDER BY book_id
    LIMIT ?
  `);
  const update = db.prepare(`
    UPDATE book_page SET
      ratings_mean=@ratings_mean, ratings_median=@ratings_median, ratings_mode=@ratings_mode,
      ratings_variance=@ratings_variance, ratings_stddev=@ratings_stddev,
      ratings_skewness=@ratings_skewness, ratings_kurtosis=@ratings_kurtosis,
      ratings_total=@ratings_total
    WHERE book_id=@book_id
  `);

  let scanned = 0;
  let updated = 0;
  let unchanged = 0;
  let noDistribution = 0;
  let afterId = '';

  // better-sqlite3 cannot run a write while a read iterator on the SAME
  // connection is still open ("This database connection is busy executing a
  // query"), so stream+UPDATE in one pass is impossible — and materializing the
  // whole table just to dodge that is worse (this is exactly the loadBookCache
  // anti-pattern AGENTS.md removed). Instead read a bounded chunk with .all()
  // (which fully consumes and closes the statement), write those rows, then
  // resume after the last book_id. Keyset (not OFFSET) keeps each chunk an
  // index range scan on the book_id PK; `''` sorts below every real id so the
  // first chunk needs no special case. Mirrors authorMint.ts.
  while (true) {
    const rows = select.all(afterId, CHUNK) as BookPageRatingsRow[];
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1].book_id;

    for (const row of rows) {
      scanned++;
      if (scanned % PROGRESS_EVERY === 0) {
        console.log(chalk.gray(`   … scanned ${scanned.toLocaleString('en-US')} / ${total.toLocaleString('en-US')} (${updated.toLocaleString('en-US')} updated)`));
      }

      if (!row.ratings_dist) {
        noDistribution++;
        continue;
      }

      const next = ratingsStatsColumns(row.ratings_dist);
      if (sameColumns(row, next)) {
        unchanged++;
        continue;
      }

      withDbLockRetry(() => update.run({ book_id: row.book_id, ...next }));
      updated++;
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(chalk.cyan.bold(`\n🔄 Ratings Stats Backfill Complete: ${scanned.toLocaleString('en-US')} book_page rows in ${elapsed}s`));
  console.log(chalk.gray('----------------------------------------------------------------------'));
  console.log(`   Updated: ${chalk.yellow(updated.toLocaleString('en-US'))} rows (derived columns recomputed from ratings_dist)`);
  console.log(`   Unchanged: ${chalk.gray(unchanged.toLocaleString('en-US'))} rows (already accurate)`);
  console.log(`   Skipped: ${chalk.gray(noDistribution.toLocaleString('en-US'))} rows (no ratings_dist stored)`);
  console.log(chalk.gray('----------------------------------------------------------------------'));
}
