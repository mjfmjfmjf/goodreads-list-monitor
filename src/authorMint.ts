import chalk from 'chalk';
import { getDb } from './db.ts';
import { streamRows, countAuthors } from './storage.ts';
import { withDbLockRetry } from './utils.ts';
import { looksLikeNameConcat } from './authorOrphans.ts';

// Offline backfill-mint (PLAN-author-id-first.md Phase 1 /
// PLAN-author-completion.md §2): create an `authors` row for every distinct
// `books.author_id` that has none, so that after this every book-referenced id
// resolves in the author table.
//
// Why it exists: before it, ~371k book-referenced author ids had no `authors`
// row at all. Those ids were only ever created as a side effect of crawling
// their author page, so the only thing that could host them was
// `author-orphans --scrape` — a *network* crawl at ~2s per author, i.e. ~8 days
// to mint what one offline pass does in seconds. It also had a coverage hole:
// `authorOrphans` skips a book whose *name string* is already a cache key, so
// the ~8,071 name→2+id collision families hid their secondary ids in both
// sweeps. Minting by id has no such hole.
//
// Minted rows are deliberately bare: `{id, name}` with `slug` NULL. The first
// successful author-page scrape fills in the canonical slug + name and writes
// the `author_slugs` ledger row. Nothing reads the slug before then (see B1:
// callers pass `authorScrapeRef(slug, id)`).

// Chunked keyset pagination over the same set. better-sqlite3 cannot execute a
// write while a read iterator on the same connection is still open ("This
// database connection is busy executing a query"), so the single streaming pass
// can only ever be a dry run. Instead we read a chunk with .all() — which fully
// consumes and closes the statement — write those rows, then resume after the
// last id.
//
// Keyset (not OFFSET) so each chunk resumes at an index position instead of
// re-scanning and skipping: `idx_books_author_pub (author_id, ratings DESC, published)` makes
// the WHERE + GROUP BY + ORDER BY + LIMIT an index range scan. `''` sorts below
// every real id, so the first chunk needs no special case.
const UNHOSTED_CHUNK_SQL = `
  SELECT author_id AS id,
         (SELECT b.author FROM books b
           WHERE b.author_id = books.author_id
           ORDER BY b.ratings DESC LIMIT 1) AS name,
         MIN(first_seen) AS first_seen,
         MAX(last_updated) AS last_updated
  FROM books
  WHERE author_id IS NOT NULL AND author_id > @afterId
  GROUP BY author_id
  HAVING NOT EXISTS (SELECT 1 FROM authors a WHERE a.id = author_id)
  ORDER BY author_id
  LIMIT @limit
`;

// Each read chunk finds every unhosted id AND picks its display name:
//
//   * GROUP BY author_id collapses ~11.6M book rows to one row per author.
//   * The display name is an explicit correlated subquery for the author's
//     highest-rated book, not a bare column. A bare `author` column beside
//     min()/max() aggregates is only defined for ONE aggregate — SQLite's rule
//     says the bare value comes from "the input row which also contains the min
//     or max", and with two aggregates (MIN(first_seen) and MAX(last_updated))
//     which one wins is unspecified. Before the timestamps were added there was
//     no aggregate at all, so the bare column silently depended on index scan
//     order. Selecting it explicitly makes the choice deliberate.
//   * first_seen / last_seen come from the books that reference the author, so a
//     minted row records when we actually first learned the id exists rather
//     than the moment of the mint. `books.first_seen` is the oldest book sighting
//     and `books.last_updated` the newest, so this is the true observation
//     window. Both fall back to the mint time when every book row is NULL.
//   * The anti-join is in SQL (NOT EXISTS against the authors PK), so nothing
//     book-scale is ever materialized in JS, and LIMIT still bounds the scan so
//     keyset pagination keeps its early-exit.
const CHUNK = 5000;

