import chalk from 'chalk';
import { LibraryExport, LibraryEntry } from './libraryExport.js';
import {
  getLibrary,
  readInYear,
  charCounts,
  charBucket,
  publishedCounts,
  missingLetters,
  missingPubYears,
  pubYearUpper,
  mostRecentReviewYear,
  renderCharCountLines,
  renderPublishedYearLines,
  parseYear,
  CharField
} from './library.js';
import { getBook, loadGenreTagXref, loadTagBooks } from './storage.js';
import type { BookCache, TagBookRow } from './storage.js';
import { getYear, formatBookLink } from './utils.js';
import { groupFavoriteAuthors } from './favoriteAuthors.js';
import { maybeSyncLiveReads, fetchLiveYearReads } from './reviewListSync.js';
import { loadConfig } from './storage.js';

export interface YearInBooksOptions {
  year?: string;
  export?: string;
  library?: string;
  requireReviews?: boolean;
  live?: boolean;
  userId?: string;
  vote?: boolean;
  voteBooks?: string;
}

const CHAR_FIELDS: CharField[] = ['title', 'authorLast', 'authorFirst'];

const FIELD_HEADERS: Record<CharField, string> = {
  title: 'Title first letter',
  authorLast: 'Author last name',
  authorFirst: 'Author first name'
};

const STAR_LABELS: Record<number, string> = {
  5: 'five-star',
  4: 'four-star',
  3: 'three-star',
  2: 'two-star',
  1: 'one-star'
};

export const DIVIDER = '------------------------------------------';

export interface SectionContext {
  entries: LibraryEntry[];
  bookCache: BookCache;
  reviewYear: number;
  voteGenres?: boolean;
  voteBooks?: string;
}

export interface Section {
  key: string;
  title: string | ((ctx: SectionContext) => string);
  render(ctx: SectionContext): Promise<string[]> | string[];
}

function parsePages(entry: LibraryEntry): number | undefined {
  const n = parseInt(entry.pages, 10);
  return isNaN(n) || n <= 0 ? undefined : n;
}

