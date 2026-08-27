import chalk from 'chalk';
import { loadAuthorCache } from './storage.js';
import type { AuthorCache } from './storage.js';
import type { AuthorCacheEntry } from './storage.js';

export type AuthorSortField = 'numRatings' | 'averageRating' | 'numReviews' | 'numShelves' | 'catalogPages';

export interface AuthorTopStatsOptions {
  limit?: string;
  sortBy?: string;
  minRatings?: string;
  maxRatings?: string;
}

export interface SelectedAuthor {
  name: string;
  entry: AuthorCacheEntry;
  value: number;
}

const SORT_FIELDS: AuthorSortField[] = ['numRatings', 'averageRating', 'numReviews', 'numShelves', 'catalogPages'];

const SORT_LABELS: Record<AuthorSortField, string> = {
  numRatings: 'Number of Ratings',
  averageRating: 'Average Rating',
  numReviews: 'Number of Reviews',
  numShelves: 'Number of Shelves',
  catalogPages: 'Catalog Pages'
};

const parseNum = (s?: string): number => parseInt((s || '0').replace(/,/g, ''), 10) || 0;
const parseAvg = (s?: string): number => parseFloat(s || '0') || 0;

export function selectAuthors(authorCache: AuthorCache, options: AuthorTopStatsOptions = {}): { authors: SelectedAuthor[]; missingField: number } {
  const sortBy = (options.sortBy || 'numRatings') as AuthorSortField;
  if (!SORT_FIELDS.includes(sortBy)) {
    console.error(chalk.red.bold(`Error: --sortBy must be one of: ${SORT_FIELDS.join(', ')}`));
    process.exit(1);
  }

  const minRatings = options.minRatings !== undefined ? parseNum(options.minRatings) : 0;
  const maxRatings = options.maxRatings !== undefined ? parseNum(options.maxRatings) : Infinity;
  const limit = options.limit ? parseInt(options.limit, 10) : 100;

  const valueOf = (entry: AuthorCacheEntry): number =>
    sortBy === 'averageRating' ? parseAvg(entry.averageRating) :
    sortBy === 'catalogPages' ? (entry.catalogPages ?? 0) :
    parseNum(entry[sortBy]);

  const authors: SelectedAuthor[] = [];
  let missingField = 0;

  for (const [name, entry] of Object.entries(authorCache)) {
    const ratings = parseNum(entry.numRatings);
    if (ratings < minRatings || ratings > maxRatings) continue;

    const value = valueOf(entry);
    if (sortBy === 'catalogPages') {
      // null/undefined catalogPages = 0 pages (not "missing")
      authors.push({ name, entry, value: value || 0 });
    } else if (value <= 0) {
      missingField++;
      continue;
    } else {
      authors.push({ name, entry, value });
    }
  }

  authors.sort((a, b) => {
    if (a.value !== b.value) return b.value - a.value;
    const ar = parseNum(a.entry.numRatings);
    const br = parseNum(b.entry.numRatings);
    if (ar !== br) return br - ar;
    return a.name.localeCompare(b.name);
  });

  return { authors: authors.slice(0, limit), missingField };
}

export async function runAuthorTopStats(options: AuthorTopStatsOptions = {}): Promise<void> {
  const authorCache = await loadAuthorCache();

  const sortBy = (options.sortBy || 'numRatings') as AuthorSortField;
  const limit = options.limit ? parseInt(options.limit, 10) : 100;
  const minRatings = options.minRatings !== undefined ? parseNum(options.minRatings) : 0;
  const maxRatings = options.maxRatings !== undefined ? parseNum(options.maxRatings) : Infinity;

  const { authors, missingField } = selectAuthors(authorCache, options);

  console.log(chalk.cyan.bold(`\n🏆 Top Authors by ${SORT_LABELS[sortBy]}`));
  let criteriaMsg = `   Criteria: Min Ratings: ${minRatings.toLocaleString()}`;
  if (maxRatings < Infinity) criteriaMsg += `, Max Ratings: ${maxRatings.toLocaleString()}`;
  console.log(chalk.gray(criteriaMsg));
  console.log(chalk.gray(`   Limit: Top ${limit} authors`));
  console.log(chalk.gray('------------------------------------------'));

  const countToDisplay = Math.min(authors.length, limit);

  if (countToDisplay === 0) {
    console.log(chalk.yellow('   No authors found matching the criteria.'));
    return;
  }

  for (let i = 0; i < countToDisplay; i++) {
    const { name, entry, value } = authors[i];
    const avg = entry.averageRating ? `Avg: ${chalk.green.bold(entry.averageRating)}` : 'Avg: N/A';
    const ratings = entry.numRatings ? `Ratings: ${chalk.yellow(entry.numRatings)}` : 'Ratings: N/A';
    const reviews = entry.numReviews ? `Reviews: ${entry.numReviews}` : 'Reviews: N/A';
    const shelves = entry.numShelves ? `Shelves: ${entry.numShelves}` : 'Shelves: N/A';
    const pages = entry.catalogPages ? `Pages: ${chalk.magenta(String(entry.catalogPages))}` : '';
    const updated = entry.lastSeen ? `, Updated: ${new Date(entry.lastSeen).toLocaleDateString()}` : '';

    console.log(
      `${(i + 1).toString().padStart(4, ' ')}. ${name} (${entry.slug})\n` +
      `      ${avg}, ${ratings}, ${reviews}, ${shelves}${pages ? ', ' + pages : ''}${updated}`
    );
  }

  console.log(chalk.gray('------------------------------------------'));
  console.log(
    chalk.cyan(
      `Total authors with ${sortBy}: ${authors.length.toLocaleString()} (Displayed: ${countToDisplay}${missingField > 0 ? `, Excluded (no ${sortBy}): ${missingField.toLocaleString()}` : ''})\n`
    )
  );
}
