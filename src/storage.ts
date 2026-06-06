import fs from 'fs-extra';
import path from 'path';

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
  ratings: string;
  published: string;
  lastUpdated: string;
  tags?: { [tagName: string]: number };
  requiresAuth?: boolean;
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

const STATE_FILE = path.join(process.cwd(), 'state.json');
const BACKUP_FILE = path.join(process.cwd(), 'state.json.bak');
const BOOKS_CACHE_FILE = path.join(process.cwd(), 'booksCache.json');
const CONFIG_FILE = path.join(process.cwd(), 'config.json');

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

export async function loadConfig(): Promise<Config> {
  if (await fs.pathExists(CONFIG_FILE)) {
    return await fs.readJson(CONFIG_FILE);
  }
  return {};
}
