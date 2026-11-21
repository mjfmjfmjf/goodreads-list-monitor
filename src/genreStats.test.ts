import path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-genrestats-${process.pid}-${Date.now()}.db`;
});

import {
  aggregateGenreStats,
  genreSlug,
  loadWorksWithGenres,
  positionWeight,
  renderGenreStatsTable,
  sortGenreStats,
  type GenreWork,
} from './genreStats.ts';
import { closeDb, getDb } from './db.ts';

afterAll(() => closeDb());

beforeEach(() => {
  getDb().exec('DELETE FROM books;');
});

const work = (genres: string[], ratings: number, id = '1'): GenreWork => ({
  id,
  workId: `w${id}`,
  ratings,
  genres,
});

describe('genre scoring', () => {
  it('builds Goodreads slugs from display names', () => {
    expect(genreSlug('Young Adult')).toBe('young-adult');
    expect(genreSlug('Science Fiction')).toBe('science-fiction');
    expect(genreSlug('Sci-Fi / Fantasy')).toBe('sci-fi-fantasy');
  });

  it('scores first genre 10, second 9, third 8, and floors at zero', () => {
    expect([0, 1, 2, 9, 10, 11].map(positionWeight)).toEqual([10, 9, 8, 1, 0, 0]);
  });

  it('counts a genre once per work but weighs it by its position', () => {
    const stats = aggregateGenreStats([
      work(['Fiction', 'Young Adult', 'Magic'], 1_000_000),
      work(['Magic', 'Fiction'], 2_000_000, '2'),
      work(['Fiction', 'Fiction'], 3_000_000, '3'), // duplicate inside one work
    ]);
    const byName = new Map(stats.map((row) => [row.name, row]));

    expect(byName.get('Fiction')).toMatchObject({
      books: 3,
      points: 10 + 9 + 10, // positions 1, 2, 1 in the three works
      ratings: 6_000_000,
      weightedRatings: 1_000_000 * 10 + 2_000_000 * 9 + 3_000_000 * 10,
    });
    expect(byName.get('Young Adult')).toMatchObject({ books: 1, points: 9, ratings: 1_000_000 });
    expect(byName.get('Magic')).toMatchObject({
      books: 2,
      points: 8 + 10,
      ratings: 3_000_000,
      weightedRatings: 1_000_000 * 8 + 2_000_000 * 10,
    });
    expect(stats).toHaveLength(3);
  });

  it('sorts by any of the four score columns with a stable name tie-break', () => {
    const stats = aggregateGenreStats([
      work(['Alpha', 'Beta'], 100),
      work(['Beta', 'Alpha'], 200),
    ]);
    expect(sortGenreStats(stats, 'books').map((r) => r.name)).toEqual(['Alpha', 'Beta']);
    // Both genres appear at both positions, so points and total ratings tie;
    // the name tie-break keeps that deterministic.
    expect(sortGenreStats(stats, 'points').map((r) => r.name)).toEqual(['Alpha', 'Beta']);
    expect(sortGenreStats(stats, 'ratings').map((r) => r.name)).toEqual(['Alpha', 'Beta']);
    // Beta is first more often on the heavier work, so weighted ratings differ.
    expect(sortGenreStats(stats, 'weightedRatings').map((r) => r.name)).toEqual(['Beta', 'Alpha']);
  });

  it('renders both Goodreads links and the four score columns', () => {
    const html = renderGenreStatsTable(
      sortGenreStats(aggregateGenreStats([work(['Young Adult'], 1_234_567)]), 'points'),
    );
    expect(html).toContain('BOOKS');
    expect(html).toContain('POINTS');
    expect(html).toContain('WTD RATINGS');
    expect(html).toContain('https://www.goodreads.com/shelf/show/young-adult');
    expect(html).toContain('https://www.goodreads.com/genres/young-adult');
    expect(html).toContain('1,234,567');
  });
});

describe('loadWorksWithGenres', () => {
  function insertBook(
    id: string,
    workId: string,
    ratings: number,
    genres: string,
    isWorkRep = 0,
  ): void {
    getDb()
      .prepare(
        `INSERT INTO books (id, title, author, ratings, genres, work_id, is_work_rep, last_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
      )
      .run(id, `Book ${id}`, 'Author', ratings, genres, workId, isWorkRep);
  }

  it('keeps one row per work, preferring the work rep, and applies the ratings cutoff', () => {
    insertBook('1', 'w1', 2_000_000, '["Fiction"]', 0);
    insertBook('2', 'w1', 2_000_000, '["Fiction","Young Adult"]', 1); // rep wins
    insertBook('3', 'w2', 1_500_000, '["Magic"]', 0); // no rep: highest-rated edition
    insertBook('4', 'w2', 1_000_000, '["Wrong Genre"]', 0);
    insertBook('5', 'w3', 500_000, '["Below Cutoff"]', 1);
    insertBook('6', 'w4', 2_000_000, 'not json', 1);

    const rows = loadWorksWithGenres(1_000_000);
    expect(rows.map((row) => row.id)).toEqual(['2', '3']);
    expect(rows[0].genres).toEqual(['Fiction', 'Young Adult']);
    expect(rows[1].genres).toEqual(['Magic']);
  });
});
