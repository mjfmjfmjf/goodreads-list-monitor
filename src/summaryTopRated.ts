import chalk from 'chalk';
import { loadBookCache } from './storage.js';
import { getYear, formatBookLink } from './utils.js';

interface SummaryOptions {
  minAvg?: string;
  maxAvg?: string;
  minRatings?: string;
  limit?: string;
}

export async function runSummaryTopOrBottom(options: SummaryOptions = {}, isBottom = false): Promise<void> {
  const bookCache = await loadBookCache();
  const allBooks = Object.values(bookCache);

  const minAvg = options.minAvg ? parseFloat(options.minAvg) : 0;
  const maxAvg = options.maxAvg ? parseFloat(options.maxAvg) : Infinity;
  const minRatings = parseInt(options.minRatings?.replace(/,/g, '') || '0', 10);
  const limit = options.limit ? parseInt(options.limit, 10) : Infinity;

  console.log(chalk.cyan.bold(`\n🏆 ${isBottom ? 'Lowest-Rated' : 'Top-Rated'} Books Summary`));
  let criteriaMsg = `   Criteria: Min Ratings: ${minRatings.toLocaleString()}`;
  if (minAvg > 0) criteriaMsg += `, Min Avg Rating: ${minAvg}`;
  if (maxAvg < Infinity) criteriaMsg += `, Max Avg Rating: ${maxAvg}`;
  console.log(chalk.gray(criteriaMsg));
  if (limit < Infinity) {
    console.log(chalk.gray(`   Limit: ${isBottom ? 'Bottom' : 'Top'} ${limit} books`));
  }
  console.log(chalk.gray('------------------------------------------'));

  // Filter books
  const filtered = allBooks.filter(book => {
    if (book.isBad) return false;
    if (!book.title || book.title === 'Unknown') return false;

    const avg = parseFloat(book.avgRating || '0');
    if (avg < minAvg || avg > maxAvg) return false;

    const ratings = parseInt(book.ratings.replace(/,/g, ''), 10) || 0;
    if (ratings < minRatings) return false;

    return true;
  });

  // Sort by avgRating (ascending if isBottom, descending if not), then by ratings count descending
  filtered.sort((a, b) => {
    const avgA = parseFloat(a.avgRating || '0');
    const avgB = parseFloat(b.avgRating || '0');
    if (avgA !== avgB) {
      return isBottom ? avgA - avgB : avgB - avgA;
    }

    const ratingsA = parseInt(a.ratings.replace(/,/g, ''), 10) || 0;
    const ratingsB = parseInt(b.ratings.replace(/,/g, ''), 10) || 0;
    return ratingsB - ratingsA;
  });

  const countToDisplay = Math.min(filtered.length, limit);

  if (countToDisplay === 0) {
    console.log(chalk.yellow('   No books found matching the criteria.'));
    return;
  }

  for (let i = 0; i < countToDisplay; i++) {
    const book = filtered[i];
    const bookLink = formatBookLink(book.title, book.id);
    const pubStr = book.published && book.published !== 'Unknown' ? `, Pub: ${book.published}` : '';
    const tagsStr = book.tags && Object.keys(book.tags).length > 0
      ? `, Tags: [${Object.entries(book.tags).map(([t, c]) => `${t}:${c}`).join(', ')}]`
      : '';
    const updateStr = book.lastUpdated ? `, Updated: ${new Date(book.lastUpdated).toLocaleDateString()}` : '';

    console.log(
      `${(i + 1).toString().padStart(4, ' ')}. ${bookLink} by ${book.author}\n` +
      `      Avg Rating: ${chalk.green.bold(book.avgRating || '0')}, Ratings: ${chalk.yellow(book.ratings)}${pubStr}${tagsStr}${updateStr}`
    );
  }

  console.log(chalk.gray('------------------------------------------'));
  console.log(chalk.cyan(`Total books matching criteria: ${filtered.length} (Displayed: ${countToDisplay})\n`));
}

export async function runSummaryTop(options: SummaryOptions = {}): Promise<void> {
  await runSummaryTopOrBottom(options, false);
}

export async function runSummaryBottom(options: SummaryOptions = {}): Promise<void> {
  await runSummaryTopOrBottom(options, true);
}
