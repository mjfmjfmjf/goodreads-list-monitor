import chalk from 'chalk';
import { getDb } from './db.js';

export interface GenreCompareResult {
  exactMatched: string[];   // genre names that ARE a tag
  unmatched: string[];      // genre names with no exact tag (need tags / are near-match candidates)
  nonGenreTags: string[];   // tags that are NOT a genre
}

// Genre names are stored as slugs ("science-fiction"); tags in tag_books are
// lowercased-hyphenated too. So an exact match is direct string equality.
export function computeGenreCompare(
  genreNames: string[],
  tagNames: string[]
): GenreCompareResult {
  const tagSet = new Set(tagNames);
  const genreSet = new Set(genreNames);
  const exactMatched: string[] = [];
  const unmatched: string[] = [];
  for (const g of genreNames) {
    if (tagSet.has(g)) exactMatched.push(g);
    else unmatched.push(g);
  }
  const nonGenreTags: string[] = [];
  for (const t of tagNames) {
    if (!genreSet.has(t)) nonGenreTags.push(t);
  }
  return { exactMatched, unmatched, nonGenreTags };
}

export async function runGenreCompare(options: { limit?: string; sortBy?: string } = {}): Promise<void> {
  const db = getDb();
  const genres = db.prepare('SELECT name FROM genres').all() as any[];
  const tags = db.prepare('SELECT DISTINCT tag_name FROM tag_books').all() as any[];

  if (genres.length === 0) {
    console.log(chalk.yellow('\n   No genres in cache. Run `genre-list --scrape` first.'));
    return;
  }

  const res = computeGenreCompare(
    genres.map(r => r.name),
    tags.map(r => r.tag_name)
  );

  const limit = options.limit ? parseInt(options.limit, 10) : 25;
  const sortBy = options.sortBy || 'count';

  console.log(chalk.cyan.bold('\n🔀 Genre ↔ Tag comparison (goal 2)'));
  console.log(chalk.gray('----------------------------------------------------------------------'));
  console.log(
    `   Genres: ${chalk.white(formatNum(genres.length))} · Tags: ${chalk.white(formatNum(tags.length))} · ` +
    `${chalk.green.bold('exact matches ' + formatNum(res.exactMatched.length))} · ` +
    `${chalk.yellow.bold('no tag ' + formatNum(res.unmatched.length))} · ` +
    `${chalk.gray('tags-not-genres ' + formatNum(res.nonGenreTags.length))}`
  );
  console.log(chalk.gray('----------------------------------------------------------------------'));

  printSet('\n✅ Genres that are already tags (exact match)', res.exactMatched, 'count', limit);
  printSet('\n🆘 Genres with NO tag yet — near-match candidates', res.unmatched, sortBy, limit);
  printSet('\n🏷️  Tags that are NOT genres (personal-shelf long tail)', res.nonGenreTags, 'count', limit);

  const matched = new Set(res.exactMatched);
  const unmatched = res.unmatched.filter(g => !matched.has(g));
  console.log(chalk.gray(`\n   Tip: ${chalk.yellow(formatNum(unmatched.length))} of ${formatNum(genres.length)} genres (${(unmatched.length/genres.length*100).toFixed(0)}%) have no tag — these are the near-match (goal 2.1) / tag-scrape prioritization (goal 4) targets.`));
}

function printSet(title: string, names: string[], sortBy: string, limit: number): void {
  const db = getDb();
  console.log(chalk.white.bold(title));
  if (names.length === 0) {
    console.log(chalk.gray('   (none)'));
    return;
  }
  const withCounts = names.map(name => {
    const r = db.prepare('SELECT COUNT(DISTINCT book_id) AS c FROM tag_books WHERE tag_name = ?').get(name) as any;
    const genre = db.prepare('SELECT member_count AS mc FROM genres WHERE name = ?').get(name) as any;
    return { name, books: r?.c ?? 0, genreBooks: genre?.mc ?? 0 };
  });
  if (sortBy === 'member') withCounts.sort((a, b) => b.genreBooks - a.genreBooks || a.name.localeCompare(b.name));
  else if (sortBy === 'alpha') withCounts.sort((a, b) => a.name.localeCompare(b.name));
  else withCounts.sort((a, b) => b.genreBooks - a.genreBooks || b.books - a.books || a.name.localeCompare(b.name));

  const shown = withCounts.slice(0, limit);
  const nameW = Math.max(...shown.map(s => s.name.length), 8);
  console.log(chalk.gray('-'.repeat(nameW + 24)));
  for (const s of shown) {
    console.log(
      chalk.white(s.name.padEnd(nameW)) + '  ' +
      chalk.green(String(s.genreBooks).padStart(8)) + ' gr books · ' +
      chalk.gray(String(s.books).padStart(8)) + ' in our tags'
    );
  }
  if (withCounts.length > shown.length) {
    console.log(chalk.gray(`   … and ${formatNum(withCounts.length - shown.length)} more (use --limit <n>).`));
  }
}

const formatNum = (n: number): string => n.toLocaleString('en-US');
