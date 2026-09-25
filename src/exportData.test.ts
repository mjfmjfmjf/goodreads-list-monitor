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
      db.prepare(`INSERT INTO book_page (book_id, publisher, isbn13, format, language, editions_count, scraped_at)
        VALUES ('170448', 'Penguin', '9780451524935', 'Paperback', 'English', 42, '2026-09-05T00:00:00Z')`).run();
      db.prepare(`INSERT INTO tag_stats (tag_name, last_page_seen, estimate_page, estimate_source, updated)
        VALUES ('science-fiction', 10, 25, 'histogram-ratio', '2026-09-01T00:00:00Z')`).run();
      db.prepare(`INSERT INTO lists (list_id, title, last_count, seen_book_ids, ingested, discovery_page, url)
        VALUES ('best-of-fantasy', 'Best Fantasy', 500, '["1","2"]', 1, 3, 'https://www.goodreads.com/list/show/1')`).run();

      const res = await exportBooksAndAuthors(db, { basename: 'mjf', outDir });
      expect(path.basename(res.booksFile)).toMatch(/^mjf_books_\d{8}-\d{6}\.csv\.gz$/);
      expect(path.basename(res.authorsFile)).toMatch(/^mjf_authors_\d{8}-\d{6}\.csv\.gz$/);
      expect(res.bookCount).toBe(1);
      expect(res.authorCount).toBe(1);

      // All eight shareable tables are exported (config/browser_scrape/failures/list bookkeeping excluded).
      const byTable = new Map(res.files.map(f => [f.table, f]));
      expect(byTable.get('tag_books')!.count).toBe(1);
      expect(byTable.get('genres')!.count).toBe(1);
      expect(byTable.get('genre_tag_xref')!.count).toBe(1);
      expect(byTable.get('book_page')!.count).toBe(1);
      expect(byTable.get('tag_stats')!.count).toBe(1);
      expect(byTable.get('lists')!.count).toBe(1);

      const booksCsv = parseGz(res.booksFile);
      expect(booksCsv.split('\n')[0]).toBe('id,title,author,author_id,ratings,avg_rating,published,pages,series_pos,genres,last_updated,tags,requires_auth,is_bad,fail_count,work_id,first_seen,is_work_rep');
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
      const bookPageCsv = parseGz(byTable.get('book_page')!.path);
      expect(bookPageCsv.split('\n')[0]).toBe('book_id,publisher,isbn13,isbn10,asin,format,language,description,series,reviews_count,ratings_dist,currently_reading,to_read,editions_count,scraped_at');
      expect(bookPageCsv).toContain('170448,Penguin');
      const tagStatsCsv = parseGz(byTable.get('tag_stats')!.path);
      expect(tagStatsCsv.split('\n')[0]).toBe('tag_name,last_page_seen,estimate_page,estimate_source,updated');
      expect(tagStatsCsv).toContain('science-fiction');
      const listsCsv = parseGz(byTable.get('lists')!.path);
      expect(listsCsv.split('\n')[0]).toBe('list_id,title,last_count,seen_book_ids,ingested,discovery_page,url');
      expect(listsCsv).toContain('best-of-fantasy,Best Fantasy');
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

