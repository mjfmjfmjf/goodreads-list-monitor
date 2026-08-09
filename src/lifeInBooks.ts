import chalk from 'chalk';
import { getLibrary, reviewedAll } from './library.js';
import { loadBookCache } from './storage.js';
import {
  DIVIDER,
  Section,
  SectionContext,
  renderSections,
  renderStats,
  renderRatings,
  renderFavoriteAuthors,
  renderPublishers,
  renderBookshelves,
  parseRating
} from './yearInBooks.js';
import { LibraryEntry } from './libraryExport.js';

export interface LifeInBooksOptions {
  export?: string;
  library?: string;
}

function renderLifeStats(ctx: SectionContext): string[] {
  const lines = renderStats(ctx.entries);
  const dated = ctx.entries
    .filter(e => /^\d{4}\//.test(e.dateRead))
    .sort((a, b) => a.dateRead.localeCompare(b.dateRead));
  if (dated.length === 0) return lines;

  const first = dated[0];
  const last = dated[dated.length - 1];
  const years = new Set(dated.map(e => e.dateRead.slice(0, 4)));
  const minY = Math.min(...Array.from(years, Number));
  const maxY = Math.max(...Array.from(years, Number));

  lines.push(chalk.gray(DIVIDER));
  lines.push(`   Active span: ${chalk.white(minY)} → ${chalk.white(maxY)} (${chalk.white(years.size.toLocaleString())} year${years.size === 1 ? '' : 's'} with reviews)`);
  lines.push(`   First book: ${chalk.white(`${first.title} by ${first.author}`)} (${chalk.white(first.dateRead)})`);
  lines.push(`   Most recent: ${chalk.white(`${last.title} by ${last.author}`)} (${chalk.white(last.dateRead)})`);
  return lines;
}

function renderYearByYear(ctx: SectionContext): string[] {
  const byYear = new Map<string, { books: number; pages: number[]; ratings: number[]; noPages: number }>();

  for (const entry of ctx.entries) {
    const y = entry.dateRead.slice(0, 4);
    if (!/^\d{4}$/.test(y)) continue;
    let group = byYear.get(y);
    if (!group) {
      group = { books: 0, pages: [], ratings: [], noPages: 0 };
      byYear.set(y, group);
    }
    group.books++;
    const p = parseInt(entry.pages, 10);
    if (!isNaN(p) && p > 0) group.pages.push(p);
    else group.noPages++;
    const rating = parseRating(entry);
    if (rating !== undefined) group.ratings.push(rating);
  }

  if (byYear.size === 0) return [chalk.gray('   (no dated reviews)')];

  const lines: string[] = [];
  for (const y of Array.from(byYear.keys()).sort()) {
    const group = byYear.get(y)!;
    const pagesTotal = group.pages.reduce((sum, p) => sum + p, 0);
    const mean = group.ratings.length > 0
      ? (group.ratings.reduce((sum, r) => sum + r, 0) / group.ratings.length).toFixed(2)
      : 'n/a';
    let line =
      `   ${chalk.white(y)}: ${chalk.yellow(group.books.toLocaleString())} book${group.books === 1 ? '' : 's'}, ` +
      `${chalk.yellow(pagesTotal.toLocaleString())} pages, mean rating ${chalk.green.bold(mean)}`;
    if (group.noPages > 0) line += chalk.gray(` (${group.noPages.toLocaleString()} without page counts)`);
    if (group.ratings.length !== group.books) line += chalk.gray(` (${(group.books - group.ratings.length).toLocaleString()} unrated)`);
    lines.push(line);
  }
  return lines;
}

const SECTIONS: Section[] = [
  { key: 'stats', title: '📊 Reading stats', render: renderLifeStats },
  { key: 'ratings', title: '⭐ Ratings and reviews', render: (ctx) => renderRatings(ctx.entries) },
  { key: 'year-by-year', title: '📅 Year by year', render: renderYearByYear },
  { key: 'favorite-authors', title: '🏆 Favorite authors', render: renderFavoriteAuthors },
  { key: 'publishers', title: '🏢 Publishers', render: renderPublishers },
  { key: 'bookshelves', title: '🏷️ Bookshelves', render: renderBookshelves }
];

export async function runLifeInBooks(options: LifeInBooksOptions = {}): Promise<void> {
  const library = await getLibrary(options);

  const entries = reviewedAll(library);
  if (entries.length === 0) {
    console.log(chalk.yellow('   No books read + reviewed in the library export.'));
    return;
  }

  const bookCache = await loadBookCache();
  let reviewYear = 0;
  for (const entry of entries) {
    const y = parseInt(entry.dateRead.slice(0, 4), 10);
    if (!isNaN(y) && y > reviewYear) reviewYear = y;
  }
  const ctx: SectionContext = { entries, bookCache, reviewYear };

  console.log(chalk.cyan.bold('\n📚 Life in Books'));
  console.log(chalk.gray(`   ${entries.length.toLocaleString()} books read + reviewed across all years (read shelf + review text, year from Date Read)`));
  console.log(chalk.gray(DIVIDER));

  await renderSections(SECTIONS, ctx);
}