// Number of reading days to use as the per-day denominator for a year.
//   - current calendar year  -> Jan 1 → today (incomplete year)
//   - first year of reading  -> date of the earliest book → Dec 31 of that year
//   - any other year         -> the full year (365 or 366 if leap)
// `allEntries` is the full dated read set across years, used to detect the
// first year and its earliest book date.
export function readingDays(year: number, allEntries: LibraryEntry[]): number {
  const now = new Date();
  const currentYear = now.getFullYear();

  const parseDate = (s: string): Date | null => {
    const m = s.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  };
  const daySpan = (a: Date, b: Date): number =>
    Math.max(1, Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000)));

  // Current calendar year: Jan 1 → today.
  if (year === currentYear) {
    return daySpan(new Date(year, 0, 1), now);
  }

  // First year of reading: earliest book date → Dec 31.
  const allYears = allEntries
    .map(e => e.dateRead.match(/^(\d{4})\//)?.[1])
    .filter((y): y is string => !!y)
    .map(Number);
  const minYear = allYears.length ? Math.min(...allYears) : year;
  if (year === minYear) {
    const firstTs = allEntries
      .filter(e => e.dateRead.startsWith(`${year}/`))
      .map(e => parseDate(e.dateRead))
      .filter((d): d is Date => d !== null)
      .map(d => d.getTime());
    const startMs = firstTs.length ? Math.min(...firstTs) : new Date(year, 0, 1).getTime();
    return daySpan(new Date(startMs), new Date(year, 11, 31));
  }

  // Full year.
  const leap = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
  return leap ? 366 : 365;
}

export function parseRating(entry: LibraryEntry): number | undefined {
  const v = parseFloat(entry.myRating);
  if (isNaN(v) || v === 0) return undefined;
  return v;
}

function exampleText(entries: LibraryEntry[], bucketOf: (entry: LibraryEntry) => string): Map<string, string> {
  const map = new Map<string, string>();
  const sorted = [...entries].sort((a, b) => a.dateRead.localeCompare(b.dateRead));
  for (const entry of sorted) {
    const bucket = bucketOf(entry);
    if (!map.has(bucket)) map.set(bucket, ` — "${entry.title}" by ${entry.author}`);
  }
  return map;
}

export interface PerDayContext {
  year: number;
  allEntries: LibraryEntry[];
}

export function renderStats(entries: LibraryEntry[], perDay?: PerDayContext): string[] {
  const lines: string[] = [];
  lines.push(`   Books read: ${chalk.white(entries.length.toLocaleString())}`);

  const withPages = entries
    .map(entry => ({ entry, pages: parsePages(entry) }))
    .filter((x): x is { entry: LibraryEntry; pages: number } => x.pages !== undefined);

  if (withPages.length > 0) {
    const totalPages = withPages.reduce((sum, x) => sum + x.pages, 0);
    const missingPages = entries.length - withPages.length;
    const countNote = missingPages > 0 ? ` (${missingPages} books had no page count)` : '';
    lines.push(`   Pages read: ${chalk.white(totalPages.toLocaleString())}${chalk.gray(countNote)}`);

    if (perDay) {
      const days = readingDays(perDay.year, perDay.allEntries);
      const booksPerDay = entries.length / days;
      const pagesPerDay = totalPages / days;
      lines.push(
        `   Per day: ${chalk.white(booksPerDay.toFixed(2))} book${booksPerDay === 1 ? '' : 's'} · ` +
        `${chalk.white(pagesPerDay.toFixed(0))} pages (${chalk.gray(`${days} days`)} in ${perDay.year})`
      );
    }

    const sorted = [...withPages].sort((a, b) => a.pages - b.pages);
    const shortest = sorted[0];
    const longest = sorted[sorted.length - 1];
    lines.push(`   Shortest: ${chalk.white(`${shortest.entry.title} by ${shortest.entry.author}`)} — ${shortest.pages} pages`);
    lines.push(`   Longest: ${chalk.white(`${longest.entry.title} by ${longest.entry.author}`)} — ${longest.pages} pages`);

    const mean = Math.round(totalPages / withPages.length);
    const sortedPages = sorted.map(x => x.pages);
    const mid = Math.floor(sortedPages.length / 2);
    const median = sortedPages.length % 2 === 0
      ? Math.round((sortedPages[mid - 1] + sortedPages[mid]) / 2)
      : sortedPages[mid];
    lines.push(`   Mean page length: ${chalk.white(mean.toLocaleString())}  |  Median: ${chalk.white(median.toLocaleString())}`);
  } else {
    lines.push(chalk.gray('   (no books with page counts)'));
  }

  return lines;
}

export function renderRatings(entries: LibraryEntry[]): string[] {
  const lines: string[] = [];
  const hist = new Map<number, number>();
  const ratings: number[] = [];
  for (const entry of entries) {
    const rating = parseRating(entry);
    if (rating === undefined) continue;
    ratings.push(rating);
    hist.set(rating, (hist.get(rating) || 0) + 1);
  }

  if (ratings.length === 0) {
    lines.push(chalk.gray('   (no rated books)'));
  } else {
    const buckets = Array.from(hist.keys()).sort((a, b) => b - a);
    const starText = buckets
      .map(star => {
        const n = hist.get(star) || 0;
        const label = STAR_LABELS[star] ?? `${star}-star`;
        return `${n.toLocaleString()} ${label}${n === 1 ? '' : 's'}`;
      })
      .join(', ');
    lines.push(`   ${chalk.white(starText)}`);

    const average = ratings.reduce((sum, r) => sum + r, 0) / ratings.length;
    lines.push(`   Average rating: ${chalk.white(average.toFixed(2))} (${ratings.length.toLocaleString()} rated)`);
  }

  lines.push(chalk.gray(DIVIDER));

  const reviewLens = entries.map(entry => entry.review.length).filter(n => n > 0);
  if (reviewLens.length === 0) {
    lines.push(chalk.gray('   (no reviews)'));
    return lines;
  }

  const sorted = [...reviewLens].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mean = Math.round(sorted.reduce((sum, n) => sum + n, 0) / sorted.length);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];

  lines.push(chalk.white.bold('   Review length (characters, trimmed):'));
  lines.push(`   Min: ${chalk.white(min.toLocaleString())}  |  Max: ${chalk.white(max.toLocaleString())}`);
  lines.push(`   Mean: ${chalk.white(mean.toLocaleString())}  |  Median: ${chalk.white(median.toLocaleString())} (from ${sorted.length.toLocaleString()} reviews)`);

  return lines;
}

