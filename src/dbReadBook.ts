import chalk from 'chalk';
import { getDb } from './db.js';

export interface BookRow {
  id: string;
  title: string;
  author: string;
  author_id?: string;
  ratings?: number;
  avg_rating?: number | null;
  published?: string | null;
  pages?: number | null;
  series_pos?: number | null;
  work_id?: string | null;
  last_updated?: string;
  is_bad?: number;
}

export interface AuthorRow {
  name?: string;
  id?: string;
  slug?: string;
  average_rating?: number | null;
  num_ratings?: number | null;
  num_reviews?: number | null;
  num_shelves?: number | null;
  catalog_pages?: number | null;
  last_seen?: string;
}

export interface BookWithAuthor {
  book: BookRow;
  author: AuthorRow | null;
}

// Read one book by id and join the first matching author row (by author_id ->
// authors.id, which is the author's numeric Goodreads id).
export function queryBookWithAuthor(db: { prepare(sql: string): { get(...p: unknown[]): unknown } }, id: string): BookWithAuthor | null {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(id) as BookRow | undefined;
  if (!book) return null;

  let author: AuthorRow | null = null;
  if (book.author_id) {
    // authors.id can repeat across name-variant rows, so prefer a canonical row
    // (one carrying stats, most recently seen) over an arbitrary duplicate.
    author = (db.prepare('SELECT * FROM authors WHERE id = ? ORDER BY last_seen DESC, num_ratings DESC LIMIT 1').get(book.author_id) as AuthorRow | undefined) || null;
  }
  return { book, author };
}

export function formatNum(n: number | null | undefined): string {
  if (n == null) return '—';
  return Number(n).toLocaleString();
}

export function formatAvg(n: number | null | undefined): string {
  if (n == null) return '—';
  return Number(n).toFixed(2);
}

export function formatBookDetail(d: BookWithAuthor): string {
  const { book, author } = d;
  const lines: string[] = [];

  lines.push(chalk.cyan.bold(`📖 "${book.title}"`));
  lines.push(`   ID           : ${book.id}`);
  lines.push(`   Author       : ${book.author}`);
  if (book.author_id) lines.push(`   Author ID    : ${book.author_id}`);
  lines.push(`   Ratings      : ${formatNum(book.ratings)}`);
  lines.push(`   Avg rating   : ${formatAvg(book.avg_rating)}`);
  lines.push(`   Published    : ${book.published ?? '—'}`);
  if (book.pages != null) lines.push(`   Pages        : ${formatNum(book.pages)}`);
  if (book.series_pos != null) lines.push(`   Series pos   : ${book.series_pos}`);
  if (book.work_id) lines.push(`   Work ID      : ${book.work_id}`);
  if (book.is_bad) lines.push(`   is_bad       : ${chalk.red('true')}`);
  if (book.last_updated) lines.push(`   Last updated : ${book.last_updated}`);

  if (author) {
    lines.push(chalk.cyan.bold(`\n👤 Author (from authors table)`));
    lines.push(`   Name         : ${author.name ?? '—'}`);
    lines.push(`   Author ID    : ${author.id ?? '—'}`);
    lines.push(`   Slug         : ${author.slug ?? '—'}`);
    lines.push(`   Avg rating   : ${formatAvg(author.average_rating)}`);
    lines.push(`   Ratings      : ${formatNum(author.num_ratings)}`);
    lines.push(`   Reviews      : ${formatNum(author.num_reviews)}`);
    lines.push(`   Shelves      : ${formatNum(author.num_shelves)}`);
    if (author.catalog_pages != null) lines.push(`   Catalog pages: ${formatNum(author.catalog_pages)}`);
    if (author.last_seen) lines.push(`   Last seen    : ${author.last_seen}`);
  } else {
    lines.push(chalk.gray(`\n👤 No author row found for author_id "${book.author_id ?? '(none)'}"`));
  }

  return lines.join('\n');
}

export async function runDbReadBook(bookId: string): Promise<void> {
  const db = getDb();
  const result = queryBookWithAuthor(db, bookId);
  if (!result) {
    console.log(chalk.yellow(`No book found with id "${bookId}" in the DB.`));
    return;
  }
  console.log(formatBookDetail(result));
}
