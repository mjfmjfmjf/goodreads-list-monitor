import { createGzip } from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { statSync } from 'node:fs';
import path from 'path';
import chalk from 'chalk';

// Sanitized CSV+gzip export of the shareable library-data tables (books,
// authors, tag_books, genres, genre_tag_xref). Deliberately EXCLUDES config
// (live session cookies / userId), lists, and author_scrape_failures
// (operational scrape-bookkeeping). Not network-bound; reads directly from the
// local DB and streams to disk so the ~1M-row books table doesn't inflate memory.

// Ordered list of tables to export; the order is the display/reporting order.
export const EXPORT_TABLES = ['books', 'authors', 'tag_books', 'genres', 'genre_tag_xref'] as const;

function pickle(value: unknown): string {
  if (value == null) return '';
  // Handle JSON-ish columns (genres, tags) that are stored as strings here.
  return String(value);
}

// Escape a single CSV field per RFC 4180: quote when it contains a comma,
// double-quote, or newline; double any embedded double-quotes.
function csvField(value: unknown): string {
  const s = pickle(value);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function toCsvLine(values: unknown[]): string {
  return values.map(csvField).join(',') + '\n';
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface ExportFile {
  table: string;
  path: string;
  count: number;
}

export interface ExportBatchResult {
  files: ExportFile[];
  booksFile: string;
  authorsFile: string;
  bookCount: number;
  authorCount: number;
}

// Write one table to `<basename>_<table>_<ts>.csv.gz` and resolve with its path
// and row count once the gzip+file write has fully flushed to disk.
function exportTable(
  db: import('better-sqlite3').Database,
  table: string,
  outDir: string,
  basename: string,
  ts: string
): Promise<{ path: string; count: number }> {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(c => c.name);
  const fileName = `${basename}_${table}_${ts}.csv.gz`;
  const dest = path.join(outDir, fileName);

  const gzip = createGzip();
  const out = createWriteStream(dest);
  gzip.pipe(out);

  let count = 0;
  gzip.write(toCsvLine(cols)); // header first
  for (const row of db.prepare(`SELECT * FROM ${table}`).iterate() as IterableIterator<Record<string, unknown>>) {
    gzip.write(toCsvLine(cols.map(c => row[c])));
    count++;
  }

  return new Promise((resolve, reject) => {
    out.on('error', reject);
    gzip.on('error', reject);
    gzip.end();
    out.on('finish', () => resolve({ path: dest, count }));
  });
}

export async function exportBooksAndAuthors(
  db: import('better-sqlite3').Database,
  options: { basename: string; outDir?: string }
): Promise<ExportBatchResult> {
  const { basename, outDir = process.cwd() } = options;
  if (!basename || !/^[A-Za-z0-9._-]+$/.test(basename)) {
    throw new Error('basename (identifier) must be non-empty and use only letters, digits, ".", "_", or "-".');
  }
  const ts = timestamp();
  const files: ExportFile[] = [];
  for (const table of EXPORT_TABLES) {
    files.push({ table, ...(await exportTable(db, table, outDir, basename, ts)) });
  }
  const books = files.find(f => f.table === 'books')!;
  const authors = files.find(f => f.table === 'authors')!;
  return {
    files,
    booksFile: books.path,
    authorsFile: authors.path,
    bookCount: books.count,
    authorCount: authors.count,
  };
}

export function fmtBytes(b: number): string {
  if (b >= 1024 * 1024 * 1024) return (b / 1073741824).toFixed(2) + ' GB';
  if (b >= 1024 * 1024) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
  return b + ' B';
}

export function printExportResult(r: ExportBatchResult, outDir: string): void {
  console.log(chalk.cyan.bold('\n📦 Sanitized export written to:'));
  console.log(chalk.gray(outDir));
  for (const f of r.files) {
    const bytes = statSync(f.path).size;
    console.log(chalk.white(`  ${path.basename(f.path)}   ${f.count.toLocaleString('en-US')} rows   ${fmtBytes(bytes)}`));
  }
  console.log(chalk.gray('   (config with session cookies, lists, and author_scrape_failures intentionally excluded)'));
}