export function renderDistribution(ctx: SectionContext): string[] {
  const entries = ctx.entries;
  const lines: string[] = [];

  CHAR_FIELDS.forEach((field, i) => {
    if (i > 0) lines.push(chalk.gray(DIVIDER));
    lines.push(chalk.white.bold(`   ${FIELD_HEADERS[field]}:`));
    const examples = exampleText(entries, entry => charBucket(entry, field));
    lines.push(...renderCharCountLines(entries, field, bucket => examples.get(bucket) || ''));
    const missing = missingLetters(charCounts(entries, field));
    if (missing.length) lines.push(chalk.yellow(`      Missing (${missing.length}): ${missing.join(', ')}`));
  });

  lines.push(chalk.gray(DIVIDER));
  lines.push(chalk.white.bold('   Publication year:'));
  const pubExamples = exampleText(entries, entry => parseYear(entry.published) ?? 'Unknown');
  lines.push(...renderPublishedYearLines(entries, bucket => pubExamples.get(bucket) || ''));
  const counts = publishedCounts(entries);
  const upper = pubYearUpper(counts, ctx.reviewYear);
  const missingYears = missingPubYears(counts, ctx.reviewYear);
  if (missingYears.length) lines.push(chalk.yellow(`      Missing publication years 1961-${upper} (${missingYears.length}): ${missingYears.join(', ')}`));

  return lines;
}

export function topStarLevel(entries: LibraryEntry[]): number {
  for (let star = 5; star >= 1; star--) {
    if (entries.some(entry => parseRating(entry) === star)) return star;
  }
  return 0;
}

function topRatedTitle(entries: LibraryEntry[]): string {
  const star = topStarLevel(entries);
  if (star === 0) return '⭐ Five-star books';
  return `⭐ ${STAR_LABELS[star] ?? `${star}-star`} books`;
}

async function renderTopRated(ctx: SectionContext): Promise<string[]> {
  const entries = ctx.entries;
  const star = topStarLevel(entries);
  if (star === 0) return [chalk.gray('   (no rated books)')];

  const rated = entries.filter(entry => parseRating(entry) === star);
  const lines: string[] = [];
  if (star < 5) {
    lines.push(chalk.gray(`   (no five-star ratings — showing your top-rated ${star}-star books instead)`));
  }

  rated.forEach((entry, i) => {
    const book = ctx.bookCache[entry.id];
    const ratings = book && book.ratings && book.ratings !== '0' ? `Ratings: ${chalk.yellow(book.ratings)}` : 'Ratings: N/A';
    const avg = book?.avgRating ? `Avg: ${chalk.green.bold(book.avgRating)}` : 'Avg: N/A';
    const pubStr = book?.published || entry.published || '';
    const year = getYear(pubStr);
    const yearStr = year !== null ? `Year: ${year}` : 'Year: N/A';
    lines.push(
      `${(i + 1).toString().padStart(4, ' ')}. ${chalk.white(formatBookLink(entry.title, entry.id))}\n` +
      `      by ${entry.author} | ${yearStr}, ${ratings}, ${avg}`
    );
  });

  return lines;
}

export function renderFavoriteAuthors(ctx: SectionContext): string[] {
  const entries = ctx.entries;
  const { rows } = groupFavoriteAuthors(entries);
  const qualified = rows.filter(r => r.books >= 3);
  const lines: string[] = [];

  const byBooks = [...qualified]
    .sort((a, b) => b.books - a.books || b.avg - a.avg || a.name.localeCompare(b.name))
    .slice(0, 10);
  const byAvg = [...qualified]
    .sort((a, b) => b.avg - a.avg || b.books - a.books || a.name.localeCompare(b.name))
    .slice(0, 10);

  lines.push(chalk.white.bold('   Top 10 by number of books (min 3):'));
  if (byBooks.length === 0) {
    lines.push(chalk.gray('      (none)'));
  } else {
    byBooks.forEach((row, i) => {
      lines.push(
        `${(i + 1).toString().padStart(6, ' ')}. ${chalk.white(row.name)} — Books: ${chalk.yellow(row.books.toLocaleString())}, Avg my rating: ${chalk.green.bold(row.avg.toFixed(2))}`
      );
    });
  }

  lines.push(chalk.gray(DIVIDER));

  lines.push(chalk.white.bold('   Top 10 by average rating (min 3):'));
  if (byAvg.length === 0) {
    lines.push(chalk.gray('      (none)'));
  } else {
    byAvg.forEach((row, i) => {
      lines.push(
        `${(i + 1).toString().padStart(6, ' ')}. ${chalk.white(row.name)} — Books: ${chalk.yellow(row.books.toLocaleString())}, Avg my rating: ${chalk.green.bold(row.avg.toFixed(2))}`
      );
    });
  }

  return lines;
}

