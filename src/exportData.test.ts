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
import { importData } from './importData.js';

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

function writeGz(file: string, csv: string): void {
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(csv, 'utf8')));
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
      db.prepare(`INSERT INTO tag_books (tag_name, book_id, position, shelved, harvested_at)
        VALUES ('to-read', '170448', 1, 100, '2026-08-28T00:00:00Z')`).run();
      db.prepare(`INSERT INTO genres (name, member_count, first_seen, last_updated)
        VALUES ('fiction', 1000000, '2026-08-28', '2026-08-28')`).run();
      db.prepare(`INSERT INTO genre_tag_xref (genre_name, tag_name, kind)
        VALUES ('fiction', 'fiction', 'exact')`).run();

      const res = await exportBooksAndAuthors(db, { basename: 'mjf', outDir });
      expect(path.basename(res.booksFile)).toMatch(/^mjf_books_\d{8}-\d{6}\.csv\.gz$/);
      expect(path.basename(res.authorsFile)).toMatch(/^mjf_authors_\d{8}-\d{6}\.csv\.gz$/);
      expect(res.bookCount).toBe(1);
      expect(res.authorCount).toBe(1);

      // All five shareable tables are exported (list/config/failures excluded).
      const byTable = new Map(res.files.map(f => [f.table, f]));
      expect(byTable.get('tag_books')!.count).toBe(1);
      expect(byTable.get('genres')!.count).toBe(1);
      expect(byTable.get('genre_tag_xref')!.count).toBe(1);

      const booksCsv = parseGz(res.booksFile);
      expect(booksCsv.split('\n')[0]).toBe('id,title,author,author_id,ratings,avg_rating,published,pages,series_pos,genres,last_updated,tags,requires_auth,is_bad,fail_count,work_id');
      expect(booksCsv).toContain('170448,Animal Farm');
      const authorsCsv = parseGz(res.authorsFile);
      expect(authorsCsv.split('\n')[0]).toBe('name,id,slug,last_seen,average_rating,num_ratings,num_reviews,num_shelves,first_seen,catalog_pages,fail_count,last_error');
      expect(authorsCsv).toContain('George Orwell,3706');

      const tagCsv = parseGz(byTable.get('tag_books')!.path);
      expect(tagCsv.split('\n')[0]).toBe('tag_name,book_id,position,shelved,harvested_at');
      expect(tagCsv).toContain('to-read,170448');
      const genreCsv = parseGz(byTable.get('genres')!.path);
      expect(genreCsv.split('\n')[0]).toBe('name,member_count,first_seen,last_updated');
      expect(genreCsv).toContain('fiction');
      const xrefCsv = parseGz(byTable.get('genre_tag_xref')!.path);
      expect(xrefCsv.split('\n')[0]).toBe('genre_name,tag_name,kind');
      expect(xrefCsv).toContain('fiction,fiction,exact');
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

describe('import of new tables (fill-blank, don\'t replace good data)', () => {
  it('keeps a good tag_books position/shelved when the imported row is blank', async () => {
    const db = getDb();
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'grdximp-'));
    try {
      db.prepare(`INSERT INTO tag_books (tag_name, book_id, position, shelved, harvested_at)
        VALUES ('history', '991', 5, 300, '2026-08-01T00:00:00Z')`).run();
      const file = path.join(dir, 'tag_books.csv.gz');
      // Imported row has blank position/shelved (older/fresh scrape) — must not clobber 5/300.
      writeGz(file, 'tag_name,book_id,position,shelved,harvested_at\nhistory,991,,,2026-08-28T00:00:00Z\n');
      const counts = await importData(db, { tagBooksFile: file });
      expect(counts.tagBooksUpdated).toBe(1);
      const row = db.prepare('SELECT * FROM tag_books WHERE tag_name=? AND book_id=?').get('history', '991') as any;
      expect(row.position).toBe(5);
      expect(row.shelved).toBe(300);
      expect(row.harvested_at).toBe('2026-08-28T00:00:00Z');
    } finally {
      fs.removeSync(dir);
    }
  });

  it('inserts a new tag_books row when absent', async () => {
    const db = getDb();
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'grdximp2-'));
    try {
      const file = path.join(dir, 'tag_books.csv.gz');
      writeGz(file, 'tag_name,book_id,position,shelved,harvested_at\ngraphic-novels,42,1,,2026-08-28T00:00:00Z\n');
      const counts = await importData(db, { tagBooksFile: file });
      expect(counts.tagBooksInserted).toBe(1);
      const row = db.prepare('SELECT * FROM tag_books WHERE tag_name=? AND book_id=?').get('graphic-novels', '42') as any;
      expect(row.position).toBe(1);
      expect(row.shelved).toBeNull();
    } finally {
      fs.removeSync(dir);
    }
  });

  it("prefers an 'exact' xref kind and never downgrades it", async () => {
    const db = getDb();
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'grdximp3-'));
    try {
      db.prepare(`INSERT INTO genre_tag_xref (genre_name, tag_name, kind) VALUES ('sf', 'science-fiction', 'exact')`).run();
      const file = path.join(dir, 'xref.csv.gz');
      writeGz(file, 'genre_name,tag_name,kind\nsf,science-fiction,cognate\nnew-genre,new-tag,cognate\n');
      const counts = await importData(db, { xrefFile: file });
      expect(counts.xrefUpdated).toBe(1);
      expect(counts.xrefInserted).toBe(1);
      expect((db.prepare('SELECT kind FROM genre_tag_xref WHERE genre_name=? AND tag_name=?').get('sf', 'science-fiction') as any).kind).toBe('exact');
      expect((db.prepare('SELECT kind FROM genre_tag_xref WHERE genre_name=? AND tag_name=?').get('new-genre', 'new-tag') as any).kind).toBe('cognate');
    } finally {
      fs.removeSync(dir);
    }
  });

  it('keeps the newest genre first_seen oldest / last_updated newest', async () => {
    const db = getDb();
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'grdximp4-'));
    try {
      db.prepare(`INSERT INTO genres (name, member_count, first_seen, last_updated)
        VALUES ('fantasy', 500000, '2026-06-01', '2026-08-01')`).run();
      const file = path.join(dir, 'genres.csv.gz');
      writeGz(file, 'name,member_count,first_seen,last_updated\nfantasy,999999,2026-09-01,2026-09-01\n');
      const counts = await importData(db, { genresFile: file });
      expect(counts.genresUpdated).toBe(1);
      const row = db.prepare('SELECT * FROM genres WHERE name=?').get('fantasy') as any;
      expect(row.member_count).toBe(500000); // fill-blank-only: existing good value kept
      expect(row.first_seen).toBe('2026-06-01'); // oldest kept
      expect(row.last_updated).toBe('2026-09-01'); // newest kept
    } finally {
      fs.removeSync(dir);
    }
  });
});
