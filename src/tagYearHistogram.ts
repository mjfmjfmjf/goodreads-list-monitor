import chalk from 'chalk';
import { getDb } from './db.ts';
import { loadTagBooks } from './storage.ts';
import { extractYear } from './authorNewestYearHistogram.ts';

const formatNum = (n: number): string => n.toLocaleString('en-US');

export interface TagYearHistogramOptions {
  tag: string;
  minTags?: number;
  byDecade?: boolean;
}

export interface TagYearBucket {
  label: string;
  count: number;
}

export function computeTagYearHistogram(tag: string, minTags: number = 1, byDecade: boolean = false): TagYearBucket[] {
  const db = getDb();
  const tagLower = tag.toLowerCase();
  const tagRows = loadTagBooks(tagLower);
  if (tagRows.length === 0) {
    // try original case
    const tagRows2 = loadTagBooks(tag);
    if (tagRows2.length === 0) return [];
    const tagRows = tagRows2;
  }

  const bookIds = [...new Set(tagRows.map(r => r.bookId))];
  if (bookIds.length === 0) return [];
  
  const placeholders = bookIds.map(() => '?').join(',');
  // Get tag counts for all books at once
  const tagCountRows = db.prepare(`SELECT book_id, COUNT(*) as cnt FROM tag_books WHERE book_id IN (${placeholders}) GROUP BY book_id`).all(...bookIds) as any[];
  const tagCounts = new Map<string, number>();
  for (const row of tagCountRows) {
    tagCounts.set(row.book_id, row.cnt);
  }
  
  // Get published years for all books at once
  const bookRows = db.prepare(`SELECT id, published FROM books WHERE id IN (${placeholders})`).all(...bookIds) as any[];
  const publishedMap = new Map<string, string>();
  for (const row of bookRows) {
    if (row.published) publishedMap.set(row.id, row.published);
  }

  const yearCounts = new Map<string, number>();
  for (const bookId of bookIds) {
    const totalTags = tagCounts.get(bookId) || 0;
    if (totalTags < minTags) continue;
    
    const published = publishedMap.get(bookId);
    if (!published) continue;
    
    const year = extractYear(published);
    if (year == null) continue;
    
    if (byDecade) {
      const decade = Math.floor(year / 10) * 10;
      const label = `${decade}s`;
      yearCounts.set(label, (yearCounts.get(label) || 0) + 1);
    } else {
      const label = String(year);
      yearCounts.set(label, (yearCounts.get(label) || 0) + 1);
    }
  }

  const buckets = Array.from(yearCounts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => {
      const na = parseInt(a.label);
      const nb = parseInt(b.label);
      return isNaN(na) || isNaN(nb) ? a.label.localeCompare(b.label) : na - nb;
    });

  return buckets;
}

export async function runTagYearHistogram(options: TagYearHistogramOptions): Promise<void> {
  const tag = options.tag;
  const minTags = options.minTags ?? 1;
  const byDecade = options.byDecade ?? false;

  console.log(chalk.cyan.bold(`\n📊 Tag-Year Histogram: "${tag}"`));
  console.log(chalk.gray(`   Books in tag_books for "${tag}" with >= ${minTags} total tags`));
  console.log(chalk.gray(`   Grouped by ${byDecade ? 'decade' : 'year'}`));

  const buckets = computeTagYearHistogram(tag, minTags, byDecade);
  
  if (buckets.length === 0) {
    console.log(chalk.yellow('\n   No books found matching criteria.'));
    return;
  }

  const LABEL = byDecade ? 'DECADE' : 'YEAR';
  const LW = Math.max(LABEL.length, ...buckets.map(b => b.label.length)) + 1;
  const CW = Math.max(5, ...buckets.map(b => formatNum(b.count).length));
  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  const pctOf = (count: number) => total > 0 ? ((count / total) * 100).toFixed(1) + '%' : '0.0%';
  const PW = Math.max(1, ...buckets.map(b => pctOf(b.count).length));

  const rule = '-'.repeat(LW + CW + PW + 7);
  console.log(chalk.gray(rule));
  console.log(chalk.white(`${LABEL.padEnd(LW)} | ${'COUNT'.padStart(CW)} | ${'%'.padStart(PW)}`));
  console.log(chalk.gray(rule));

  for (const bucket of buckets) {
    const coloredCount = chalk.yellow(formatNum(bucket.count).padStart(CW));
    const pctStr = chalk.cyan(pctOf(bucket.count).padStart(PW));
    console.log(`${chalk.white(bucket.label.padEnd(LW))} | ${coloredCount} | ${pctStr}`);
  }

  console.log(chalk.gray(rule));
  console.log(chalk.cyan.bold(`Total: ${formatNum(total)}`));
}
