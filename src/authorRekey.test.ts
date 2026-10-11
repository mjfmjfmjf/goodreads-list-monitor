import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mergeAuthorRows, rekeyAuthors, type AuthorRow } from './authorRekey.ts';

const row = (over: Partial<AuthorRow>): AuthorRow => ({
  id: '1',
  name: null,
  slug: null,
  last_seen: '2026-01-01',
  ...over,
});

describe('mergeAuthorRows', () => {
  it('keeps the clean name over a statless whitespace-dirty mint row', () => {
    const merged = mergeAuthorRows([
      row({ id: '1406384', name: 'John Green', slug: '1406384.John_Green', num_ratings: 11489618, last_seen: '2026-08-01' }),
      row({ id: '1406384', name: 'John  Green', slug: '1406384.John_Green', num_ratings: 0, last_seen: '2026-01-01' }),
    ]);
    expect(merged.name).toBe('John Green');
    expect(merged.num_ratings).toBe(11489618);
    expect(merged.slug).toBe('1406384.John_Green');
  });

  it('drops a punctuation role suffix lost by slug stripping', () => {
    const merged = mergeAuthorRows([
      row({ id: '721', name: 'John Grisham(Editor)', slug: '721.John_Grisham', num_ratings: 0, last_seen: '2026-02-01' }),
      row({ id: '721', name: 'John Grisham', slug: '721.John_Grisham', num_ratings: 999, last_seen: '2026-07-01' }),
    ]);
    expect(merged.name).toBe('John Grisham');
  });

  it('merges two stat-bearing rows field-wise: MAX counts, MIN/MAX seen, avg from max-ratings', () => {
    const merged = mergeAuthorRows([
      row({ id: '9', name: 'A Author', slug: '9.A_Author', num_ratings: 100, num_reviews: 5, num_shelves: 300, average_rating: 4.5, ratings_rate: 0.9, first_seen: '2025-01-01', last_seen: '2026-05-01' }),
      row({ id: '9', name: 'A  Author', slug: '9.A_Author', num_ratings: 50, num_reviews: 9, num_shelves: 200, average_rating: 3.1, ratings_rate: 0.4, first_seen: '2024-06-01', last_seen: '2026-09-01' }),
    ]);
    expect(merged.num_ratings).toBe(100);
    expect(merged.num_reviews).toBe(9);
    expect(merged.num_shelves).toBe(300);
    expect(merged.average_rating).toBe(4.5);
    expect(merged.ratings_rate).toBe(0.9);
    expect(merged.first_seen).toBe('2024-06-01');
    expect(merged.last_seen).toBe('2026-09-01');
  });

  it('takes the latest-seen slug on a dual-slug id', () => {
    const merged = mergeAuthorRows([
      row({ id: '9013570', name: 'Stephen Richard Witt', slug: '9013570.Stephen_Richard_Witt', num_ratings: 5000, last_seen: '2025-01-01' }),
      row({ id: '9013570', name: 'Stephen   Witt', slug: '9013570.Stephen_Witt', num_ratings: 12, last_seen: '2026-09-01' }),
    ]);
    expect(merged.slug).toBe('9013570.Stephen_Witt');
    // canonical name matches the canonical slug suffix (normalized), not the old slug
    expect(merged.name).toBe('Stephen   Witt');
  });
});

const OLD_SCHEMA = `
  CREATE TABLE authors (
    name TEXT PRIMARY KEY,
    id TEXT,
    slug TEXT,
    last_seen TEXT NOT NULL,
    average_rating REAL,
    num_ratings INTEGER DEFAULT 0,
    num_reviews INTEGER DEFAULT 0,
    num_shelves INTEGER DEFAULT 0,
    first_seen TEXT,
    catalog_pages INTEGER,
    fail_count INTEGER DEFAULT 0,
    last_error TEXT,
    ratings_rate REAL
  );
  CREATE TABLE author_slugs (
    author_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    name TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    PRIMARY KEY (author_id, slug)
  );
`;

