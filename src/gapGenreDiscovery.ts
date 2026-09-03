import chalk from 'chalk';
import { getDb } from './db.js';
import { runTagDiscovery } from './discovery.js';
import { delay, isConnectivityError } from './utils.js';

export interface GapGenreDiscoveryOptions {
  count?: string;
  start?: string;
  minTags?: string;
  shelfPages?: string;
  sortBy?: string;
  force?: boolean;
  dryRun?: boolean;
}

// Gap genres = genres that are also tags (genre name = a /shelf/show/<name>)
// but have NOT yet been scraped into tag_books. These are the highest-value
// remaining tag scrapes: goal 4 orders them "most books to least books".
export function getGapGenres(options: { sortBy?: string; force?: boolean }): Array<{ name: string; memberCount: number; scraped: boolean }> {
  const db = getDb();
  const genres = db.prepare('SELECT name, member_count FROM genres ORDER BY name').all() as any[];
  const scraped = new Set((db.prepare('SELECT DISTINCT tag_name FROM tag_books').all() as any[]).map(r => r.tag_name));

  const out = genres
    .map(g => ({ name: g.name, memberCount: g.member_count ?? 0, scraped: scraped.has(g.name) }))
    .filter(g => options.force || !g.scraped);

  if (options.sortBy === 'alpha') out.sort((a, b) => a.name.localeCompare(b.name));
  else out.sort((a, b) => b.memberCount - a.memberCount || a.name.localeCompare(b.name));

  return out;
}

export async function runGapGenreTagDiscovery(options: GapGenreDiscoveryOptions = {}): Promise<void> {
  const sortBy = options.sortBy || 'member';
  const force = !!options.force;
  const dryRun = !!options.dryRun;

  const gaps = getGapGenres({ sortBy, force });
  const totalGaps = gaps.length;

  const count = options.count ? parseInt(options.count, 10) : Infinity;
  const start = options.start ? parseInt(options.start, 10) : 1;
  const slice = gaps.slice(start - 1, options.count ? start - 1 + count : undefined);

  console.log(chalk.cyan.bold('\n🕳️  Gap genre→tag discovery'));
  console.log(chalk.gray(`   Genres total: ${formatNum((getDb().prepare('SELECT COUNT(*) AS c FROM genres').get() as any).c)} · Gap (genre not yet in tag_books): ${formatNum(totalGaps)} · Processing ${slice.length} (${sortBy === 'alpha' ? 'alpha' : 'by member count'} order, start #${start}).`));
  if (force) console.log(chalk.gray('   --force: also reprocessing genres already in tag_books.'));

  if (slice.length === 0) {
    console.log(chalk.green.bold('\n   ✅ No gaps to scrape.'));
    return;
  }

  slice.forEach((g, idx) => {
    console.log(chalk.gray(`   ${start + idx}. ${g.name} (${formatNum(g.memberCount)} books${g.scraped ? ', already scraped' : ''})`));
  });

  if (dryRun) {
    console.log(chalk.yellow(`\n   Dry run — ${slice.length} genres would be scraped. Pass without --dry-run to scrape.`));
    return;
  }

  const shelfPageStart = '1';
  const shelfPageEnd = options.shelfPages ? parseShelfPages(options.shelfPages) : '25';

  for (let i = 0; i < slice.length; i++) {
    const g = slice[i];
    console.log(chalk.yellow.bold(`\n==================================================`));
    console.log(chalk.yellow.bold(`🕳️  GAP SCRAPE [${start + i}/${totalGaps}] (${i + 1}/${slice.length} this run): "${g.name}"`));
    console.log(chalk.yellow.bold(`==================================================`));
    try {
      await runTagDiscovery(g.name, {
        cacheOnly: true,
        minTags: options.minTags,
        shelfPageStart,
        shelfPageEnd,
      });
    } catch (err: any) {
      if (isConnectivityError(err)) {
        console.log(chalk.red.bold(`\n🛑 Aborting gap scrape: network error (${err.code} — ${err.message}).`));
        console.log(chalk.red.bold(`   The connection to Goodreads is down; continuing would only produce more empty shelves.`));
        console.log(chalk.red.bold(`   Progress up to this point is saved; re-run when your connection is back.`));
        return;
      }
      console.error(chalk.red.bold(`   ❌ Error scraping genre "${g.name}":`), err.message);
    }
    if (i < slice.length - 1) {
      await delay(1000, 3000);
    }
  }

  console.log(chalk.cyan.bold(`\n🎉 Gap genre→tag discovery complete for ${slice.length} genres.`));
}

function parseShelfPages(range: string): string {
  const m = range.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) throw new Error(`Invalid shelf pages range: "${range}". Use "N" or "N-M".`);
  return m[2] || m[1];
}

const formatNum = (n: number): string => n.toLocaleString('en-US');
