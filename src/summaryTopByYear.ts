import chalk from 'chalk';
import { loadBookCache } from './storage.js';
import { getYear } from './utils.js';

async function summarizeTopByYear() {
  const bookCache = await loadBookCache();
  const books = Object.values(bookCache);

  // Map to store: year -> { maxRatings: number, book: any }
  const topByYear: Record<number, { maxRatings: number; book: any }> = {};

  for (const book of books) {
    if (book.published === 'Unknown') continue;

    const year = getYear(book.published);
    if (year === null) continue;

    const ratings = parseInt(book.ratings.replace(/,/g, ''), 10) || 0;

    if (!topByYear[year] || ratings > topByYear[year].maxRatings) {
      topByYear[year] = { maxRatings: ratings, book };
    }
  }

  const sortedYears = Object.keys(topByYear)
    .map(y => parseInt(y, 10))
    .sort((a, b) => a - b);

  console.log(chalk.cyan.bold('\n🏆 Most Rated Book per Year (from Cache)'));
  console.log(chalk.gray('------------------------------------------'));

  for (const year of sortedYears) {
    const { maxRatings, book } = topByYear[year];
    const formattedRatings = maxRatings.toLocaleString();
    const avgStr = book.avgRating ? ` (${book.avgRating} avg)` : '';
    console.log(
      `${chalk.yellow.bold(year)} ` +
      `${chalk.white(`numRatings=${formattedRatings}${avgStr}`)} - ` +
      `${chalk.gray(`id=${book.id},`)} ` +
      `${chalk.green(`title=${book.title},`)} ` +
      `${chalk.magenta(`author=${book.author}`)}`
    );
  }

  console.log(chalk.gray('------------------------------------------'));
  console.log(chalk.cyan(`Total years represented: ${sortedYears.length}\n`));
}

summarizeTopByYear().catch(err => {
  console.error(chalk.red.bold('Error generating top by year summary:'), err);
});
