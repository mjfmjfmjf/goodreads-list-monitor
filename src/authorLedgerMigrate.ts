import { DB_PATH } from './db.ts';
import { AUTHOR_FAIL_LIMIT } from './storage.ts';
import Database from 'better-sqlite3';

export interface AuthorLedgerMigrateOptions {
  apply?: boolean;
  dbPath?: string;
}

export interface AuthorLedgerMigrateResult {
  applied: boolean;
  hadLegacyColumns: boolean;
  authorsRows: number;
  authorsWithLegacyStrikes: number;
  /** How many never-crawled authors the legacy count keeps out of the crawl queue. */
  wouldBeBlockedIfImported: number;
  maxLegacyFailCount: number;
  /** Ledger rows ADDED by the merge (existing rows are updated in place, not counted). */
  mergedLegacyStrikes: number;
  ledgerRowsBefore: number;
  ledgerRowsAfter: number;
  droppedColumns: string[];
  columnsAfter: string[];
}

// §4 of PLAN-author-completion.md: `author_scrape_failures` becomes the single
// strike ledger and `authors.fail_count` / `authors.last_error` go away.
//
// The legacy `authors.fail_count` IS merged into the ledger, taking MAX so a
// strike recorded in either place survives. Dropping it was a mistake: the two
// ledgers barely overlap (live DB 569 ids legacy-only, 721 ledger-only) because
// the legacy counter was written by years of past crawls. Filtering candidates on
// the ledger alone silently re-admitted every author the legacy counter had
// already retired at the threshold — 519 never-crawled authors — and a
// `--sortBy topRatings` queue GREW (235,645 -> 235,907) instead of shrinking.
// 503 legacy rows sit at exactly 5 (the old cap), which is a retired author, not
// a suspicious number.
//
// MAX is the right merge because a legacy 5 means "exhausted" and must keep
// excluding the author; a legacy 1-4 merges conservatively below the threshold.
//
// `page_gone` is in the drop list because it belonged to the same broken scheme
// and was reverted: routing dead pages (400/404/410) to it recorded NO strike, so
// those authors were never filtered out of the queue and re-404'd on every run
// forever. Dead pages count strikes again, which is what drops them out. The
// column is inert now; this just finishes the cleanup.
const LEGACY_COLUMNS = ['fail_count', 'last_error', 'page_gone'] as const;

export function authorColumns(db: Database.Database): string[] {
  return (db.prepare('PRAGMA table_info(authors)').all() as { name: string }[]).map((c) => c.name);
}

