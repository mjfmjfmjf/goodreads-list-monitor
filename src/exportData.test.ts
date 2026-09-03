import fs from 'fs-extra';
import path from 'path';
import zlib from 'zlib';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Isolate the DB before db.js is imported.
vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-export-test-${process.pid}-${Date.now()}.db`;
});

import { closeDb, getDb } from './db.js';
import { exportBooksAndAuthors } from './exportData.js';

const DB_FILE = process.env.GOODREADS_DB_PATH!;

afterAll(() => {
  closeDb();
  delete process.env.GOODREADS_DB_PATH;
  for (const suffix of ['', '-wal', '-shm']) {
    fs.removeSync(DB_FILE + suffix);
  }
});

function parseGz(file: string): string {
  return zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
}

describe('exportBooksAndAuthors', () => {
  it('exports books and authors as gzipped CSVs with header + rows', async () => {
    const db = getDb();
    const outDir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'grdx-'));
    try {
      db.prepare(`INSERT INTO authors (name, id, slug, last_seen, num_ratings) VALUES
        ('George Orwell', '3706', '3706.George_Orwell', '2026-08-28', 11249733)`).run();
      db.prepare(`INSERT INTO books (id, title, author, author_id, ratings, published, last_updated)
        VALUES ('170448', 'Animal Farm', 'George Orwell', '3706', 4784802, '1945', '2026-08-28')`).run();

      const res = await exportBooksAndAuthors(db, { basename: 'mjf', outDir });
      expect(path.basename(res.booksFile)).toMatch(/^mjf_books_\d{8}-\d{6}\.csv\.gz$/);
      expect(path.basename(res.authorsFile)).toMatch(/^mjf_authors_\d{8}-\d{6}\.csv\.gz$/);
      expect(res.bookCount).toBe(1);
      expect(res.authorCount).toBe(1);

      const booksCsv = parseGz(res.booksFile);
      expect(booksCsv.split('\n')[0]).toBe('id,title,author,author_id,ratings,avg_rating,published,pages,series_pos,genres,last_updated,tags,requires_auth,is_bad,fail_count,work_id');
      expect(booksCsv).toContain('170448,Animal Farm');
      const authorsCsv = parseGz(res.authorsFile);
      expect(authorsCsv.split('\n')[0]).toBe('name,id,slug,last_seen,average_rating,num_ratings,num_reviews,num_shelves,first_seen,catalog_pages,fail_count,last_error');
      expect(authorsCsv).toContain('George Orwell,3706');
    } finally {
      fs.removeSync(outDir);
    }
  });

  it('escapes CSV special characters in field values', async () => {
    const db = getDb();
    const outDir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'grdxesc-'));
    try {
      db.prepare(`INSERT INTO books (id, title, author, published, last_updated)
        VALUES ('esc1', 'A "quoted", "titled" book', 'Some, "Author"', 'Unknown', '2026-08-28')`).run();

      const res = await exportBooksAndAuthors(db, { basename: 'esc', outDir });
      const csv = parseGz(res.booksFile);
      expect(csv).toContain('"A ""quoted"", ""titled"" book","Some, ""Author"""');
    } finally {
      fs.removeSync(outDir);
    }
  });

  it('rejects an empty or unsafe basename', async () => {
    const db = getDb();
    await expect(exportBooksAndAuthors(db, { basename: '' })).rejects.toThrow();
    await expect(exportBooksAndAuthors(db, { basename: '../evil' })).rejects.toThrow();
  });
});
