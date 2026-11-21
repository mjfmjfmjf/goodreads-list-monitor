import chalk from 'chalk';
import { getDb } from './db.ts';

// Prototype scope: only work-representative books ABOVE minRatings (default
// 1,000,000 for the preview). The planned reports will use 1,000 and a top-2000
// genre cutoff; the scoring/link shape is the same at either threshold.
export interface GenreStatsOptions {
  minRatings?: string;
  limit?: string;
  sortBy?: GenreSortField;
}

export type GenreSortField = 'books' | 'points' | 'ratings' | 'weightedRatings';

export interface GenreWork {
  id: string;
  workId: string | null;
  ratings: number;
  genres: string[];
}

export interface GenreStatRow {
  name: string;
  slug: string;
  books: number;
  points: number;
  ratings: number;
  weightedRatings: number;
}

const MAX_POSITION_POINTS = 10;

const fmt = (n: number): string => n.toLocaleString('en-US');

export function genreSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Goodreads lists a book's genres in rank order. Position 1 is worth 10 points,
// position 2 nine, and so on down to 1; anything past position 10 scores 0 but
// still counts once toward the flat book/ratings totals.
export function positionWeight(index: number): number {
  return Math.max(0, MAX_POSITION_POINTS - index);
}

export function aggregateGenreStats(works: GenreWork[]): GenreStatRow[] {
  const stats = new Map<string, GenreStatRow>();
  for (const work of works) {
    const seen = new Set<string>();
    for (let i = 0; i < work.genres.length; i++) {
      const name = work.genres[i].trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      let row = stats.get(name);
      if (!row) {
        row = {
          name,
          slug: genreSlug(name),
          books: 0,
          points: 0,
          ratings: 0,
          weightedRatings: 0,
        };
        stats.set(name, row);
      }
      const weight = positionWeight(i);
      row.books++;
      row.points += weight;
      row.ratings += work.ratings;
      row.weightedRatings += work.ratings * weight;
    }
  }
  return [...stats.values()];
}

export function sortGenreStats(rows: GenreStatRow[], by: GenreSortField): GenreStatRow[] {
  return [...rows].sort((a, b) => {
    const diff = b[by] - a[by];
    return diff !== 0 ? diff : a.name.localeCompare(b.name);
  });
}

interface GenreBookRow {
  id: string;
  work_id: string | null;
  ratings: number;
  genres: string;
  is_work_rep: number;
}

function parseGenres(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

// One row per work: prefer the edition Goodreads marked as the work
// representative, then the highest-rated edition with genres. Editions of the
// same work carry the same work-level ratings, so summing them would multiply
// each work by its edition count.
export function loadWorksWithGenres(minRatings: number, inclusive = false): GenreWork[] {
  const rows = getDb()
    .prepare(
      `SELECT id, work_id, ratings, genres, is_work_rep
       FROM books INDEXED BY idx_books_ratings
       WHERE ratings ${inclusive ? '>=' : '>'} ? AND genres LIKE '[%'`,
    )
    .all(minRatings) as GenreBookRow[];

  const byWork = new Map<string, GenreBookRow>();
  for (const row of rows) {
    const key = row.work_id || `id:${row.id}`;
    const current = byWork.get(key);
    if (
      !current ||
      row.is_work_rep > current.is_work_rep ||
      (row.is_work_rep === current.is_work_rep && row.ratings > current.ratings)
    ) {
      byWork.set(key, row);
    }
  }
  return [...byWork.values()].map((row) => ({
    id: row.id,
    workId: row.work_id,
    ratings: row.ratings,
    genres: parseGenres(row.genres),
  }));
}

const SORT_FIELDS: GenreSortField[] = ['books', 'points', 'ratings', 'weightedRatings'];

export function renderGenreStatsTable(rows: GenreStatRow[]): string {
  if (rows.length === 0) return 'No genres matched this threshold.';

  const width = Math.max('GENRE'.length, ...rows.map((row) => row.name.length));
  const line = [
    'RANK'.padEnd(5),
    'GENRE'.padEnd(width),
    'BOOKS'.padStart(9),
    'POINTS'.padStart(9),
    'RATINGS'.padStart(13),
    'WTD RATINGS'.padStart(14),
  ].join('  ');
  const body = rows.flatMap((row, index) => [
    [
      String(index + 1).padEnd(5),
      row.name.padEnd(width),
      fmt(row.books).padStart(9),
      fmt(row.points).padStart(9),
      fmt(row.ratings).padStart(13),
      fmt(row.weightedRatings).padStart(14),
    ].join('  '),
    `     tag:   https://www.goodreads.com/shelf/show/${row.slug}`,
    `     genre: https://www.goodreads.com/genres/${row.slug}`,
  ]);
  return [line, '-'.repeat(line.length), ...body].join('\n');
}

export function runGenreStats(options: GenreStatsOptions = {}): void {
  const minRatings = Math.max(0, Number(options.minRatings ?? 1_000_000) || 0);
  const limit = Math.max(1, Number(options.limit ?? 20) || 20);
  const sortBy = SORT_FIELDS.includes(options.sortBy as GenreSortField)
    ? (options.sortBy as GenreSortField)
    : 'points';

  console.log(chalk.cyan.bold('\n🏷️  Genre stats (prototype)'));
  const works = loadWorksWithGenres(minRatings);
  const all = aggregateGenreStats(works);
  const top = sortGenreStats(all, sortBy).slice(0, limit);

  console.log(
    chalk.gray(
      `   ${fmt(works.length)} works with genres above ${fmt(minRatings)} ratings · ${fmt(all.length)} genres · showing top ${fmt(top.length)} by ${sortBy}`,
    ),
  );
  console.log(chalk.gray('   BOOKS = 1 per work · POINTS = 10 for first genre, 9 for second, … · RATINGS = summed rating counts · WTD RATINGS = ratings × position weight'));
  console.log(chalk.gray('------------------------------------------'));
  console.log(renderGenreStatsTable(top));
}
