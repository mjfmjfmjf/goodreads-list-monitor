import chalk from 'chalk';
import { iterateAuthors } from './storage.ts';
import type { AuthorCacheEntry } from './storage.ts';

// Author-selection inputs may be either the legacy id-keyed Record (unit tests,
// small hand-built caches) or an iterable of entries — the scalable path:
// iterateAuthors() streams rows without materializing the ~960k-row object that
// loadAuthorCache() used to build on every statistics command. Yields [id, entry]
// pairs; for the Record form the id is the map key (as it always was), for the
// iterable form it is entry.id (identical in production, where keys == ids).
export function* authorPairs(
  src: Record<string, AuthorCacheEntry> | Iterable<AuthorCacheEntry>,
): Generator<[string, AuthorCacheEntry]> {
  if (src != null && typeof (src as any)[Symbol.iterator] === 'function') {
    for (const entry of src as Iterable<AuthorCacheEntry>) yield [entry.id, entry];
  } else {
    for (const [key, entry] of Object.entries(src as Record<string, AuthorCacheEntry>)) yield [key, entry];
  }
}

export type AuthorSortField = 'numRatings' | 'averageRating' | 'numReviews' | 'numShelves' | 'catalogPages' | 'ratingsRate';

export interface AuthorTopStatsOptions {
  limit?: string;
  sortBy?: string;
  minRatings?: string;
  maxRatings?: string;
}

export interface SelectedAuthor {
  id: string;
  name: string;
  entry: AuthorCacheEntry;
  value: number;
}

export type AuthorScrapeProof = boolean;

// "Was this author's Goodreads author page ever scraped?" A scrape is proven by
// either author-page stats having been captured (even if legitimately all-zero,
// e.g. a brand-new author with 0 ratings) OR the catalog-page count having been
// written (the multiPage crawl writes it on any successful first-page parse).
// Used as the `--minAge` cooling trigger so a scraped-but-statless author (or a
// genuinely zero-rated one) is never re-faced at the top of the pool just
// because they lack stats to prove the prior scrape.
export function wasAuthorPageScraped(entry: AuthorCacheEntry): AuthorScrapeProof {
  return Boolean(
    entry.numRatings ||
    entry.averageRating ||
    entry.numReviews ||
    entry.numShelves ||
    (entry.catalogPages ?? 0) >= 1
  );
}

const SORT_FIELDS: AuthorSortField[] = ['numRatings', 'averageRating', 'numReviews', 'numShelves', 'catalogPages', 'ratingsRate'];

const SORT_LABELS: Record<AuthorSortField, string> = {
  numRatings: 'Number of Ratings',
  averageRating: 'Average Rating',
  numReviews: 'Number of Reviews',
  numShelves: 'Number of Shelves',
  catalogPages: 'Catalog Pages',
  ratingsRate: 'Ratings growth / day',
};

const parseNum = (s?: string): number => parseInt((s || '0').replace(/,/g, ''), 10) || 0;
const parseAvg = (s?: string): number => parseFloat(s || '0') || 0;

export function selectAuthors(authorModels: Record<string, AuthorCacheEntry> | Iterable<AuthorCacheEntry>, options: AuthorTopStatsOptions = {}): { authors: SelectedAuthor[]; missingField: number } {
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
    sortBy === 'ratingsRate' ? (entry.ratingsRate ?? 0) :
    parseNum(entry[sortBy]);

  const authors: SelectedAuthor[] = [];
  let missingField = 0;

  for (const [id, entry] of authorPairs(authorModels)) {
    const ratings = parseNum(entry.numRatings);
    if (ratings < minRatings || ratings > maxRatings) continue;

    const name = entry.name ?? id;
    const value = valueOf(entry);
    if (sortBy === 'catalogPages') {
      // null/undefined catalogPages = 0 pages (not "missing")
      authors.push({ id, name, entry, value: value || 0 });
    } else if (value <= 0) {
      missingField++;
      continue;
    } else {
      authors.push({ id, name, entry, value });
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
  const sortBy = (options.sortBy || 'numRatings') as AuthorSortField;
  const limit = options.limit ? parseInt(options.limit, 10) : 100;
  const minRatings = options.minRatings !== undefined ? parseNum(options.minRatings) : 0;
  const maxRatings = options.maxRatings !== undefined ? parseNum(options.maxRatings) : Infinity;

  const { authors, missingField } = selectAuthors(iterateAuthors(), options);

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