export function renderBookshelves(ctx: SectionContext): string[] {
  const entries = ctx.entries;
  const counts = new Map<string, number>();
  let noShelfBooks = 0;

  for (const entry of entries) {
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

  if (counts.size === 0) return [chalk.gray('   (no bookshelves)')];

  const lines: string[] = [];
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [shelf, count] of sorted) {
    const pct = (count / entries.length) * 100;
    lines.push(`   ${chalk.white(shelf)}: ${chalk.yellow(count.toLocaleString())} (${pct.toFixed(1)}%)`);
  }
  if (noShelfBooks > 0) lines.push(chalk.gray(`   (${noShelfBooks.toLocaleString()} book${noShelfBooks === 1 ? '' : 's'} had no bookshelves)`));

  return lines;
}

export interface TagCountRow {
  tag: string;
  count: number;
  pct: number;
}

// Tally how many of the year's books belong to each tag in the tag_books
// table (the tagDiscovery/tagAudit shelves). Lookup is by book id. Returns
// tags sorted by biggest count first, then alphabetically.
export function computeTagCounts(entries: LibraryEntry[], tagRows: TagBookRow[]): TagCountRow[] {
  const tagsByBook = new Map<string, Set<string>>();
  for (const row of tagRows) {
    let tags = tagsByBook.get(row.bookId);
    if (!tags) {
      tags = new Set();
      tagsByBook.set(row.bookId, tags);
    }
    tags.add(row.tagName);
  }

  const counts = new Map<string, number>();
  for (const entry of entries) {
    const tags = tagsByBook.get(entry.id);
    if (!tags) continue;
    for (const tag of tags) counts.set(tag, (counts.get(tag) || 0) + 1);
  }

  const total = entries.length;
  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count, pct: total > 0 ? (count / total) * 100 : 0 }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

const TOP_TAGS = 100;
const TOP_GENRE_TAGS = 100;
const TOP_VOTE_BOOKS = 100;

export interface GenreVoteRow {
  genre: string;
  votes: number;
  pct: number;
}

export interface GenreVoteDetail {
  genre: string;
  tag?: string; // the tag that gave the winning best position (positioned vote only)
  position?: number; // the winning best position (lower = stronger; positioned vote only)
  fallback?: boolean; // true when the vote came from books.genres[0] (no positioned genre tag)
}

// Normalize a genre/tag name for canonical-genre matching: lowercased,
// non-alphanumerics stripped (e.g. "Picture Books" -> "picturebooks",
// "middle-grade" -> "middlegrade").
export function normalizeGenreName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Maps any genre-like name to a canonical genre name so book-page display
// strings ("Picture Books") and xref slugs ("picture-books"/"picture-book")
// all fold into one vote bucket. Keyed by normalized name.
export function buildCanonicalGenreLookup(xrefTagToGenre: Map<string, string>): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const [tag, genre] of xrefTagToGenre) {
    lookup.set(normalizeGenreName(tag), genre);
    lookup.set(normalizeGenreName(genre), genre);
  }
  return lookup;
}

