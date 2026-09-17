import chalk from 'chalk';
import { iterateBooks, countBooks } from './storage.js';
import type { CachedBook } from './storage.js';
import { stripTitleSuffix } from './utils.js';

export interface TitleCharRow {
  char: string;
  count: number;
}

export interface TitleCharHistogram {
  first: TitleCharRow[];
  last: TitleCharRow[];
  total: number;
}

export function computeTitleCharHistogram(
  books: Iterable<Pick<CachedBook, 'title'>>,
  total?: number
): TitleCharHistogram {
  const firstCounts = new Map<string, number>();
  const lastCounts = new Map<string, number>();

  for (const book of books) {
    const title = stripTitleSuffix(book.title);
    if (!title) continue;

    const first = title.charAt(0);
    const last = title.charAt(title.length - 1);

    if (first) firstCounts.set(first, (firstCounts.get(first) ?? 0) + 1);
    if (last) lastCounts.set(last, (lastCounts.get(last) ?? 0) + 1);
  }

  const toRows = (map: Map<string, number>): TitleCharRow[] =>
    [...map.entries()]
      .map(([char, count]) => ({ char, count }))
      .sort((a, b) => b.count - a.count || a.char.charCodeAt(0) - b.char.charCodeAt(0));

  return { first: toRows(firstCounts), last: toRows(lastCounts), total: total ?? (books as any[]).length ?? 0 };
}

function printSection(title: string, rows: TitleCharRow[], total: number): void {
  const maxCount = Math.max(...rows.map((r) => r.count), 1);
  const maxLabelWidth = Math.max(...rows.map((r) => r.char.length), 1);

  console.log(chalk.cyan.bold(`\n📊 ${title}:`));
  console.log(chalk.gray('----------------------------------------------------------------------'));

  for (const row of rows) {
    const pct = total > 0 ? ((row.count / total) * 100).toFixed(2) : '0.00';
    const labelPadded = row.char.padEnd(maxLabelWidth, ' ');
    const countPadded = row.count.toLocaleString().padStart(7, ' ');
    const pctPadded = pct.padStart(6, ' ');

    const barLen = Math.round((row.count / maxCount) * 30);
    const bar = '█'.repeat(barLen);

    console.log(`${labelPadded} : ${chalk.yellow(countPadded)} books (${chalk.cyan(pctPadded)}%) ${chalk.green(bar)}`);
  }
}

export async function runTitleCharHistogram(): Promise<void> {
  const hist = computeTitleCharHistogram(iterateBooks(), countBooks());

  printSection('First Character of Title', hist.first, hist.total);
  printSection('Last Character of Title', hist.last, hist.total);

  console.log(chalk.gray('----------------------------------------------------------------------'));
  console.log(chalk.cyan.bold(`Total books in cache: ${hist.total.toLocaleString()}`));
  console.log(chalk.gray('Rows show the exact first/last character of the title (including punctuation like ? ! . ,).'));
}
