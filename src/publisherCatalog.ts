import chalk from 'chalk';
import { getDb } from './db.js';
import { hasBookPageTable } from './bookPageGaps.js';

export interface PublisherCatalogOptions {
  limit?: string;
  sortBy?: string;
  minRatings?: string;
  minBooks?: string;
}

export interface PublisherBookRow {
  publisher: string;
  workKey: string;
  ratings: number;
  avgRating: number | null;
}

export interface RankedPublisher {
  publisher: string;
  books: number;
  totalRatings: number;
  avgRating: number | null;
}

export const SORT_FIELDS = ['books', 'avgRating', 'totalRatings'] as const;
export type PublisherSortField = (typeof SORT_FIELDS)[number];

const SORT_LABELS: Record<PublisherSortField, string> = {
  books: 'Number of Books',
  avgRating: 'Average Rating',
  totalRatings: 'Total Ratings',
};

// Count DISTINCT works per publisher (editions of the same work collapse on
// the work key); each (publisher, work) is represented by its highest-rated
// edition so avg_rating/total-ratings aren't inflated by duplicates.

export function computePublisherCatalog(
  rows: PublisherBookRow[],
  options: PublisherCatalogOptions = {}
): RankedPublisher[] {
  const sortBy = (options.sortBy || 'books') as PublisherSortField;
  const minRatings = parseInt((options.minRatings || '0').replace(/,/g, ''), 10) || 0;
  const minBooks = parseInt(options.minBooks || '1', 10) || 1;
  const limit = parseInt(options.limit || '25', 10);

  // Representative per (publisher, work): the highest-rated edition.
  const reps = new Map<string, PublisherBookRow>();
  for (const row of rows) {
    if (row.ratings < minRatings) continue;
    const key = `${row.publisher}\u001f${row.workKey}`;
    const prev = reps.get(key);
    if (
      !prev ||
      row.ratings > prev.ratings ||
      (row.ratings === prev.ratings && (row.avgRating ?? 0) > (prev.avgRating ?? 0))
    ) {
      reps.set(key, { ...row });
    }
  }

  const byPublisher = new Map<string, { books: number; totalRatings: number; avgSum: number; avgCount: number }>();
  for (const rep of reps.values()) {
    const p = byPublisher.get(rep.publisher) || { books: 0, totalRatings: 0, avgSum: 0, avgCount: 0 };
    p.books += 1;
    p.totalRatings += rep.ratings;
    if (rep.avgRating != null) {
      p.avgSum += rep.avgRating;
      p.avgCount += 1;
    }
    byPublisher.set(rep.publisher, p);
  }

  const out: RankedPublisher[] = [];
  for (const [publisher, p] of byPublisher) {
    if (p.books < minBooks) continue;
    out.push({
      publisher,
      books: p.books,
      totalRatings: p.totalRatings,
      avgRating: p.avgCount > 0 ? p.avgSum / p.avgCount : null,
    });
  }

  const avg = (p: RankedPublisher): number => p.avgRating ?? -1;
  out.sort((a, b) => {
    if (sortBy === 'books') {
      if (a.books !== b.books) return b.books - a.books;
      if (a.totalRatings !== b.totalRatings) return b.totalRatings - a.totalRatings;
    } else if (sortBy === 'avgRating') {
      if (avg(a) !== avg(b)) return avg(b) - avg(a);
      if (a.books !== b.books) return b.books - a.books;
    } else {
      if (a.totalRatings !== b.totalRatings) return b.totalRatings - a.totalRatings;
      if (a.books !== b.books) return b.books - a.books;
    }
    return a.publisher.localeCompare(b.publisher);
  });

  return out.slice(0, limit);
}

export function loadPublisherRows(): PublisherBookRow[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT bp.publisher AS publisher,
           COALESCE(NULLIF(b.work_id, ''), b.id) AS work_key,
           b.ratings AS ratings,
           b.avg_rating AS avg_rating
    FROM book_page bp
    JOIN books b ON b.id = bp.book_id
    WHERE bp.publisher IS NOT NULL AND bp.publisher <> ''
      AND b.is_bad = 0
  `).all() as any[];
  return rows.map((r) => ({
    publisher: (r.publisher as string).trim(),
    workKey: r.work_key as string,
    ratings: Number(r.ratings) || 0,
    avgRating: r.avg_rating != null ? Number(r.avg_rating) : null,
  }));
}

export async function runPublisherCatalog(options: PublisherCatalogOptions = {}): Promise<void> {
  if (!hasBookPageTable()) {
    console.error(chalk.red.bold('The book_page table does not exist — no browser book-page scrapes have run yet.'));
    return;
  }

  const sortBy = (options.sortBy || 'books') as PublisherSortField;
  if (!SORT_FIELDS.includes(sortBy as any)) {
    console.error(chalk.red.bold(`Error: --sortBy must be one of: ${SORT_FIELDS.join(', ')}`));
    process.exit(1);
  }

  const minRatings = parseInt((options.minRatings || '0').replace(/,/g, ''), 10) || 0;
  const minBooks = parseInt(options.minBooks || '1', 10) || 1;
  const limit = parseInt(options.limit || '25', 10);

  const publishers = computePublisherCatalog(loadPublisherRows(), options);

  console.log(chalk.cyan.bold(`\n🏢 Top Publishers by ${SORT_LABELS[sortBy]}`));
  console.log(chalk.gray(`   Criteria: Min Books: ${minBooks.toLocaleString()} per publisher, Min Ratings: ${minRatings.toLocaleString()} per work`));
  console.log(chalk.gray(`   Limit: Top ${limit} publishers`));
  console.log(chalk.gray('------------------------------------------'));

  if (publishers.length === 0) {
    console.log(chalk.yellow('   No publishers found matching the criteria.'));
    return;
  }

  for (let i = 0; i < publishers.length; i++) {
    const p = publishers[i];
    const avg = p.avgRating != null ? `Avg Rating: ${chalk.green.bold(p.avgRating.toFixed(2))}` : 'Avg Rating: N/A';
    const books = `Books: ${chalk.yellow(p.books.toLocaleString())}`;
    const total = p.totalRatings > 0 ? `Total Ratings: ${p.totalRatings.toLocaleString()}` : 'Total Ratings: N/A';
    console.log(
      `${(i + 1).toString().padStart(4, ' ')}. ${p.publisher}\n` +
      `      ${books}, ${avg}, ${total}`
    );
  }

  console.log(chalk.gray('------------------------------------------'));
}