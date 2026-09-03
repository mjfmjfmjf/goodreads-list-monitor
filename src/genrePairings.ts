import chalk from 'chalk';
import { getDb } from './db.js';

export interface Pairing {
  tag: string;
  overlap: number;   // |genre ∩ tag|
  union: number;     // |genre ∪ tag|
  jaccard: number;   // overlap / union, 0..1
  pct: number;       // jaccard * 100, rounded
}

export interface PairingOptions {
  genre?: string;        // restrict to a single genre name
  limit?: string;        // top-K per genre (default 10)
  minMember?: string;    // only genres with member_count >= this
  tagLimit?: string;     // restict per-tag book sets? (unused; sets are full)
  allTags?: boolean;     // include tags that ARE also genres (default: non-genre only)
}

// Load map tag_name -> Set(book_id) once and reuse for every genre.
export function loadTagSets(): { tagSets: Map<string, Set<string>>; nonGenreTags: string[] } {
  const db = getDb();
  const genres = new Set<string>((db.prepare('SELECT name FROM genres').all() as any[]).map(r => r.name));
  const tagSets = new Map<string, Set<string>>();
  const rows = db.prepare('SELECT tag_name, book_id FROM tag_books').all() as any[];
  for (const r of rows) {
    let s = tagSets.get(r.tag_name);
    if (!s) { s = new Set(); tagSets.set(r.tag_name, s); }
    s.add(r.book_id);
  }
  const nonGenreTags = [...tagSets.keys()].filter(t => !genres.has(t));
  return { tagSets, nonGenreTags };
}

// Score one genre's book set against a list of candidate (tag, set) pairs.
// Pure and testable.
export function rankPairings(
  genreBooks: Set<string>,
  candidateSets: Array<{ tag: string; books: Set<string> }>
): Pairing[] {
  const out: Pairing[] = [];
  for (const { tag, books } of candidateSets) {
    let overlap = 0;
    // iterate the smaller set for speed
    const [small, big] = books.size < genreBooks.size ? [books, genreBooks] : [genreBooks, books];
    for (const b of small) if (big.has(b)) overlap++;
    const union = genreBooks.size + books.size - overlap;
    const jaccard = union > 0 ? overlap / union : 0;
    out.push({ tag, overlap, union, jaccard, pct: Math.round(jaccard * 10000) / 100 });
  }
  return out;
}

function renderGenre(name: string, memberCount: number, pairings: Pairing[], genesis: 'exact' | 'scraped' | 'unscraped', topK: number): void {
  console.log(chalk.gray(`\n── ${chalk.white.bold(name)} (${(memberCount || 0).toLocaleString()} bks · ${genesis})`));
  const shown = pairings.slice(0, topK);
  for (let i = 0; i < shown.length; i++) {
    const p = shown[i];
    const bar = '█'.repeat(Math.max(1, Math.round(p.pct / 5)));
    console.log(`  ${String(i + 1).padStart(2)}. ${p.pct.toFixed(1).padStart(5)}%  ${chalk.green(String(p.overlap)).padStart(5)}/Δ${String(p.union).padStart(5)}  ${chalk.gray(bar)} ${chalk.white(p.tag)}`);
  }
  if (pairings.length > shown.length) {
    console.log(chalk.gray(`     … ${pairings.length - shown.length} more`));
  }
}

export function computeGenrePairings(options: PairingOptions = {}): void {
  const db = getDb();
  const { tagSets, nonGenreTags } = loadTagSets();
  const allTagsArr = [...tagSets.entries()].map(([tag, books]) => ({ tag, books }));

  const topK = options.limit ? parseInt(options.limit, 10) : 10;
  const minMember = options.minMember ? parseInt(options.minMember, 10) : 0;

  const genreRows = (db.prepare('SELECT name, member_count FROM genres ORDER BY member_count DESC').all() as any[])
    .filter((g: any) => (g.member_count ?? 0) >= minMember);
  const genreNames = genreRows.map((g: any) => g.name);

  const candidates = options.allTags ? allTagsArr : tagSets.size ? allTagsArr.filter(c => nonGenreTags.includes(c.tag)) : [];

  const singleGenre = options.genre ? [options.genre] : null;

  console.log(chalk.cyan.bold('\n🎯 Genre ↔ tag pairings (by book-set Jaccard similarity)'));
  console.log(chalk.gray(`   Genres: ${genreNames.length} · Candidates: ${chalk.white(String(candidates.length))} ${options.allTags ? '(all tags)' : '(non-genre tags)'} · top ${topK} each`));

  const target = singleGenre && singleGenre[0];
  if (target) {
    // pre-check: is this genre scraped (has a book set)?
    const g = genreRows.find((x: any) => x.name === target);
    const books = tagSets.get(target);
    if (!g) { console.log(chalk.yellow(`   Unknown genre "${target}".`)); return; }
    if (!books || books.size === 0) { console.log(chalk.yellow(`   Genre "${target}" has no scraped book set yet (not in tag_books). Scrape it first with gapGenreTagDiscovery.sh.`)); return; }
    const pairings = rankPairings(books, candidates).sort((a, b) => b.jaccard - a.jaccard || b.overlap - a.overlap);
    const genesis = pairings.some(p => p.jaccard >= 0.999) ? 'exact' : 'scraped';
    renderGenre(target, g.member_count ?? 0, pairings, genesis, topK);
    return;
  }

  for (const g of genreRows) {
    const books = tagSets.get(g.name);
    if (!books || books.size === 0) {
      // unscraped genre — nothing to compare, note briefly
      console.log(chalk.gray(`\n── ${chalk.white.bold(g.name)} (${(g.member_count ?? 0).toLocaleString()} bks · unscraped)`));
      console.log(chalk.gray(`     (no book set yet — scrape with gapGenreTagDiscovery.sh)`));
      continue;
    }
    const pairings = rankPairings(books, candidates).sort((a, b) => b.jaccard - a.jaccard || b.overlap - a.overlap);
    const genesis = pairings.some(p => p.jaccard >= 0.999) ? 'exact' : 'scraped';
    renderGenre(g.name, g.member_count ?? 0, pairings, genesis, topK);
  }
}
