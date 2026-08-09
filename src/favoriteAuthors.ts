import chalk from 'chalk';
import { LibraryExport, LibraryEntry } from './libraryExport.js';
import { getLibrary } from './library.js';
import { splitAuthorNames } from './bookMatch.js';
import { normalizeAuthor } from './utils.js';

const STAR_LABELS = [5, 4, 3, 2, 1] as const;

const SORTS = ['avgRating', 'books'] as const;
type SortBy = typeof SORTS[number];

const SORT_LABELS: Record<SortBy, string> = {
  avgRating: 'my average rating',
  books: 'number of books'
};

interface AuthorGroup {
  key: string;
  name: string;
  ratings: number[];
  stars: Map<number, number>;
  entries: LibraryEntry[];
}

export interface GroupedRow {
  name: string;
  books: number;
  avg: number;
  stars: Map<number, number>;
  entries: LibraryEntry[];
}

export interface GroupedResult {
  rows: GroupedRow[];
  reviewedBooks: number;
  skippedNotRated: number;
  skippedNoKey: number;
}

export interface GroupExtractor {
  (entry: LibraryEntry): { key: string; name: string } | undefined;
}

export interface GroupedCommandConfig {
  command: string;
  nounPlural: string;
  nounSingular: string;
  nounCap: string;
  skipLabel: string;
  definition: string;
  extract: GroupExtractor;
}

export interface GroupedCommandOptions {
  limit?: string;
  minBooks?: string;
  sortBy?: string;
  export?: string;
  library?: string;
  books?: boolean;
}

export type FavoriteAuthorsOptions = GroupedCommandOptions;

function parseRating(entry: LibraryEntry): number | undefined {
  const v = parseFloat(entry.myRating);
  if (isNaN(v) || v === 0) return undefined;
  return v;
}

function displayName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

export function groupRatedRows(entries: LibraryEntry[], extract: GroupExtractor): GroupedResult {
  const groups = new Map<string, { key: string; name: string; ratings: number[]; stars: Map<number, number>; entries: LibraryEntry[] }>();
  let reviewedBooks = 0;
  let skippedNotRated = 0;
  let skippedNoKey = 0;

  for (const entry of entries) {
    const rating = parseRating(entry);
    if (rating === undefined) {
      skippedNotRated++;
      continue;
    }
    reviewedBooks++;
    const extracted = extract(entry);
    if (!extracted) {
      skippedNoKey++;
      continue;
    }

    let group = groups.get(extracted.key);
    if (!group) {
      group = { key: extracted.key, name: extracted.name, ratings: [], stars: new Map<number, number>(), entries: [] };
      groups.set(extracted.key, group);
    }
    group.ratings.push(rating);
    group.stars.set(rating, (group.stars.get(rating) || 0) + 1);
    group.entries.push(entry);
  }

  const rows: GroupedRow[] = Array.from(groups.values()).map(g => ({
    name: g.name,
    books: g.ratings.length,
    avg: g.ratings.reduce((sum, r) => sum + r, 0) / g.ratings.length,
    stars: g.stars,
    entries: g.entries
  }));

  return { rows, reviewedBooks, skippedNotRated, skippedNoKey };
}

export const authorExtractor: GroupExtractor = entry => {
  const names = splitAuthorNames(entry.author);
  if (names.length === 0) return undefined;
  const name = displayName(names[0]);
  const key = normalizeAuthor(name);
  if (!key) return undefined;
  return { key, name };
};

export const publisherExtractor: GroupExtractor = entry => {
  const name = displayName(entry.publisher);
  if (!name) return undefined;
  const key = normalizeAuthor(name);
  if (!key) return undefined;
  return { key, name };
};

export function groupFavoriteAuthors(entries: LibraryEntry[]): GroupedResult {
  return groupRatedRows(entries, authorExtractor);
}

export function groupFavoritePublishers(entries: LibraryEntry[]): GroupedResult {
  return groupRatedRows(entries, publisherExtractor);
}

