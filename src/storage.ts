import fs from 'fs-extra';
import path from 'path';
import { parseSeriesPos } from './seriesPos.js';
import { getDb } from './db.js';

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
  averageRating?: string;
  numRatings?: string;
  numReviews?: string;
  numShelves?: string;
  catalogPages?: number;
  failCount?: number;
  lastError?: string;
}

export const AUTHOR_FAIL_LIMIT = 5;

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

const BOOK_UPSERT_SQL = `
  INSERT INTO books (id, title, author, author_id, ratings, avg_rating, published, pages, series_pos, genres, last_updated, tags, requires_auth, is_bad, fail_count, work_id)
  VALUES (@id, @title, @author, @authorId, @ratings, @avgRating, @published, @pages, @seriesPos, @genres, @lastUpdated, @tags, @requiresAuth, @isBad, @failCount, @workId)
  ON CONFLICT(id) DO UPDATE SET
    title=excluded.title, author=excluded.author, author_id=excluded.author_id,
    ratings=excluded.ratings, avg_rating=excluded.avg_rating, published=excluded.published,
    pages=excluded.pages, series_pos=excluded.series_pos, genres=excluded.genres,
    last_updated=excluded.last_updated, tags=excluded.tags,
    requires_auth=excluded.requires_auth, is_bad=excluded.is_bad, fail_count=excluded.fail_count,
    work_id=COALESCE(excluded.work_id, work_id)
`;

function bindBook(book: CachedBook) {
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    authorId: book.authorId || null,
    ratings: parseNum(book.ratings),
    avgRating: book.avgRating ? parseFloat(book.avgRating) : null,
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
  };
}

export function upsertBook(book: CachedBook): void {
  getDb().prepare(BOOK_UPSERT_SQL).run(bindBook(book));
}

export function getBook(id: string): CachedBook | undefined {
  const row = getDb().prepare('SELECT * FROM books WHERE id = ?').get(id) as any;
  return row ? rowToBook(row) : undefined;
}

export function countBooks(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS c FROM books').get() as any;
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
  const tx = db.transaction(() => {
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
          avgRating: b.avgRating ? parseFloat(b.avgRating) : null,
          published: b.published ?? null,
          workId: b.workId || null,
          lastUpdated: b.lastUpdated,
        });
        result.updated++;
      } else {
        result.skipped++;
      }
    }
  });
  tx();
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
  const tx = db.transaction(() => {
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
  });
  tx();
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

export interface SyncBooksOutcome {
  inserted: number;
  updated: number;
}

export async function syncBooksToCache(books: any[], bookCache: BookCache): Promise<SyncBooksOutcome> {
  const db = getDb();
  const outcome: SyncBooksOutcome = { inserted: 0, updated: 0 };

  const upsertStmt = db.prepare(BOOK_UPSERT_SQL);

  const parseRatings = (r: string | undefined) => parseInt((r || '0').replace(/,/g, ''), 10);

  const tx = db.transaction(() => {
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
  });
  tx();
  return outcome;
}

// ── Authors ────────────────────────────────────────────────────────

function rowToAuthor(row: any): AuthorCacheEntry & { name: string } {
  return {
    name: row.name,
    id: row.id,
    slug: row.slug,
    lastSeen: row.last_seen,
    averageRating: row.average_rating != null ? String(row.average_rating) : undefined,
    numRatings: row.num_ratings ? String(row.num_ratings) : undefined,
    numReviews: row.num_reviews ? String(row.num_reviews) : undefined,
    numShelves: row.num_shelves ? String(row.num_shelves) : undefined,
    catalogPages: row.catalog_pages ?? undefined,
    failCount: row.fail_count ?? undefined,
    lastError: row.last_error ?? undefined,
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

function bindAuthor(name: string, e: AuthorCacheEntry) {
  return {
    name,
    id: e.id,
    slug: e.slug,
    lastSeen: e.lastSeen,
    averageRating: e.averageRating ? parseFloat(e.averageRating) : null,
    numRatings: parseNum(e.numRatings),
    numReviews: parseNum(e.numReviews),
    numShelves: parseNum(e.numShelves),
    catalogPages: e.catalogPages ?? null,
    failCount: e.failCount ?? null,
    lastError: e.lastError ?? null,
  };
}

const AUTHOR_UPSERT_SQL = `
  INSERT INTO authors (name, id, slug, last_seen, average_rating, num_ratings, num_reviews, num_shelves, catalog_pages, fail_count, last_error)
  VALUES (@name, @id, @slug, @lastSeen, @averageRating, @numRatings, @numReviews, @numShelves, @catalogPages, @failCount, @lastError)
  ON CONFLICT(name) DO UPDATE SET
    id=excluded.id, slug=excluded.slug, last_seen=excluded.last_seen,
    average_rating=excluded.average_rating, num_ratings=excluded.num_ratings,
    num_reviews=excluded.num_reviews, num_shelves=excluded.num_shelves,
    catalog_pages=COALESCE(excluded.catalog_pages, catalog_pages),
    fail_count=COALESCE(excluded.fail_count, fail_count),
    last_error=COALESCE(excluded.last_error, last_error)
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

export function syncAuthorsToCache(books: any[], authorCache: AuthorCache) {
  const db = getDb();
  let updated = false;

  const upsert = db.prepare(`
    INSERT INTO authors (name, id, slug, last_seen, average_rating, num_ratings, num_reviews, num_shelves)
    VALUES (@name, @id, @slug, @lastSeen, NULL, 0, 0, 0)
    ON CONFLICT(name) DO UPDATE SET
      id=excluded.id, slug=excluded.slug, last_seen=excluded.last_seen
  `);
  const findById = db.prepare('SELECT name FROM authors WHERE id = ?');

  const tx = db.transaction(() => {
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
          updated = true;
        }
      }
    }
  });
  tx();
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
