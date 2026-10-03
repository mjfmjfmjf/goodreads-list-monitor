import fs from 'fs-extra';
import path from 'path';
import { parseSeriesPos } from './seriesPos.js';
import { getDb, refreshWorkRep, TAG_PAGE_ESTIMATE_BACKFILL_SQL } from './db.js';

export interface ListState {
  title: string;
  lastCount: number;
  seenBookIds: string[];
  ingested?: boolean;
  discoveryPage?: number;
  url?: string;
}

export interface CachedBook {
  id: string;
  title: string;
  author: string;
  authorId?: string;
  ratings: string;
  avgRating?: string;
  published: string;
  pages?: string;
  seriesPos?: number;
  genres?: string[];
  lastUpdated: string;
  tags?: { [tagName: string]: number };
  tagCount?: number;
  requiresAuth?: boolean;
  isBad?: boolean;
  failCount?: number;
  workId?: string;
  firstSeen?: string;
  isWorkRep?: boolean;
}

export interface State {
  userId: string;
  lists: {
    [listId: string]: ListState;
  };
}

export interface BookCache {
  [bookId: string]: CachedBook;
}

export interface Config {
  cookie?: string;
}

export interface AuthorCacheEntry {
  id: string;
  slug: string;
  lastSeen: string;
  firstSeen?: string;
  averageRating?: string;
  numRatings?: string;
  numReviews?: string;
  numShelves?: string;
  catalogPages?: number;
  failCount?: number;
  lastError?: string;
  ratingsRate?: number;
}

export const AUTHOR_FAIL_LIMIT = 5;

// Minimum time between two stats observations before a per-day ratings-growth
// rate is recorded, so a back-to-back scrape (or an unlucky same-day update)
// can't blow up Δ/day into an astronomical ranking.
export const GROWTH_RATE_MIN_DAYS = 1;

export interface AuthorCache {
  [authorName: string]: AuthorCacheEntry;
}

export interface AuthorStats {
  averageRating?: string;
  numRatings?: string;
  numReviews?: string;
  numShelves?: string;
  name?: string;
  slug?: string;
}

const parseNum = (s?: string): number => parseInt((s || '0').replace(/,/g, ''), 10) || 0;

export function updateAuthorStats(entry: AuthorCacheEntry, stats: AuthorStats): boolean {
  const existingRatings = parseNum(entry.numRatings);
  const existingReviews = parseNum(entry.numReviews);
  const newRatings = parseNum(stats.numRatings);
  const newReviews = parseNum(stats.numReviews);

  if (newRatings < existingRatings || newReviews < existingReviews) return false;

  // Was this author already stats-captured? A minted author (created by a
  // book/list walk, numRatings undefined) has no baseline, so the first scrape
  // only establishes one — the growth rate needs a second observation.
  const hadPriorCapture = entry.numRatings !== undefined;
  const priorSeenMs = hadPriorCapture ? Date.parse(entry.lastSeen ?? '') : Number.NaN;

  let changed = false;
  if (stats.averageRating !== undefined && entry.averageRating !== stats.averageRating) {
    entry.averageRating = stats.averageRating;
    changed = true;
  }
  if (stats.numRatings !== undefined && entry.numRatings !== stats.numRatings) {
    entry.numRatings = stats.numRatings;
    changed = true;
  }
  if (stats.numReviews !== undefined && entry.numReviews !== stats.numReviews) {
    entry.numReviews = stats.numReviews;
    changed = true;
  }
  if (stats.numShelves !== undefined && entry.numShelves !== stats.numShelves) {
    entry.numShelves = stats.numShelves;
    changed = true;
  }

  // Ratings-growth rate: Δratings / days since the previous stats observation
  // (last_seen was stamped at that scrape). Only updated when ratings actually
  // grew and the window is meaningful; otherwise the previous rate is kept.
  if (changed && newRatings > existingRatings && hadPriorCapture && Number.isFinite(priorSeenMs) && priorSeenMs > 0) {
    const elapsedDays = (Date.now() - priorSeenMs) / 86400000;
    if (elapsedDays >= GROWTH_RATE_MIN_DAYS) {
      entry.ratingsRate = Math.round(((newRatings - existingRatings) / elapsedDays) * 100) / 100;
    }
  }

  if (changed) entry.lastSeen = new Date().toISOString();
  return changed;
}

// ── Books ──────────────────────────────────────────────────────────

function rowToBook(row: any): CachedBook {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    authorId: row.author_id || undefined,
    ratings: String(row.ratings ?? 0),
    avgRating: row.avg_rating != null ? String(row.avg_rating) : undefined,
    published: row.published,
    pages: row.pages != null ? String(row.pages) : undefined,
    seriesPos: row.series_pos ?? undefined,
    genres: row.genres ? JSON.parse(row.genres) : undefined,
    lastUpdated: row.last_updated,
    tags: row.tags ? JSON.parse(row.tags) : undefined,
    requiresAuth: row.requires_auth === 1,
    isBad: row.is_bad === 1,
    failCount: row.fail_count || undefined,
    workId: row.work_id || undefined,
    firstSeen: row.first_seen || undefined,
    isWorkRep: row.is_work_rep === 1,
  };
}