// Best-position genre voting: each book casts ONE vote, for the canonical
// genre whose tag holds the book at the lowest position on its shelf
// (position = rank on that tag's shelf at harvest time; 1 = most central).
// A genre's "strength" for a book is the best (lowest) position among all the
// book's tags that map to it. Ties break by more distinct mapping tags, then
// alphabetically. Books with no genre-mapped tag carrying a shelf position
// fall back to the first entry in the book's own genre column (books.genres[0],
// as scraped from the book page) so they still get a vote.
export function computeGenreVoteByBook(
  entries: LibraryEntry[],
  tagRows: TagBookRow[],
  xrefTagToGenre: Map<string, string>,
  bookCache?: BookCache
): Map<string, GenreVoteDetail> {
  const rowsByBook = new Map<string, TagBookRow[]>();
  for (const row of tagRows) {
    if (!xrefTagToGenre.has(row.tagName)) continue;
    let arr = rowsByBook.get(row.bookId);
    if (!arr) {
      arr = [];
      rowsByBook.set(row.bookId, arr);
    }
    arr.push(row);
  }

  const canonicalLookup = buildCanonicalGenreLookup(xrefTagToGenre);

  const byBook = new Map<string, GenreVoteDetail>();
  for (const entry of entries) {
    const rows = rowsByBook.get(entry.id);
    let winner: GenreVoteDetail | undefined;

    if (rows && rows.length > 0) {
      const candidates = new Map<string, { best: number; tagCount: number; bestTag: string }>();
      for (const row of rows) {
        const genre = xrefTagToGenre.get(row.tagName)!;
        let c = candidates.get(genre);
        if (!c) {
          c = { best: Infinity, tagCount: 0, bestTag: '' };
          candidates.set(genre, c);
        }
        c.tagCount++;
        if (row.position !== undefined && row.position !== null) {
          if (row.position < c.best) {
            c.best = row.position;
            c.bestTag = row.tagName;
          } else if (row.position === c.best && row.tagName < c.bestTag) {
            c.bestTag = row.tagName;
          }
        }
      }

      let bestGenre = '';
      let bestKey: number = Infinity;
      let bestTagCount: number = 0;
      for (const [genre, c] of candidates) {
        if (c.best === Infinity) continue; // no positioned tag for this genre
        const key = c.best;
        if (
          bestGenre === '' ||
          key < bestKey ||
          (key === bestKey && c.tagCount > bestTagCount) ||
          (key === bestKey && c.tagCount === bestTagCount && genre < bestGenre)
        ) {
          bestGenre = genre;
          bestKey = key;
          bestTagCount = c.tagCount;
        }
      }
      if (bestGenre) {
        const c = candidates.get(bestGenre)!;
        winner = { genre: bestGenre, tag: c.bestTag, position: c.best };
      }
    }

    if (!winner && bookCache) {
      const genres = bookCache[entry.id]?.genres;
      if (genres && genres.length > 0) {
        const fallbackGenre = canonicalLookup.get(normalizeGenreName(genres[0])) || genres[0];
        winner = { genre: fallbackGenre, fallback: true };
      }
    }

    if (winner) byBook.set(entry.id, winner);
  }
  return byBook;
}

export function computeGenreVotes(
  entries: LibraryEntry[],
  tagRows: TagBookRow[],
  xrefTagToGenre: Map<string, string>,
  bookCache?: BookCache
): GenreVoteRow[] {
  const byBook = computeGenreVoteByBook(entries, tagRows, xrefTagToGenre, bookCache);
  const counts = new Map<string, number>();
  for (const detail of byBook.values()) counts.set(detail.genre, (counts.get(detail.genre) || 0) + 1);

  const total = entries.length;
  return Array.from(counts.entries())
    .map(([genre, votes]) => ({ genre, votes, pct: total > 0 ? (votes / total) * 100 : 0 }))
    .sort((a, b) => b.votes - a.votes || a.genre.localeCompare(b.genre));
}

