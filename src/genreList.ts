import chalk from 'chalk';
import { scrapeGenreList } from './scraper.js';
import { upsertGenres, loadGenres, countGenres } from './storage.js';
import { runGenreCompare } from './genreCompare.js';
import { ensureXrefSeeded, renderXref } from './genreXref.js';

export interface GenreListOptions {
  scrape?: boolean;
  compare?: boolean;
  seedXref?: boolean;
  xref?: boolean;
  cognateOnly?: boolean;
  limit?: string;
  sortBy?: string;
}

const formatNum = (n: number): string => n.toLocaleString('en-US');

export async function runGenreList(options: GenreListOptions = {}): Promise<void> {
  if (options.scrape) {
    return runGenreScrape();
  }
  if (options.seedXref) {
    return runSeedXref();
  }
  if (options.xref) {
    return renderXref({ limit: options.limit, showCognateOnly: options.cognateOnly });
  }
  if (options.compare) {
    return runGenreCompare({ limit: options.limit, sortBy: options.sortBy });
  }
  return runGenreReport(options);
}

function runSeedXref(): void {
  console.log(chalk.cyan.bold('\n🔗 Seeding genre↔tag xref…'));
  const r = ensureXrefSeeded();
  console.log(chalk.cyan.bold(`   exact: +${r.exactAdded} / -${r.exactRemoved} · cognate: +${r.cognateAdded} / -${r.cognateRemoved}`));
  renderXref({ limit: 100 });
}

async function runGenreScrape(): Promise<void> {
  console.log(chalk.cyan.bold('\n📚 Scraping Goodreads genre list (/genres/list)…'));
  const genres = await scrapeGenreList();
  const { inserted, updated } = upsertGenres(genres);
  console.log(chalk.cyan.bold(`\n🏁 Done. ${formatNum(genres.length)} genres scraped → ${inserted} new, ${updated} refreshed.`));
  console.log(chalk.cyan.bold(`📊 Total genres in cache: ${formatNum(countGenres())}`));
}

function runGenreReport(options: GenreListOptions): void {
  const genres = loadGenres();
  const now = new Date();
  const limit = options.limit ? parseInt(options.limit, 10) : 50;

  console.log(chalk.cyan.bold(`\n🏷️  Genre catalog (${formatNum(genres.length)} total):`));
  if (genres.length === 0) {
    console.log(chalk.gray('   Empty. Run `genre-list --scrape` to populate.'));
    return;
  }

  // Highlight genres that look stale — i.e. have not been seen populated on a
  // recent re-run. Since last_updated refreshes on every scrape where the genre
  // is still present, an old last_updated signals the genre disappeared or got
  // deprioritized by Goodreads.
  const nameW = Math.max('GENRE'.length, ...genres.map(g => g.name.length));
  console.log(chalk.gray('-'.repeat(nameW + 24)));
  console.log(chalk.white('GENRE'.padEnd(nameW) + '  ' + 'BOOKS'.padStart(9) + '  ' + 'FIRST SEEN'.padEnd(19) + '  ' + 'LAST UPDATED'.padEnd(19)));
  console.log(chalk.gray('-'.repeat(nameW + 24)));

  const shown = genres.slice(0, limit);
  for (const g of shown) {
    const daysSince = Math.floor((now.getTime() - new Date(g.lastUpdated).getTime()) / 86400000);
    const stale = daysSince > 30;
    const lastUpdated = stale ? chalk.yellow(g.lastUpdated.slice(0, 19)) : chalk.gray(g.lastUpdated.slice(0, 19));
    console.log(
      chalk.white(g.name.padEnd(nameW)) + '  ' +
      chalk.green(formatNum(g.memberCount).padStart(9)) + '  ' +
      chalk.gray(g.firstSeen.slice(0, 19).padEnd(19)) + '  ' +
      lastUpdated
    );
  }
  if (shown.length < genres.length) {
    console.log(chalk.gray(`   … and ${formatNum(genres.length - shown.length)} more (use --limit <n>).`));
  }
}