export function loadBookCache(): BookCache {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM books').all();
  const cache: BookCache = {};
  for (const row of rows) {
    const book = rowToBook(row);
    cache[book.id] = book;
  }
  return cache;
}

// Stream the full `books` table one row at a time as CachedBook objects,
// O(1) memory — the replacement for loadBookCache() in iteration-only
// consumers (histograms, summaries, audits, sync helpers). The caller may
// `break` early; better-sqlite3 frees the statement once the cursor (and the
// generator) is garbage collected.
export function* iterateBooks(): Generator<CachedBook> {
  const stmt = getDb().prepare('SELECT * FROM books');
  for (const row of stmt.iterate()) {
    yield rowToBook(row);
  }
}

// Stream arbitrary projection rows (e.g. 'SELECT ratings, work_id FROM books')
// for SQL-side aggregation, keeping memory flat. Rows are raw DB columns, NOT
// CachedBook objects — use only the columns you select.
export function* streamRows<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Generator<T> {
  const stmt = getDb().prepare(sql);
  for (const row of stmt.iterate(...(params as any[]))) {
    yield row as T;
  }
}

const BOOK_UPSERT_SQL = `
  INSERT INTO books (id, title, author, author_id, ratings, avg_rating, published, pages, series_pos, genres, last_updated, tags, requires_auth, is_bad, fail_count, work_id, first_seen)
  VALUES (@id, @title, @author, @authorId, @ratings, @avgRating, @published, @pages, @seriesPos, @genres, @lastUpdated, @tags, @requiresAuth, @isBad, @failCount, @workId, COALESCE(@firstSeen, @lastUpdated))
  ON CONFLICT(id) DO UPDATE SET
    title=excluded.title, author=excluded.author, author_id=excluded.author_id,
    ratings=excluded.ratings, avg_rating=excluded.avg_rating, published=excluded.published,
    pages=excluded.pages, series_pos=excluded.series_pos, genres=excluded.genres,
    last_updated=excluded.last_updated, tags=excluded.tags,
    requires_auth=excluded.requires_auth, is_bad=excluded.is_bad, fail_count=excluded.fail_count,
    work_id=COALESCE(excluded.work_id, work_id),
    first_seen=COALESCE(books.first_seen, excluded.first_seen)
`;

function bindBook(book: CachedBook) {
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    authorId: book.authorId || null,
    ratings: parseNum(book.ratings),
    // A book with no ratings has no average to scrape — record it as 0 so the
    // field is populated, not NULL. A book WITH ratings but no avg is a scrape
    // gap and must stay NULL so it stays detectable/backfillable.
    avgRating: book.avgRating ? parseFloat(book.avgRating) : (parseNum(book.ratings) === 0 ? 0 : null),
    published: book.published,
    pages: book.pages ? parseInt(book.pages, 10) : null,
    seriesPos: book.seriesPos ?? null,
    genres: book.genres ? JSON.stringify(book.genres) : null,
    lastUpdated: book.lastUpdated,
    tags: book.tags ? JSON.stringify(book.tags) : null,
    requiresAuth: book.requiresAuth ? 1 : 0,
    isBad: book.isBad ? 1 : 0,
    failCount: book.failCount ?? null,
    workId: book.workId || null,
    firstSeen: book.firstSeen || null,
  };
}

export function upsertBook(book: CachedBook): void {
  const db = getDb();
  db.prepare(BOOK_UPSERT_SQL).run(bindBook(book));
  if (book.workId) refreshWorkRep(db, book.workId);
}

export function getBook(id: string): CachedBook | undefined {
  const row = getDb().prepare('SELECT * FROM books WHERE id = ?').get(id) as any;
  return row ? rowToBook(row) : undefined;
}

export function countBooks(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS c FROM books').get() as any;
  return row?.c ?? 0;
}

export function countAuthors(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS c FROM authors').get() as any;
  return row?.c ?? 0;
}

export function deleteBook(id: string): boolean {
  return getDb().prepare('DELETE FROM books WHERE id = ?').run(id).changes > 0;
}

export interface AuthorPageBookRow {
  id: string;
  title: string;
  author: string;
  authorId?: string;
  ratings?: string;
  avgRating?: string;
  published?: string;
  workId?: string;
}

export type AuthorPageMergeOutcome =
  | { kind: 'insert'; book: CachedBook }
  | { kind: 'update'; book: CachedBook }
  | { kind: 'skip' };

const BLANK_SENTINELS = new Set(['unknown', 'null', 'unknown author', 'n/a']);
const isBlank = (s?: string | null) => !s || !s.trim() || BLANK_SENTINELS.has(s.trim().toLowerCase());