export async function runGroupedCommand(options: GroupedCommandOptions = {}, cfg: GroupedCommandConfig): Promise<void> {
  const limit = options.limit !== undefined ? parseInt(options.limit, 10) : 10;
  const minBooks = options.minBooks !== undefined ? parseInt(options.minBooks, 10) : 3;
  if (isNaN(limit) || limit <= 0) {
    console.error(chalk.red.bold('Error: --limit must be a positive number.'));
    process.exit(1);
  }
  if (isNaN(minBooks) || minBooks < 1) {
    console.error(chalk.red.bold('Error: --minBooks must be at least 1.'));
    process.exit(1);
  }

  const sortBy = (options.sortBy || 'avgRating') as SortBy;
  if (!SORTS.includes(sortBy)) {
    console.error(chalk.red.bold(`Error: --sortBy must be one of: ${SORTS.join(', ')}`));
    process.exit(1);
  }

  const library: LibraryExport = await getLibrary(options);

  const { rows, reviewedBooks, skippedNotRated, skippedNoKey } =
    groupRatedRows(library.entries.filter(entry => entry.shelf === 'read'), cfg.extract);

  const qualified = rows.filter(r => r.books >= minBooks).sort((a, b) => {
    if (sortBy === 'books') return b.books - a.books || b.avg - a.avg || a.name.localeCompare(b.name);
    return b.avg - a.avg || b.books - a.books || a.name.localeCompare(b.name);
  });

  const countToDisplay = Math.min(qualified.length, limit);

  console.log(chalk.cyan.bold(`\n🏆 ${cfg.command} by ${SORT_LABELS[sortBy]}`));
  console.log(chalk.gray(cfg.definition));
  console.log(chalk.gray('   Criteria: Min books: ' + minBooks.toLocaleString()));
  console.log(chalk.gray('   Limit: Top ' + limit + ' ' + cfg.nounPlural));
  if (options.books) console.log(chalk.gray('   Books: Listing each ' + cfg.nounSingular + '\'s books, by your rating (desc)'));
  console.log(chalk.gray('------------------------------------------'));

  if (countToDisplay === 0) {
    console.log(chalk.yellow(`   No ${cfg.nounPlural} with ${minBooks.toLocaleString()}+ rated books found.`));
  }

  for (let i = 0; i < countToDisplay; i++) {
    const row = qualified[i];
    const breakdown = STAR_LABELS
      .map(star => `${star}★: ${(row.stars.get(star) || 0).toLocaleString()}`)
      .filter(s => !s.endsWith(': 0'))
      .join(', ');
    console.log(
      `${(i + 1).toString().padStart(4, ' ')}. ${chalk.white(row.name)}\n` +
      `      Books: ${chalk.yellow(row.books.toLocaleString())}, Avg my rating: ${chalk.green.bold(row.avg.toFixed(2))} | ${breakdown}`
    );
    if (options.books && row.entries.length > 0) {
      const byRating = [...row.entries].sort(
        (a, b) => (parseRating(b) ?? 0) - (parseRating(a) ?? 0) || a.title.localeCompare(b.title)
      );
      console.log(chalk.gray('      Books by your rating:'));
      for (const entry of byRating) {
        const rating = parseRating(entry)!;
        const pages = parseInt(entry.pages, 10);
        const detail = [
          !isNaN(pages) && pages > 0 ? `${pages.toLocaleString()} pages` : null,
          entry.published && entry.published.trim() ? `pub ${entry.published.trim()}` : null
        ].filter(Boolean).join(', ');
        console.log(
          `        ${'★'.repeat(rating)} ${chalk.white(entry.title)} by ${entry.author}` +
          (detail ? chalk.gray(` — ${detail}`) : '')
        );
      }
    }
  }

  console.log(chalk.gray('------------------------------------------'));
  const skippedNote = skippedNotRated > 0 || skippedNoKey > 0
    ? ` | Excluded: ${skippedNotRated.toLocaleString()} read-but-unrated, ${skippedNoKey.toLocaleString()} ${cfg.skipLabel}`
    : '';
  console.log(
    chalk.cyan(
      `Reviewed books: ${reviewedBooks.toLocaleString()} | Distinct ${cfg.nounCap}: ${rows.length.toLocaleString()} | ${cfg.nounCap} with ${minBooks.toLocaleString()}+ rated books: ${qualified.length.toLocaleString()} (Displayed: ${countToDisplay}${skippedNote})\n`
    )
  );
}

export async function runFavoriteAuthors(options: FavoriteAuthorsOptions = {}): Promise<void> {
  await runGroupedCommand(options, {
    command: 'Favorite Authors',
    nounPlural: 'authors',
    nounSingular: 'author',
    nounCap: 'Authors',
    skipLabel: 'no author',
    definition: '   Definition: read shelf + rated books from the library export (myRating 1-5), grouped by first author',
    extract: authorExtractor
  });
}
