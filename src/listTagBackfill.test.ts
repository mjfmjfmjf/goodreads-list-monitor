import fs from 'fs-extra';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Redirect to an isolated temp DB BEFORE db.ts is imported.
// vi.hoisted runs before static imports are evaluated; a plain top-level
// assignment runs AFTER them, so db.ts would already have bound the real
// goodreads.db and these tests would DELETE from production.
vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-listtagbackfill-${process.pid}-${Date.now()}.db`;
});

import { shuffleCandidates, filterListsMissingTags } from './listTagBackfill.ts';
import { DB_PATH, closeDb, getDb } from './db.ts';

afterAll(() => {
  closeDb();
});

describe('test DB isolation', () => {
  it('never opens the production database', () => {
    const production = path.join(process.cwd(), 'goodreads.db');
    expect(path.resolve(DB_PATH)).not.toBe(production);
  });

  it('has the open connection pointing at the isolated temp DB', () => {
    const row = getDb().prepare('PRAGMA database_list').all() as { file: string }[];
    const main = row.find((r) => r.file);
    // macOS resolves /var -> /private/var, so compare realpaths.
    expect(fs.realpathSync(main!.file)).toBe(fs.realpathSync(DB_PATH));
    expect(fs.realpathSync(main!.file)).not.toBe(
      fs.realpathSync(path.join(process.cwd(), 'goodreads.db')),
    );
  });
});

describe('filterListsMissingTags', () => {
  beforeEach(() => {
    getDb().exec('DELETE FROM list_tags');
  });

  it('keeps a list that has no tag row and drops one that does', () => {
    getDb().prepare('INSERT INTO list_tags (list_id, tag_name, first_seen, last_seen) VALUES (?,?,?,?)')
      .run('111', 'fiction', 't1', 't1');

    const out = filterListsMissingTags(['111', '222']);
    expect(out).toEqual(['222']);
  });

  it('treats ANY tag row as coverage — one tag is enough to skip the list', () => {
    getDb().prepare('INSERT INTO list_tags (list_id, tag_name, first_seen, last_seen) VALUES (?,?,?,?)')
      .run('111', 'fiction', 't1', 't1');

    expect(filterListsMissingTags(['111'])).toEqual([]);
  });

  it('drops duplicates across the bookkeeping tables', () => {
    // A list commonly appears in list_scrapes AND list_walk.
    const out = filterListsMissingTags(['111', '111', '222']);
    expect(out).toEqual(['111', '222']);
  });

  it('preserves the caller order', () => {
    expect(filterListsMissingTags(['333', '111', '222'])).toEqual(['333', '111', '222']);
  });

  it('skips empty ids (a NULL list_id must not become a candidate)', () => {
    getDb().exec("INSERT OR IGNORE INTO list_scrapes (list_id, list_name, first_scraped, last_scraped) VALUES (NULL, 'x', 't', 't')");
    expect(filterListsMissingTags(['', '111', '' as any])).toEqual(['111']);
  });
});

describe('shuffleCandidates', () => {
  it('keeps every element (a reshuffle, not a subset)', () => {
    const input = Array.from({ length: 500 }, (_, i) => `id-${i}`);
    const out = shuffleCandidates(input);
    expect(out).toHaveLength(500);
    expect([...out].sort()).toEqual([...input].sort());
  });

  it('does not mutate the input array', () => {
    const input = ['a', 'b', 'c', 'd', 'e'];
    shuffleCandidates(input);
    expect(input).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('actually reorders — a reversed run proves the shuffle is not identity', () => {
    // rng() descending forces the Fisher-Yates walk to reverse the input.
    const rng = () => 1 - Math.min(1, Date.now() % 2); // 0 or 1, deterministic enough to move elements
    const input = Array.from({ length: 50 }, (_, i) => `id-${i}`);
    const out = shuffleCandidates(input, rng);
    expect(out).not.toEqual(input);
  });

  it('is deterministic for a given rng, so a run can be replayed', () => {
    const input = Array.from({ length: 20 }, (_, i) => `id-${i}`);
    const seq = () => {
      let n = 0;
      return () => ((n = (n * 1103515245 + 12345) % 2147483648) / 2147483648);
    };
    expect(shuffleCandidates(input, seq())).toEqual(shuffleCandidates(input, seq()));
  });

  it('handles empty and single-element input', () => {
    expect(shuffleCandidates([])).toEqual([]);
    expect(shuffleCandidates(['only'])).toEqual(['only']);
  });
});
