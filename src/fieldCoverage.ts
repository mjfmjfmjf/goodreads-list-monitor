import chalk from 'chalk';
import { getDb } from './db.js';

export interface FieldStat {
  field: string;
  populated: number;
  total: number;
  distinct?: number;
}

export function computeFieldStats(
  rows: Record<string, unknown>,
  total: number,
  distinctRows?: Record<string, number>,
): FieldStat[] {
  return Object.entries(rows).map(([field, populated]) => ({
    field,
    populated: Number(populated) || 0,
    total,
    distinct: distinctRows && distinctRows[field] != null ? Number(distinctRows[field]) : undefined,
  }));
}

export function formatCoverageLine(stat: FieldStat): string {
  const pct = stat.total > 0 ? ((stat.populated / stat.total) * 100).toFixed(1) : '0.0';
  const missing = stat.total - stat.populated;
  const label = stat.field.padEnd(14, ' ');
  const count = stat.populated.toLocaleString().padStart(7, ' ');
  const pctStr = `${pct.padStart(5)}%`;
  const missingStr = missing > 0 ? chalk.gray(` (${missing.toLocaleString()} missing)`) : chalk.green(' ✓ complete');
  const distinctStr = stat.distinct !== undefined
    ? chalk.gray(` · ${stat.distinct.toLocaleString()} distinct`)
    : '';
  return `${label} : ${chalk.yellow(count)} ${pctStr}${missingStr}${distinctStr}`;
}