export function computeAuthorPageMerge(existing: CachedBook | undefined, inc: AuthorPageBookRow): AuthorPageMergeOutcome {
  const now = new Date().toISOString();
  if (!existing) {
    return {
      kind: 'insert',
      book: {
        id: inc.id,
        title: inc.title,
        author: inc.author,
        authorId: inc.authorId,
        ratings: String(parseNum(inc.ratings)),
        avgRating: inc.avgRating,
        published: inc.published ?? 'Unknown',
        workId: inc.workId,
        lastUpdated: now,
        requiresAuth: false,
        isBad: false,
      },
    };
  }
  const patch: Partial<CachedBook> = {};
  if (isBlank(existing.title) && !isBlank(inc.title)) patch.title = inc.title;
  if (isBlank(existing.author) && !isBlank(inc.author)) patch.author = inc.author;
  if (!existing.authorId && inc.authorId) patch.authorId = inc.authorId;
  if ((parseNum(existing.ratings) === 0) && parseNum(inc.ratings) > 0) patch.ratings = String(parseNum(inc.ratings));
  if (!existing.avgRating && inc.avgRating) patch.avgRating = inc.avgRating;
  if (isBlank(existing.published) && !isBlank(inc.published)) patch.published = inc.published;
  if (!existing.workId && inc.workId) patch.workId = inc.workId;
  if (Object.keys(patch).length === 0) return { kind: 'skip' };
  return { kind: 'update', book: { ...existing, ...patch, lastUpdated: now } };
}

export function mergeBooksFromAuthorPage(books: AuthorPageBookRow[]): { inserted: number; updated: number; skipped: number } {
  const db = getDb();
  const result = { inserted: 0, updated: 0, skipped: 0 };
  const updateStmt = db.prepare(`
    UPDATE books SET
      title = COALESCE(@title, title),
      author = COALESCE(@author, author),
      author_id = COALESCE(@authorId, author_id),
      ratings = COALESCE(@ratings, ratings),
      avg_rating = COALESCE(@avgRating, avg_rating),
      published = COALESCE(@published, published),
      work_id = COALESCE(@workId, work_id),
      last_updated = @lastUpdated
    WHERE id = @id
  `);
  for (const inc of books) {
    if (!inc.id) continue;
    const existing = getBook(inc.id);
    const outcome = computeAuthorPageMerge(existing, inc);
    if (outcome.kind === 'insert') {
      upsertBook(outcome.book);
      result.inserted++;
    } else if (outcome.kind === 'update') {
      const b = outcome.book;
      updateStmt.run({
        id: b.id,
        title: b.title ?? null,
        author: b.author ?? null,
        authorId: b.authorId || null,
        ratings: b.ratings ? parseNum(b.ratings) : null,
        avgRating: b.avgRating ? parseFloat(b.avgRating) : (parseNum(b.ratings) === 0 ? 0 : null),
        published: b.published ?? null,
        workId: b.workId || null,
        lastUpdated: b.lastUpdated,
      });
      if (b.workId) refreshWorkRep(db, b.workId);
      result.updated++;
    } else {
      result.skipped++;
    }
  }
  return result;
}


// ── Tag books ─────────────────────────────────────────────────────

export interface TagBookRow {
  tagName: string;
  bookId: string;
  position?: number;
  shelved?: number;
  harvestedAt: string;
}

// Upsert a tag membership. PK is (tag_name, book_id), so re-reading a tag
// refreshes an existing row's position + timestamp rather than duplicating it.
// Different books can share the same position across reads — each stays its own
// (tag, book) row, accumulating historical tag → book → position mappings over time.
export function upsertTagBooks(tag: string, books: { id: string; position?: number; shelved?: number }[]): void {
  const db = getDb();
  if (!books.length) return;
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO tag_books (tag_name, book_id, position, shelved, harvested_at)
    VALUES (@tagName, @bookId, @position, @shelved, @harvestedAt)
    ON CONFLICT(tag_name, book_id) DO UPDATE SET
      position = excluded.position,
      shelved = excluded.shelved,
      harvested_at = excluded.harvested_at
  `);
  for (const book of books) {
    if (!book.id) continue;
    stmt.run({
      tagName: tag,
      bookId: book.id,
      position: book.position ?? null,
      shelved: book.shelved ?? null,
      harvestedAt: now,
    });
  }
}

export function loadTagBooks(tag?: string, bookId?: string): TagBookRow[] {
  const db = getDb();
  const clauses: string[] = [];
  const params: any[] = [];
  if (tag !== undefined) {
    clauses.push('tag_name = ?');
    params.push(tag);
  }
  if (bookId !== undefined) {
    clauses.push('book_id = ?');
    params.push(bookId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM tag_books ${where} ORDER BY tag_name, position`).all(...params) as any[];
  return rows.map(row => ({
    tagName: row.tag_name,
    bookId: row.book_id,
    position: row.position ?? undefined,
    shelved: row.shelved ?? undefined,
    harvestedAt: row.harvested_at,
  }));
}

// ── Tag shelf page stats ─────────────────────────────────────────
// Per-tag knowledge about how many pages its Goodreads shelf actually has.
// `last_page_seen` is measured from the shelf's own pagination footer during a
// scrape; `estimate_page` is a probable value backfilled for tags scraped
// before that measurement existed (harvest-derived or member-count-guess).

export interface TagStatsRow {
  tagName: string;
  lastPageSeen: number | null;
  estimatePage: number | null;
  estimateSource: string | null;
  updated: string;
}

