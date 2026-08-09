import chalk from 'chalk';
import { getLibrary } from './library.js';

export interface ShelfStatsOptions {
  limit?: string;
  sortBy?: string;
  minCount?: string;
  export?: string;
  library?: string;
}

const SORTS = ['count', 'name'] as const;
type SortBy = typeof SORTS[number];

export async function runShelfStats(options: ShelfStatsOptions = {}): Promise<void> {
  const limit = options.limit !== undefined ? parseInt(options.limit, 10) : 20;
  const minCount = options.minCount !== undefined ? parseInt(options.minCount, 10) : 0;
  if (isNaN(limit) || limit <= 0) {
    console.error(chalk.red.bold('Error: --limit must be a positive number.'));
    process.exit(1);
  }
  if (isNaN(minCount) || minCount < 0) {
    console.error(chalk.red.bold('Error: --minCount must be at least 0.'));
    process.exit(1);
  }

  const sortBy = (options.sortBy || 'count') as SortBy;
  if (!SORTS.includes(sortBy)) {
    console.error(chalk.red.bold(`Error: --sortBy must be one of: ${SORTS.join(', ')}`));
    process.exit(1);
  }

  const library = await getLibrary(options);

  const counts = new Map<string, number>();
  let noShelfBooks = 0;
  for (const entry of library.entries) {
    const shelves = entry.bookshelves
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (shelves.length === 0) {
      noShelfBooks++;
      continue;
    }
    for (const shelf of shelves) counts.set(shelf, (counts.get(shelf) || 0) + 1);
  }

  const totalBooks = library.entries.length;
  const rows = Array.from(counts.entries())
    .filter(([, c]) => c >= minCount)
    .sort((a, b) => {
      if (sortBy === 'name') return a[0].localeCompare(b[0]);
      return b[1] - a[1] || a[0].localeCompare(b[0]);
    });
  const display = Math.min(rows.length, limit);

  console.log(chalk.cyan.bold('\n🏷️ Shelf usage'));
  console.log(chalk.gray('   Definition: Bookshelves tags from the library export (all books), counted per shelf'));
  console.log(chalk.gray(`   Criteria: Min count: ${minCount.toLocaleString()}`));
  console.log(chalk.gray(`   Sort: ${sortBy === 'count' ? 'count (descending)' : 'shelf name'}`));
  console.log(chalk.gray(`   Limit: Top ${limit} shelves`));
  console.log(chalk.gray('------------------------------------------'));

  if (display === 0) {
    console.log(chalk.yellow(`   No shelves with ${minCount.toLocaleString()}+ books found.`));
  }

  for (let i = 0; i < display; i++) {
    const [shelf, count] = rows[i];
    const pct = (count / totalBooks) * 100;
    console.log(
      `${(i + 1).toString().padStart(4, ' ')}. ${chalk.white(shelf)}: ${chalk.yellow(count.toLocaleString())} (${pct.toFixed(1)}%)`
    );
  }

  console.log(chalk.gray('------------------------------------------'));
  console.log(
    chalk.cyan(
      `Distinct shelves: ${counts.size.toLocaleString()} | Books: ${totalBooks.toLocaleString()} (${noShelfBooks.toLocaleString()} without shelves) (Displayed: ${display})\n`
    )
  );
}
