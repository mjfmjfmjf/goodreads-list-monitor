import chalk from 'chalk';
import { scrapeShelfBooks } from './scraper.js';
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
}

interface Candidate {
  title: string;
  id: string;
  author: string;
  bucket: string;
  published: string;
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

export async function runTagGaps(tag: string, options: TagGapsOptions = {}): Promise<void> {
  const pages = parseInt(options.pages || '25', 10);
  const limit = parseInt(options.limit || '3', 10);
  const minTags = parseInt(options.minTags || '0', 10);

  const library = await getLibrary(options);

  let year = options.year || '';
  if (!year) {
    year = mostRecentReviewYear(library);
    console.log(chalk.gray(`   (No --year given; using most recent review year: ${year})`));
  }
  if (!/^\d{4}$/.test(year)) {
    console.error(chalk.red.bold(`Error: Invalid year "${year}". Use --year <YYYY> or a cached library with Date Read values.`));
    process.exit(1);
  }

  const entries = reviewedInYear(library, year);

  const dims: Record<string, Dimension> = {
    title: makeDimension('Title first letter', missingLetters(charCounts(entries, 'title'))),
    authorFirst: makeDimension('Author first name', missingLetters(charCounts(entries, 'authorFirst'))),
    authorLast: makeDimension('Author last name', missingLetters(charCounts(entries, 'authorLast'))),
    publishYear: makeDimension('Publication year', missingPubYears(publishedCounts(entries), parseInt(year, 10)))
  };

  console.log(chalk.cyan.bold(`\n🔍 Tag gaps for shelf "${tag}" — review year ${year}`));
  console.log(chalk.gray(`   Scanning up to ${pages} page(s) of https://www.goodreads.com/shelf/show/${tag} (min tags: ${minTags})`));
  console.log(chalk.gray(`   Up to ${limit} books per missing bucket (title/authorFirstName/authorLastName letters + publication years); already-reviewed books are skipped`));
  console.log(chalk.gray('------------------------------------------'));
  for (const dim of DIMENSIONS) {
    const d = dims[dim.key];
    console.log(chalk.gray(`   ${dim.label} missing (${d.missingList.length}): ${d.missingList.join(', ') || '—'}`));
  }
  console.log(chalk.gray('------------------------------------------'));

  const shelfBooks = await scrapeShelfBooks(tag, minTags, pages);

  let reviewedSkipped = 0;
  for (const book of shelfBooks) {
    if (matchesReviewed(library, book.id, book.title, book.author)) {
      reviewedSkipped++;
      continue;
    }

    const scanBook: ScanBook = { title: book.title, id: book.id, author: book.author, published: book.published };
    const names = splitAuthorNames(book.author);
    const { first, last } = names.length ? authorFirstAndLast(names[0]) : { first: '', last: '' };

    addCandidate(dims.title, scanBook, firstCharBucket(book.title), limit);
    addCandidate(dims.authorFirst, scanBook, firstCharBucket(first), limit);
    addCandidate(dims.authorLast, scanBook, firstCharBucket(last), limit);

    const pubYear = parseYear(book.published);
    if (pubYear) addCandidate(dims.publishYear, scanBook, pubYear, limit);

    const allFull = DIMENSIONS.every(dim => {
      const d = dims[dim.key];
      return d.missingList.length === 0 || d.missingList.every(b => (d.found.get(b) || []).length >= limit);
    });
    if (allFull) break;
  }

  console.log(chalk.cyan.bold(`\n🧭 Candidates to fill gaps (shelf order, ${shelfBooks.length} books scanned)`));
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
        console.log(chalk.yellow(`         (none found in the first ${shelfBooks.length} shelf books)`));
        continue;
      }
      for (let i = 0; i < found.length; i++) {
        const c = found[i];
        const yearStr = c.published && c.published !== 'Unknown' ? `, pub ${getYear(c.published)}` : '';
        console.log(`         ${i + 1}. ${chalk.white(formatBookLink(c.title, c.id))} by ${c.author}${yearStr}`);
      }
    }
  }

  console.log(chalk.gray('------------------------------------------'));
  console.log('');
}
