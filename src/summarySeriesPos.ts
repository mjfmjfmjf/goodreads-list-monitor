import chalk from 'chalk';
import { loadBookCache, CachedBook } from './storage.js';
import { parseSeriesPos, SERIES_POS_MULTI } from './seriesPos.js';

export interface SeriesPosHistogramRow {
  pos: number;
  count: number;
}

export interface SeriesPosHistogram {
  standalone: number;
  multiVolume: number;
  rows: SeriesPosHistogramRow[];
  total: number;
}

export function computeSeriesPosHistogram(
  books: Pick<CachedBook, 'title' | 'seriesPos'>[],
  options: { byCount?: boolean } = {}
): SeriesPosHistogram {
  const counts = new Map<number, number>();
  let standalone = 0;
  let multiVolume = 0;

  for (const book of books) {
    const pos = parseSeriesPos(book.title) ?? book.seriesPos;
    if (pos === undefined) {
      standalone++;
    } else if (pos === SERIES_POS_MULTI) {
      multiVolume++;
    } else {
      counts.set(pos, (counts.get(pos) ?? 0) + 1);
    }
  }

  const rows = [...counts.entries()]
    .map(([pos, count]) => ({ pos, count }))
    .sort(options.byCount
      ? (a, b) => b.count - a.count || a.pos - b.pos
      : (a, b) => a.pos - b.pos);

  return { standalone, multiVolume, rows, total: books.length };
}

export async function runSummarySeriesPos(options: { byCount?: boolean } = {}): Promise<void> {
  const bookCache = await loadBookCache();
  const books = Object.values(bookCache);
  const hist = computeSeriesPosHistogram(books, { byCount: options.byCount });

  const rows: { label: string; count: number; isSpecial: boolean }[] = [
    { label: 'standalone', count: hist.standalone, isSpecial: true },
    ...hist.rows.map((r) => ({ label: String(r.pos), count: r.count, isSpecial: false })),
    { label: 'multi-volume', count: hist.multiVolume, isSpecial: true },
  ];

  const maxCount = Math.max(...rows.map((r) => r.count), 1);
  const maxLabelWidth = Math.max(...rows.map((r) => r.label.length));

  console.log(chalk.cyan.bold('\n📊 Book Cache Series Position Histogram:'));
  console.log(chalk.gray('----------------------------------------------------------------------'));

  for (const row of rows) {
    const pct = hist.total > 0 ? ((row.count / hist.total) * 100).toFixed(2) : '0.00';
    const labelPadded = row.label.padEnd(maxLabelWidth, ' ');
    const countPadded = row.count.toLocaleString().padStart(7, ' ');
    const pctPadded = pct.padStart(6, ' ');

    const barLen = Math.round((row.count / maxCount) * 30);
    const bar = '█'.repeat(barLen);

    const labelColored = row.isSpecial ? chalk.magenta(labelPadded) : chalk.white(labelPadded);
    const countColored = row.count > 0 ? chalk.yellow(countPadded) : chalk.gray(countPadded);
    const barColored = chalk.green(bar);

    console.log(`${labelColored} : ${countColored} books (${chalk.cyan(pctPadded)}%) ${barColored}`);
  }

  console.log(chalk.gray('----------------------------------------------------------------------'));
  console.log(chalk.cyan.bold(`Total books in cache: ${hist.total.toLocaleString()}`));
  console.log(chalk.gray('Rows: standalone = no series marker | multi-volume = omnibus/box-set editions'));
}
