import chalk from 'chalk';
import { scrapeShelfBooks } from './scraper.js';
import { loadBookCache } from './storage.js';
import { splitAuthorNames, authorFirstAndLast } from './bookMatch.js';
import { matchesReviewed } from './libraryExport.js';
import { getLibrary, reviewedInYear, charCounts, publishedCounts, missingLetters, missingPubYears, mostRecentReviewYear, firstCharBucket, parseYear } from './library.js';
import { getYear, formatBookLink } from './utils.js';

export interface TagGapsOptions {
  pages?: string;
  year?: string;
  limit?: string;
  minTags?: string;
  export?: string;
  library?: string;
}

interface Candidate {
  title: string;
  id: string;
  author: string;
  bucket: string;
  published: string;
  pages?: string;
}

interface Dimension {
  label: string;
  missingList: string[];
  missingSet: Set<string>;
  found: Map<string, Candidate[]>;
}

interface ScanBook {
  title: string;
  id: string;
  author: string;
  published: string;
  pages?: string;
}

const DIMENSIONS: { key: 'title' | 'authorFirst' | 'authorLast' | 'publishYear'; label: string }[] = [
  { key: 'title', label: 'Title first letter' },
  { key: 'authorFirst', label: 'Author first name' },
  { key: 'authorLast', label: 'Author last name' },
  { key: 'publishYear', label: 'Publication year' }
];

function addCandidate(dim: Dimension, book: ScanBook, bucket: string, limit: number): void {
  if (!dim.missingSet.has(bucket)) return;
  const list = dim.found.get(bucket) ?? [];
  if (list.length >= limit) return;
  if (list.some(c => c.id === book.id)) return;
  list.push({ ...book, bucket });
  dim.found.set(bucket, list);
}

function makeDimension(label: string, missingList: string[]): Dimension {
  return { label, missingList, missingSet: new Set(missingList), found: new Map() };
}

function buildDims(library: Parameters<typeof reviewedInYear>[0], year: string): Record<string, Dimension> {
  const entries = reviewedInYear(library, year);
  return {
    title: makeDimension('Title first letter', missingLetters(charCounts(entries, 'title'))),
    authorFirst: makeDimension('Author first name', missingLetters(charCounts(entries, 'authorFirst'))),
    authorLast: makeDimension('Author last name', missingLetters(charCounts(entries, 'authorLast'))),
    publishYear: makeDimension('Publication year', missingPubYears(publishedCounts(entries), parseInt(year, 10)))
  };
}

function resolveYear(options: { year?: string }, library: Parameters<typeof reviewedInYear>[0]): string {
  let year = options.year || '';
  if (!year) {
    year = mostRecentReviewYear(library);
    console.log(chalk.gray(`   (No --year given; using most recent review year: ${year})`));
  }
  if (!/^\d{4}$/.test(year)) {
    console.error(chalk.red.bold(`Error: Invalid year "${year}". Use --year <YYYY> or a cached library with Date Read values.`));
    process.exit(1);
  }
  return year;
}

