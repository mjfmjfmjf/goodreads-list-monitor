import fs from 'fs-extra';
import path from 'path';
import { parseSeriesPos } from './seriesPos.js';

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
  slug: string; // The "1077326.J_K_Rowling" part
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

export function updateAuthorStats(entry: AuthorCacheEntry, stats: AuthorStats): boolean {
  const parseNum = (s?: string): number => parseInt((s || '0').replace(/,/g, ''), 10) || 0;

  const existingRatings = parseNum(entry.numRatings);
  const existingReviews = parseNum(entry.numReviews);
  const newRatings = parseNum(stats.numRatings);
  const newReviews = parseNum(stats.numReviews);

  // Ratings and reviews only grow over time. If either went down (data error or
  // page mismatch), keep all four numbers untouched.
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

const STATE_FILE = path.join(process.cwd(), 'state.json');
const BACKUP_FILE = path.join(process.cwd(), 'state.json.bak');
const BOOKS_CACHE_FILE = path.join(process.cwd(), 'booksCache.json');
const AUTHORS_CACHE_FILE = path.join(process.cwd(), 'authorsCache.json');
const CONFIG_FILE = path.join(process.cwd(), 'config.json');

export async function loadAuthorCache(): Promise<AuthorCache> {
  if (await fs.pathExists(AUTHORS_CACHE_FILE)) {
    return await fs.readJson(AUTHORS_CACHE_FILE);
  }
  return {};
}

export async function saveAuthorCache(cache: AuthorCache): Promise<void> {
  await fs.writeJson(AUTHORS_CACHE_FILE, cache, { spaces: 2 });
}

export async function syncAuthorsToCache(books: any[], authorCache: AuthorCache) {
  let updated = false;
  for (const book of books) {
    if (book.author && book.author !== 'Unknown Author' && book.authorSlug) {
      const existing = authorCache[book.author];
      if (!existing || existing.slug !== book.authorSlug) {
        authorCache[book.author] = {
          id: book.authorId || book.authorSlug.split('.')[0],
          slug: book.authorSlug,
          lastSeen: new Date().toISOString()
        };
        updated = true;
      }
    }
  }
  if (updated) await saveAuthorCache(authorCache);
}

export async function loadState(): Promise<State> {
  if (await fs.pathExists(STATE_FILE)) {
    return await fs.readJson(STATE_FILE);
  }
  return {
    userId: '',
    lists: {}
  };
}

export async function saveState(state: State): Promise<void> {
  if (await fs.pathExists(STATE_FILE)) {
    await fs.copy(STATE_FILE, BACKUP_FILE);
  }
  await fs.writeJson(STATE_FILE, state, { spaces: 2 });
}

export async function loadBookCache(): Promise<BookCache> {
  if (await fs.pathExists(BOOKS_CACHE_FILE)) {
    return await fs.readJson(BOOKS_CACHE_FILE);
  }
  return {};
}

export async function saveBookCache(cache: BookCache): Promise<void> {
  await fs.writeJson(BOOKS_CACHE_FILE, cache, { spaces: 2 });
}

export async function syncBooksToCache(books: any[], bookCache: BookCache) {
  let updated = false;
  for (const book of books) {
    const existing = bookCache[book.id];
    const isNew = !existing;
    
    // Helper to parse ratings string into a number for comparison
    const parseRatings = (r: string | undefined) => parseInt((r || '0').replace(/,/g, ''), 10);
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
      bookCache[book.id] = {
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
        tags: existing?.tags || (book.tagCount !== undefined ? {} : undefined)
      };
      
      if (book.tagCount !== undefined) {
        if (!bookCache[book.id].tags) bookCache[book.id].tags = {};
      }
      updated = true;
    }
  }
  if (updated) await saveBookCache(bookCache);
}

export async function loadConfig(): Promise<Config> {
  if (await fs.pathExists(CONFIG_FILE)) {
    return await fs.readJson(CONFIG_FILE);
  }
  return {};
}