export function ledgerMigrate(db: Database.Database, opts: AuthorLedgerMigrateOptions = {}): AuthorLedgerMigrateResult {
  const apply = !!opts.apply;
  const columnsBefore = authorColumns(db);
  const hadLegacyColumns = LEGACY_COLUMNS.some((c) => columnsBefore.includes(c));

  const authorsRows = (db.prepare('SELECT COUNT(*) AS c FROM authors').get() as any).c as number;
  const ledgerRows = () =>
    (db.prepare('SELECT COUNT(*) AS c FROM author_scrape_failures').get() as any).c as number;

  let authorsWithLegacyStrikes = 0;
  let wouldBeBlockedIfImported = 0;
  let maxLegacyFailCount = 0;
  let mergedLegacyStrikes = 0;
  if (hadLegacyColumns) {
    const stats = db
      .prepare(
        `SELECT
           SUM(CASE WHEN fail_count > 0 THEN 1 ELSE 0 END) AS withStrikes,
           SUM(CASE WHEN fail_count >= @limit THEN 1 ELSE 0 END) AS wouldBlock,
           COALESCE(MAX(fail_count), 0) AS maxFail
         FROM authors`,
      )
      .get({ limit: AUTHOR_FAIL_LIMIT }) as { withStrikes: number | null; wouldBlock: number | null; maxFail: number };
    authorsWithLegacyStrikes = stats?.withStrikes ?? 0;
    wouldBeBlockedIfImported = stats?.wouldBlock ?? 0;
    maxLegacyFailCount = stats?.maxFail ?? 0;
  }

  const ledgerRowsBefore = ledgerRows();

  if (!apply) {
    // Report what the merge WOULD add: legacy-struck authors the ledger has never
    // heard of. Rows already in the ledger are updated in place by the MAX merge
    // and are correctly not counted as new.
    let wouldAdd = 0;
    if (hadLegacyColumns && columnsBefore.includes('fail_count')) {
      wouldAdd = (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM authors a
             WHERE a.fail_count > 0
               AND NOT EXISTS (SELECT 1 FROM author_scrape_failures f WHERE f.author_id = a.id)`,
          )
          .get() as any
      ).c as number;
    }
    return {
      applied: false,
      hadLegacyColumns,
      authorsRows,
      authorsWithLegacyStrikes,
      wouldBeBlockedIfImported,
      maxLegacyFailCount,
      mergedLegacyStrikes: wouldAdd,
      ledgerRowsBefore,
      ledgerRowsAfter: ledgerRowsBefore,
      droppedColumns: hadLegacyColumns ? [...LEGACY_COLUMNS] : [],
      columnsAfter: columnsBefore,
    };
  }

  // Merge the legacy strikes into the ledger, then drop the legacy columns, in
  // one transaction so the merge can never half-apply. Run with no crawler
  // active: a process still on the old code shape would keep writing the dropped
  // columns, and its strikes would land nowhere after the drop.
  const tx = db.transaction(() => {
    if (hadLegacyColumns && columnsBefore.includes('fail_count')) {
      // MAX merge. first_seen/last_seen are filled only for rows the ledger
      // does not already have, so an existing strike history keeps its stamps.
      db.prepare(`
        INSERT INTO author_scrape_failures (author_id, fail_count, last_error, first_seen, last_seen)
        SELECT a.id, a.fail_count, a.last_error, COALESCE(a.last_seen, @now), COALESCE(a.last_seen, @now)
        FROM authors a
        WHERE a.fail_count > 0
        ON CONFLICT(author_id) DO UPDATE SET
          fail_count = MAX(author_scrape_failures.fail_count, excluded.fail_count),
          last_error = COALESCE(excluded.last_error, author_scrape_failures.last_error)
      `).run({ now: new Date().toISOString() });
      mergedLegacyStrikes = (
        db.prepare('SELECT COUNT(*) AS c FROM author_scrape_failures').get() as any
      ).c - ledgerRowsBefore;
    }
    for (const col of LEGACY_COLUMNS) {
      if (!columnsBefore.includes(col)) continue;
      // Drop the index FIRST. ALTER TABLE ... DROP COLUMN removes the column's
      // indexes itself, so a trailing DROP INDEX then fails with "no such column"
      // and rolls the whole transaction back. (Hit live on 2026/10/03 with
      // idx_authors_page_gone.)
      db.exec(`DROP INDEX IF EXISTS idx_authors_${col}`);
      db.exec(`ALTER TABLE authors DROP COLUMN ${col}`);
    }
  });
  tx();

  return {
    applied: true,
    hadLegacyColumns,
    authorsRows,
    authorsWithLegacyStrikes,
    wouldBeBlockedIfImported,
    maxLegacyFailCount,
    mergedLegacyStrikes,
    ledgerRowsBefore,
    ledgerRowsAfter: ledgerRows(),
    droppedColumns: hadLegacyColumns ? [...LEGACY_COLUMNS] : [],
    columnsAfter: authorColumns(db),
  };
}

export function runAuthorLedgerMigrate(opts: AuthorLedgerMigrateOptions = {}): void {
  const target = opts.dbPath ?? DB_PATH;
  const db = new Database(target);
  try {
    const res = ledgerMigrate(db, { apply: opts.apply });

    console.log(`authors rows            : ${res.authorsRows.toLocaleString()}`);
    console.log(`legacy fail_count rows  : ${res.authorsWithLegacyStrikes.toLocaleString()} (max ${res.maxLegacyFailCount})`);
    console.log(`would keep out of crawl : ${res.wouldBeBlockedIfImported.toLocaleString()} never-crawled authors`);
    if (res.applied) {
      console.log(`ledger rows             : ${res.ledgerRowsBefore.toLocaleString()} -> ${res.ledgerRowsAfter.toLocaleString()} (+${res.mergedLegacyStrikes.toLocaleString()} merged from legacy, MAX)`);
    } else {
      console.log(`ledger rows             : ${res.ledgerRowsBefore.toLocaleString()} (unchanged — dry run; +${res.mergedLegacyStrikes.toLocaleString()} would be merged)`);
    }

    if (!res.hadLegacyColumns) {
      console.log('no legacy columns present — already migrated (idempotent no-op)');
      return;
    }
    console.log(`columns to drop         : ${res.droppedColumns.join(', ')}`);

    if (!res.applied) {
      console.log('dry run only; re-run with --apply (crawlers must be stopped)');
      return;
    }
    console.log(`authors columns now     : ${res.columnsAfter.join(', ')}`);
    console.log('migrated — author_scrape_failures is the only strike ledger');
  } finally {
    db.close();
  }
}