export function persistShelfPageCount(tag: string, pages: number): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO tag_stats (tag_name, last_page_seen, updated)
    VALUES (@tagName, @pages, @now)
    ON CONFLICT(tag_name) DO UPDATE SET
      last_page_seen = excluded.last_page_seen,
      updated = excluded.updated
  `).run({ tagName: tag, pages, now });
}

export function getKnownShelfPages(tag: string): number | null {
  const row = getDb().prepare(
    'SELECT COALESCE(last_page_seen, estimate_page) AS pages FROM tag_stats WHERE tag_name = ?'
  ).get(tag) as any;
  return row && typeof row.pages === 'number' ? row.pages : null;
}

// The last page count actually MEASURED from a live pagination footer, ignoring
// the backfilled estimate_page guess. That estimate is a shelf_book_count/50
// division and can be wildly off (e.g. "manga" estimates 125,293 pages against
// a real shelf ~3 orders of magnitude smaller), so it is fine for capping a
// first-ever crawl but NOT safe as the start of a tail read. The tag-recent-
// monitor (PLAN-tag-recent-monitor.md) anchors on the tag_books xref instead and
// only falls back to this for a tag with no xref rows at all.
export function getMeasuredShelfPages(tag: string): number | null {
  const row = getDb().prepare('SELECT last_page_seen FROM tag_stats WHERE tag_name = ?').get(tag) as any;
  return row && typeof row.last_page_seen === 'number' ? row.last_page_seen : null;
}

// Batched anchor lookup for a whole tag list: how far down each tag's shelf we
// have already harvested, derived from tag_books itself. `position` is the
// book's GLOBAL 1-based shelf position (scraper.ts: `bookPos = (startPage - 1) * 50`,
// then incremented), so max_position / BOOKS_PER_SHELF_PAGE is the last page we
// read for that tag — a far better tail anchor than a page number, and it needs
// no live request. One chunked query per 400 tags (~1.3s for the full 4,084).
export interface TagAnchorRow {
  bookCount: number;
  maxPosition: number | null;
  measuredPage: number | null;
}

export function loadTagAnchors(tags: string[]): Map<string, TagAnchorRow> {
  const db = getDb();
  const out = new Map<string, TagAnchorRow>();
  const CHUNK = 400;
  for (let i = 0; i < tags.length; i += CHUNK) {
    const slice = tags.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT t.tag_name, COUNT(*) AS book_count, MAX(t.position) AS max_position, s.last_page_seen
      FROM tag_books t
      LEFT JOIN tag_stats s ON s.tag_name = t.tag_name
      WHERE t.tag_name IN (${placeholders})
      GROUP BY t.tag_name
    `).all(...slice) as any[];
    for (const r of rows) {
      out.set(String(r.tag_name), {
        bookCount: r.book_count ?? 0,
        maxPosition: r.max_position ?? null,
        measuredPage: typeof r.last_page_seen === 'number' ? r.last_page_seen : null,
      });
    }
  }
  return out;
}

export function loadTagStats(tag?: string): TagStatsRow[] {
  const db = getDb();
  const rows = tag !== undefined
    ? db.prepare('SELECT * FROM tag_stats WHERE tag_name = ?').all(tag)
    : db.prepare('SELECT * FROM tag_stats ORDER BY tag_name').all();
  return (rows as any[]).map(r => ({
    tagName: r.tag_name,
    lastPageSeen: r.last_page_seen ?? null,
    estimatePage: r.estimate_page ?? null,
    estimateSource: r.estimate_source ?? null,
    updated: r.updated,
  }));
}

// Re-runs the tag_stats estimate backfill against the current DB (idempotent:
// rows already present, including measured last_page_seen values, are kept).
export function backfillTagPageEstimates(): void {
  getDb().exec(TAG_PAGE_ESTIMATE_BACKFILL_SQL);
}

// ── List scrapes ────────────────────────────────────────────────
// Record which lists have been scraped all the way to the end, so repeat
// walks can skip recently-harvested lists without re-crawling them.

export interface ListScrapeRow {
  listId: string;
  listName: string;
  firstScraped: string;
  lastScraped: string;
}

export function upsertListScrape(listId: string, listName: string | null, now = new Date().toISOString()): void {
  getDb().prepare(`
    INSERT INTO list_scrapes (list_id, list_name, first_scraped, last_scraped)
    VALUES (@listId, @listName, @now, @now)
    ON CONFLICT(list_id) DO UPDATE SET
      list_name = COALESCE(excluded.list_name, list_scrapes.list_name),
      last_scraped = excluded.last_scraped
  `).run({ listId, listName, now });
}

export function loadListScrape(listId: string): ListScrapeRow | undefined {
  const row = getDb().prepare('SELECT * FROM list_scrapes WHERE list_id = ?').get(listId) as any;
  return row
    ? { listId: row.list_id, listName: row.list_name, firstScraped: row.first_scraped, lastScraped: row.last_scraped }
    : undefined;
}

// ── Tag tail monitor tracking ──────────────────────────────────────
// The tag-recent-monitor (see PLAN-tag-recent-monitor.md) tail-scrapes the
// tags a greedy set-cover needs to reach 100% tag_books coverage, to discover
// NEW books/authors. One row per tag records when its tail was last read and
// what the scrape found; tag_tail_monitor_state holds the in-flight pass so a
// restarted run resumes from where it stopped instead of re-reading every tag.

export interface TagTailScrapeRow {
  tagName: string;
  lastScraped: string;
  lastPageSeen: number | null;
  booksAdded: number;
  authorsAdded: number;
}