export function renderTags(ctx: SectionContext): string[] {
  const rows = loadTagBooks();
  const tags = computeTagCounts(ctx.entries, rows);
  const taggedBooks = new Set(rows.map(r => r.bookId));
  const xrefTagToGenre = new Map(loadGenreTagXref().map((x): [string, string] => [x.tagName, x.genreName]));

  const lines: string[] = [];
  if (tags.length === 0) {
    lines.push(chalk.gray('   (no tags found for these books)'));
  } else {
    const covered = ctx.entries.filter(e => taggedBooks.has(e.id)).length;
    const truncated = tags.length > TOP_TAGS;
    lines.push(`   ${chalk.white(tags.length.toLocaleString())} distinct tags across ${chalk.white(covered.toLocaleString())} of ${chalk.white(ctx.entries.length.toLocaleString())} books${truncated ? chalk.gray(` — showing top ${TOP_TAGS}`) : ''}`);
    lines.push(chalk.gray(DIVIDER));
    tags.slice(0, TOP_TAGS).forEach(({ tag, count, pct }, i) => {
      lines.push(`   ${String(i + 1).padStart(3, ' ')}. ${chalk.white(tag)}: ${chalk.yellow(count.toLocaleString())} (${pct.toFixed(1)}%)`);
    });
  }

  // Tags the reader's books carry that also map to a canonical genre via
  // genre_tag_xref (tag_name -> genre_name, kind=exact|cognate). Aliases fold
  // into the canonical genre: a genre's count is the UNION of books carrying
  // any of that genre's tags — the same rule the genre-tag follow-up uses.
  const genreBooks = new Map<string, { books: Set<string>; tagNames: Set<string> }>();
  const entryIds = new Set(ctx.entries.map(e => e.id));
  for (const row of rows) {
    const genre = xrefTagToGenre.get(row.tagName);
    if (!genre || !entryIds.has(row.bookId)) continue;
    let g = genreBooks.get(genre);
    if (!g) {
      g = { books: new Set(), tagNames: new Set() };
      genreBooks.set(genre, g);
    }
    g.books.add(row.bookId);
    g.tagNames.add(row.tagName);
  }

  lines.push(chalk.gray(DIVIDER));
  if (genreBooks.size === 0) {
    lines.push(chalk.gray('   (no tags map to a canonical genre yet — seed/import genre_tag_xref to see genre coverage)'));
  } else {
    const genreTags = Array.from(genreBooks.entries())
      .map(([genre, g]) => ({ genre, count: g.books.size, tags: g.tagNames.size }))
      .sort((a, b) => b.count - a.count || a.genre.localeCompare(b.genre));

    const genreTruncated = genreTags.length > TOP_GENRE_TAGS;
    lines.push(chalk.white.bold(`   Genres (folding tag aliases)${genreTruncated ? chalk.gray(` (showing top ${TOP_GENRE_TAGS} of ${genreTags.length})`) : ''}:`));
    genreTags.slice(0, TOP_GENRE_TAGS).forEach(({ genre, count, tags }, i) => {
      const pct = (count / ctx.entries.length) * 100;
      const via = tags > 1 ? chalk.gray(` (${tags} tags)`) : '';
      lines.push(`   ${String(i + 1).padStart(3, ' ')}. ${chalk.white(genre)}: ${chalk.yellow(count.toLocaleString())} (${pct.toFixed(1)}%)${via}`);
    });
  }

  if (ctx.voteGenres) {
    const votes = computeGenreVotes(ctx.entries, rows, xrefTagToGenre, ctx.bookCache);
    const bookDetails = computeGenreVoteByBook(ctx.entries, rows, xrefTagToGenre, ctx.bookCache);
    const noVote = ctx.entries.filter(e => !bookDetails.has(e.id)).length;
    lines.push(chalk.gray(DIVIDER));
    if (votes.length === 0) {
      lines.push(chalk.gray(`   (no book has a voted genre — run a tag walk to harvest positions or scrape book-page genres, then retry)`));
    } else {
      const genreVoteTruncated = votes.length > TOP_GENRE_TAGS;
      lines.push(chalk.white.bold(`   Genres (best-position vote — each book votes once)${genreVoteTruncated ? chalk.gray(` (showing top ${TOP_GENRE_TAGS} of ${votes.length})`) : ''}:`));
      votes.slice(0, TOP_GENRE_TAGS).forEach(({ genre, votes, pct }, i) => {
        lines.push(`   ${String(i + 1).padStart(3, ' ')}. ${chalk.white(genre)}: ${chalk.yellow(votes.toLocaleString())} (${pct.toFixed(1)}%)`);
      });
      lines.push(chalk.gray(`   ${noVote.toLocaleString()} of ${ctx.entries.length.toLocaleString()} books had no voted genre`));

      // When --voteBooks is given, resolve the target to a canonical genre
      // (tag name → genre via xref, or use the value directly as a genre name)
      // and list the books whose vote went to it, with the driving tag+position.
      if (ctx.voteBooks) {
        const target = xrefTagToGenre.get(ctx.voteBooks) || ctx.voteBooks;
        const targetVotes = votes.find(v => v.genre === target);
        lines.push(chalk.gray(DIVIDER));
        if (!targetVotes || targetVotes.votes === 0) {
          lines.push(chalk.gray(`   (no book voted for "${target}" — check the genre list above for a valid name)`));
        } else {
          const books = ctx.entries
            .map(e => ({ entry: e, detail: bookDetails.get(e.id) }))
            .filter(x => x.detail && x.detail.genre === target)
            .sort((a, b) =>
              (a.detail!.position ?? Infinity) - (b.detail!.position ?? Infinity) ||
              a.entry.title.localeCompare(b.entry.title)
            );
          const truncatedBooks = books.length > TOP_VOTE_BOOKS;
          lines.push(chalk.white.bold(`   Books that voted for "${chalk.white(target)}" (${chalk.yellow(books.length.toLocaleString())})${truncatedBooks ? chalk.gray(` — showing first ${TOP_VOTE_BOOKS}`) : ''}:`));
          books.slice(0, TOP_VOTE_BOOKS).forEach(({ entry, detail }, i) => {
            const via = detail!.position !== undefined && detail!.position !== null
              ? chalk.gray(` via ${detail!.tag} @ pos ${detail!.position}`)
              : chalk.gray(' via book-page genre (no positioned tag)');
            lines.push(`   ${String(i + 1).padStart(3, ' ')}. ${chalk.white(entry.title)} — ${chalk.white(entry.author)} (${chalk.gray(entry.dateRead)})${via}`);
            const book = ctx.bookCache[entry.id];
            const pageGenres = book?.genres;
            if (pageGenres && pageGenres.length > 0) {
              lines.push(`        ${chalk.gray('book page genres: ')}${chalk.white(pageGenres.join(', '))}`);
            }
          });
        }
      }
    }
  }
  return lines;
}

