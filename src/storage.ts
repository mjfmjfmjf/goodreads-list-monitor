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
  requiresAuth?: boolean;
  isBad?: boolean;
  failCount?: number;
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
}

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
  INSERT INTO books (id, title, author, author_id, ratings, avg_rating, published, pages, series_pos, genres, last_updated, tags, requires_auth, is_bad, fail_count)
  VALUES (@id, @title, @author, @authorId, @ratings, @avgRating, @published, @pages, @seriesPos, @genres, @lastUpdated, @tags, @requiresAuth, @isBad, @failCount)
  ON CONFLICT(id) DO UPDATE SET
    title=excluded.title, author=excluded.author, author_id=excluded.author_id,
    ratings=excluded.ratings, avg_rating=excluded.avg_rating, published=excluded.published,
    pages=excluded.pages, series_pos=excluded.series_pos, genres=excluded.genres,
    last_updated=excluded.last_updated, tags=excluded.tags,
    requires_auth=excluded.requires_auth, is_bad=excluded.is_bad, fail_count=excluded.fail_count
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
  };
}

export function upsertBook(book: CachedBook): void {
  getDb().prepare(BOOK_UPSERT_SQL).run(bindBook(book));
}

export function getBook(id: string): CachedBook | undefined {
  const row = getDb().prepare('SELECT * FROM books WHERE id = ?').get(id) as any;
  return row ? rowToBook(row) : undefined;
}

export function deleteBook(id: string): boolean {
  return getDb().prepare('DELETE FROM books WHERE id = ?').run(id).changes > 0;
}

export async function syncBooksToCache(books: any[], bookCache: BookCache) {
  const db = getDb();
  let updated = false;

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

        updated = true;
      }
    }
  });
  tx();
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
  };
}

const AUTHOR_UPSERT_SQL = `
  INSERT INTO authors (name, id, slug, last_seen, average_rating, num_ratings, num_reviews, num_shelves)
  VALUES (@name, @id, @slug, @lastSeen, @averageRating, @numRatings, @numReviews, @numShelves)
  ON CONFLICT(name) DO UPDATE SET
    id=excluded.id, slug=excluded.slug, last_seen=excluded.last_seen,
    average_rating=excluded.average_rating, num_ratings=excluded.num_ratings,
    num_reviews=excluded.num_reviews, num_shelves=excluded.num_shelves
`;

export function upsertAuthor(name: string, entry: AuthorCacheEntry): void {
  getDb().prepare(AUTHOR_UPSERT_SQL).run(bindAuthor(name, entry));
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

  const tx = db.transaction(() => {
    for (const book of books) {
      if (book.author && book.author !== 'Unknown Author' && book.authorSlug) {
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
