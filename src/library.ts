import chalk from 'chalk';
import { loadLibraryExport, loadLibraryExportCache, LibraryExport, LibraryEntry } from './libraryExport.js';
import { splitAuthorNames, authorFirstAndLast } from './bookMatch.js';

export interface LibraryQueryOptions {
  year?: string;
  field?: string;
  export?: string;
  library?: string;
}

const QUERIES = ['by-char', 'published-year', 'missing'];
const FIELDS = ['title', 'authorLast', 'authorFirst'] as const;
export type CharField = typeof FIELDS[number];

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

export function firstCharBucket(value: string): string {
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

export function charBucket(entry: LibraryEntry, field: CharField): string {
  return firstCharBucket(fieldValue(entry, field));
}

export function parseYear(value: string): string | null {
  const m = value.trim().match(/^(\d{4})/);
  return m ? m[1] : null;
}

export function readInYear(library: LibraryExport, year: string, requireReviews = false): LibraryEntry[] {
  const prefix = `${year}/`;
  return library.entries.filter(e =>
    e.dateRead.startsWith(prefix) && e.shelf === 'read' && (!requireReviews || e.hasReview)
  );
}

export function reviewedInYear(library: LibraryExport, year: string): LibraryEntry[] {
  return readInYear(library, year, true);
}

export function readAll(library: LibraryExport, requireReviews = false): LibraryEntry[] {
  return library.entries.filter(e => e.shelf === 'read' && (!requireReviews || e.hasReview));
}

export function reviewedAll(library: LibraryExport): LibraryEntry[] {
  return readAll(library, true);
}

export function charCounts(entries: LibraryEntry[], field: CharField): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const bucket = charBucket(entry, field);
    counts.set(bucket, (counts.get(bucket) || 0) + 1);
  }
  return counts;
}

export function publishedCounts(entries: LibraryEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const bucket = parseYear(entry.published) ?? 'Unknown';
    counts.set(bucket, (counts.get(bucket) || 0) + 1);
  }
  return counts;
}

export function missingLetters(counts: Map<string, number>): string[] {
  return ALPHABET.filter(letter => !counts.get(letter));
}

export function mostRecentReviewYear(library: LibraryExport): string {
  let maxYear = 0;
  for (const entry of library.entries) {
    const y = parseInt(entry.dateRead.slice(0, 4), 10);
    if (!isNaN(y) && y > maxYear) maxYear = y;
  }
  return String(maxYear);
}

export function pubYearUpper(counts: Map<string, number>, reviewYear: number): number {
  let upper = reviewYear;
  for (const key of counts.keys()) {
    if (key !== 'Unknown') upper = Math.max(upper, parseInt(key, 10));
  }
  return upper;
}

export function missingPubYears(counts: Map<string, number>, reviewYear: number): string[] {
  const upper = pubYearUpper(counts, reviewYear);
  const missing: string[] = [];
  for (let y = 1961; y <= upper; y++) {
    if (!counts.get(String(y))) missing.push(String(y));
  }
  return missing;
}

export function renderCharCountLines(entries: LibraryEntry[], field: CharField, firstExample?: (bucket: string) => string): string[] {
  const counts = charCounts(entries, field);
  const lines: string[] = [];
  for (const letter of ALPHABET) {
    let line = `   ${chalk.white(letter)}: ${(counts.get(letter) || 0).toLocaleString()}`;
    if (firstExample && counts.get(letter)) line += firstExample(letter);
    lines.push(line);
  }
  const hashCount = counts.get('#') || 0;
  if (hashCount > 0) {
    let line = `   ${chalk.white('#')}: ${hashCount.toLocaleString()}`;
    if (firstExample) line += firstExample('#');
    lines.push(line);
  }
  return lines;
}

export function renderPublishedYearLines(entries: LibraryEntry[], firstExample?: (pubYear: string) => string): string[] {
  const counts = publishedCounts(entries);
  const years = Array.from(counts.keys()).sort((a, b) => {
    if (a === 'Unknown') return 1;
    if (b === 'Unknown') return -1;
    return parseInt(a, 10) - parseInt(b, 10);
  });
  return years.map(pubYear => {
    let line = `   ${chalk.white(pubYear)}: ${(counts.get(pubYear) || 0).toLocaleString()}`;
    if (firstExample) line += firstExample(pubYear);
    return line;
  });
}

export function renderMissingLines(entries: LibraryEntry[], year: string): string[] {
  const lines: string[] = [];
  for (const field of FIELDS) {
    const missing = missingLetters(charCounts(entries, field));
    const value = missing.length ? missing.join(', ') : '—';
    lines.push(`   ${chalk.white(CHAR_LABELS[field])} (${missing.length} missing): ${chalk.yellow(value)}`);
  }
  const counts = publishedCounts(entries);
  const upper = pubYearUpper(counts, parseInt(year, 10));
  const missingYears = missingPubYears(counts, parseInt(year, 10));
  const yearsText = missingYears.length ? missingYears.join(', ') : '—';
  lines.push(`   ${chalk.white(`Publication years 1961-${upper}`)} (${missingYears.length} missing): ${chalk.yellow(yearsText)}`);
  return lines;
}

function printDivider(): void {
  console.log(chalk.gray('------------------------------------------'));
}

export async function getLibrary(options: { export?: string; library?: string }): Promise<LibraryExport> {
  if (options.export) return loadLibraryExport(options.export, options.library);
  const library = await loadLibraryExportCache(options.library);
  if (!library) {
    throw new Error('No library export cache found. Run once with --export <path> (or --import <path>) to import + cache your Goodreads library export.');
  }
  return library;
}

function runByChar(library: LibraryExport, year: string, field: CharField): void {
  const entries = reviewedInYear(library, year);

  console.log(chalk.cyan.bold(`\n📚 Reviewed books in ${year} by first letter`));
  console.log(chalk.gray(`   Definition: read shelf + review text, year from Date Read, by ${FIELD_LABELS[field]}`));
  printDivider();
  for (const line of renderCharCountLines(entries, field)) console.log(line);
  printDivider();
  console.log(chalk.cyan(`Total: ${entries.length.toLocaleString()}\n`));
}

function runPublishedYear(library: LibraryExport, year: string): void {
  const entries = reviewedInYear(library, year);

  console.log(chalk.cyan.bold(`\n📚 Reviewed books in ${year} by publication year`));
  console.log(chalk.gray('   Definition: read shelf + review text, year from Date Read, publication year from Year Published'));
  printDivider();
  for (const line of renderPublishedYearLines(entries)) console.log(line);
  printDivider();
  console.log(chalk.cyan(`Total: ${entries.length.toLocaleString()}\n`));
}

function runMissing(library: LibraryExport, year: string): void {
  const entries = reviewedInYear(library, year);

  console.log(chalk.cyan.bold(`\n📚 Missing audit for ${year} (${entries.length.toLocaleString()} books reviewed)`));
  console.log(chalk.gray('   Definition: read shelf + review text, year from Date Read'));
  printDivider();

  for (const line of renderMissingLines(entries, year)) console.log(line);

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
