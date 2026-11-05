import chalk from 'chalk';
import { getDb } from './db.ts';
import { hasBookPageTable } from './bookPageGaps.ts';
import { loadPublisherRows, SORT_FIELDS, type PublisherSortField } from './publisherCatalog.ts';

const SORT_LABELS: Record<string, string> = {
  books: 'Number of Books',
  avgRating: 'Average Rating',
  totalRatings: 'Total Ratings',
};
import { workKey } from './bookPageGaps.ts';

export interface PublisherTopBooksOptions {
  limit?: string;
  publishers?: string;
  sortBy?: string;
  minRatings?: string;
  minBooks?: string;
}

export async function runPublisherTopBooks(options: PublisherTopBooksOptions = {}): Promise<void> {
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
  const limit = parseInt(options.limit || '10', 10);
  const publishersLimit = parseInt(options.publishers || String(limit), 10);

  const db = getDb();
  const publisherRows = db.prepare(`
    SELECT bp.publisher AS publisher,
           b.id AS book_id,
           COALESCE(NULLIF(b.work_id, ''), b.id) AS work_key,
           b.ratings AS ratings,
           b.avg_rating AS avg_rating,
           b.title AS title,
           b.author AS author
    FROM book_page bp
    JOIN books b ON b.id = bp.book_id
    WHERE bp.publisher IS NOT NULL AND bp.publisher <> ''
      AND b.is_bad = 0
  `).all() as any[];
  
  // Count works per publisher
  const reps = new Map<string, any>();
  for (const row of publisherRows) {
    if ((Number(row.ratings) || 0) < minRatings) continue;
    const key = `${(row.publisher as string).trim()}\u001f${row.work_key}`;
    const prev = reps.get(key);
    if (!prev || (Number(row.ratings) || 0) > (Number(prev.ratings) || 0)) {
      reps.set(key, { 
        publisher: (row.publisher as string).trim(),
        workKey: row.work_key,
        id: row.book_id,
        ratings: Number(row.ratings) || 0,
        avgRating: row.avg_rating != null ? Number(row.avg_rating) : null,
        title: row.title,
        author: row.author
      });
    }
  }
  
  const byPublisher = new Map<string, any[]>();
  for (const rep of reps.values()) {
    if (!byPublisher.has(rep.publisher)) byPublisher.set(rep.publisher, []);
    byPublisher.get(rep.publisher)!.push(rep);
  }
  
  const ranked = [];
  for (const [publisher, works] of byPublisher) {
    if (works.length < minBooks) continue;
    const totalRatings = works.reduce((sum, w) => sum + w.ratings, 0);
    let weightedSum = 0;
    let weightedTotal = 0;
    for (const w of works) {
      if (w.avgRating != null && w.ratings > 0) {
        weightedSum += w.avgRating * w.ratings;
        weightedTotal += w.ratings;
      }
    }
    const avgRating = weightedTotal > 0 ? weightedSum / weightedTotal : null;
    works.sort((a, b) => b.ratings - a.ratings || (b.avgRating || 0) - (a.avgRating || 0));
    ranked.push({
      publisher,
      books: works.length,
      totalRatings,
      avgRating,
      topBook: works[0],
    });
  }
  
  const avg = (p: any): number => p.avgRating ?? -1;
  ranked.sort((a, b) => {
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
  
  const topPublishers = ranked.slice(0, publishersLimit);
  
  console.log(chalk.cyan.bold(`\n🏢 Top Publishers by ${SORT_LABELS[sortBy]} — Top Book per Publisher`));
  console.log(chalk.gray(`   Showing top book (by ratings) for each of the top ${publishersLimit} publishers`));
  console.log(chalk.gray('------------------------------------------'));
  
  for (let i = 0; i < topPublishers.length; i++) {
    const p = topPublishers[i];
    let bookRow: any = null;
    let bookId = p.topBook?.id || p.topBook?.workKey;
    if (bookId) {
      bookRow = db.prepare('SELECT title, author, id FROM books WHERE id = ?').get(bookId) as any;
      if (!bookRow && p.topBook?.workKey) {
        bookRow = db.prepare('SELECT title, author, id FROM books WHERE id = ?').get(p.topBook.workKey) as any;
      }
    }
    const title = bookRow?.title || p.topBook?.title || 'Unknown';
    const author = bookRow?.author || p.topBook?.author || '';
    const actualBookId = bookRow?.id || bookId;
    const avgStr = p.avgRating != null ? `avg ${p.avgRating.toFixed(2)}` : 'avg N/A';
    console.log(
      `${(i + 1).toString().padStart(4, ' ')}. ${chalk.bold(p.publisher)} (${p.books.toLocaleString()} works, ${p.totalRatings.toLocaleString()} total ratings, ${avgStr})`
    );
    console.log(
      `      ${chalk.green((p.topBook?.ratings || 0).toLocaleString())} ratings - [book:${chalk.white(title)}${author ? ' by ' + author : ''}|${actualBookId && actualBookId !== 'undefined' ? actualBookId : ''}]`
    );
    console.log();
  }
}
