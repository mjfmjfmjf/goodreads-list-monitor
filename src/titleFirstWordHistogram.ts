import chalk from 'chalk';
import { loadBookCache, CachedBook } from './storage.js';
import { stripTitleSuffix } from './utils.js';

export interface FirstWordRow {
  word: string;
  count: number;
}

export interface TitleFirstWordHistogram {
  rows: FirstWordRow[];
  total: number;
  distinctWords: number;
}

export function extractFirstWord(title: string): string | undefined {
  const cleaned = stripTitleSuffix(title).replace(/^[\s"'“”‘’\[\(\-–—*_]+/, '');
  const match = cleaned.match(/^[^\s]+/);
  if (!match) return undefined;
  const word = match[0].toLowerCase().replace(/["'“”‘’\]\)\-–—*_.,!?;:…]+$/, '');
  return /[a-z0-9\u00c0-\uffff]/i.test(word) ? word : undefined;
}

export function computeTitleFirstWordHistogram(
  books: Pick<CachedBook, 'title'>[],
  options: { limit?: number } = {}
): TitleFirstWordHistogram {
  const counts = new Map<string, number>();

  for (const book of books) {
    const word = extractFirstWord(book.title);
    if (!word) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  const all = [...counts.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));

  const limit = options.limit && options.limit > 0 ? options.limit : all.length;
  return { rows: all.slice(0, limit), total: books.length, distinctWords: all.length };
}

export async function runTitleFirstWordHistogram(options: { limit?: number } = {}): Promise<void> {
  const bookCache = await loadBookCache();
  const books = Object.values(bookCache);
  const hist = computeTitleFirstWordHistogram(books, options);

  console.log(chalk.cyan.bold('\n📚 Titles by first word:'));
  console.log(chalk.gray('----------------------------------------------------------------------'));

  const maxCount = Math.max(...hist.rows.map((r) => r.count), 1);

  for (const row of hist.rows) {
    const pct = hist.total > 0 ? ((row.count / hist.total) * 100).toFixed(2) : '0.00';
    const labelPadded = row.word.padEnd(16, ' ');
    const countPadded = row.count.toLocaleString().padStart(7, ' ');
    const pctPadded = pct.padStart(6, ' ');
    const barLen = Math.round((row.count / maxCount) * 30);
    const bar = '█'.repeat(barLen);
    console.log(`${labelPadded} : ${chalk.yellow(countPadded)} (${chalk.cyan(pctPadded)}%) ${chalk.green(bar)}`);
  }

  console.log(chalk.gray('----------------------------------------------------------------------'));
  console.log(chalk.cyan.bold(`Total books: ${hist.total.toLocaleString()} · ${hist.distinctWords.toLocaleString()} distinct first words${options.limit ? ` (showing top ${Math.min(hist.rows.length, options.limit)})` : ''}`));
}
