import Database from 'better-sqlite3';
import { DB_PATH } from './db.ts';

// Author re-key migration: collapse the (rare) same-id name-variant rows left
// by the old `name TEXT PRIMARY KEY` schema into one id-keyed row, and backfill
// the `author_slugs` history ledger. Pure merge logic lives here; the DB swap
// takes an already-open better-sqlite3 handle so it can run without loading the
// app's storage layer.

export interface AuthorRow {
  id: string;
  name: string | null;
  slug: string | null;
  last_seen: string;
  first_seen?: string | null;
  average_rating?: number | null;
  num_ratings?: number | null;
  num_reviews?: number | null;
  num_shelves?: number | null;
  catalog_pages?: number | null;
  ratings_rate?: number | null;
}

export interface MergedAuthor {
  id: string;
  name: string | null;
  slug: string | null;
  last_seen: string;
  first_seen: string | null;
  average_rating: number | null;
  num_ratings: number;
  num_reviews: number;
  num_shelves: number;
  catalog_pages: number | null;
  ratings_rate: number | null;
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? '').replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
};

const norm = (s?: string | null): string => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

// The slug suffix Goodreads derives from the display name: "721.John_Grisham"
// -> "John Grisham".
const slugSuffix = (slug: string): string =>
  slug.split('.').slice(1).join('.').replace(/_/g, ' ');

// Collapse every row sharing an author id into one canonical row.
//   • canonical slug  = latest-seen row's slug (every slug is kept in
//     `author_slugs`); tie-break by ratings.
//   • canonical name  = the stored name whose whitespace-normalized form equals
//     the canonical slug suffix (so "John Green" beats "John  Green"), else the
//     max-ratings row's name.
//   • counts          = field-wise MAX (statless mint rows are 0).
//   • avg/rate        = from the max-ratings row.
//   • first_seen      = MIN; last_seen = MAX.
export function mergeAuthorRows(rows: AuthorRow[]): MergedAuthor {
  if (rows.length === 0) throw new Error('mergeAuthorRows requires at least one row');

  const byRatingsThenSeen = (a: AuthorRow, b: AuthorRow): number => {
    const r = num(b.num_ratings) - num(a.num_ratings);
    if (r !== 0) return r;
    return (b.last_seen ?? '').localeCompare(a.last_seen ?? '');
  };
  const maxRatingsRow = rows.slice().sort(byRatingsThenSeen)[0];
  const latestSeenRow = rows
    .slice()
    .sort((a, b) => (b.last_seen ?? '').localeCompare(a.last_seen ?? '') || num(b.num_ratings) - num(a.num_ratings))[0];

  const canonicalSlug = latestSeenRow.slug || maxRatingsRow.slug || rows.find((r) => r.slug)?.slug || null;

  let canonicalName: string | null = null;
  if (canonicalSlug) {
    const suffix = norm(slugSuffix(canonicalSlug));
    const match = rows
      .filter((r) => r.name && norm(r.name) === suffix)
      .sort(byRatingsThenSeen)[0];
    if (match) canonicalName = match.name;
  }
  if (!canonicalName) canonicalName = maxRatingsRow.name ?? rows.find((r) => r.name)?.name ?? null;

  const maxField = (f: keyof AuthorRow): number => rows.reduce((m, r) => Math.max(m, num(r[f])), 0);
  const firstSeens = rows.map((r) => r.first_seen).filter((s): s is string => !!s);

  return {
    id: rows[0].id,
    name: canonicalName,
    slug: canonicalSlug,
    last_seen: rows.reduce((m, r) => ((r.last_seen ?? '') > m ? r.last_seen : m), rows[0].last_seen),
    first_seen: firstSeens.length ? firstSeens.reduce((m, s) => (s < m ? s : m)) : null,
    average_rating: maxRatingsRow.average_rating ?? null,
    num_ratings: maxField('num_ratings'),
    num_reviews: maxField('num_reviews'),
    num_shelves: maxField('num_shelves'),
    catalog_pages: rows.some((r) => r.catalog_pages != null) ? maxField('catalog_pages') : null,
    ratings_rate: maxRatingsRow.ratings_rate ?? null,
  };
}

const AUTHORS_NEW_DDL = `
  CREATE TABLE authors_new (
    id TEXT PRIMARY KEY,
    name TEXT,
    slug TEXT,
    last_seen TEXT NOT NULL,
    average_rating REAL,
    num_ratings INTEGER DEFAULT 0,
    num_reviews INTEGER DEFAULT 0,
    num_shelves INTEGER DEFAULT 0,
    first_seen TEXT,
    catalog_pages INTEGER,
    ratings_rate REAL
  );
`;

const INSERT_NEW = `
  INSERT INTO authors_new
    (id, name, slug, last_seen, average_rating, num_ratings, num_reviews, num_shelves, first_seen, catalog_pages, ratings_rate)
  VALUES
    (@id, @name, @slug, @last_seen, @average_rating, @num_ratings, @num_reviews, @num_shelves, @first_seen, @catalog_pages, @ratings_rate)
`;

