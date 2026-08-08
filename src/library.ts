import chalk from 'chalk';
import { loadLibraryExport, loadLibraryExportCache, LibraryExport, LibraryEntry } from './libraryExport.js';
import { splitAuthorNames, authorFirstAndLast } from './bookMatch.js';

export interface LibraryQueryOptions {
  year?: string;
  field?: string;
  export?: string;
}

const QUERIES = ['by-char', 'published-year', 'missing'];
const FIELDS = ['title', 'authorLast', 'authorFirst'] as const;
type CharField = typeof FIELDS[number];

const FIELD_LABELS: Record<CharField, string> = {
  title: 'title',
  authorLast: 'author last name',
  authorFirst: 'author first name'
};

const CHAR_LABELS: Record<CharField, string> = {
  title: 'Title first letter',
  authorLast: 'Author last name',
  authorFirst: 'Author first name'
};

const ALPHABET = Array.from({ length: 26 }, (_, i) => String.fromCharCode('A'.charCodeAt(0) + i));

function firstCharBucket(value: string): string {
  const c = value.trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : '#';
}

function fieldValue(entry: LibraryEntry, field: CharField): string {
  if (field === 'title') return entry.title;
  const names = splitAuthorNames(entry.author);
  if (names.length === 0) return '';
  const { first, last } = authorFirstAndLast(names[0]);
  return field === 'authorLast' ? last : first;
}

function parseYear(value: string): string | null {
  const m = value.trim().match(/^(\d{4})/);
  return m ? m[1] : null;
}

function reviewedInYear(library: LibraryExport, year: string): LibraryEntry[] {
  const prefix = `${year}/`;
  return library.entries.filter(e => e.shelf === 'read' && e.hasReview && e.dateRead.startsWith(prefix));
}

function charCounts(entries: LibraryEntry[], field: CharField): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const bucket = firstCharBucket(fieldValue(entry, field));
    counts.set(bucket, (counts.get(bucket) || 0) + 1);
  }
  return counts;
}

function publishedCounts(entries: LibraryEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const bucket = parseYear(entry.published) ?? 'Unknown';
    counts.set(bucket, (counts.get(bucket) || 0) + 1);
  }
  return counts;
}

function printDivider(): void {
  console.log(chalk.gray('------------------------------------------'));
}

async function getLibrary(options: { export?: string }): Promise<LibraryExport> {
  if (options.export) return loadLibraryExport(options.export);
  const library = await loadLibraryExportCache();
  if (!library) {
    throw new Error('No library export cache found. Run once with --export <path> (or --import <path>) to import + cache your Goodreads library export.');
  }
  return library;
}

function runByChar(library: LibraryExport, year: string, field: CharField): void {
  const entries = reviewedInYear(library, year);
  const counts = charCounts(entries, field);

  console.log(chalk.cyan.bold(`\n📚 Reviewed books in ${year} by first letter`));
  console.log(chalk.gray(`   Definition: read shelf + review text, year from Date Read, by ${FIELD_LABELS[field]}`));
  printDivider();
  for (const letter of ALPHABET) {
    console.log(`   ${chalk.white(letter)}: ${(counts.get(letter) || 0).toLocaleString()}`);
  }
  const hashCount = counts.get('#') || 0;
  if (hashCount > 0) console.log(`   ${chalk.white('#')}: ${hashCount.toLocaleString()}`);
  printDivider();
  console.log(chalk.cyan(`Total: ${entries.length.toLocaleString()}\n`));
}

function runPublishedYear(library: LibraryExport, year: string): void {
  const entries = reviewedInYear(library, year);
  const counts = publishedCounts(entries);

  const years = Array.from(counts.keys()).sort((a, b) => {
    if (a === 'Unknown') return 1;
    if (b === 'Unknown') return -1;
    return parseInt(a, 10) - parseInt(b, 10);
  });

  console.log(chalk.cyan.bold(`\n📚 Reviewed books in ${year} by publication year`));
  console.log(chalk.gray('   Definition: read shelf + review text, year from Date Read, publication year from Year Published'));
  printDivider();
  for (const pubYear of years) {
    console.log(`   ${chalk.white(pubYear)}: ${(counts.get(pubYear) || 0).toLocaleString()}`);
  }
  printDivider();
  console.log(chalk.cyan(`Total: ${entries.length.toLocaleString()}\n`));
}

function missingLetters(counts: Map<string, number>): string[] {
  return ALPHABET.filter(letter => !counts.get(letter));
}

function runMissing(library: LibraryExport, year: string): void {
  const entries = reviewedInYear(library, year);

  console.log(chalk.cyan.bold(`\n📚 Missing audit for ${year} (${entries.length.toLocaleString()} books reviewed)`));
  console.log(chalk.gray('   Definition: read shelf + review text, year from Date Read'));
  printDivider();

  for (const field of FIELDS) {
    const missing = missingLetters(charCounts(entries, field));
    const value = missing.length ? missing.join(', ') : '—';
    console.log(`   ${chalk.white(CHAR_LABELS[field])} (${missing.length} missing): ${chalk.yellow(value)}`);
  }

  const counts = publishedCounts(entries);
  let maxPub = 0;
  for (const key of counts.keys()) {
    if (key !== 'Unknown') {
      const n = parseInt(key, 10);
      if (n > maxPub) maxPub = n;
    }
  }
  const upper = Math.max(parseInt(year, 10), maxPub);
  const missingYears: string[] = [];
  for (let y = 1961; y <= upper; y++) {
    if (!counts.get(String(y))) missingYears.push(String(y));
  }
  const yearsText = missingYears.length ? missingYears.join(', ') : '—';
  console.log(`   ${chalk.white(`Publication years 1961-${upper}`)} (${missingYears.length} missing): ${chalk.yellow(yearsText)}`);

  printDivider();
  console.log('');
}

export async function runLibraryQuery(query: string, options: LibraryQueryOptions = {}): Promise<void> {
  if (!QUERIES.includes(query)) {
    console.error(chalk.red.bold(`Error: Unknown library query "${query}". Available queries: ${QUERIES.join(', ')}`));
    process.exit(1);
  }

  if (!options.year || !/^\d{4}$/.test(options.year)) {
    console.error(chalk.red.bold(`Error: ${query} requires --year <YYYY>`));
    process.exit(1);
  }

  const library = await getLibrary(options);

  if (query === 'by-char') {
    const field = (options.field || 'title') as CharField;
    if (!FIELDS.includes(field)) {
      console.error(chalk.red.bold(`Error: --field must be one of: ${FIELDS.join(', ')}`));
      process.exit(1);
    }
    runByChar(library, options.year, field);
  } else if (query === 'published-year') {
    runPublishedYear(library, options.year);
  } else if (query === 'missing') {
    runMissing(library, options.year);
  }
}
