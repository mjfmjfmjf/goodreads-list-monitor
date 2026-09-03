import chalk from 'chalk';
import { getDb } from './db.js';
import { replaceGenreTagXref, loadGenreTagXref, loadGenres } from './storage.js';
import { computeGenreCompare } from './genreCompare.js';

// Curated spelling-variant families: a canonical genre mapped to all its
// spelling/tag-form variants (kind='cognate'). These fold sf/scifi/sci-fi/sff
// into science-fiction, nonfiction into non-fiction, picture-book(s) into
// picture-books, and the sci-fi+fantasy compound spellings into one.
const COGNATE_FAMILIES: Array<{ genre: string; tags: string[] }> = [
  { genre: 'science-fiction', tags: ['sf', 'sci-fi', 'scifi', 'sff', 'science-fiction'] },
  { genre: 'science-fiction-fantasy', tags: ['sci-fi-fantasy', 'scifi-fantasy', 'fantasy-sci-fi', 'fantasy-scifi', 'science-fiction-fantasy'] },
  { genre: 'non-fiction', tags: ['non-fiction', 'nonfiction'] },
  { genre: 'picture-books', tags: ['picture-books', 'picture-book'] },
];

export interface XrefSeedResult {
  exactAdded: number;
  exactRemoved: number;
  cognateAdded: number;
  cognateRemoved: number;
}

// Ensures the xref contains both the exact genre<->tag matches (from the
// compare) and the curated cognate families. Idempotent when re-run.
export function ensureXrefSeeded(): XrefSeedResult {
  const db = getDb();
  const genres = loadGenres().map(g => g.name);
  const tags = (db.prepare('SELECT DISTINCT tag_name FROM tag_books').all() as any[]).map(r => r.tag_name);

  const res = computeGenreCompare(genres, tags);
  const exact = replaceGenreTagXrefForAll(res.exactMatched, 'exact');

  let cognateAdded = 0;
  let cognateRemoved = 0;
  for (const fam of COGNATE_FAMILIES) {
    // Only map tags that actually exist in tag_books (skip phantom aliases).
    const real = fam.tags.filter(t => tags.includes(t));
    if (real.length === 0) continue;
    const r = replaceGenreTagXref(fam.genre, real.map(t => ({ tagName: t, kind: 'cognate' })));
    cognateAdded += r.added;
    cognateRemoved += r.removed;
  }

  return {
    exactAdded: exact.added,
    exactRemoved: exact.removed,
    cognateAdded,
    cognateRemoved,
  };
}

function replaceGenreTagXrefForAll(genres: string[], kind: string): { added: number; removed: number } {
  const db = getDb();
  let added = 0;
  let removed = 0;
  for (const g of genres) {
    const tags = (db.prepare('SELECT DISTINCT tag_name FROM tag_books WHERE tag_name = ?').all(g) as any[]).map(r => r.tag_name);
    const r = replaceGenreTagXref(g, tags.map(t => ({ tagName: t, kind })));
    added += r.added;
    removed += r.removed;
  }
  return { added, removed };
}

export function renderXref(options: { limit?: string | number; showCognateOnly?: boolean } = {}): void {
  const rows = loadGenreTagXref();
  const limit = typeof options.limit === 'number' ? options.limit : (options.limit ? parseInt(options.limit, 10) : 40);
  const filtered = options.showCognateOnly ? rows.filter(r => r.kind === 'cognate') : rows;

  // group by genre
  const byGenre = new Map<string, string[]>();
  for (const r of filtered) {
    if (!byGenre.has(r.genreName)) byGenre.set(r.genreName, []);
    byGenre.get(r.genreName)!.push(r.tagName);
  }
  const genres = [...byGenre.keys()].sort();

  console.log(chalk.cyan.bold(`\n🔗 Genre ↔ Tag xref (${chalk.white(String(rows.length))} rows, ${chalk.white(String(byGenre.size))} genres):`));
  if (rows.length === 0) {
    console.log(chalk.gray('   Empty. Run `genre-list --seed-xref` to populate.'));
    return;
  }
  let shown = 0;
  for (const g of genres.slice(0, limit)) {
    const tags = byGenre.get(g)!.slice(0, 10);
    console.log(chalk.white(g.padEnd(28)) + (byGenre.get(g)!.length > 10 ? chalk.gray(` ${byGenre.get(g)!.length} tags → `) : chalk.gray(' → ')) + chalk.gray(tags.join(', ')));
    shown++;
  }
  if (genres.length > shown) console.log(chalk.gray(`   … and ${genres.length - shown} more genres (use --limit <n>).`));
}