// Backfill author_slugs from the pre-collapse rows: one entry per (id, slug),
// earliest first_seen / latest last_seen, name from the most recent sighting.
// One window-function pass — a correlated name lookup would full-scan per group.
const BACKFILL_SLUGS = `
  INSERT INTO author_slugs (author_id, slug, name, first_seen, last_seen)
  SELECT author_id, slug, name, first_seen, last_seen FROM (
    SELECT
      id AS author_id,
      slug,
      name,
      ROW_NUMBER() OVER (PARTITION BY id, slug ORDER BY last_seen DESC) AS rn,
      MIN(COALESCE(first_seen, last_seen)) OVER (PARTITION BY id, slug) AS first_seen,
      MAX(last_seen) OVER (PARTITION BY id, slug) AS last_seen
    FROM authors
    WHERE slug IS NOT NULL AND slug != ''
  )
  WHERE rn = 1
  ON CONFLICT(author_id, slug) DO UPDATE SET
    first_seen = MIN(author_slugs.first_seen, excluded.first_seen),
    last_seen  = MAX(author_slugs.last_seen, excluded.last_seen),
    name       = COALESCE(excluded.name, author_slugs.name)
`;

export interface RekeyResult {
  groups: number;
  collapsedRows: number;
  multiRowGroups: number;
  applied: boolean;
  sample: MergedAuthor[];
}

// Dry run by default. With `apply`, performs the swap in one transaction:
// build authors_new, backfill author_slugs, drop the old indexes, rename
// authors -> authors_old_<stamp>, authors_new -> authors, recreate the stats
// indexes. The old table is kept as the rollback.
export function rekeyAuthors(
  db: Database.Database,
  opts: { apply?: boolean; dateStamp?: string } = {},
): RekeyResult {
  const rows = db.prepare('SELECT * FROM authors').all() as AuthorRow[];
  const groups = new Map<string, AuthorRow[]>();
  for (const r of rows) {
    const g = groups.get(r.id);
    if (g) g.push(r);
    else groups.set(r.id, [r]);
  }
  const grouped = [...groups.values()];
  const merged = grouped.map(mergeAuthorRows);
  const multiRowGroups = grouped.filter((g) => g.length > 1).length;
  const result: RekeyResult = {
    groups: groups.size,
    collapsedRows: rows.length - merged.length,
    multiRowGroups,
    applied: false,
    sample: merged.filter((_, i) => grouped[i].length > 1).slice(0, 20),
  };

  if (!opts.apply) return result;

  const stamp = opts.dateStamp ?? new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const oldTable = `authors_old_${stamp}`;
  const already = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'authors_old_%'")
    .all() as { name: string }[];
  if (already.length) {
    throw new Error(
      `refusing to re-key: a rollback table already exists (${already.map((t) => t.name).join(', ')}) — drop it or restore it first`,
    );
  }

  const tx = db.transaction(() => {
    db.exec(AUTHORS_NEW_DDL);
    const ins = db.prepare(INSERT_NEW);
    for (const m of merged) ins.run(m);
    db.exec(BACKFILL_SLUGS);

    // Index names are DB-global: free them before the rename so the recreates
    // on the new table don't collide (idx_authors_id is already gone).
    db.exec('DROP INDEX IF EXISTS idx_authors_num_ratings');
    db.exec('DROP INDEX IF EXISTS idx_authors_num_shelves');
    db.exec('DROP INDEX IF EXISTS idx_authors_id');
    db.exec(`ALTER TABLE authors RENAME TO ${oldTable}`);
    db.exec('ALTER TABLE authors_new RENAME TO authors');
    db.exec('CREATE INDEX IF NOT EXISTS idx_authors_num_ratings ON authors(num_ratings DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_authors_num_shelves ON authors(num_shelves DESC)');
  });
  tx();

  return { ...result, applied: true };
}

// CLI entry. Opens the DB raw (bypassing the id-PK startup guard in db.ts) so it
// can migrate a pre-rekey file. Dry run by default.
export function runAuthorRekey(opts: { apply?: boolean; dbPath?: string } = {}): void {
  const target = opts.dbPath ?? DB_PATH;
  const db = new Database(target);
  try {
    const res = rekeyAuthors(db, { apply: opts.apply });
    const action = res.applied ? 're-keyed' : 'dry run';
    console.log(
      `${action}: ${res.groups.toLocaleString()} ids, ${res.multiRowGroups.toLocaleString()} multi-row groups, ` +
        `${res.collapsedRows.toLocaleString()} rows collapsed`,
    );
    if (res.sample.length) {
      console.log('sample collapses:');
      for (const m of res.sample) {
        console.log(`  ${m.id}  name="${m.name}" slug="${m.slug}" ratings=${m.num_ratings}`);
      }
    }
    if (res.applied) {
      console.log('done — old table kept as authors_old_<stamp> for rollback');
    } else {
      console.log('dry run only; re-run with --apply to migrate (make a manual DB copy first)');
    }
  } finally {
    db.close();
  }
}
