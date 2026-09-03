import chalk from 'chalk';
import { getDb } from './db.js';
import { loadTagSets, rankPairings } from './genrePairings.js';

export interface TagPairingOptions {
  tag?: string;          // restrict to a single non-genre tag
  limit?: string;        // top-K genres per tag (default 5)
  minBooks?: string;     // only consider non-genre tags with >= this many books
  maxResults?: string;   // max non-genre tags to report (default all)
}

export function computeTagPairings(options: TagPairingOptions = {}): void {
  const db = getDb();
  const { tagSets, nonGenreTags } = loadTagSets();

  const topK = options.limit ? parseInt(options.limit, 10) : 5;
  const minBooks = options.minBooks ? parseInt(options.minBooks, 10) : 0;
  const maxResults = options.maxResults ? parseInt(options.maxResults, 10) : Infinity;

  const genreSet = new Set<string>((db.prepare('SELECT name FROM genres').all() as any[]).map(r => r.name));
  // "tags that are genres" = tags whose name is also a genre AND that have a book set.
  const genreTagSets = [...tagSets.entries()]
    .filter(([name]) => genreSet.has(name))
    .map(([tag, books]) => ({ tag, books }));

  let subjects = [...tagSets.entries()]
    .filter(([name]) => !genreSet.has(name))
    .filter(([, books]) => books.size >= minBooks)
    .map(([tag, books]) => ({ tag, books }));

  const single = options.tag ? [options.tag] : null;
  if (single && single[0]) {
    const hit = subjects.find(s => s.tag === single[0]);
    if (!hit) { console.log(chalk.yellow(`   "${single[0]}" is either not a scraped tag, or is a genre-tag (try a non-genre tag, or genre-tag-pairings).`)); return; }
    subjects = [hit];
  }

  if (genreTagSets.length === 0) {
    console.log(chalk.yellow('\n   No genres are scraped as tags yet (no book sets). Scrape gap genres first.'));
    return;
  }

  console.log(chalk.cyan.bold('\n🔖 Tag ↔ genre pairings (each non-genre tag vs all genre-tags, by Jaccard)'));
  console.log(chalk.gray(`   Non-genre tags: ${subjects.length} · Genre-tags available: ${chalk.white(String(genreTagSets.length))} · top ${topK} each`));

  const slice = subjects.slice(0, maxResults);
  for (const subj of slice) {
    const pairings = rankPairings(subj.books, genreTagSets)
      .sort((a, b) => b.jaccard - a.jaccard || b.overlap - a.overlap);
    console.log(chalk.gray(`\n── ${chalk.white.bold(subj.tag)} (${subj.books.size.toLocaleString()} bks)`));
    const shown = pairings.slice(0, topK);
    if (shown.length === 0 || shown[0].jaccard === 0) {
      console.log(chalk.gray(`     (no overlap with any scraped genre)`));
      continue;
    }
    for (let i = 0; i < shown.length; i++) {
      const p = shown[i];
      const bar = '█'.repeat(Math.max(1, Math.round(p.pct / 5)));
      console.log(`  ${String(i + 1).padStart(2)}. ${p.pct.toFixed(1).padStart(5)}%  ${chalk.green(String(p.overlap)).padStart(5)}/Δ${String(p.union).padStart(5)}  ${chalk.gray(bar)} ${chalk.white(p.tag)}`);
    }
  }
  if (slice.length < subjects.length) {
    console.log(chalk.gray(`\n   … ${subjects.length - slice.length} more non-genre tags (use --maxResults).`));
  }
}