export async function runFieldCoverage(): Promise<void> {
  const db = getDb();

  // Browser-scraper tables (book_page / browser_scrape / list_walk) may not
  // exist until the first --engine browser or list-walk run creates them.
  const hasTable = (t: string): boolean =>
    !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t);

  const bookPageTotals = hasTable('book_page')
    ? (db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN publisher IS NOT NULL THEN 1 ELSE 0 END) AS 'publisher',
      SUM(CASE WHEN isbn13 IS NOT NULL THEN 1 ELSE 0 END) AS 'isbn13',
      SUM(CASE WHEN isbn10 IS NOT NULL THEN 1 ELSE 0 END) AS 'isbn10',
      SUM(CASE WHEN asin IS NOT NULL THEN 1 ELSE 0 END) AS 'asin',
      SUM(CASE WHEN format IS NOT NULL THEN 1 ELSE 0 END) AS 'format',
      SUM(CASE WHEN language IS NOT NULL THEN 1 ELSE 0 END) AS 'language',
      SUM(CASE WHEN description IS NOT NULL THEN 1 ELSE 0 END) AS 'description',
      SUM(CASE WHEN series IS NOT NULL THEN 1 ELSE 0 END) AS 'series',
      SUM(CASE WHEN reviews_count IS NOT NULL THEN 1 ELSE 0 END) AS 'reviews_count',
      SUM(CASE WHEN ratings_dist IS NOT NULL THEN 1 ELSE 0 END) AS 'ratings_dist',
      SUM(CASE WHEN currently_reading IS NOT NULL THEN 1 ELSE 0 END) AS 'currently_reading',
      SUM(CASE WHEN to_read IS NOT NULL THEN 1 ELSE 0 END) AS 'to_read',
      SUM(CASE WHEN editions_count IS NOT NULL THEN 1 ELSE 0 END) AS 'editions_count'
    FROM book_page
  `).get() as any)
    : null;

  const browserScrapeTotals = hasTable('browser_scrape')
    ? (db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS 'ok',
      SUM(CASE WHEN status='throttled' THEN 1 ELSE 0 END) AS 'throttled',
      SUM(CASE WHEN status='missing' THEN 1 ELSE 0 END) AS 'missing',
      SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS 'error'
    FROM browser_scrape
  `).get() as any)
    : null;

  const listWalkTotals = hasTable('list_walk')
    ? (db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS 'done',
      SUM(CASE WHEN status='started' THEN 1 ELSE 0 END) AS 'started',
      SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS 'error',
      SUM(CASE WHEN total_books IS NOT NULL THEN 1 ELSE 0 END) AS 'total_books',
      SUM(CASE WHEN walkable_books IS NOT NULL THEN 1 ELSE 0 END) AS 'walkable_books'
    FROM list_walk
  `).get() as any)
    : null;

  const bookTotals = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN author_id IS NOT NULL THEN 1 ELSE 0 END) AS 'author_id',
      SUM(CASE WHEN ratings IS NOT NULL THEN 1 ELSE 0 END) AS 'ratings',
      SUM(CASE WHEN ratings = 0 THEN 1 ELSE 0 END) AS 'ratings_zero',
      SUM(CASE WHEN avg_rating IS NOT NULL THEN 1 ELSE 0 END) AS 'avg_rating',
      SUM(CASE WHEN published IS NOT NULL AND published NOT IN ('Unknown', 'null', '') THEN 1 ELSE 0 END) AS 'published',
      SUM(CASE WHEN pages IS NOT NULL THEN 1 ELSE 0 END) AS 'pages',
      SUM(CASE WHEN series_pos IS NOT NULL THEN 1 ELSE 0 END) AS 'series_pos',
      SUM(CASE WHEN genres IS NOT NULL AND genres != '' AND genres != '[]' THEN 1 ELSE 0 END) AS 'genres',
      SUM(CASE WHEN tags IS NOT NULL AND tags != '' AND tags != '{}' THEN 1 ELSE 0 END) AS 'tags',
      SUM(CASE WHEN work_id IS NOT NULL AND work_id != '' THEN 1 ELSE 0 END) AS 'work_id'
    FROM books
  `).get() as any;

  // 0 ratings is a real value (the book has no ratings yet), not missing data.
  // Report the zero-rating population as a separate annotation instead of as
  // part of the "missing" bucket.
  const bookRatingsZero = Number(bookTotals.ratings_zero) || 0;
  delete bookTotals.ratings_zero;

  // Distinct values per scalar column. These expose how much a column repeats
  // across the cache: e.g. a work_id may map to several book editions, and an
  // author_id is shared by all of that author's books.
  const bookDistinct = db.prepare(`
    SELECT
      COUNT(DISTINCT author_id) AS 'author_id',
      COUNT(DISTINCT avg_rating) AS 'avg_rating',
      COUNT(DISTINCT pages) AS 'pages',
      COUNT(DISTINCT series_pos) AS 'series_pos',
      COUNT(DISTINCT work_id) AS 'work_id'
    FROM books
  `).get() as Record<string, number>;

  // Genres and Tags are JSON (arrays / keyword maps), so a scalar distinct
  // count doesn't make sense. Instead report the count of distinct member
  // names across the whole cache — how many distinct genre labels, and how
  // many distinct tag/shelf names, appear anywhere on any book.
  const genreNames = new Set<string>();
  const tagNames = new Set<string>();
  for (const row of db.prepare(`SELECT genres, tags FROM books WHERE genres IS NOT NULL OR tags IS NOT NULL`).all() as any[]) {
    if (row.genres && row.genres !== '[]') {
      for (const g of JSON.parse(row.genres) as string[]) genreNames.add(g);
    }
    if (row.tags && row.tags !== '{}') {
      for (const k of Object.keys(JSON.parse(row.tags) as Record<string, number>)) tagNames.add(k);
    }
  }

  const authorTotals = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN average_rating IS NOT NULL THEN 1 ELSE 0 END) AS 'average_rating',
      SUM(CASE WHEN num_ratings IS NOT NULL AND num_ratings > 0 THEN 1 ELSE 0 END) AS 'num_ratings',
      SUM(CASE WHEN num_reviews IS NOT NULL AND num_reviews > 0 THEN 1 ELSE 0 END) AS 'num_reviews',
      SUM(CASE WHEN num_shelves IS NOT NULL AND num_shelves > 0 THEN 1 ELSE 0 END) AS 'num_shelves',
      SUM(CASE WHEN slug IS NOT NULL AND slug != '' THEN 1 ELSE 0 END) AS 'slug',
      SUM(CASE WHEN catalog_pages IS NOT NULL AND catalog_pages > 0 THEN 1 ELSE 0 END) AS 'catalog_pages',
      SUM(CASE WHEN fail_count > 0 THEN 1 ELSE 0 END) AS 'failed_ever',
      SUM(CASE WHEN fail_count >= 5 THEN 1 ELSE 0 END) AS 'chronic_failures'
    FROM authors
  `).get() as any;

  const authorDistinct = db.prepare(`
    SELECT COUNT(DISTINCT slug) AS 'slug' FROM authors
  `).get() as Record<string, number>;

  // Bad author-id tracking for the author-orphans scrape pipeline: ids that
  // have repeatedly failed to scrape (404s) and are skipped on later runs.
  const scrapeFailTotal = (db.prepare(`SELECT COUNT(*) AS c FROM author_scrape_failures`).get() as any).c as number;
  const scrapeFailChronic = (db.prepare(`SELECT COUNT(*) AS c FROM author_scrape_failures WHERE fail_count >= 3`).get() as any).c as number;

  const tagTotals = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COUNT(DISTINCT tag_name) AS 'distinct_tags',
      COUNT(DISTINCT book_id) AS 'distinct_book_ids',
      SUM(CASE WHEN position IS NOT NULL THEN 1 ELSE 0 END) AS 'position',
      SUM(CASE WHEN shelved IS NOT NULL THEN 1 ELSE 0 END) AS 'shelved',
      MIN(shelved) AS 'shelved_min',
      MAX(shelved) AS 'shelved_max',
      AVG(shelved) AS 'shelved_avg',
      COUNT(DISTINCT harvested_at) AS 'distinct_harvest_times'
    FROM tag_books
  `).get() as any;

  console.log(chalk.cyan.bold('\n📊 Book-cache field coverage:'));
  console.log(chalk.gray('----------------------------------------------------------------------'));
  for (const stat of computeFieldStats(bookTotals, Number(bookTotals.total), bookDistinct)) {
    console.log('  ' + formatCoverageLine(stat));
  }
  console.log(`  ${'ratings_zero'.padEnd(14)} : ${chalk.yellow(bookRatingsZero.toLocaleString().padStart(7))} ${chalk.gray('· books with exactly 0 ratings')}`);
  console.log(`  ${'genres'.padEnd(14)} : distinct genre labels ${chalk.yellow(genreNames.size.toLocaleString())}`);
  console.log(`  ${'tags'.padEnd(14)} : distinct tag/shelf names ${chalk.yellow(tagNames.size.toLocaleString())}`);
  console.log(chalk.cyan.bold(`\n📊 Author-cache field coverage:`));
  console.log(chalk.gray('----------------------------------------------------------------------'));
  // Give the slug line a distinct value (should equal the author count; slugs are unique).
  for (const stat of computeFieldStats(authorTotals, Number(authorTotals.total), authorDistinct)) {
    console.log('  ' + formatCoverageLine(stat));
  }
  console.log(
    `  ${'scrape_failed'.padEnd(14)} : ${chalk.yellow(scrapeFailTotal.toLocaleString().padStart(7))}` +
    ` ${chalk.gray(`· ${scrapeFailChronic.toLocaleString()} skipped at threshold (3+)`)}`
  );
  console.log(chalk.cyan.bold(`\n📊 Tag-book field coverage:`));
  console.log(chalk.gray('----------------------------------------------------------------------'));
  const tagTotal = Number(tagTotals.total);
  console.log(chalk.gray(`  total rows          : ${tagTotal.toLocaleString()}`));
  console.log(chalk.gray(`  distinct tags       : ${Number(tagTotals.distinct_tags).toLocaleString()}`));
  console.log(chalk.gray(`  distinct book IDs   : ${Number(tagTotals.distinct_book_ids).toLocaleString()}`));
  console.log(chalk.gray(`  distinct harvests   : ${Number(tagTotals.distinct_harvest_times).toLocaleString()}`));
  console.log('  ' + formatCoverageLine({ field: 'position', populated: Number(tagTotals.position), total: tagTotal }));
  const shelvedPop = Number(tagTotals.shelved) || 0;
  console.log('  ' + formatCoverageLine({ field: 'shelved', populated: shelvedPop, total: tagTotal }));
  const shelvedAvg = tagTotals.shelved_avg != null ? Number(tagTotals.shelved_avg).toFixed(1) : '—';
  console.log(`  ${'shelved min'.padEnd(14)} : ${chalk.yellow((tagTotals.shelved_min ?? '—').toLocaleString?.() ?? '—')}  max ${chalk.yellow((tagTotals.shelved_max ?? '—').toLocaleString?.() ?? '—')}  avg ${chalk.yellow(shelvedAvg)}`);

  if (bookPageTotals && Number(bookPageTotals.total) > 0) {
    console.log(chalk.cyan.bold(`\n📊 Browser book-page field coverage:`));
    console.log(chalk.gray('----------------------------------------------------------------------'));
    for (const stat of computeFieldStats(bookPageTotals, Number(bookPageTotals.total))) {
      console.log('  ' + formatCoverageLine(stat));
    }
  }

  if (browserScrapeTotals && Number(browserScrapeTotals.total) > 0) {
    console.log(chalk.cyan.bold(`\n📊 Browser-scrape checkpoint coverage:`));
    console.log(chalk.gray('----------------------------------------------------------------------'));
    console.log(chalk.gray(`  total rows          : ${Number(browserScrapeTotals.total).toLocaleString()}`));
    for (const status of ['ok', 'throttled', 'missing', 'error']) {
      const pop = Number(browserScrapeTotals[status]) || 0;
      console.log('  ' + formatCoverageLine({ field: status, populated: pop, total: Number(browserScrapeTotals.total) }));
    }
  }

  if (listWalkTotals && Number(listWalkTotals.total) > 0) {
    console.log(chalk.cyan.bold(`\n📊 Scraped-list ledger coverage:`));
    console.log(chalk.gray('----------------------------------------------------------------------'));
    console.log(chalk.gray(`  total lists         : ${Number(listWalkTotals.total).toLocaleString()}`));
    for (const status of ['done', 'started', 'error']) {
      const pop = Number(listWalkTotals[status]) || 0;
      console.log('  ' + formatCoverageLine({ field: status, populated: pop, total: Number(listWalkTotals.total) }));
    }
    console.log(
      `  ${'total_books'.padEnd(14)} : ${chalk.yellow(((Number(listWalkTotals.total_books) || 0)).toLocaleString().padStart(7))}` +
      ` ${chalk.gray(`· ${((Number(listWalkTotals.walkable_books) || 0)).toLocaleString()} walkable`)}`
    );
  }

  console.log();
}