describe('export → import round-trip preserves new tables and columns', () => {
  it('restores books.first_seen/requires_auth/fail_count, authors.fail_count, book_page, tag_stats, and lists', async () => {
    const db = getDb();
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'grdxrt-'));
    try {
      db.prepare(`INSERT INTO books (id, title, author, author_id, ratings, avg_rating, published, last_updated, requires_auth, is_bad, fail_count, work_id, first_seen)
        VALUES ('rt1', 'Round Trip', 'George Orwell', '3706', 100, 4.0, '1945', '2026-08-01', 1, 0, 4, 'w1', '2026-01-01')`).run();
      db.prepare(`INSERT INTO authors (name, id, slug, last_seen, num_ratings, fail_count)
        VALUES ('Round Trip Author', '3706', '3706.Round_Trip_Author', '2026-08-28', 10, 2)`).run();
      db.prepare(`INSERT INTO book_page (book_id, publisher, isbn13, format, language, editions_count, scraped_at)
        VALUES ('rt1', 'Secker', '9781234567897', 'Hardback', 'English', 5, '2026-09-05T00:00:00Z')`).run();
      db.prepare(`INSERT INTO tag_stats (tag_name, last_page_seen, estimate_page, estimate_source, updated)
        VALUES ('fiction', 7, 12, 'ratio', '2026-09-01T00:00:00Z')`).run();
      db.prepare(`INSERT INTO lists (list_id, title, last_count, seen_book_ids, ingested, discovery_page, url)
        VALUES ('l1', 'List One', 10, '["3","4"]', 0, 1, 'https://example.com/1')`).run();

      const res = await exportBooksAndAuthors(db, { basename: 'rt', outDir: dir });

      db.exec('DELETE FROM books; DELETE FROM authors; DELETE FROM tag_books; DELETE FROM genres; DELETE FROM genre_tag_xref; DELETE FROM book_page; DELETE FROM tag_stats; DELETE FROM lists;');

      const byTable = new Map(res.files.map(f => [f.table, f.path]));
      const counts = await importData(db, {
        booksFile: byTable.get('books')!,
        authorsFile: byTable.get('authors')!,
        tagBooksFile: byTable.get('tag_books')!,
        genresFile: byTable.get('genres')!,
        xrefFile: byTable.get('genre_tag_xref')!,
        bookPageFile: byTable.get('book_page')!,
        tagStatsFile: byTable.get('tag_stats')!,
        listsFile: byTable.get('lists')!,
      });

      // The shared test DB already holds rows from earlier tests, so the exports
// contain more than just this test's fixtures; the row-level assertions below
// are what pin the round-trip behavior.
      expect(counts.booksInserted).toBeGreaterThanOrEqual(1);
      expect(counts.authorsInserted).toBeGreaterThanOrEqual(1);
      expect(counts.bookPagesInserted).toBeGreaterThanOrEqual(1);
      expect(counts.tagStatsInserted).toBeGreaterThanOrEqual(1);
      expect(counts.listsInserted).toBeGreaterThanOrEqual(1);

      const book = db.prepare('SELECT * FROM books WHERE id=?').get('rt1') as any;
      expect(book.first_seen).toBe('2026-01-01'); // preserved, not re-stamped to import time
      expect(book.requires_auth).toBe(1);
      expect(book.fail_count).toBe(4);
      expect(book.work_id).toBe('w1');
      const author = db.prepare('SELECT * FROM authors WHERE name=?').get('Round Trip Author') as any;
      expect(author.first_seen).toBeNull(); // not exported in the fixture (null)
      expect(author.fail_count).toBe(2);
      const page = db.prepare('SELECT * FROM book_page WHERE book_id=?').get('rt1') as any;
      expect(page.publisher).toBe('Secker');
      expect(page.isbn13).toBe('9781234567897');
      expect(page.editions_count).toBe(5);
      const ts = db.prepare('SELECT * FROM tag_stats WHERE tag_name=?').get('fiction') as any;
      expect(ts.last_page_seen).toBe(7);
      expect(ts.estimate_source).toBe('ratio');
      const list = db.prepare('SELECT * FROM lists WHERE list_id=?').get('l1') as any;
      expect(JSON.parse(list.seen_book_ids)).toEqual(['3', '4']);
      expect(list.ingested).toBe(0);
    } finally {
      fs.removeSync(dir);
    }
  });

  it('keeps the newest scraped_at for book_page and unions lists.seen_book_ids on re-import', async () => {
    const db = getDb();
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'grdxrt2-'));
    try {
      db.prepare(`INSERT INTO book_page (book_id, publisher, scraped_at)
        VALUES ('7', 'Old House', '2026-09-01T00:00:00Z')`).run();
      db.prepare(`INSERT INTO lists (list_id, title, last_count, seen_book_ids, ingested, discovery_page, url)
        VALUES ('l9', 'Nine', 2, '["1","2"]', 1, 2, 'https://example.com/9')`).run();

      // Newer scrape must replace; older scrape must be skipped.
      const newer = path.join(dir, 'bp_newer.csv.gz');
      writeGz(newer, 'book_id,publisher,isbn13,isbn10,asin,format,language,description,series,reviews_count,ratings_dist,currently_reading,to_read,editions_count,scraped_at\n7,New House,,,,,,,,,,,,,2026-09-10T00:00:00Z\n');
      const counts = await importData(db, { bookPageFile: newer });
      expect(counts.bookPagesUpdated).toBe(1);
      expect((db.prepare('SELECT publisher FROM book_page WHERE book_id=?').get('7') as any).publisher).toBe('New House');

      const older = path.join(dir, 'bp_older.csv.gz');
      writeGz(older, 'book_id,publisher,isbn13,isbn10,asin,format,language,description,series,reviews_count,ratings_dist,currently_reading,to_read,editions_count,scraped_at\n7,Stale House,,,,,,,,,,,,,2026-08-01T00:00:00Z\n');
      const counts2 = await importData(db, { bookPageFile: older });
      expect(counts2.bookPagesSkipped).toBe(1);
      expect((db.prepare('SELECT publisher FROM book_page WHERE book_id=?').get('7') as any).publisher).toBe('New House');

      // lists.seen_book_ids union: merged with existing set.
      const listsFile = path.join(dir, 'lists.csv.gz');
      writeGz(listsFile, 'list_id,title,last_count,seen_book_ids,ingested,discovery_page,url\nl9,Nine,3,["3"],1,5,https://example.com/9\n');
      const counts3 = await importData(db, { listsFile });
      expect(counts3.listsUpdated).toBe(1);
      const list = db.prepare('SELECT seen_book_ids FROM lists WHERE list_id=?').get('l9') as any;
      expect(JSON.parse(list.seen_book_ids)).toEqual(['1', '2', '3']);
    } finally {
      fs.removeSync(dir);
    }
  });
});
