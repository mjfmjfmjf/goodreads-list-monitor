import chalk from 'chalk';
import { loadBookCache } from './storage.js';
import { getYear } from './utils.js';

export async function runSummaryByYear(): Promise<void> {
  const bookCache = await loadBookCache();
  const yearCounts: { [year: number]: number } = {};
  let unknownCount = 0;
  const otherIssues: { [label: string]: number } = {};

  const books = Object.values(bookCache);

  for (const book of books) {
    const year = getYear(book.published);
    
    if (year !== null) {
      yearCounts[year] = (yearCounts[year] || 0) + 1;
    } else if (!book.published || book.published === 'Unknown') {
      unknownCount++;
    } else {
      otherIssues[book.published] = (otherIssues[book.published] || 0) + 1;
    }
  }

  const sortedYears = Object.keys(yearCounts)
    .map(Number)
    .sort((a, b) => a - b);

  console.log(chalk.cyan.bold('\n📊 Publication Year Summary:'));
  console.log(chalk.gray('----------------------------'));

  for (const year of sortedYears) {
    console.log(`${year.toString().padStart(4, ' ')}: ${chalk.yellow(yearCounts[year])} books`);
  }

  if (Object.keys(otherIssues).length > 0 || unknownCount > 0) {
    console.log(chalk.gray('----------------------------'));
    if (unknownCount > 0) {
      console.log(`${chalk.red('Unknown')}: ${chalk.bold(unknownCount)} books`);
    }

    for (const label of Object.keys(otherIssues).sort()) {
      console.log(`${chalk.magenta(label)}: ${otherIssues[label]} books`);
    }
  }

  console.log(chalk.cyan(`\nTotal books in cache: ${books.length}`));
}
