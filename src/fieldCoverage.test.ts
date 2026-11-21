import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, afterAll } from 'vitest';
import { computeFieldStats, formatCoverageLine, runFieldCoverage, REPORTED_TABLES, IGNORED_TABLES } from './fieldCoverage.ts';
import chalk from 'chalk';

vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-fieldcoverage-test-${process.pid}-${Date.now()}.db`;
});

import { closeDb, getDb } from './db.ts';

afterAll(() => {
  closeDb();
  delete process.env.GOODREADS_DB_PATH;
});

describe('computeFieldStats', () => {
  it('maps SQL aggregate rows to FieldStats with numeric coercion', () => {
    const stats = computeFieldStats({ work_id: 12, genres: null }, 20);
    expect(stats).toEqual([
      { field: 'work_id', populated: 12, total: 20, distinct: undefined },
      { field: 'genres', populated: 0, total: 20, distinct: undefined },
    ]);
  });

  it('attaches distinct counts when a distinct map is provided', () => {
    const stats = computeFieldStats(
      { work_id: 12, pages: 5 },
      20,
      { work_id: 11, pages: 4 },
    );
    expect(stats).toEqual([
      { field: 'work_id', populated: 12, total: 20, distinct: 11 },
      { field: 'pages', populated: 5, total: 20, distinct: 4 },
    ]);
  });

  it('omits distinct for fields missing from the distinct map', () => {
    const stats = computeFieldStats({ work_id: 12, pages: 5 }, 20, { work_id: 11 });
    expect(stats.find(s => s.field === 'pages')?.distinct).toBeUndefined();
  });
});

describe('formatCoverageLine', () => {
  it('shows percent and missing count', () => {
    chalk.level = 0;
    expect(formatCoverageLine({ field: 'work_id', populated: 5, total: 10 })).toContain('50.0%');
    expect(formatCoverageLine({ field: 'work_id', populated: 5, total: 10 })).toContain('(5 missing)');
  });

  it('marks complete fields', () => {
    chalk.level = 0;
    expect(formatCoverageLine({ field: 'title', populated: 100, total: 100 })).toContain('✓ complete');
  });

  it('shows distinct count when present', () => {
    chalk.level = 0;
    expect(formatCoverageLine({ field: 'work_id', populated: 10, total: 20, distinct: 8 })).toContain('8 distinct');
  });

  it('shows numeric min/max/avg when present', () => {
    chalk.level = 0;
    const line = formatCoverageLine({
      field: 'num_books', populated: 100, total: 100,
      min: 1, max: 1137, avg: 47.25, distinct: 42,
    });
    expect(line).toContain('min 1');
    expect(line).toContain('max 1,137');
    expect(line).toContain('avg 47.3');
    expect(line).toContain('42 distinct');
  });

  it('shows a lexical range for date-like strings without an average', () => {
    chalk.level = 0;
    const line = formatCoverageLine({
      field: 'created_at', populated: 99, total: 100,
      min: '2011-03-04', max: '2026-11-08', distinct: 1876,
    });
    expect(line).toContain('min 2011-03-04');
    expect(line).toContain('max 2026-11-08');
    expect(line).not.toContain('avg');
    expect(line).toContain('1,876 distinct');
  });
});

describe('runFieldCoverage', () => {
  it('treats 0 ratings as present and prints a separate zero-rating count', async () => {
    const db = getDb();
    const now = '2026-09-10T00:00:00Z';
    db.prepare(
      `INSERT INTO books (id, title, author, author_id, ratings, avg_rating, published, last_updated, first_seen)
       VALUES ('r1', 'Rated Book', 'A', 'a1', 1200, 4.2, '2001', @now, @now),
              ('z1', 'Zero Book', 'B', 'a2', 0, 0, '2002', @now, @now)`
    ).run({ now });

    chalk.level = 0;
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runFieldCoverage();
    const lines = out.mock.calls.map((c) => c.join(' '));
    out.mockRestore();

    const ratingsLine = lines.find((l) => l.includes('ratings') && l.includes('%'));
    expect(ratingsLine).toContain('100.0%');
    expect(ratingsLine).toContain('✓ complete');
    const zeroLine = lines.find((l) => l.includes('ratings_zero'));
    expect(zeroLine).toContain('1');
    expect(zeroLine).toContain('0 ratings');
  });

  it('prints the list_scrapes ledger section when the table exists', async () => {
    const db = getDb();
    db.exec('DELETE FROM list_scrapes;');
    const ins = db.prepare(
      'INSERT INTO list_scrapes (list_id, list_name, first_scraped, last_scraped, num_scraped, num_books_scraped) VALUES (?, ?, ?, ?, ?, ?)'
    );
    ins.run('1', 'A', '2026-09-09T10:00:00Z', '2026-09-09T10:00:00Z', 1, 10);
    ins.run('2', 'B', '2026-09-10T10:00:00Z', '2026-09-12T10:00:00Z', 2, 20);

    chalk.level = 0;
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runFieldCoverage();
    const lines = out.mock.calls.map((c) => c.join(' '));
    out.mockRestore();

    const header = lines.find((l) => l.includes('List-tag walk ledger coverage'));
    expect(header).toBeTruthy();
    const total = lines.find((l) => l.includes('total lists'));
    expect(total).toContain('2');
    const rescraped = lines.find((l) => l.includes('re-scraped'));
    expect(rescraped).toContain('1');
    const range = lines.find((l) => l.includes('first scrape range'));
    expect(range).toContain('09-09');
    expect(range).toContain('09-10');
    const latest = lines.find((l) => l.includes('latest scrape'));
    expect(latest).toContain('09-12');
    const numScraped = lines.find((l) => l.startsWith('  num_scraped'))!;
    expect(numScraped).toContain('min 1');
    expect(numScraped).toContain('max 2');
    expect(numScraped).toContain('avg 1.5');
    expect(numScraped).toContain('2 distinct');

    const numBooks = lines.find((l) => l.startsWith('  num_books_scraped'))!;
    expect(numBooks).toContain('min 10');
    expect(numBooks).toContain('max 20');
    expect(numBooks).toContain('avg 15.0');
    expect(numBooks).toContain('2 distinct');
  });

  it('prints the list-tag harvest section with known/tagged/remaining', async () => {
    const db = getDb();
    db.exec('DELETE FROM list_scrapes; DELETE FROM list_tags; DELETE FROM lists;');
    const now = '2026-10-07T00:00:00Z';
    db.prepare(
      'INSERT INTO list_scrapes (list_id, list_name, first_scraped, last_scraped) VALUES (?, ?, ?, ?)'
    ).run('10', 'A', now, now);
    db.prepare(
      'INSERT INTO list_scrapes (list_id, list_name, first_scraped, last_scraped) VALUES (?, ?, ?, ?)'
    ).run('20', 'B', now, now);
    db.prepare(
      'INSERT INTO list_tags (list_id, tag_name, first_seen, last_seen) VALUES (?, ?, ?, ?)'
    ).run('10', 'fiction', now, now);
    db.prepare(
      'INSERT INTO list_tags (list_id, tag_name, first_seen, last_seen) VALUES (?, ?, ?, ?)'
    ).run('10', 'classics', now, now);
    db.prepare(
      'INSERT INTO lists (list_id, title) VALUES (?, ?)'
    ).run('30', 'Monitored');

    chalk.level = 0;
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runFieldCoverage();
    const lines = out.mock.calls.map((c) => c.join(' '));
    out.mockRestore();

    const header = lines.find((l) => l.includes('List-tag harvest coverage'));
    expect(header).toBeTruthy();
    const known = lines.find((l) => l.includes('known lists'));
    expect(known).toContain('3'); // list_scrapes 10, 20 + lists 30
    const tagged = lines.find((l) => l.includes('tagged'));
    expect(tagged).toContain('1'); // only list 10 carries tags
    expect(tagged).toContain('33.3%');
    expect(tagged).toContain('2 remaining');
    const tagRows = lines.find((l) => l.includes('tag rows'));
    expect(tagRows).toContain('2'); // fiction + classics
    expect(tagRows).toContain('2 distinct tags');
  });

  it('shows distinct publisher/format/language counts in the book-page section', async () => {
    const db = getDb();
    const now = '2026-09-10T00:00:00Z';
    const ins = db.prepare(
      'INSERT INTO book_page (book_id, publisher, format, language, scraped_at) VALUES (?, ?, ?, ?, ?)'
    );
    ins.run('p1', 'Penguin', 'Hardcover', 'English', now);
    ins.run('p2', 'Penguin', 'Paperback', 'English', now);
    ins.run('p3', 'Harper', 'Paperback', 'Spanish; Castilian', now);

    chalk.level = 0;
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runFieldCoverage();
    const lines = out.mock.calls.map((c) => c.join(' '));
    out.mockRestore();

    expect(lines.find((l) => l.startsWith('  publisher'))).toContain('2 distinct'); // Penguin, Harper
    expect(lines.find((l) => l.startsWith('  format'))).toContain('2 distinct'); // Hardcover, Paperback
    expect(lines.find((l) => l.startsWith('  language'))).toContain('2 distinct'); // English, Spanish
  });

  it('shows list_meta min/max/avg and distinct counts', async () => {
    const db = getDb();
    db.exec('DELETE FROM list_meta;');
    const now = '2026-11-09T00:00:00Z';
    const ins = db.prepare(
      `INSERT INTO list_meta
         (list_id, num_books, num_voters, created_at, created_at_raw, creator_id, creator_name, num_likes, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    ins.run('1', 10, 2, '2013-05-01', 'May 1st, 2013', 'u1', 'Alice', 5, now, now);
    ins.run('2', 20, 4, '2015-01-01', 'January 1st, 2015', 'u2', 'Bob', 0, now, now);
    ins.run('3', 30, 6, '2020-12-31', null, 'u1', 'Alice', null, now, now);

    chalk.level = 0;
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runFieldCoverage();
    const lines = out.mock.calls.map((c) => c.join(' '));
    out.mockRestore();

    const numBooks = lines.find((l) => l.startsWith('  num_books '))!;
    expect(numBooks).toContain('min 10');
    expect(numBooks).toContain('max 30');
    expect(numBooks).toContain('avg 20.0');
    expect(numBooks).toContain('3 distinct');

    const numVoters = lines.find((l) => l.startsWith('  num_voters'))!;
    expect(numVoters).toContain('min 2');
    expect(numVoters).toContain('max 6');
    expect(numVoters).toContain('avg 4.0');

    const createdAt = lines.find((l) => l.startsWith('  created_at'))!;
    expect(createdAt).toContain('min 2013-05-01');
    expect(createdAt).toContain('max 2020-12-31');
    expect(createdAt).toContain('3 distinct');
    expect(createdAt).not.toContain('avg');

    const createdAtRaw = lines.find((l) => l.startsWith('  created_at_raw'))!;
    expect(createdAtRaw).toContain('2 distinct');
    expect(createdAtRaw).not.toContain('min');

    const creatorId = lines.find((l) => l.startsWith('  creator_id'))!;
    expect(creatorId).toContain('2 distinct');
    expect(creatorId).not.toContain('min');

    const creatorName = lines.find((l) => l.startsWith('  creator_name'))!;
    expect(creatorName).toContain('2 distinct');

    const numLikes = lines.find((l) => l.startsWith('  num_likes'))!;
    expect(numLikes).toContain('66.7%');
    expect(numLikes).toContain('(1 missing)');
    expect(numLikes).toContain('min 0');
    expect(numLikes).toContain('max 5');
    expect(numLikes).toContain('avg 2.5');
    expect(numLikes).toContain('2 distinct');
  });

  it('reports author slugs, the shelf directory snapshot and work-level shelves', async () => {
    const db = getDb();
    const now = '2026-11-20T00:00:00.000Z';
    const slugId = 'coverage-slug-1';
    const shelfTag = 'coverage-test-tag';
    const workId = 'coverage-work-1';
    try {
      db.prepare(
        'INSERT INTO author_slugs (author_id, slug, name, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)'
      ).run(slugId, 'coverage-author', 'Coverage Author', now, now);
      db.prepare(
        'INSERT INTO shelf_tag_directory (tag_name, book_count, "rank", scraped_at) VALUES (?, ?, ?, ?)'
      ).run(shelfTag, 42, 7, now);
      db.prepare(
        'INSERT INTO work_tag_books (work_id, tag_name, position, shelved, harvested_at) VALUES (?, ?, ?, ?, ?)'
      ).run(workId, shelfTag, 1, 3, now);

      chalk.level = 0;
      const out = vi.spyOn(console, 'log').mockImplementation(() => {});
      await runFieldCoverage();
      const lines = out.mock.calls.map((c) => c.join(' '));
      out.mockRestore();

      expect(lines.some((l) => l.includes('Author slug dictionary'))).toBe(true);
      expect(lines.find((l) => l.includes('slug rows'))).toContain('1');
      expect(lines.some((l) => l.includes('Shelf tag directory snapshot'))).toBe(true);
      expect(lines.find((l) => l.includes('snapshot tags'))).toContain('1');
      expect(lines.some((l) => l.includes('Work-level shelves'))).toBe(true);
      expect(lines.find((l) => l.includes('xref rows'))).toContain('1');
      expect(lines.some((l) => l.includes('Author scrape failures'))).toBe(true);
    } finally {
      db.prepare('DELETE FROM author_slugs WHERE author_id = ?').run(slugId);
      db.prepare('DELETE FROM shelf_tag_directory WHERE tag_name = ?').run(shelfTag);
      db.prepare('DELETE FROM work_tag_books WHERE work_id = ?').run(workId);
    }
  });

  it('reports zero-yield tag-tail scrapes as zeros, not missing values', async () => {
    const db = getDb();
    const tag = 'coverage-zero-yield';
    const now = '2026-11-20T00:00:00.000Z';
    try {
      db.prepare(
        'INSERT INTO tag_tail_scrapes (tag_name, last_scraped, last_page_seen, books_added, authors_added) VALUES (?, ?, ?, ?, ?)'
      ).run(tag, now, 1, 0, 0);

      chalk.level = 0;
      const out = vi.spyOn(console, 'log').mockImplementation(() => {});
      await runFieldCoverage();
      const lines = out.mock.calls.map((c) => c.join(' '));
      out.mockRestore();

      expect(lines.find((l) => l.includes('books_added_zero'))).toContain('1');
      expect(lines.find((l) => l.includes('authors_added_zero'))).toContain('1');
      const booksAdded = lines.find((l) => l.trimStart().startsWith('books_added'))!;
      expect(booksAdded).toContain('100.0%');
    } finally {
      db.prepare('DELETE FROM tag_tail_scrapes WHERE tag_name = ?').run(tag);
    }
  });
});

describe('table accounting', () => {
  it('accounts for every schema table in REPORTED_TABLES or IGNORED_TABLES', () => {
    const db = getDb();
    const schemaTables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[]).map(r => r.name);
    const covered = new Set<string>([...REPORTED_TABLES, ...IGNORED_TABLES]);
    expect(schemaTables.filter(t => !covered.has(t))).toEqual([]);
    for (const t of REPORTED_TABLES) expect([...IGNORED_TABLES]).not.toContain(t);
  });

  it('actually queries every table it claims to report', () => {
    const source = readFileSync(new URL('./fieldCoverage.ts', import.meta.url), 'utf8');
    for (const table of REPORTED_TABLES) {
      const query = new RegExp(`\\b(?:FROM|JOIN)\\s+${table}\\b`);
      expect(source, `${table} is listed in REPORTED_TABLES but never queried`).toMatch(query);
    }
    expect(IGNORED_TABLES).not.toContain('work_tag_books');
  });
});