export function renderPublishers(ctx: SectionContext): string[] {
  const entries = ctx.entries;
  const counts = new Map<string, number>();
  let noPublisherBooks = 0;

  for (const entry of entries) {
    const publisher = entry.publisher.replace(/\s+/g, ' ').trim();
    if (!publisher) {
      noPublisherBooks++;
      continue;
    }
    counts.set(publisher, (counts.get(publisher) || 0) + 1);
  }

  if (counts.size === 0) return [chalk.gray('   (no publishers)')];

  const lines: string[] = [];
  lines.push(`   Distinct publishers: ${chalk.white(counts.size.toLocaleString())}`);

  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = sorted.slice(0, 10);

  lines.push(chalk.gray(DIVIDER));
  lines.push(chalk.white.bold('   Top 10 by number of books:'));
  for (const [publisher, count] of top) {
    const pct = (count / entries.length) * 100;
    lines.push(`      ${chalk.white(publisher)}: ${chalk.yellow(count.toLocaleString())} (${pct.toFixed(1)}%)`);
  }
  if (noPublisherBooks > 0) lines.push(chalk.gray(`   (${noPublisherBooks.toLocaleString()} book${noPublisherBooks === 1 ? '' : 's'} had no publisher)`));

  return lines;
}

export const SECTIONS: Section[] = [
  { key: 'stats', title: '📊 Reading stats', render: (ctx) => renderStats(ctx.entries) },
  { key: 'ratings', title: '⭐ Ratings and reviews', render: (ctx) => renderRatings(ctx.entries) },
  { key: 'distribution', title: '📊 Distribution', render: renderDistribution },
  { key: 'five-star', title: (ctx) => topRatedTitle(ctx.entries), render: renderTopRated },
  { key: 'favorite-authors', title: '🏆 Favorite authors', render: renderFavoriteAuthors },
  { key: 'tags', title: '🏷️ Tags', render: renderTags },
  { key: 'bookshelves', title: '📚 Bookshelves', render: renderBookshelves },
  { key: 'publishers', title: '🏢 Publishers', render: renderPublishers }
];

export async function renderSections(sections: Section[], ctx: SectionContext): Promise<void> {
  for (const section of sections) {
    const title = typeof section.title === 'function' ? section.title(ctx) : section.title;
    console.log(chalk.white.bold(`\n${title}`));
    console.log(chalk.gray(DIVIDER));
    for (const line of await section.render(ctx)) console.log(line);
  }

  console.log(chalk.gray(DIVIDER));
  console.log('');
}