export function upsertTagTailScrape(tag: string, info: { lastPageSeen?: number | null; booksAdded?: number; authorsAdded?: number }): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO tag_tail_scrapes (tag_name, last_scraped, last_page_seen, books_added, authors_added)
    VALUES (@tagName, @now, @lastPageSeen, @booksAdded, @authorsAdded)
    ON CONFLICT(tag_name) DO UPDATE SET
      last_scraped = excluded.last_scraped,
      last_page_seen = excluded.last_page_seen,
      books_added = excluded.books_added,
      authors_added = excluded.authors_added
  `).run({ tagName: tag, now, lastPageSeen: info.lastPageSeen ?? null, booksAdded: info.booksAdded ?? 0, authorsAdded: info.authorsAdded ?? 0 });
}

export function loadTagTailScrape(tag: string): TagTailScrapeRow | undefined {
  const row = getDb().prepare('SELECT * FROM tag_tail_scrapes WHERE tag_name = ?').get(tag) as any;
  return row ? {
    tagName: row.tag_name,
    lastScraped: row.last_scraped,
    lastPageSeen: row.last_page_seen ?? null,
    booksAdded: row.books_added ?? 0,
    authorsAdded: row.authors_added ?? 0,
  } : undefined;
}

// Tags whose tail was read after `since` (ISO) — used to skip a tag when
// resuming an in-flight pass that already covered it.
export function loadRecentTagTailScrapes(since: string): Set<string> {
  const rows = getDb().prepare('SELECT tag_name FROM tag_tail_scrapes WHERE last_scraped >= ?').all(since) as any[];
  return new Set(rows.map(r => String(r.tag_name)));
}

export interface TagTailState {
  runStartedAt: string;
  runCompleted: boolean;
}

export function loadTagTailState(): TagTailState | undefined {
  const row = getDb().prepare("SELECT * FROM tag_tail_monitor_state WHERE id = '1'").get() as any;
  return row ? { runStartedAt: row.run_started_at, runCompleted: !!row.run_completed } : undefined;
}

export function saveTagTailState(state: TagTailState): void {
  getDb().prepare(`
    INSERT INTO tag_tail_monitor_state (id, run_started_at, run_completed)
    VALUES ('1', @runStartedAt, @runCompleted)
    ON CONFLICT(id) DO UPDATE SET
      run_started_at = excluded.run_started_at,
      run_completed = excluded.run_completed
  `).run({ runStartedAt: state.runStartedAt, runCompleted: state.runCompleted ? 1 : 0 });
}

export interface SyncBooksOutcome {
  inserted: number;
  updated: number;
}

export async function syncBooksToCache(books: any[], bookCache: BookCache): Promise<SyncBooksOutcome> {
  const db = getDb();
  const outcome: SyncBooksOutcome = { inserted: 0, updated: 0 };

  const upsertStmt = db.prepare(BOOK_UPSERT_SQL);

  const parseRatings = (r: string | undefined) => parseInt((r || '0').replace(/,/g, ''), 10);

  for (const book of books) {
    // Compare against the current DB row (not just the caller's snapshot)
    // so concurrent writers can't be regressed by stale values.
    const snap = bookCache[book.id];
    const existing = getBook(book.id) ?? snap;
    const isNew = !existing;

    const existingRatingsNum = parseRatings(existing?.ratings);
    const newRatingsNum = parseRatings(book.ratings);

    const hasBetterTitle = existing?.title === 'Unknown' && book.title !== 'Unknown';
    const hasBetterAuthor = existing?.author === 'Unknown' && book.author !== 'Unknown';
    const hasBetterAuthorId = !existing?.authorId && book.authorId;
    const hasBetterDate = (existing?.published === 'Unknown' || !existing?.published) && (book.published && book.published !== 'Unknown');
    const hasBetterPages = !existing?.pages && book.pages;
    const hasBetterRatings = newRatingsNum > existingRatingsNum;
    const hasBetterAvgRating = book.avgRating && book.avgRating !== existing?.avgRating;
    const newSeriesPos = book.title !== 'Unknown' ? parseSeriesPos(book.title) : undefined;
    const hasBetterSeriesPos = existing?.seriesPos === undefined && newSeriesPos !== undefined;
    const hasChangedSeriesPos = existing?.seriesPos !== undefined && newSeriesPos !== undefined && newSeriesPos !== existing.seriesPos;

    if (isNew || hasBetterTitle || hasBetterAuthor || hasBetterAuthorId || hasBetterDate || hasBetterPages || hasBetterRatings || hasBetterAvgRating || hasBetterSeriesPos || hasChangedSeriesPos) {
      const merged: CachedBook = {
        id: book.id,
        title: book.title !== 'Unknown' ? book.title : (existing?.title || 'Unknown'),
        author: book.author !== 'Unknown' ? book.author : (existing?.author || 'Unknown'),
        authorId: book.authorId || existing?.authorId,
        ratings: hasBetterRatings ? book.ratings : (existing?.ratings || '0'),
        avgRating: book.avgRating || existing?.avgRating,
        published: (book.published && book.published !== 'Unknown') ? book.published : (existing?.published || 'Unknown'),
        pages: book.pages || existing?.pages,
        seriesPos: newSeriesPos !== undefined ? newSeriesPos : existing?.seriesPos,
        lastUpdated: new Date().toISOString(),
        tags: existing?.tags || (book.tagCount !== undefined ? {} : undefined),
        genres: existing?.genres,
        requiresAuth: existing?.requiresAuth,
        isBad: existing?.isBad,
        failCount: existing?.failCount,
      };

      if (book.tagCount !== undefined && !merged.tags) merged.tags = {};

      bookCache[book.id] = merged;

      upsertStmt.run(bindBook(merged));

      if (isNew) outcome.inserted++;
      else outcome.updated++;
    }
  }
  return outcome;
}

// ── Authors ────────────────────────────────────────────────────────

function rowToAuthor(row: any): AuthorCacheEntry & { name: string } {
  return {
    name: row.name,
    id: row.id,
    slug: row.slug,
    lastSeen: row.last_seen,
    firstSeen: row.first_seen ?? undefined,
    averageRating: row.average_rating != null ? String(row.average_rating) : undefined,
    numRatings: row.num_ratings ? String(row.num_ratings) : undefined,
    numReviews: row.num_reviews ? String(row.num_reviews) : undefined,
    numShelves: row.num_shelves ? String(row.num_shelves) : undefined,
    catalogPages: row.catalog_pages ?? undefined,
    failCount: row.fail_count ?? undefined,
    lastError: row.last_error ?? undefined,
    ratingsRate: row.ratings_rate ?? undefined,
  };
}

export function loadAuthorCache(): AuthorCache {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM authors').all();
  const cache: AuthorCache = {};
  for (const row of rows) {
    const author = rowToAuthor(row);
    cache[author.name] = author;
  }
  return cache;
}

export function getAuthor(name: string): AuthorCacheEntry | undefined {
  const row = getDb().prepare('SELECT * FROM authors WHERE name = ?').get(name) as any;
  return row ? rowToAuthor(row) : undefined;
}

export function findAuthorBySlug(slug: string): { key: string; entry: AuthorCacheEntry } | undefined {
  const row = getDb()
    .prepare('SELECT * FROM authors WHERE slug = ? ORDER BY last_seen DESC LIMIT 1')
    .get(slug) as any;
  return row ? { key: row.name as string, entry: rowToAuthor(row) } : undefined;
}

// True when an author with this id already has a cache row. The author-one
// --file batch uses it to skip ids it has already ingested on a prior run.
export function authorExistsById(id: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM authors WHERE id = ? LIMIT 1').get(id);
}

function bindAuthor(name: string, e: AuthorCacheEntry) {
  return {
    name,
    id: e.id,
    slug: e.slug,
    lastSeen: e.lastSeen,
    firstSeen: e.firstSeen ?? null,
    averageRating: e.averageRating ? parseFloat(e.averageRating) : null,
    numRatings: parseNum(e.numRatings),
    numReviews: parseNum(e.numReviews),
    numShelves: parseNum(e.numShelves),
    catalogPages: e.catalogPages ?? null,
    failCount: e.failCount ?? null,
    lastError: e.lastError ?? null,
    ratingsRate: e.ratingsRate ?? null,
  };
}

const AUTHOR_UPSERT_SQL = `
  INSERT INTO authors (name, id, slug, last_seen, first_seen, average_rating, num_ratings, num_reviews, num_shelves, catalog_pages, fail_count, last_error, ratings_rate)
  VALUES (@name, @id, @slug, @lastSeen, COALESCE(@firstSeen, @lastSeen), @averageRating, @numRatings, @numReviews, @numShelves, @catalogPages, @failCount, @lastError, @ratingsRate)
  ON CONFLICT(name) DO UPDATE SET
    id=excluded.id, slug=excluded.slug, last_seen=excluded.last_seen,
    first_seen=COALESCE(authors.first_seen, excluded.first_seen),
    average_rating=excluded.average_rating, num_ratings=excluded.num_ratings,
    num_reviews=excluded.num_reviews, num_shelves=excluded.num_shelves,
    catalog_pages=COALESCE(excluded.catalog_pages, catalog_pages),
    fail_count=COALESCE(excluded.fail_count, fail_count),
    last_error=COALESCE(excluded.last_error, last_error),
    ratings_rate=excluded.ratings_rate
