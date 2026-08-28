import { createGunzip } from 'node:zlib';
import { createReadStream, openSync, readSync, closeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import chalk from 'chalk';

// Importer for the sanitized CSV+gzip exports produced by exportData.
// Policy (per existing merge conventions in storage.ts):
//   - For an existing book/author (matched by id / name), fill-blank-only per
//     field: only adopt the imported value when the DB value is currently
//     blank/bad ('' / 'Unknown' / 0 / null). Never overwrite a good value.
//   - Genres: UNION — merge distinct imported genres into the existing set
//     (adopt all imported genres when the DB has none).
// No network; reads the gz files and writes to the local DB in a transaction.

const BLANK_SENTINELS = new Set(['unknown', 'null', 'unknown author', 'n/a']);
const isBlank = (s?: string | null) => !s || !s.trim() || BLANK_SENTINELS.has(s.trim().toLowerCase());

function toInt(v: unknown): number | null {
  if (v == null || String(v).trim() === '') return null;
  const n = parseInt(String(v).replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}
function toFloat(v: unknown): number | null {
  if (v == null || String(v).trim() === '') return null;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

// Parse a possibly-JSON-encoded column (genres array / tags object). Returns the
// parsed value, or undefined when the field is empty/blank.
function parseJsonField(v: unknown): string[] | Record<string, unknown> | undefined {
  if (v == null || isBlank(String(v))) return undefined;
  const s = String(v).trim();
  if (s.startsWith('[') || s.startsWith('{')) {
    try { return JSON.parse(s); } catch { return undefined; }
  }
  return undefined;
}

// ── Pure, testable CSV decoding ─────────────────────────────────────
export interface ImportRow {
  headers: string[];
  values: (string | null)[];
}

// True when the file begins with the gzip magic bytes (1f 8b).
function isGzip(file: string): boolean {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(2);
    readSync(fd, buf, 0, 2, 0);
    return buf[0] === 0x1f && buf[1] === 0x8b;
  } finally {
    closeSync(fd);
  }
}

// Open a CSV source (plain .csv or .csv.gz), automatically decompressing when
// the content is gzipped so callers don't need to care about the wrapping.
export function openCsvStream(file: string): NodeJS.ReadableStream {
  const raw = createReadStream(file);
  return isGzip(file) ? raw.pipe(createGunzip()) : raw;
}

// Streaming line-parsed CSV (plain or gzipped) using RFC4180 quoting.
export async function readCsvGz(file: string, onRow: (headers: string[], fields: (string | null)[]) => void): Promise<number> {
  const rl = createInterface({ input: openCsvStream(file), crlfDelay: Infinity });

  let headers: string[] | null = null;
  let rowCount = 0;
  for await (const line of rl) {
    const fields = splitCsvLine(line);
    if (!headers) {
      headers = fields.map(f => f ?? '');
      continue;
    }
    onRow(headers, fields);
    rowCount++;
  }
  return rowCount;
}

// RFC4180 field splitter (handles quoted fields, embedded commas, doubled quotes).
export function splitCsvLine(line: string): (string | null)[] {
  const out: (string | null)[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ',') {
      out.push(cur.length ? cur : '');
      cur = '';
    } else cur += ch;
  }
  out.push(cur.length ? cur : '');
  return out.map(s => (s === '' ? null : s));
}

// Merge two tag maps key-wise. Tags are currently a flat {tagName: number} map
// but are planned to become a multi-field structure going forward, so we merge
// defensively: union the keys, keeping the existing value per key unless the
// incoming provides a strictly better value. Non-object shapes are adopted
// wholesale only when the existing tag map is empty.
export function mergeTags(existing: Record<string, unknown> | undefined, inc: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const e = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : undefined;
  const inc2 = inc && typeof inc === 'object' && !Array.isArray(inc) ? inc : undefined;
  if (!inc2) return e;
  if (!e) return inc2;
  const out = { ...e };
  for (const [k, v] of Object.entries(inc2)) {
    if (out[k] === undefined) out[k] = v;
    else if (typeof v === 'number' && typeof out[k] === 'number') out[k] = Math.max(out[k] as number, v);
    else if (v && typeof v === 'object' && out[k] && typeof out[k] === 'object') out[k] = { ...(out[k] as object), ...(v as object) };
  }
  return out;
}

export interface BookImportRow {
  id: string;
  title?: string;
  author?: string;
  authorId?: string;
  ratings?: number | null;
  avgRating?: number | null;
  published?: string;
  pages?: number | null;
  seriesPos?: number | null;
  genres?: string[];
  tags?: Record<string, unknown>;
  workId?: string;
  isBad?: number | null;
}

export function decodeBookRow(headers: string[], fields: (string | null)[]): BookImportRow | null {
  const get = (name: string) => {
    const ix = headers.indexOf(name);
    return ix >= 0 ? fields[ix] : null;
  };
  const id = get('id');
  if (!id) return null;
  return {
    id,
    title: get('title') ?? undefined,
    author: get('author') ?? undefined,
    authorId: get('author_id') ?? undefined,
    ratings: toInt(get('ratings')),
    avgRating: toFloat(get('avg_rating')),
    published: get('published') ?? undefined,
    pages: toInt(get('pages')),
    seriesPos: toFloat(get('series_pos')),
    genres: parseJsonField(get('genres')) as string[] | undefined,
    tags: parseJsonField(get('tags')) as Record<string, unknown> | undefined,
    workId: get('work_id') ?? undefined,
    isBad: toInt(get('is_bad')),
  };
}

export interface AuthorImportRow {
  name: string;
  id?: string;
  slug?: string;
  lastSeen?: string;
  averageRating?: number | null;
  numRatings?: number | null;
  numReviews?: number | null;
  numShelves?: number | null;
  catalogPages?: number | null;
  lastError?: string;
}

export function decodeAuthorRow(headers: string[], fields: (string | null)[]): AuthorImportRow | null {
  const get = (name: string) => {
    const ix = headers.indexOf(name);
    return ix >= 0 ? fields[ix] : null;
  };
  const name = get('name');
  if (!name) return null;
  return {
    name,
    id: get('id') ?? undefined,
    slug: get('slug') ?? undefined,
    lastSeen: get('last_seen') ?? undefined,
    averageRating: toFloat(get('average_rating')),
    numRatings: toInt(get('num_ratings')),
    numReviews: toInt(get('num_reviews')),
    numShelves: toInt(get('num_shelves')),
    catalogPages: toInt(get('catalog_pages')),
    lastError: get('last_error') ?? undefined,
  };
}

// Fill-blank-only merge + genre/tag union. Never overwrites a good DB value.
export interface ExistingBook {
  title?: string; author?: string; authorId?: string; ratings?: number | null;
  avgRating?: number | null; published?: string; pages?: number | null;
  seriesPos?: number | null; genres?: string[]; tags?: Record<string, unknown>;
  workId?: string; isBad?: number | null;
}
export interface MergedBook {
  changed: boolean;
  merged: {
    title: string; author: string; authorId?: string; ratings: number | null;
    avgRating: number | null; published: string; pages: number | null;
    seriesPos: number | null; genres?: string[]; tags?: Record<string, unknown>;
    workId?: string; isBad: number | null;
  };
}

// Adopt `inc` only when the existing string value is blank/bad. Otherwise keep.
function pickStr(existing: string | undefined, inc: string | undefined, fallback: string): string {
  if (!isBlank(existing)) return existing!;
  return !isBlank(inc) ? inc! : fallback;
}
// A numeric value is "good" when it's a positive, finite number.
const goodNum = (n: number | null | undefined) => n != null && Number.isFinite(n) && n > 0;
function pickNum(existing: number | null | undefined, inc: number | null | undefined): number | null {
  if (goodNum(existing)) return existing!;
  return goodNum(inc) ? inc! : null;
}

export function mergeBook(existing: ExistingBook | undefined, inc: BookImportRow, ratingPolicy: 'keep' | 'update' = 'keep'): MergedBook {
  const title = pickStr(existing?.title, inc.title, 'Unknown');
  const author = pickStr(existing?.author, inc.author, 'Unknown');
  const authorId = existing?.authorId || inc.authorId;
  const published = pickStr(existing?.published, inc.published, 'Unknown');
  const workId = existing?.workId || inc.workId;
  const ratings = pickNum(existing?.ratings ?? null, inc.ratings ?? null);
  // avgRating honors the policy: 'update' overwrites an existing good value with
  // a differing imported one; 'keep' (default) is fill-blank-only.
  const avgRating: number | null = ratingPolicy === 'update'
    ? (goodNum(inc.avgRating ?? null) ? (inc.avgRating ?? null) : existing?.avgRating ?? null)
    : pickNum(existing?.avgRating ?? null, inc.avgRating ?? null);
  const pages = pickNum(existing?.pages ?? null, inc.pages ?? null);
  const seriesPos = pickNum(existing?.seriesPos ?? null, inc.seriesPos ?? null);
  const isBad: number | null = goodNum(inc.isBad ?? null) ? (inc.isBad ?? null) : (existing?.isBad ?? null);

  const curGenres = existing?.genres || [];
  const incGenres = inc.genres || [];
  const genres = [...new Set([...curGenres, ...incGenres])];
  const tags = mergeTags(existing?.tags, inc.tags);

  if (!existing) {
    return {
      changed: true,
      merged: {
        title, author, authorId, ratings, avgRating, published, pages, seriesPos, genres, tags, workId, isBad,
      },
    };
  }

  const changed =
    existing.title !== title
    || existing.author !== author
    || (existing.authorId ?? undefined) !== authorId
    || Number(existing.ratings ?? 0) !== Number(ratings ?? 0)
    || (existing.avgRating ?? null) !== avgRating
    || (existing.published ?? 'Unknown') !== published
    || (existing.pages ?? null) !== pages
    || (existing.seriesPos ?? null) !== seriesPos
    || JSON.stringify(existing.genres || []) !== JSON.stringify(genres)
    || JSON.stringify(existing.tags || {}) !== JSON.stringify(tags || {})
    || (existing.workId ?? undefined) !== workId;

  return { changed, merged: { title, author, authorId, ratings, avgRating, published, pages, seriesPos, genres, tags, workId, isBad } };
}

// ── DB persistence (fill-blank + union) ─────────────────────────────
export interface ImportCounts { booksInserted: number; booksUpdated: number; booksSkipped: number; authorsInserted: number; authorsUpdated: number; authorsSkipped: number; }

export async function importBooksFile(
  db: import('better-sqlite3').Database,
  booksFile: string,
  counts: ImportCounts,
  ratingPolicy: 'keep' | 'update' = 'keep'
): Promise<{ total: number }> {
  const upsertStmt = db.prepare(`
    INSERT INTO books
      (id, title, author, author_id, ratings, avg_rating, published, pages, series_pos, genres, last_updated, tags, requires_auth, is_bad, fail_count, work_id)
    VALUES
      (@id, @title, @author, @authorId, @ratings, @avgRating, @published, @pages, @seriesPos, @genres, @lastUpdated, @tags, 0, @isBad, 0, @workId)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, author=excluded.author, author_id=excluded.author_id,
      ratings=excluded.ratings, avg_rating=excluded.avg_rating, published=excluded.published,
      pages=excluded.pages, series_pos=excluded.series_pos, genres=excluded.genres,
      last_updated=excluded.last_updated, tags=excluded.tags, is_bad=excluded.is_bad,
      work_id=COALESCE(excluded.work_id, work_id)
  `);

  const now = new Date().toISOString();
  const find = db.prepare('SELECT * FROM books WHERE id = ?');

  // Stream the file, decoding + merging against the current DB row, writing in
  // bounded batches inside explicit BEGIN/COMMIT so memory stays flat and each
  // batch is atomic even though the reader loop is async.
  const BATCH = 10_000;
  let batch: any[] = [];
  let total = 0;

  const commit = db.transaction((rows: any[]) => {
    for (const p of rows) {
      upsertStmt.run(p);
      if (p.isNew) counts.booksInserted++;
      else counts.booksUpdated++;
    }
  });

  await readCsvGz(booksFile, (headers, fields) => {
    const row = decodeBookRow(headers, fields);
    if (!row) return;
    total++;
    const existing = find.get(row.id) as any;
    const e = existing ? {
      title: existing.title, author: existing.author,
      authorId: existing.author_id, ratings: existing.ratings, avgRating: existing.avg_rating,
      published: existing.published, pages: existing.pages, seriesPos: existing.series_pos,
      genres: existing.genres ? safeJson(existing.genres) : undefined,
      tags: existing.tags ? safeJson(existing.tags) : undefined,
      workId: existing.work_id, isBad: existing.is_bad,
    } : undefined;
    const { merged } = mergeBook(e as ExistingBook, row, ratingPolicy);
    batch.push({
      id: row.id,
      title: merged.title,
      author: merged.author,
      authorId: merged.authorId || null,
      ratings: merged.ratings,
      avgRating: merged.avgRating,
      published: merged.published,
      pages: merged.pages,
      seriesPos: merged.seriesPos,
      genres: merged.genres && merged.genres.length ? JSON.stringify(merged.genres) : null,
      lastUpdated: now,
      tags: merged.tags ? JSON.stringify(merged.tags) : null,
      isBad: merged.isBad ? 1 : 0,
      workId: merged.workId || null,
      isNew: !existing,
    });
    if (batch.length >= BATCH) {
      commit(batch);
      batch = [];
    }
  });
  if (batch.length) commit(batch);
  return { total };
}

const safeJson = (s: string) => { try { return JSON.parse(s); } catch { return undefined; } };

export async function importAuthorsFile(
  db: import('better-sqlite3').Database,
  authorsFile: string,
  counts: ImportCounts
): Promise<{ total: number }> {
  const upsertStmt = db.prepare(`
    INSERT INTO authors
      (name, id, slug, last_seen, average_rating, num_ratings, num_reviews, num_shelves, catalog_pages, last_error)
    VALUES
      (@name, @id, @slug, @lastSeen, @averageRating, @numRatings, @numReviews, @numShelves, @catalogPages, @lastError)
    ON CONFLICT(name) DO UPDATE SET
      id=excluded.id, slug=excluded.slug, last_seen=excluded.last_seen,
      average_rating=excluded.average_rating, num_ratings=excluded.num_ratings,
      num_reviews=excluded.num_reviews, num_shelves=excluded.num_shelves,
      catalog_pages=excluded.catalog_pages, last_error=excluded.last_error
  `);

  const find = db.prepare('SELECT * FROM authors WHERE name = ?');
  const toWrite: any[] = [];
  let total = 0;
  await readCsvGz(authorsFile, (headers, fields) => {
    const row = decodeAuthorRow(headers, fields);
    if (!row) return;
    total++;
    const existing = find.get(row.name) as any;
    const mergedAuthor = mergeAuthor(existing as any, row as AuthorImportRow);
    toWrite.push({
      name: row.name,
      id: mergedAuthor.id,
      slug: mergedAuthor.slug,
      lastSeen: mergedAuthor.lastSeen,
      averageRating: mergedAuthor.averageRating,
      numRatings: mergedAuthor.numRatings,
      numReviews: mergedAuthor.numReviews,
      numShelves: mergedAuthor.numShelves,
      catalogPages: mergedAuthor.catalogPages,
      lastError: mergedAuthor.lastError ?? null,
      isNew: !existing,
    });
  });

  const tx = db.transaction(() => {
    for (const p of toWrite) {
      upsertStmt.run(p);
      if (p.isNew) counts.authorsInserted++;
      else counts.authorsUpdated++;
    }
  });
  tx();
  return { total };
}

// Fill-blank-only for authors (status fields like last_seen are always updated).
export interface ExistingAuthor {
  id?: string; slug?: string; lastSeen?: string; averageRating?: number | null; numRatings?: number | null;
  numReviews?: number | null; numShelves?: number | null; catalogPages?: number | null; lastError?: string;
}
export function mergeAuthor(existing: ExistingAuthor | undefined, inc: AuthorImportRow): ExistingAuthor {
  const pickStr = (e: string | undefined, i: string | undefined, fb: string) => !isBlank(e) ? e! : (!isBlank(i) ? i! : fb);
  const pickNum2 = (e: number | null | undefined, i: number | null | undefined) => goodNum(e) ? e! : (goodNum(i) ? i! : null);
  return {
    id: pickStr(existing?.id, inc.id, ''),
    slug: pickStr(existing?.slug, inc.slug, ''),
    lastSeen: !isBlank(inc.lastSeen) ? inc.lastSeen! : (existing?.lastSeen ?? ''),
    averageRating: pickNum2(existing?.averageRating ?? null, inc.averageRating ?? null),
    numRatings: pickNum2(existing?.numRatings ?? null, inc.numRatings ?? null),
    numReviews: pickNum2(existing?.numReviews ?? null, inc.numReviews ?? null),
    numShelves: pickNum2(existing?.numShelves ?? null, inc.numShelves ?? null),
    catalogPages: pickNum2(existing?.catalogPages ?? null, inc.catalogPages ?? null),
    lastError: existing?.lastError ?? inc.lastError,
  };
}

export interface ImportOptions {
  booksFile?: string;
  authorsFile?: string;
  ratingPolicy?: 'keep' | 'update';
}
export async function importData(
  db: import('better-sqlite3').Database,
  options: ImportOptions
): Promise<ImportCounts> {
  if (!options.booksFile && !options.authorsFile) {
    throw new Error('Provide at least one of --books or --authors file paths.');
  }
  const counts: ImportCounts = { booksInserted: 0, booksUpdated: 0, booksSkipped: 0, authorsInserted: 0, authorsUpdated: 0, authorsSkipped: 0 };
  const policy = options.ratingPolicy === 'update' ? 'update' : 'keep';
  if (options.booksFile) await importBooksFile(db, options.booksFile, counts, policy);
  if (options.authorsFile) await importAuthorsFile(db, options.authorsFile, counts);
  return counts;
}

export function printImportResult(counts: ImportCounts, ratingPolicy: 'keep' | 'update' = 'keep'): void {
  console.log(chalk.cyan.bold('\n📥 Import complete:'));
  console.log(chalk.white(`  books:   ${counts.booksInserted} inserted, ${counts.booksUpdated} updated`));
  console.log(chalk.white(`  authors: ${counts.authorsInserted} inserted, ${counts.authorsUpdated} updated`));
  console.log(chalk.gray(`  avgRating policy: ${ratingPolicy === 'update' ? 'update (overwrite)' : 'keep (fill-blank-only)'}`));
}
