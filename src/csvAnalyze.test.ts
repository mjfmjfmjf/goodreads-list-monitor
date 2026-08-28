import fs from 'fs-extra';
import path from 'path';
import zlib from 'zlib';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Isolate the DB before db.js is imported.
vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-analyze-test-${process.pid}-${Date.now()}.db`;
});

import { closeDb, getDb } from './db.js';
import { exportBooksAndAuthors } from './exportData.js';
import { analyzeCsv } from './csvAnalyze.js';

const DB_FILE = process.env.GOODREADS_DB_PATH!;

function gzWrite(file: string, content: string): void {
  fs.writeFileSync(file, zlib.gzipSync(content));
}

afterAll(() => {
  closeDb();
  delete process.env.GOODREADS_DB_PATH;
  for (const suffix of ['', '-wal', '-shm']) {
    fs.removeSync(DB_FILE + suffix);
  }
});

describe('analyzeCsv', () => {
  it('reports rows, columns, and per-field stats', async () => {
    const f = path.join(process.env.TMPDIR || '/tmp', `ana-${Date.now()}.csv.gz`);
    try {
      gzWrite(f, 'id,title,ratings,genres\n1,One,100,["Fiction"]\n2,Two,200,["Fiction"]\n3,,300,\n');
      const a = await analyzeCsv(f);
      expect(a.rowCount).toBe(3);
      expect(a.colCount).toBe(4);
      const title = a.fields.find(x => x.name === 'title')!;
      expect(title.populated).toBe(2);
      const ratings = a.fields.find(x => x.name === 'ratings')!;
      expect(ratings.type).toBe('number');
      expect(ratings.numericMin).toBe('100');
      expect(ratings.numericMax).toBe('300');
      const genres = a.fields.find(x => x.name === 'genres')!;
      expect(genres.type).toBe('json');
    } finally {
      fs.removeSync(f);
    }
  });

  it('reads a plain (non-gzipped) CSV file', async () => {
    const f = path.join(process.env.TMPDIR || '/tmp', `anaplain-${Date.now()}.csv`);
    try {
      fs.writeFileSync(f, 'id,title,ratings\n1,One,100\n2,Two,200\n');
      const a = await analyzeCsv(f);
      expect(a.rowCount).toBe(2);
      expect(a.colCount).toBe(3);
      expect(a.fields.find(x => x.name === 'title')!.populated).toBe(2);
    } finally {
      fs.removeSync(f);
    }
  });

  it('analyzes a real exported gz file', async () => {
    const outDir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'anaexp-'));
    try {
      const db = getDb();
      db.prepare(`INSERT INTO authors (name, id, slug, last_seen, num_ratings) VALUES ('George Orwell','3706','3706.George_Orwell','2026-08-28',11249733)`).run();
      db.prepare(`INSERT INTO books (id, title, author, author_id, ratings, avg_rating, published, genres, last_updated) VALUES ('X','Animal Farm','George Orwell','3706',4784802,4.03,'1945','["Fiction","Classics"]','2026-08-28')`).run();
      const res = await exportBooksAndAuthors(db, { basename: 't', outDir });
      const a = await analyzeCsv(res.booksFile);
      expect(a.rowCount).toBe(1);
      expect(a.fields.find(f => f.name === 'genres')!.type).toBe('json');
      expect(a.fields.find(f => f.name === 'ratings')!.numericMin).toBe('4784802');
    } finally {
      fs.removeSync(outDir);
    }
  });
});
