import { describe, it, expect, vi, afterAll } from 'vitest';

vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-workreps-test-${process.pid}-${Date.now()}.db`;
});

import { closeDb, getDb, recomputeWorkReps, refreshWorkRep } from './db.js';

afterAll(() => {
  closeDb();
  delete process.env.GOODREADS_DB_PATH;
});

const insert = (id: string, workId: string | null, ratings: number) => {
  getDb().prepare(
    `INSERT INTO books (id, title, author, author_id, work_id, ratings, avg_rating, published, last_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, `Title ${id}`, 'A', 'a1', workId, ratings, 4.0, '2000', '2026-01-01T00:00:00Z');
};

const reps = (): Set<string> => {
  const rows = getDb().prepare('SELECT id FROM books WHERE is_work_rep = 1').all() as Array<{ id: string }>;
  return new Set(rows.map(r => r.id));
};

describe('work representative de-dup (is_work_rep)', () => {
  it('recomputeWorkReps picks the highest-ratings edition of each work, lowest id on tie', () => {
    insert('2', 'w1', 1000);
    insert('1', 'w1', 5000);
    insert('3', 'w1', 5000);
    insert('4', 'w1', 3000);
    recomputeWorkReps();
    expect(reps()).toEqual(new Set(['1']));
  });

  it('recomputeWorkReps never marks rows without a work id', () => {
    insert('5', null, 999999);
    recomputeWorkReps();
    expect(reps()).toEqual(new Set(['1']));
  });

  it('refreshWorkRep keeps a single work current without touching others', () => {
    insert('6', 'w2', 100);
    insert('7', 'w2', 200);
    refreshWorkRep(getDb(), 'w2');
    expect(reps()).toEqual(new Set(['1', '7']));

    // A new higher-rated edition takes over the rep slot; the loser clears.
    insert('8', 'w2', 300);
    refreshWorkRep(getDb(), 'w2');
    expect(reps()).toEqual(new Set(['1', '8']));

    // Other works are untouched.
    expect(reps().has('6')).toBe(false);
    expect(reps().has('7')).toBe(false);
  });
});