const insertOld = (db: Database.Database, r: Partial<AuthorRow> & { name: string; id: string }) =>
  db.prepare(`INSERT INTO authors (name, id, slug, last_seen, num_ratings, first_seen)
    VALUES (@name, @id, @slug, @last_seen, @num_ratings, @first_seen)`).run({
    name: r.name,
    id: r.id,
    slug: r.slug ?? null,
    last_seen: r.last_seen ?? '2026-01-01',
    num_ratings: r.num_ratings ?? 0,
    first_seen: r.first_seen ?? null,
  });

describe('rekeyAuthors', () => {
  it('dry run reports the collapse without touching the table', () => {
    const db = new Database(':memory:');
    db.exec(OLD_SCHEMA);
    insertOld(db, { id: '1406384', name: 'John Green', slug: '1406384.John_Green', num_ratings: 11, last_seen: '2026-08-01' });
    insertOld(db, { id: '1406384', name: 'John  Green', slug: '1406384.John_Green', num_ratings: 0, last_seen: '2026-01-01' });
    insertOld(db, { id: '2', name: 'Solo Author', slug: '2.Solo_Author', num_ratings: 3 });

    const res = rekeyAuthors(db, { apply: false });
    expect(res.groups).toBe(2);
    expect(res.collapsedRows).toBe(1);
    expect(res.multiRowGroups).toBe(1);
    expect(res.applied).toBe(false);
    expect((db.prepare('SELECT COUNT(*) AS n FROM authors').get() as { n: number }).n).toBe(3);
  });

  it('applies: id-PK authors, old table retained, author_slugs backfilled', () => {
    const db = new Database(':memory:');
    db.exec(OLD_SCHEMA);
    insertOld(db, { id: '1406384', name: 'John Green', slug: '1406384.John_Green', num_ratings: 11, first_seen: '2025-01-01', last_seen: '2026-08-01' });
    insertOld(db, { id: '1406384', name: 'John  Green', slug: '1406384.John_Green', num_ratings: 0, first_seen: '2026-01-01', last_seen: '2026-01-01' });
    insertOld(db, { id: '9013570', name: 'Stephen Richard Witt', slug: '9013570.Stephen_Richard_Witt', num_ratings: 50, last_seen: '2025-01-01' });
    insertOld(db, { id: '9013570', name: 'Stephen   Witt', slug: '9013570.Stephen_Witt', num_ratings: 1, last_seen: '2026-09-01' });

    rekeyAuthors(db, { apply: true, dateStamp: '20260101' });

    const authors = db.prepare('SELECT id, name, slug, num_ratings FROM authors ORDER BY id').all() as any[];
    expect(authors.map((a) => a.id)).toEqual(['1406384', '9013570']);
    expect(authors.find((a) => a.id === '1406384').name).toBe('John Green');
    expect(authors.find((a) => a.id === '1406384').num_ratings).toBe(11);
    expect(authors.find((a) => a.id === '9013570').slug).toBe('9013570.Stephen_Witt');

    const oldCount = (db.prepare('SELECT COUNT(*) AS n FROM authors_old_20260101').get() as { n: number }).n;
    expect(oldCount).toBe(4);

    const slugs = db.prepare('SELECT author_id, slug, first_seen, last_seen FROM author_slugs ORDER BY author_id, slug').all() as any[];
    expect(slugs.map((s) => s.slug)).toEqual([
      '1406384.John_Green',
      '9013570.Stephen_Richard_Witt',
      '9013570.Stephen_Witt',
    ]);
    const john = slugs.find((s) => s.slug === '1406384.John_Green');
    expect(john.first_seen).toBe('2025-01-01');
    expect(john.last_seen).toBe('2026-08-01');

    // id-PK is enforced
    expect(() =>
      db.prepare('INSERT INTO authors (id, name, last_seen) VALUES (?, ?, ?)').run('1406384', 'Dupe', '2026-01-01'),
    ).toThrow();
  });
});