async function runGapsCore(
  library: Parameters<typeof reviewedInYear>[0],
  year: string,
  limit: number,
  books: ScanBook[],
  sourceLabel: string,
  scannedLabel: string,
  candidatesLabel: string
): Promise<void> {
  const dims = buildDims(library, year);

  console.log(chalk.cyan.bold(`\n🔍 ${sourceLabel} — review year ${year}`));
  console.log(chalk.gray(`   ${scannedLabel}`));
  console.log(chalk.gray(`   Up to ${limit} books per missing bucket (title/authorFirstName/authorLastName letters + publication years); already-reviewed books are skipped`));
  console.log(chalk.gray('------------------------------------------'));
  for (const dim of DIMENSIONS) {
    const d = dims[dim.key];
    console.log(chalk.gray(`   ${dim.label} missing (${d.missingList.length}): ${d.missingList.join(', ') || '—'}`));
  }
  console.log(chalk.gray('------------------------------------------'));

  let reviewedSkipped = 0;
  for (const book of books) {
    if (matchesReviewed(library, book.id, book.title, book.author)) {
      reviewedSkipped++;
      continue;
    }

    const names = splitAuthorNames(book.author);
    const { first, last } = names.length ? authorFirstAndLast(names[0]) : { first: '', last: '' };

    addCandidate(dims.title, book, firstCharBucket(book.title), limit);
    addCandidate(dims.authorFirst, book, firstCharBucket(first), limit);
    addCandidate(dims.authorLast, book, firstCharBucket(last), limit);

    const pubYear = parseYear(book.published);
    if (pubYear) addCandidate(dims.publishYear, book, pubYear, limit);

    const allFull = DIMENSIONS.every(dim => {
      const d = dims[dim.key];
      return d.missingList.length === 0 || d.missingList.every(b => (d.found.get(b) || []).length >= limit);
    });
    if (allFull) break;
  }

  console.log(chalk.cyan.bold(`\n🧭 Candidates to fill gaps (${candidatesLabel}, ${books.length} books scanned)`));
  if (reviewedSkipped > 0) console.log(chalk.gray(`   (skipped ${reviewedSkipped.toLocaleString()} already-reviewed books)`));
  console.log(chalk.gray('------------------------------------------'));

  for (const dim of DIMENSIONS) {
    const d = dims[dim.key];
    if (d.missingList.length === 0) {
      console.log(chalk.green.bold(`\n   ✅ ${dim.label}: no gaps to fill`));
      continue;
    }
    console.log(chalk.white.bold(`\n   ${dim.label} (missing: ${d.missingList.join(', ') || '—'}):`));
    for (const bucket of d.missingList) {
      const found = d.found.get(bucket) || [];
      console.log(chalk.gray(`      ${chalk.white(bucket)}:`));
      if (found.length === 0) {
        console.log(chalk.yellow(`         (none found in the first ${books.length} books)`));
        continue;
      }
      for (let i = 0; i < found.length; i++) {
        const c = found[i];
        const yearStr = c.published && c.published !== 'Unknown' ? `, pub ${getYear(c.published)}` : '';
        const pagesStr = c.pages ? `, ${c.pages} pages` : '';
        console.log(`         ${i + 1}. ${chalk.white(formatBookLink(c.title, c.id))} by ${c.author}${yearStr}${pagesStr}`);
      }
    }
  }

  console.log(chalk.gray('------------------------------------------'));
  console.log('');
}

export async function runTagGaps(tag: string, options: TagGapsOptions = {}): Promise<void> {
  const pages = parseInt(options.pages || '25', 10);
  const limit = parseInt(options.limit || '3', 10);
  const minTags = parseInt(options.minTags || '0', 10);

  const library = await getLibrary(options);
  const year = resolveYear(options, library);

  const shelfBooks = await scrapeShelfBooks(tag, minTags, pages);

  const scanBooks: ScanBook[] = shelfBooks.map(book => ({
    title: book.title,
    id: book.id,
    author: book.author,
    published: book.published,
    pages: book.pages
  }));

  await runGapsCore(
    library,
    year,
    limit,
    scanBooks,
    `Tag gaps for shelf "${tag}"`,
    `Scanning up to ${pages} page(s) of https://www.goodreads.com/shelf/show/${tag} (min tags: ${minTags})`,
    'shelf order'
  );
}

export async function runCacheGaps(options: TagGapsOptions = {}): Promise<void> {
  const limit = parseInt(options.limit || '3', 10);

  const library = await getLibrary(options);
  const year = resolveYear(options, library);

  const bookCache = await loadBookCache();
  const scanBooks: ScanBook[] = Object.values(bookCache)
    .filter(book => !book.isBad && book.title && book.title !== 'Unknown' && book.author && book.author !== 'Unknown')
    .sort((a, b) => {
      const ratingsA = parseInt(a.ratings.replace(/,/g, ''), 10) || 0;
      const ratingsB = parseInt(b.ratings.replace(/,/g, ''), 10) || 0;
      return ratingsB - ratingsA;
    })
    .map(book => ({
      title: book.title,
      id: book.id,
      author: book.author,
      published: book.published,
      pages: book.pages
    }));

  await runGapsCore(
    library,
    year,
    limit,
    scanBooks,
    `Book-cache gap fillers`,
    `Scanning ${scanBooks.length.toLocaleString()} cached books (sorted by ratings)`,
    'cache order'
  );
}
