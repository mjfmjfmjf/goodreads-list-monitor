import chalk from 'chalk';
import { iterateBooks } from './storage.ts';
import { parseSeriesPos, SERIES_POS_MULTI } from './seriesPos.ts';

export interface TopBySeriesPosOptions {
  position?: string;
  limit?: string;
}

export async function runTopBySeriesPos(options: TopBySeriesPosOptions = {}): Promise<void> {
  const pos = options.position !== undefined ? parseFloat(options.position) : 1;
  const limit = parseInt(options.limit || '50', 10) || 50;

  const books = [];
  for (const book of iterateBooks()) {
    const bpos = parseSeriesPos(book.title) ?? book.seriesPos;
    if (bpos !== undefined && bpos !== SERIES_POS_MULTI && Math.abs(bpos - pos) < 0.001) {
      books.push(book);
    }
  }

  books.sort((a, b) => {
    const ra = parseInt(String(a.ratings || '0').replace(/,/g, ''), 10) || 0;
    const rb = parseInt(String(b.ratings || '0').replace(/,/g, ''), 10) || 0;
    if (rb !== ra) return rb - ra;
    const aa = typeof a.avgRating === 'number' ? a.avgRating : parseFloat(String(a.avgRating ?? '0'));
    const ab = typeof b.avgRating === 'number' ? b.avgRating : parseFloat(String(b.avgRating ?? '0'));
    if ((isNaN(ab)?0:ab) !== (isNaN(aa)?0:aa)) return (isNaN(ab)?0:ab) - (isNaN(aa)?0:aa);
    return a.title.localeCompare(b.title);
  });

  console.log(chalk.cyan.bold(`\n🏆 Top books at series position ${pos}`));
  console.log(chalk.gray(`   Found ${books.length.toLocaleString()} books | Showing top ${Math.min(limit, books.length)}`));
  console.log(chalk.gray('------------------------------------------'));

  for (let i = 0; i < Math.min(limit, books.length); i++) {
    const b = books[i];
    const r = parseInt(String(b.ratings || '0').replace(/,/g, ''), 10) || 0;
    const aa = typeof b.avgRating === 'number' ? b.avgRating : parseFloat(String(b.avgRating ?? ''));
    const a = !isNaN(aa) ? aa.toFixed(2) : 'N/A';
    console.log(
      `${(i + 1).toString().padStart(4, ' ')}. ${chalk.green(r.toLocaleString())} ratings (${a}★) - [book:${chalk.white(b.title)}${b.author ? ' by ' + b.author : ''}|${b.id}]`
    );
  }

  console.log(chalk.gray('------------------------------------------'));
  console.log(chalk.gray(`Total run time: < 1s`));
}
