import chalk from 'chalk';
import { getDb } from './db.ts';
import { withDbLockRetry } from './utils.ts';
import { countBooks } from './storage.ts';
import { parseSeriesPos } from './seriesPos.ts';

// Keyset page size. A chunk is read with .all() so the statement is closed
// before any UPDATE runs — see the loop comment for why a single streaming pass
// can't write. Mirrors authorMint.ts and backfillRatingsStats.ts.
export const CHUNK = 5000;

interface SeriesPosRow {
  id: string;
  title: string | null;
  series_pos: number | null;
}

export async function runBackfillSeriesPos(): Promise<void> {
  const totalBooks = countBooks();
  const db = getDb();
  const select = db.prepare(
    `SELECT id, title, series_pos FROM books WHERE id > ? ORDER BY id LIMIT ?`
  );
  // Update ONLY series_pos: the old code re-read the whole row and wrote it back
  // via upsertBook(), which both threw (see below) and could clobber concurrent
  // writers to other columns. A targeted column update can't.
  const update = db.prepare(`UPDATE books SET series_pos = ? WHERE id = ?`);

  let filled = 0;
  let corrected = 0;
  let cleared = 0;
  let afterId = '';

  // better-sqlite3 cannot .run() while a read iterator on the SAME connection is
  // open ("This database connection is busy executing a query"), so the previous
  // `for (const snap of iterateBooks()) { ... upsertBook(book) }` threw on the
  // first row that actually needed a change (it only appeared to work when every
  // title already matched). Read a bounded chunk with .all() — which fully
  // consumes and closes the statement — write it, then resume after the last id.
  // Keyset (not OFFSET) keeps each chunk an index range scan on the id PK; `''`
  // sorts below every real id so the first chunk needs no special case.
  while (true) {
    const rows = select.all(afterId, CHUNK) as SeriesPosRow[];
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1].id;

    for (const row of rows) {
      if (!row.title || row.title === 'Unknown') continue;

      const parsed = parseSeriesPos(row.title);
      const existing = row.series_pos ?? undefined;
      if (parsed === existing) continue;

      if (parsed === undefined) {
        if (existing !== undefined) cleared++;
      } else if (existing === undefined) {
        filled++;
      } else {
        corrected++;
      }
      withDbLockRetry(() => update.run(parsed === undefined ? null : parsed, row.id));
    }
  }

  console.log(chalk.cyan.bold(`\n🔄 Series Position Backfill Complete: ${totalBooks.toLocaleString()} books in DB`));
  console.log(chalk.gray('----------------------------------------------------------------------'));
  console.log(`   Filled: ${chalk.yellow(filled)} books (parseable position now stored)`);
  console.log(`   Corrected: ${chalk.yellow(corrected)} books (stale value replaced with fresh parse)`);
  console.log(`   Cleared: ${chalk.yellow(cleared)} books (stale value removed, title now parses to standalone)`);
  console.log(chalk.gray('   Books with Unknown titles were left untouched.'));
  console.log(chalk.gray('----------------------------------------------------------------------'));
}
