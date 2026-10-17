import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-backfill-seriespos-test-${process.pid}-${Date.now()}.db`;
});

import { closeDb, getDb } from './db.ts';
import { runBackfillSeriesPos, CHUNK } from './backfillSeriesPos.ts';

function insertBook(id: string, title: string, seriesPos: number | null = null) {
  getDb().prepare(`
    INSERT INTO books (id, title, author, author_id, ratings, avg_rating, published, last_updated, series_pos)
    VALUES (?, ?, 'A', 'a1', 10, 4.0, '2000', ?, ?)
  `).run(id, title, '2026-09-05T00:00:00Z', seriesPos);
}

function pos(id: string): number | null {
  return (getDb().prepare('SELECT series_pos AS s FROM books WHERE id = ?').get(id) as any).s;
}

let logs: string;

beforeEach(() => {
  logs = '';
  vi.spyOn(console, 'log').mockImplementation((...args) => {
    logs += args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n';
  });
  getDb().prepare('DELETE FROM books').run();
  logs = '';
});

afterAll(() => {
  closeDb();
  delete process.env.GOODREADS_DB_PATH;
  vi.restoreAllMocks();
});

describe('runBackfillSeriesPos', () => {
  it('fills, corrects, and clears series positions without throwing', async () => {
    insertBook('b1', 'Foo (Bar, #3)', null);   // fill → 3
    insertBook('b2', 'Foo (Bar, #4)', 2);       // correct → 4
    insertBook('b3', 'Standalone Book', 5);     // clear → NULL
    insertBook('b4', 'Standalone Book Two', null); // no-op
    insertBook('b5', 'Unknown', null);          // skipped
    insertBook('b6', 'Berserk, Vol. 12', null); // fill → 12 (manga form)

    await runBackfillSeriesPos();

    expect(pos('b1')).toBe(3);
    expect(pos('b2')).toBe(4);
    expect(pos('b3')).toBeNull();
    expect(pos('b4')).toBeNull();
    expect(pos('b5')).toBeNull();
    expect(pos('b6')).toBe(12);

    expect(logs).toMatch(/Filled:.*2.*books/);
    expect(logs).toMatch(/Corrected:.*1.*books/);
    expect(logs).toMatch(/Cleared:.*1.*books/);
  });

  it('processes every row across a keyset chunk boundary', async () => {
    const n = CHUNK + 1;
    const db = getDb();
    db.transaction(() => {
      for (let i = 0; i < n; i++) {
        insertBook(String(i).padStart(6, '0'), `Book (Ser, #${i + 1})`, null);
      }
    })();

    await runBackfillSeriesPos();

    const filled = (getDb().prepare('SELECT COUNT(*) AS c FROM books WHERE series_pos IS NOT NULL').get() as any).c;
    expect(filled).toBe(n);
  });

  it('is idempotent on a second run', async () => {
    insertBook('b1', 'Foo (Bar, #3)', null);
    await runBackfillSeriesPos();

    logs = '';
    await runBackfillSeriesPos();
    expect(logs).toMatch(/Filled:.*0.*books/);
    expect(logs).toMatch(/Corrected:.*0.*books/);
    expect(logs).toMatch(/Cleared:.*0.*books/);
  });
});