// Cheap standalone count for the same set — used by the command header and by
// field-coverage so the "Goal A backlog" is a first-class reported number.
export function countUnhostedAuthorIds(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM (
                SELECT DISTINCT author_id FROM books
                WHERE author_id IS NOT NULL AND author_id <> ''
              ) b
              WHERE NOT EXISTS (SELECT 1 FROM authors a WHERE a.id = b.author_id)`)
    .get() as { c: number };
  return row?.c ?? 0;
}

// A book author string we refuse to store as a display name.
//
// The interesting case is Goodreads multi-author pages, where our scraper stores
// every credited author run together with NO separator — "Barbara
// SanfilippoRudy Ruettiger", "Terrie SmithMichele LightShane Fisher". That is not
// one person's name, and it is the *majority* of the unhosted ids because
// multi-author books are common and a co-author rarely gets their own crawl.
// `looksLikeNameConcat` is the repo's existing detector (authorOrphans.ts).
//
// Minting NULL is the honest outcome: the name stays empty until the author page
// is scraped, and that scrape writes the canonical name. Minting the run-together
// string instead would look like a real name to every name-keyed consumer
// (author-orphans --inspect, CSV export) and could survive uncorrected.
function usableName(raw: unknown): string | null {
  const name = String(raw ?? '').trim();
  if (!name) return null;
  const lower = name.toLowerCase();
  if (lower === 'unknown author' || lower === 'unknown' || lower === 'n/a') return null;
  if (looksLikeNameConcat(name)) return null;
  return name;
}

export interface AuthorMintResult {
  scanned: number;
  inserted: number;
  // How many of the scanned ids had a book author string usable as a display
  // name, vs. none. Worth reporting: it is the answer to "will these rows look
  // sane before they are scraped", and it quantifies the multi-author
  // run-together problem in the books table.
  named: number;
  sample: { id: string; name: string | null }[];
  applied: boolean;
}

// Single-statement upsert, one per new id: no db.transaction (the WAL writer
// lock is held for exactly one statement at a time), idempotent via ON CONFLICT
// DO NOTHING, so an aborted run is safe to replay.
const MINT_SQL = `
  INSERT INTO authors (id, name, slug, last_seen, first_seen)
  VALUES (@id, @name, NULL, @lastSeen, @firstSeen)
  ON CONFLICT(id) DO NOTHING
`;

export function runAuthorMint(
  opts: { apply?: boolean; sampleSize?: number; logEvery?: number } = {}
): AuthorMintResult {
  const sampleSize = opts.sampleSize ?? 10;
  const logEvery = opts.logEvery ?? 25000;
  const result: AuthorMintResult = { scanned: 0, inserted: 0, named: 0, sample: [], applied: !!opts.apply };

  const insert = getDb().prepare(MINT_SQL);
  const chunkStmt = getDb().prepare(UNHOSTED_CHUNK_SQL);
  let afterId = '';

  for (;;) {
    const chunk = chunkStmt.all({ afterId, limit: CHUNK }) as { id: string; name: string | null; first_seen: string | null; last_updated: string | null }[];
    if (!chunk.length) break;
    const now = new Date().toISOString();
    for (const row of chunk) {
      result.scanned++;
      const name = usableName(row.name);
      if (name !== null) result.named++;
      if (result.sample.length < sampleSize) result.sample.push({ id: row.id, name });
      if (!opts.apply) continue;
      // Observation window from the books table; the mint time is only a
      // fallback for an author whose book rows are all NULL on both stamps.
      const firstSeen = row.first_seen || now;
      const lastSeen = row.last_updated || firstSeen;
      withDbLockRetry(() => insert.run({ id: row.id, name, firstSeen, lastSeen }));
      result.inserted++;
      if (result.inserted % logEvery === 0) {
        console.log(
          chalk.gray(`   … minted ${result.inserted.toLocaleString()} of ${result.scanned.toLocaleString()} scanned`)
        );
      }
    }
    afterId = chunk[chunk.length - 1].id;
    if (!opts.apply) break; // dry run: one chunk is representative, no need to scan 11.6M rows
  }
  return result;
}

export function reportAuthorMint(result: AuthorMintResult): void {
  const before = countUnhostedAuthorIds();
  console.log(chalk.cyan.bold(`\n👤 Author Mint: book-referenced author ids with no authors row`));
  console.log(chalk.gray(`   ${result.scanned.toLocaleString()} id(s) to mint · authors table now ${countAuthors().toLocaleString()} rows`));
  const unnamed = result.scanned - result.named;
  console.log(
    chalk.gray(
      `   ${result.named.toLocaleString()} have a usable book author string; ${unnamed.toLocaleString()} mint with name NULL\n` +
        `   (a NULL name is a multi-author run-together string like "Terrie SmithMichele Light", or "Unknown" — the first\n` +
        `   author-page scrape writes the canonical name and slug. Filling those now would look real and be wrong.)`
    )
  );
  if (result.sample.length) {
    console.log(chalk.gray('   sample (slug stays NULL until the first author-page scrape):'));
    for (const s of result.sample) console.log(`      ${s.id}  ${s.name ?? chalk.gray('(no usable name in books)')}`);
  }
  if (!result.applied) {
    console.log(chalk.yellow(`\n   Dry run — nothing written. Re-run with --apply to mint ${result.scanned.toLocaleString()} row(s).`));
    console.log(chalk.gray(`   Still unhosted after this dry run: ${before.toLocaleString()}\n`));
    return;
  }
  console.log(chalk.green.bold(`\n   ✅ Minted ${result.inserted.toLocaleString()} author row(s)`));
  console.log(chalk.gray(`   Unhosted book author ids remaining: ${before.toLocaleString()}`));
  console.log(
    chalk.gray(
      `   These rows have no stats and no slug yet — they are candidates for\n` +
      `   author-rescan --multiPage --onlyUntouched --sortBy topRatings --minRatings 0\n`
    )
  );
}