import fs from 'fs-extra';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-tagpairing-${process.pid}-${Date.now()}.db`;
});

import { closeDb } from './db.js';
import { upsertGenres, upsertTagBooks } from './storage.js';
import { loadTagSets } from './genrePairings.js';

const DB_FILE = process.env.GOODREADS_DB_PATH!;

afterAll(() => {
  closeDb();
  delete process.env.GOODREADS_DB_PATH;
  for (const suffix of ['', '-wal', '-shm']) fs.removeSync(DB_FILE + suffix);
});

beforeAll(() => {
  // genres: fantasy (exists as a scraped genre-tag), plus another genre.
  upsertGenres([{ name: 'fantasy', memberCount: 100 }, { name: 'scifi-genre', memberCount: 50 }]);
  // fantasy is a scraped tag (genre-tag)
  upsertTagBooks('fantasy', [
    { id: 'a', position: 1, shelved: 1 },
    { id: 'b', position: 2, shelved: 1 },
    { id: 'c', position: 3, shelved: 1 },
  ]);
  // scifi-genre is NOT scraped (no tag_books) — should NOT appear as a genre-tag
  // non-genre tag "tbr" shares books a, b with fantasy
  upsertTagBooks('tbr', [
    { id: 'a', position: 1, shelved: 1 },
    { id: 'b', position: 2, shelved: 1 },
  ]);
});

describe('loadTagSets split for tag-pairings direction', () => {
  it('separates genre-tags (scraped) from non-genre tags', () => {
    const { tagSets, nonGenreTags } = loadTagSets();
    // fantasy is a genre AND scraped -> in tagSets as genre-tag, NOT in nonGenreTags
    expect(tagSets.has('fantasy')).toBe(true);
    expect(nonGenreTags).toContain('tbr');
    expect(nonGenreTags).not.toContain('fantasy');
    // scifi-genre is a genre but not scraped -> absent from tagSets entirely
    expect(tagSets.has('scifi-genre')).toBe(false);
  });
});
