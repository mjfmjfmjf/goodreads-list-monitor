import { describe, expect, it, vi, afterAll } from 'vitest';

// Isolate the DB before db.js is imported.
vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-db-test-${process.pid}-${Date.now()}.db`;
});

import fs from 'fs-extra';
import { closeDb, getDb } from './db.js';

const DB_FILE = process.env.GOODREADS_DB_PATH!;

afterAll(() => {
  closeDb();
  delete process.env.GOODREADS_DB_PATH;
  for (const suffix of ['', '-wal', '-shm']) {
    fs.removeSync(DB_FILE + suffix);
  }
});

describe('database lock observability', () => {
  it('prepared statements still work through the wrapped prepare', () => {
    const db = getDb();
    db.prepare('INSERT INTO genres (name, first_seen, last_updated) VALUES (?, ?, ?)')
      .run('t-wrap', 'now', 'now');
    const row = db.prepare('SELECT name FROM genres WHERE name = ?').get('t-wrap') as any;
    expect(row.name).toBe('t-wrap');
  });

  it('does not warn or choke for fast transactions', () => {
    const db = getDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tx = db.transaction(() => {
      db.prepare('INSERT INTO genres (name, first_seen, last_updated) VALUES (?, ?, ?)')
        .run('t-fast', 'now', 'now');
    });
    tx();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('spies on statement .run/.get through the wrapper without breaking them', () => {
    const db = getDb();
    // The wrapped prepare returns a statement whose .run is a closure; calling it
    // multiple times must remain correct (no state leak across calls).
    const stmt = db.prepare('INSERT INTO genres (name, first_seen, last_updated) VALUES (?, ?, ?)');
    stmt.run('t-1', 'now', 'now');
    stmt.run('t-2', 'now', 'now');
    expect(db.prepare('SELECT COUNT(*) AS c FROM genres WHERE name IN (?, ?)').get('t-1', 't-2')).toEqual({ c: 2 });
  });
});