export async function runYearInBooks(options: YearInBooksOptions = {}): Promise<void> {
  let year = options.year || '';
  let library: LibraryExport;
  let liveSourceNote = '';

  if (options.userId) {
    if (!year) {
      year = String(new Date().getFullYear());
      console.log(chalk.gray(`   (No --year given; using current year: ${year})`));
    }
    const config = loadConfig();
    const result = await fetchLiveYearReads(options.userId, year, { cookie: config.cookie });
    if (result.stoppedReason === 'error' || result.entries.length === 0) {
      console.error(chalk.red.bold(
        result.error
          ? `Error: Live review-list fetch failed for user ${options.userId}: ${result.error}`
          : `No books read in ${year} for user ${options.userId} (or the review list requires the login cookie / is private).`
      ));
      process.exit(1);
    }
    library = {
      sourcePath: `live review-list (user ${options.userId}, read_at ${year})`,
      totalEntries: result.entries.length,
      reviewedEntries: result.entries.filter(e => e.hasReview).length,
      reviewedById: new Set(result.entries.map(e => e.id)),
      reviewedByTitleAuthor: new Set(),
      entries: result.entries
    };
    liveSourceNote = chalk.gray(`   Source: live review-list page for user ${chalk.white(options.userId)} (${result.pagesFetched} page${result.pagesFetched === 1 ? '' : 's'} walked) — no CSV export needed. Publisher data is not on the review-list page, so the Publishers section will be empty.`);
  } else {
    library = await getLibrary(options);

    if (!year) {
      year = mostRecentReviewYear(library);
      console.log(chalk.gray(`   (No --year given; using most recent review year: ${year})`));
    }

    if (options.live && year === String(new Date().getFullYear())) {
      const sync = await maybeSyncLiveReads(library, year);
      if (sync && sync.entries.length > 0) {
        const known = new Set(library.entries.map(e => e.id));
        const merged = sync.entries.filter(e => !known.has(e.id));
        if (merged.length > 0) {
          const liveNote = chalk.green(
            `\n   ✳️  Live review-list sync: +${merged.length} book${merged.length === 1 ? '' : 's'} read since your last CSV export (${sync.pagesFetched} page${sync.pagesFetched === 1 ? '' : 's'} walked; ${sync.stoppedReason === 'caught-up' ? 'caught up' : sync.stoppedReason}).`
          );
          library.entries.push(...merged);
          console.log(liveNote);
        }
      } else if (sync) {
        console.log(chalk.gray(`   (Live review-list sync: no new reads since your last CSV export — ${sync.pagesFetched} page${sync.pagesFetched === 1 ? '' : 's'} walked.)`));
      }
    }
  }

  if (!/^\d{4}$/.test(year)) {
    console.error(chalk.red.bold(`Error: Invalid year "${year}". Use --year <YYYY> or a cached library with Date Read values.`));
    process.exit(1);
  }

  const requireReviews = options.requireReviews === true;
  const readEntries = readInYear(library, year, false);
  const reviewedEntries = readInYear(library, year, true);
  const entries = requireReviews ? reviewedEntries : readEntries;
  if (entries.length === 0) {
    console.log(chalk.yellow(requireReviews
      ? `   No books read + reviewed in ${year}.`
      : `   No books read in ${year}.`));
    return;
  }

  // Sparse cache: only the books actually read that year.
  const bookCache: BookCache = {};
  for (const entry of entries) {
    if (bookCache[entry.id]) continue;
    const book = getBook(entry.id);
    if (book) bookCache[entry.id] = book;
  }
  const ctx: SectionContext = { entries, bookCache, reviewYear: parseInt(year, 10), voteGenres: options.vote === true || options.voteBooks !== undefined, voteBooks: options.voteBooks };
  const allDated = library.entries.filter(e => /^\d{4}\//.test(e.dateRead));
  const perDay: PerDayContext = { year: parseInt(year, 10), allEntries: allDated };
  const sections: Section[] = [
    { key: 'stats', title: '📊 Reading stats', render: (c) => renderStats(c.entries, perDay) },
    ...SECTIONS.slice(1),
  ];

  console.log(chalk.cyan.bold(`\n📚 Year in Books — ${year}`));
  if (liveSourceNote) console.log(liveSourceNote);
  console.log(chalk.gray(requireReviews
    ? `   ${readEntries.length.toLocaleString()} books read (${reviewedEntries.length.toLocaleString()} reviewed) — read shelf + review text required, year from Date Read`
    : `   ${readEntries.length.toLocaleString()} books read (${reviewedEntries.length.toLocaleString()} reviewed) — read shelf, year from Date Read`));
  console.log(chalk.gray(DIVIDER));

  await renderSections(sections, ctx);
}
