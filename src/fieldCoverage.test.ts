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
    const ins = db.prepare(
      'INSERT INTO list_scrapes (list_id, list_name, first_scraped, last_scraped) VALUES (?, ?, ?, ?)'
    );
    ins.run('1', 'A', '2026-09-09T10:00:00Z', '2026-09-09T10:00:00Z');
    ins.run('2', 'B', '2026-09-10T10:00:00Z', '2026-09-12T10:00:00Z');

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
});

describe('table accounting', () => {
  it('accounts for every schema table in REPORTED_TABLES or IGNORED_TABLES', () => {
    const db = getDb();
    const schemaTables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[]).map(r => r.name);
    const covered = new Set<string>([...REPORTED_TABLES, ...IGNORED_TABLES]);
    expect(schemaTables.filter(t => !covered.has(t))).toEqual([]);
    for (const t of REPORTED_TABLES) expect([...IGNORED_TABLES]).not.toContain(t);
  });
});