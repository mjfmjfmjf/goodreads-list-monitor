import fs from 'fs-extra';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-tagpairing-${process.pid}-${Date.now()}.db`;
});

import { closeDb, getDb } from './db.js';
import { upsertGenres, upsertTagBooks, upsertGenreTagXref, loadGenreTagXref } from './storage.js';
import { loadTagSets } from './genrePairings.js';
import { computeTagPairings, writeSimilarityXref } from './tagPairings.js';

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

describe('computeTagPairings with --minJaccard', () => {
  // tbr (a,b) vs genre-tag fantasy (a,b,c): overlap 2 / union 3 = 66.7% Jaccard
  const capture = () => {
    const out: string[] = [];
    const orig = console.log;
    const strip = (s: string) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
    console.log = (...args: any[]) => out.push(args.map(strip).join(' '));
    return {
      out: () => out.join('\n'),
      restore: () => { console.log = orig; },
    };
  };

  it('skips a tag entirely when its best match is below the threshold', () => {
    const c = capture();
    try {
      computeTagPairings({ minJaccard: '70' });
      const out = c.out();
      expect(out).not.toContain('── tbr');
      expect(out).toContain('min match 70%');
      expect(out).toContain('0 tag(s) with a genre match ≥ 70% · 1 tag(s) skipped');
    } finally {
      c.restore();
    }
  });

  it('keeps only the matches at/above the threshold', () => {
    const c = capture();
    try {
      computeTagPairings({ minJaccard: '50' });
      const out = c.out();
      expect(out).toContain('── tbr');
      expect(out).toContain('66.7%');
      expect(out).toContain('fantasy');
      expect(out).toContain('1 tag(s) with a genre match ≥ 50% · 0 tag(s) skipped');
    } finally {
      c.restore();
    }
  });
});

describe('writeSimilarityXref (tag-pairings --loadXref)', () => {
  it('maps each qualifying tag to its best genre (kind=similarity), skipping below-bar', () => {
    // tbr vs fantasy = 66.7%; below 70 no rows, at 50 one row
    expect(writeSimilarityXref(70).added).toEqual([]);
    const res = writeSimilarityXref(50);
    expect(res.added.length).toBe(1);
    expect(res.added[0]).toMatchObject({ tag: 'tbr', genre: 'fantasy', pct: 66.67, books: 2 });
    expect(res.skipped).toBe(0);
    const rows = loadGenreTagXref().filter(x => x.tagName === 'tbr');
    expect(rows).toEqual([{ genreName: 'fantasy', tagName: 'tbr', kind: 'similarity' }]);
  });

  it('rebuild is idempotent: unchanged rows are reported as kept, not re-added', () => {
    const res = writeSimilarityXref(50);
    expect(res.added).toEqual([]);
    expect(res.kept).toBe(1);
    const rows = loadGenreTagXref().filter(x => x.tagName === 'tbr');
    expect(rows).toEqual([{ genreName: 'fantasy', tagName: 'tbr', kind: 'similarity' }]);
  });

  it('prunes a stale row whose tag falls below the bar', () => {
    // tbr qualifies at 50% (66.7%) — first load creates the row
    writeSimilarityXref(50);
    // now raise the bar above tbr's 66.7%: the prior row must be removed
    const res = writeSimilarityXref(80);
    expect(res.removed).toEqual([expect.objectContaining({ tag: 'tbr', oldGenre: 'fantasy' })]);
    expect(loadGenreTagXref().filter(x => x.tagName === 'tbr')).toEqual([]);
  });

  it('re-points a tag whose best genre changed', () => {
    // tbr qualifies at 50% (66.7% vs fantasy). Add a new genre-tag that tbr
    // overlaps MORE with, bump it into the xref, then re-point must occur.
    // seed tbr → fantasy at 50% (66.7%) BEFORE legend exists
    writeSimilarityXref(50);
    upsertGenres([{ name: 'legend', memberCount: 100 }]);
    upsertTagBooks('legend', [
      { id: 'a', position: 1, shelved: 1 },
      { id: 'b', position: 2, shelved: 1 },
    ]);
    // tbr (a,b) vs legend (a,b): overlap 2 / union 2 = 100% > fantasy 66.7%
    const res = writeSimilarityXref(50);
    const changed = res.changed.filter(c => c.tag === 'tbr');
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ oldGenre: 'fantasy', genre: 'legend', pct: 100, books: 2 });
    expect(loadGenreTagXref().filter(x => x.tagName === 'tbr')).toEqual([{ genreName: 'legend', tagName: 'tbr', kind: 'similarity' }]);
  });

  it('never touches curated exact/cognate rows and does not shadow them', () => {
    // curated: tag "mythic" → legend (cognate-style). Run the loader at a bar
    // that would otherwise create a similarity row for mythic → legend.
    upsertGenreTagXref('mythic', 'legend', 'exact');
    upsertTagBooks('mythic', [
      { id: 'a', position: 1, shelved: 1 },
      { id: 'b', position: 2, shelved: 1 },
    ]);
    const res = writeSimilarityXref(50);
    expect(res.curatedKept).toBeGreaterThan(0);
    expect(res.added.some(c => c.tag === 'mythic')).toBe(false);
    const rows = loadGenreTagXref().filter(x => x.tagName === 'mythic');
    expect(rows).toEqual([{ genreName: 'legend', tagName: 'mythic', kind: 'exact' }]);
  });

  it('drops a curated tag\'s stale similarity orphan without touching its curated row', () => {
    // the old upsert bug: a tag gets BOTH a curated row and a leftover
    // similarity row for a different genre — the syncer must drop the orphan.
    upsertGenreTagXref('mythic', 'legend', 'exact');
    upsertTagBooks('mythic', [
      { id: 'a', position: 1, shelved: 1 },
      { id: 'b', position: 2, shelved: 1 },
    ]);
    getDb().prepare('INSERT INTO genre_tag_xref (genre_name, tag_name, kind) VALUES (?, ?, ?)').run('fantasy', 'mythic', 'similarity');
    const res = writeSimilarityXref(50);
    expect(res.removed).toContainEqual(expect.objectContaining({ tag: 'mythic', oldGenre: 'fantasy' }));
    const rows = loadGenreTagXref().filter(x => x.tagName === 'mythic');
    expect(rows).toEqual([{ genreName: 'legend', tagName: 'mythic', kind: 'exact' }]);
  });

  it('--loadXref syncs and exits without the match listing', () => {
    const out: string[] = [];
    const orig = console.log;
    const strip = (s: string) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
    console.log = (...args: any[]) => out.push(args.map(strip).join(' '));
    try {
      computeTagPairings({ loadXref: '50' });
      const joined = out.join('\n');
      expect(joined).toContain('Synced tag→genre xref (kind=similarity) against pairings ≥ 50%');
      expect(joined).toContain('kept');
      expect(joined).not.toContain('── tbr');
    } finally {
      console.log = orig;
    }
  });
});
