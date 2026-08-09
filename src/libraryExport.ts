import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import { normalizeTitle, normalizeAuthor } from './utils.js';

const REQUIRED_COLUMNS = ['Book Id', 'Title', 'Author', 'Exclusive Shelf', 'Date Read', 'My Review', 'My Rating', 'Number of Pages', 'Publisher', 'Bookshelves'];

const CACHE_VERSION = 7;

function cachePath(libraryName?: string): string {
  if (!libraryName) return path.join(process.cwd(), 'libraryExportCache.json');
  if (!/^[A-Za-z0-9._-]+$/.test(libraryName)) {
    throw new Error(`Invalid --library name "${libraryName}". Use only letters, numbers, dots, dashes, and underscores.`);
  }
  return path.join(process.cwd(), `libraryExportCache.${libraryName}.json`);
}

export interface LibraryEntry {
  id: string;
  title: string;
  author: string;
  shelf: string;
  dateRead: string;
  hasReview: boolean;
  review: string;
  published: string;
  myRating: string;
  pages: string;
  publisher: string;
  bookshelves: string;
}

export interface LibraryExport {
  sourcePath: string;
  totalEntries: number;
  reviewedEntries: number;
  reviewedById: Set<string>;
  reviewedByTitleAuthor: Set<string>;
  entries: LibraryEntry[];
  cachedAt?: string;
}

export function isReviewedEntry(entry: Record<string, string>): boolean {
  if (entry['Exclusive Shelf'] === 'read') return true;
  if (entry['Date Read'] && entry['Date Read'].trim()) return true;
  if (entry['My Review'] && entry['My Review'].trim()) return true;
  return false;
}

export function matchesReviewed(
  library: LibraryExport,
  bookId: string,
  title: string,
  author: string
): boolean {
  if (library.reviewedById.has(bookId)) return true;
  if (title && author) {
    const key = `${normalizeTitle(title)}|${normalizeAuthor(author)}`;
    if (library.reviewedByTitleAuthor.has(key)) return true;
  }
  return false;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || (row.length === 1 && row[0] !== '')) {
        rows.push(row);
      }
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export async function loadLibraryExport(exportPath: string, libraryName?: string): Promise<LibraryExport> {
  const resolved = path.resolve(process.cwd(), exportPath);
  if (!(await fs.pathExists(resolved))) {
    throw new Error(`Library export file not found at: ${resolved}`);
  }

  const raw = await fs.readFile(resolved, 'utf8');
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

  const rows = parseCsv(text);
  if (rows.length < 2) {
    throw new Error(`Library export at ${resolved} has no data rows.`);
  }

  const headers = rows[0].map(h => h.trim());
  const missing = REQUIRED_COLUMNS.filter(col => !headers.includes(col));
  if (missing.length > 0) {
    throw new Error(
      `Library export at ${resolved} is missing required column(s): ${missing.join(', ')}.\n` +
      `Expected columns include: ${REQUIRED_COLUMNS.join(', ')}. The Goodreads export format may have changed.`
    );
  }

  const idx = (name: string) => headers.indexOf(name);

  let dateWarnings = 0;
  const reviewedById = new Set<string>();
  const reviewedByTitleAuthor = new Set<string>();
  const entries: LibraryEntry[] = [];
  let reviewedEntries = 0;
  let totalEntries = 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 1 && row[0].trim() === '') continue;
    totalEntries++;

    const entry: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      entry[headers[c]] = row[c] ?? '';
    }

    const dateRead = entry['Date Read'];
    if (dateRead && dateWarnings < 5 && !/^\d{4}\/\d{2}\/\d{2}$/.test(dateRead.trim())) {
      dateWarnings++;
      if (dateWarnings === 1) {
        console.log(chalk.yellow(`⚠️  Warning: Some Date Read values don't match YYYY/MM/DD (e.g. "${dateRead}"). The Goodreads export format may have changed.`));
      }
    }

    const review = (entry['My Review'] || '').trim();
    entries.push({
      id: entry['Book Id'],
      title: entry['Title'],
      author: entry['Author'],
      shelf: entry['Exclusive Shelf'],
      dateRead: dateRead.trim(),
      hasReview: !!review,
      review,
      published: (entry['Year Published'] || '').trim(),
      myRating: (entry['My Rating'] || '').trim(),
      pages: (entry['Number of Pages'] || '').trim(),
      publisher: (entry['Publisher'] || '').trim(),
      bookshelves: (entry['Bookshelves'] || '').trim()
    });

    if (isReviewedEntry(entry)) {
      reviewedEntries++;
      const id = entry['Book Id'];
      if (id) reviewedById.add(id);
      const title = entry['Title'];
      const author = entry['Author'];
      if (title && author) {
        reviewedByTitleAuthor.add(`${normalizeTitle(title)}|${normalizeAuthor(author)}`);
      }
    }
  }

  console.log(chalk.gray(`   Library export: ${path.basename(resolved)} (${totalEntries.toLocaleString()} entries, ${reviewedEntries.toLocaleString()} reviewed)`));

  const library: LibraryExport = {
    sourcePath: resolved,
    totalEntries,
    reviewedEntries,
    reviewedById,
    reviewedByTitleAuthor,
    entries
  };
  await saveLibraryExportCache(library, libraryName);
  return library;
}

export async function saveLibraryExportCache(library: LibraryExport, libraryName?: string): Promise<void> {
  const cacheFile = cachePath(libraryName);
  const payload = {
    version: CACHE_VERSION,
    sourcePath: library.sourcePath,
    importedAt: new Date().toISOString(),
    totalEntries: library.totalEntries,
    reviewedEntries: library.reviewedEntries,
    reviewedById: Array.from(library.reviewedById),
    reviewedByTitleAuthor: Array.from(library.reviewedByTitleAuthor),
    entries: library.entries
  };
  await fs.writeJson(cacheFile, payload, { spaces: 2 });
  const cachedName = path.basename(cacheFile);
  console.log(chalk.gray(`   Library export cached: ${path.basename(library.sourcePath)} (${cachedName} — future --excludeReviewed runs won't need --export/--import)`));
}

export async function loadLibraryExportCache(libraryName?: string): Promise<LibraryExport | null> {
  const cacheFile = cachePath(libraryName);
  if (!(await fs.pathExists(cacheFile))) return null;
  try {
    const payload = await fs.readJson(cacheFile);
    if (
      payload?.version !== CACHE_VERSION ||
      !payload.sourcePath ||
      !Array.isArray(payload.reviewedById) ||
      !Array.isArray(payload.reviewedByTitleAuthor) ||
      !Array.isArray(payload.entries)
    ) {
      throw new Error('stale cache (different version)');
    }
    return {
      sourcePath: payload.sourcePath,
      totalEntries: payload.totalEntries,
      reviewedEntries: payload.reviewedEntries,
      reviewedById: new Set(payload.reviewedById),
      reviewedByTitleAuthor: new Set(payload.reviewedByTitleAuthor),
      entries: payload.entries,
      cachedAt: payload.importedAt
    };
  } catch (error: any) {
    console.log(chalk.yellow(`   ⚠️  Library export cache at ${cacheFile} is ${error.message}. Run once with --export to rebuild it.`));
    return null;
  }
}