`;

export function upsertAuthor(name: string, entry: AuthorCacheEntry): void {
  getDb().prepare(AUTHOR_UPSERT_SQL).run(bindAuthor(name, entry));
}

export function recordAuthorFailure(name: string, reason: string): void {
  const existing = getAuthor(name);
  if (!existing) return;
  existing.failCount = (existing.failCount ?? 0) + 1;
  existing.lastError = reason.slice(0, 200);
  upsertAuthor(name, existing);
}

// ── Author scrape-failure tracking ─────────────────────────────
// Persists author ids that failed to scrape (e.g. orphan ids that 404), so a
// later run can skip re-trying the same bad ids instead of hammering them.

// After this many consecutive failures, stop re-trying an author id on future
// runs. Shared by the orphan-author sweeps and the single-book author-page
// lookups (scrapeBookByAuthorPage).
export const AUTHOR_SCRAPE_FAIL_LIMIT = 3;

export interface AuthorScrapeFailure {
  authorId: string;
  failCount: number;
  lastError?: string;
  firstSeen: string;
  lastSeen: string;
}

export function recordAuthorScrapeFailure(authorId: string, reason: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  const row = db.prepare('SELECT fail_count FROM author_scrape_failures WHERE author_id = ?').get(authorId) as any;
  const failCount = (row?.fail_count ?? 0) + 1;
  db.prepare(`
    INSERT INTO author_scrape_failures (author_id, fail_count, last_error, first_seen, last_seen)
    VALUES (@id, @failCount, @error, @now, @now)
    ON CONFLICT(author_id) DO UPDATE SET
      fail_count = excluded.fail_count,
      last_error = excluded.last_error,
      last_seen = excluded.last_seen
  `).run({ id: authorId, failCount, error: reason.slice(0, 200), now });
}

export function clearAuthorScrapeFailure(authorId: string): void {
  getDb().prepare('DELETE FROM author_scrape_failures WHERE author_id = ?').run(authorId);
}

export function loadAuthorScrapeFailure(authorId: string): AuthorScrapeFailure | undefined {
  const row = getDb().prepare('SELECT * FROM author_scrape_failures WHERE author_id = ?').get(authorId) as any;
  if (!row) return undefined;
  return {
    authorId: row.author_id,
    failCount: row.fail_count,
    lastError: row.last_error ?? undefined,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
  };
}

export function loadScrapeFailures(): AuthorScrapeFailure[] {
  const rows = getDb().prepare('SELECT * FROM author_scrape_failures').all() as any[];
  return rows.map(row => ({
    authorId: row.author_id,
    failCount: row.fail_count,
    lastError: row.last_error ?? undefined,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
  }));
}

// ── Genre catalog tracking ──────────────────────────────────────
// Genres are scraped from /genres/list (name = the hyphenated slug, e.g.
// "science-fiction"; member_count = the "# books" Goodreads reports). Re-runs
// refresh last_updated + member_count and keep first_seen fixed, so a genre
// that stops appearing or stops being populated is visible as a stale row.

export interface GenreRow {
  name: string;
  memberCount: number;
  firstSeen: string;
  lastUpdated: string;
}

// Returns the change summary for the run: how many were new vs refreshed.
export function upsertGenres(genres: Array<{ name: string; memberCount: number }>): { inserted: number; updated: number } {
  const db = getDb();
  const now = new Date().toISOString();
  let inserted = 0;
  let updated = 0;
  const stmt = db.prepare(`
    INSERT INTO genres (name, member_count, first_seen, last_updated)
    VALUES (@name, @count, @now, @now)
    ON CONFLICT(name) DO UPDATE SET
      member_count = excluded.member_count,
      last_updated = excluded.last_updated
  `);
  for (const g of genres) {
    const exists = (db.prepare('SELECT 1 AS x FROM genres WHERE name = ?').get(g.name) as any) !== undefined;
    stmt.run({ name: g.name, count: g.memberCount, now });
    if (exists) updated++; else inserted++;
  }
  return { inserted, updated };
}

export function loadGenres(): GenreRow[] {
  const rows = getDb().prepare('SELECT * FROM genres ORDER BY name').all() as any[];
  return rows.map(row => ({
    name: row.name,
    memberCount: row.member_count ?? 0,
    firstSeen: row.first_seen,
    lastUpdated: row.last_updated,
  }));
}

export function countGenres(): number {
  return (getDb().prepare('SELECT COUNT(*) AS c FROM genres').get() as any).c as number;
}

export interface GenreTagXrefRow {
  genreName: string;
  tagName: string;
  kind: string;
}

// Seed/replace the xref mappings for a single canonical genre. `rows` is the
// full desired tag set (tag_name -> kind) for that genre; any existing xref
// rows for the genre not listed here are removed, so re-running is idempotent.
export function replaceGenreTagXref(genre: string, tags: Array<{ tagName: string; kind: string }>): { added: number; removed: number } {
  const db = getDb();
  let added = 0;
  let removed = 0;
  const tx = db.transaction(() => {
    const existingRows = (db.prepare('SELECT tag_name, kind FROM genre_tag_xref WHERE genre_name = ?').all(genre) as any[]);
    const want = new Set(tags.map(t => t.tagName));
    // Curated edits never delete machine-added 'similarity' rows (e.g. a
    // re-run of --seed-xref after tag-pairings --loadXref must not nuke them).
    for (const e of existingRows) {
      if (!want.has(e.tag_name) && e.kind !== 'similarity') {
        db.prepare('DELETE FROM genre_tag_xref WHERE genre_name = ? AND tag_name = ?').run(genre, e.tag_name);
        removed++;
      }
    }
    const upsert = db.prepare(`
      INSERT INTO genre_tag_xref (genre_name, tag_name, kind)
      VALUES (@g, @t, @k)
      ON CONFLICT(genre_name, tag_name) DO UPDATE SET kind = excluded.kind
    `);
    for (const t of tags) {
      const existed = (db.prepare('SELECT 1 AS x FROM genre_tag_xref WHERE genre_name = ? AND tag_name = ?').get(genre, t.tagName) as any) !== undefined;
      upsert.run({ g: genre, t: t.tagName, k: t.kind });
      if (!existed) added++;
    }
  });
  tx();
  return { added, removed };
}

// Add a single tag→genre mapping without disturbing the genre's other rows
// (unlike replaceGenreTagXref). Kind precedence: curated kinds ('exact',
// 'cognate') always win over a machine-inferred 'similarity', so an automated
// load can never downgrade an edited mapping. Returns what happened.
export function upsertGenreTagXref(tagName: string, genreName: string, kind: string): 'added' | 'kept' | 'updated' {
  const db = getDb();
  const existing = db.prepare('SELECT kind FROM genre_tag_xref WHERE genre_name = ? AND tag_name = ?').get(genreName, tagName) as any;
  if (existing) {
    if (existing.kind === kind) return 'kept';
    if (existing.kind !== 'similarity' && kind === 'similarity') return 'kept';
    db.prepare('UPDATE genre_tag_xref SET kind = ? WHERE genre_name = ? AND tag_name = ?').run(kind, genreName, tagName);
    return 'updated';
  }
  db.prepare('INSERT INTO genre_tag_xref (genre_name, tag_name, kind) VALUES (?, ?, ?)').run(genreName, tagName, kind);
  return 'added';
}

export function loadGenreTagXref(): GenreTagXrefRow[] {
  const rows = getDb().prepare('SELECT * FROM genre_tag_xref').all() as any[];
  return rows.map(row => ({ genreName: row.genre_name, tagName: row.tag_name, kind: row.kind }));
}

export function loadXrefTagMap(): Map<string, string> {
  // tag_name -> canonical genre_name
  const map = new Map<string, string>();
  for (const r of loadGenreTagXref()) map.set(r.tagName, r.genreName);
  return map;
}

export function syncAuthorsToCache(books: any[], authorCache: AuthorCache): number {
  const db = getDb();
  let added = 0;

  const upsert = db.prepare(`
    INSERT INTO authors (name, id, slug, last_seen, first_seen, average_rating, num_ratings, num_reviews, num_shelves)
    VALUES (@name, @id, @slug, @lastSeen, @lastSeen, NULL, 0, 0, 0)
    ON CONFLICT(name) DO UPDATE SET
      id=excluded.id, slug=excluded.slug, last_seen=excluded.last_seen,
      first_seen=COALESCE(authors.first_seen, excluded.first_seen)
  `);
  const findById = db.prepare('SELECT name FROM authors WHERE id = ?');

  for (const book of books) {
    if (book.author && book.author !== 'Unknown Author' && book.authorSlug) {
      // Author identity is the id; if this author already exists under some
      // OTHER name variant (mangled spacing, role suffixes), do NOT create
      // a duplicate row keyed by the variant.
      const authorId = String(book.authorId || book.authorSlug.split('.')[0]);
      const existingById = findById.get(authorId) as any;
      if (existingById && existingById.name !== book.author) {
        continue;
      }
      const existing = authorCache[book.author];
      if (!existing || existing.slug !== book.authorSlug) {
        if (!existing) added++;
        const entry: AuthorCacheEntry = {
          id: book.authorId || book.authorSlug.split('.')[0],
          slug: book.authorSlug,
          lastSeen: new Date().toISOString(),
        };
        authorCache[book.author] = entry;
        upsert.run({
          name: book.author,
          id: entry.id,
          slug: entry.slug,
          lastSeen: entry.lastSeen,
        });
      }
    }
  }
  return added;
}

// ── State ──────────────────────────────────────────────────────────

export function loadState(): State {
  const db = getDb();

  const userRow = db.prepare("SELECT value FROM config WHERE key = 'userId'").get() as any;
  const userId = userRow?.value || '';

  const listRows = db.prepare('SELECT * FROM lists').all() as any[];
  const lists: { [listId: string]: ListState } = {};
  for (const row of listRows) {
    lists[row.list_id] = {
      title: row.title,
      lastCount: row.last_count,
      seenBookIds: row.seen_book_ids ? JSON.parse(row.seen_book_ids) : [],
      ingested: row.ingested === 1,
      discoveryPage: row.discovery_page ?? undefined,
      url: row.url ?? undefined,
    };
  }

  return { userId, lists };
}

export function saveState(state: State): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO config (key, value) VALUES ('userId', @value)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run({ value: state.userId });

    db.prepare('DELETE FROM lists').run();
    const insert = db.prepare(`
      INSERT INTO lists (list_id, title, last_count, seen_book_ids, ingested, discovery_page, url)
      VALUES (@listId, @title, @lastCount, @seenBookIds, @ingested, @discoveryPage, @url)
    `);
    for (const [listId, list] of Object.entries(state.lists)) {
      insert.run({
        listId,
        title: list.title,
        lastCount: list.lastCount,
        seenBookIds: JSON.stringify(list.seenBookIds),
        ingested: list.ingested ? 1 : 0,
        discoveryPage: list.discoveryPage ?? null,
        url: list.url ?? null,
      });
    }
  });
  tx();
}

// ── Config ─────────────────────────────────────────────────────────

export function loadConfig(): Config {
  const db = getDb();
  const row = db.prepare("SELECT value FROM config WHERE key = 'cookie'").get() as any;
  return row ? { cookie: row.value } : {};
}
