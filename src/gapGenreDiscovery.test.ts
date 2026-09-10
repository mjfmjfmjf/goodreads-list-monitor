import fs from 'fs-extra';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-gapgenre-${process.pid}-${Date.now()}.db`;
});

import { closeDb, getDb } from './db.js';
import { getGapGenres } from './gapGenreDiscovery.js';
import { upsertGenres, upsertTagBooks, backfillTagPageEstimates } from './storage.js';

const DB_FILE = process.env.GOODREADS_DB_PATH!;

afterAll(() => {
  closeDb();
  delete process.env.GOODREADS_DB_PATH;
  for (const suffix of ['', '-wal', '-shm']) fs.removeSync(DB_FILE + suffix);
});

beforeAll(() => {
  upsertGenres([
    { name: 'science-fiction', memberCount: 300 },
    { name: 'fantasy', memberCount: 200 },
    { name: 'medicine', memberCount: 100 },
    { name: 'tiny-genre', memberCount: 5 },
  ]);
  // fantasy is already scraped into tag_books
  upsertTagBooks('fantasy', [{ id: '111', position: 1, shelved: 10 }]);
});

describe('getGapGenres', () => {
  it('excludes genres already present in tag_books by default', () => {
    const gaps = getGapGenres({});
    const names = gaps.map(g => g.name);
    expect(names).not.toContain('fantasy');
    expect(names.sort()).toEqual(['medicine', 'science-fiction', 'tiny-genre']);
  });

  it('sorts by member count descending by default (most books first)', () => {
    const gaps = getGapGenres({});
    expect(gaps.map(g => g.name)).toEqual(['science-fiction', 'medicine', 'tiny-genre']);
  });

  it('supports alpha sort', () => {
    const gaps = getGapGenres({ sortBy: 'alpha' });
    expect(gaps.map(g => g.name)).toEqual(['medicine', 'science-fiction', 'tiny-genre']);
  });

  it('force includes already-scraped genres', () => {
    const gaps = getGapGenres({ force: true });
    expect(gaps.map(g => g.name)).toContain('fantasy');
    const f = gaps.find(g => g.name === 'fantasy')!;
    expect(f.scraped).toBe(true);
  });

  it('exposes the probable shelf page count from tag_stats', () => {
    upsertGenres([{ name: 'pagey-genre', memberCount: 880 }]);
    upsertTagBooks('pagey-genre', Array.from({ length: 500 }, (_, i) => ({ id: `p${i}`, position: i + 1, shelved: 1 })));
    backfillTagPageEstimates();

    const pagey = getGapGenres({ force: true }).find(g => g.name === 'pagey-genre')!;
    expect(pagey.pages).toBe(10); // ceil(500/50)
  });
});
