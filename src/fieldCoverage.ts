import chalk from 'chalk';
import { getDb } from './db.ts';
import { AUTHOR_FAIL_LIMIT } from './storage.ts';

export interface FieldStat {
  field: string;
  populated: number;
  total: number;
  distinct?: number;
}

// Tables whose data appears somewhere in this report (field-coverage or
// ledger sections). `list_walk` is created lazily by the walker, so it is
// reported conditionally — presence in this list is about intent, not schema.
// The guard test in fieldCoverage.test.ts asserts every schema table is in
// REPORTED_TABLES ∪ IGNORED_TABLES, so a newly created table cannot silently
// go un-displayed (mirror of the exportData EXPORT/EXCLUDED guard).
export const REPORTED_TABLES = [
  'books',
  'authors',
  'author_slugs',
  'author_scrape_failures',
  'tag_books',
  'genres',
  'genre_tag_xref',
  'tag_stats',
  'popular_by_date_book',
  'tag_tail_scrapes',
  'tag_tail_monitor_state',
  'book_page',
  'browser_scrape',
  'list_walk',
  'list_scrapes',
  'list_tags',
  'lists',
  'list_tag_walk_history',
  'list_tag_walks',
] as const;

// Secrets (config holds live cookies) and one-off/legacy junk tables that are
// never displayed on purpose.
export const IGNORED_TABLES = [
  'config',
  'work_shelf_scrapes',
  'work_tag_books',
  'authors_old_20261003',
  'emrys_books',
  'emrys_tags',
  'emrys_09_04_books',
  'emrys_09_04_tags',
] as const;

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

  // Distinct publisher/format/language labels, mirroring the book-cache
  // report — exposes how much these low-cardinality columns repeat.
  const bookPageDistinct = hasTable('book_page')
    ? (db.prepare(`
    SELECT
      COUNT(DISTINCT publisher) AS 'publisher',
      COUNT(DISTINCT format) AS 'format',
      COUNT(DISTINCT language) AS 'language'
    FROM book_page
  `).get() as Record<string, number>)
    : undefined;

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

  const listScrapeTotals = hasTable('list_scrapes')
    ? (db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN first_scraped != last_scraped THEN 1 ELSE 0 END) AS 'rescraped',
      MIN(first_scraped) AS 'first_min',
      MAX(first_scraped) AS 'first_max',
      MAX(last_scraped) AS 'last_max'
    FROM list_scrapes
    WHERE list_id IS NOT NULL AND list_id != ''
  `).get() as any)
    : null;

  // Tag-harvest denominator: every list id we have ever learned about, unioned
  // from the same three sources listTagBackfill's queue reads (lists ∪
  // list_scrapes ∪ list_walk). `list_tags` is the only table that says a list
  // has already been read for tags, so "remaining" is the honest queue depth —
  // which is what `list-tag-backfill` restarts at. Empty list_ids are excluded
  // everywhere: 5 junk list_scrapes rows (list_id='', name='x', stamps='t')
  // would otherwise inject a bogus 1-row "known" list into the denominator.
  const listTagSources = [
    'SELECT list_id FROM lists WHERE list_id IS NOT NULL AND list_id != \'\'',
    'SELECT list_id FROM list_scrapes WHERE list_id IS NOT NULL AND list_id != \'\'',
  ];
  if (hasTable('list_walk')) {
    listTagSources.push('SELECT list_id FROM list_walk WHERE list_id IS NOT NULL AND list_id != \'\'');
  }
  const listTagTotals = hasTable('list_tags')
    ? (db.prepare(`
    WITH known AS (${listTagSources.join(' UNION ')})
    SELECT
      (SELECT COUNT(*) FROM known) AS 'known',
      (SELECT COUNT(DISTINCT list_id) FROM list_tags) AS 'tagged',
      (SELECT COUNT(*) FROM known k
        WHERE NOT EXISTS (SELECT 1 FROM list_tags t WHERE t.list_id = k.list_id)) AS 'remaining',
      (SELECT COUNT(*) FROM list_tags) AS 'tag_rows',
      (SELECT COUNT(DISTINCT tag_name) FROM list_tags) AS 'distinct_tags'
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
      SUM(CASE WHEN source IS NOT NULL AND source != '' THEN 1 ELSE 0 END) AS 'source'
    FROM authors
  `).get() as any;

  const authorDistinct = db.prepare(`
    SELECT
      COUNT(DISTINCT slug) AS 'slug',
      COUNT(DISTINCT source) AS 'source'
    FROM authors
  `).get() as Record<string, number>;

  // Bad author-id tracking for the author-orphans scrape pipeline: ids that
  // have repeatedly failed to scrape (404s) and are skipped on later runs.
  // There is ONE strike ledger and ONE threshold (storage.ts). These used to be
  // two columns on `authors` (limit 5) plus this table (limit 3), read as
  // hardcoded literals here.
  const strikeStats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN fail_count >= @limit THEN 1 ELSE 0 END) AS chronic,
      SUM(fail_count) AS summed
    FROM author_scrape_failures
  `).get({ limit: AUTHOR_FAIL_LIMIT }) as any;
  const scrapeFailTotal = (strikeStats?.total ?? 0) as number;
  const scrapeFailChronic = (strikeStats?.chronic ?? 0) as number;

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

  // Genre dictionary + genre↔tag xref (the normalized genre tables behind
  // books' denormalized genres JSON column).
  const genreDictTotals = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN member_count > 0 THEN 1 ELSE 0 END) AS 'member_count',
      MIN(first_seen) AS 'first_min',
      MAX(last_updated) AS 'last_max'
    FROM genres
  `).get() as any;
  const genreXrefTotals = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COUNT(DISTINCT genre_name) AS 'genres',
      COUNT(DISTINCT tag_name) AS 'tags',
      COUNT(DISTINCT kind) AS 'kinds'
    FROM genre_tag_xref
  `).get() as any;
  const genreXrefKinds = db.prepare(`
    SELECT kind, COUNT(*) AS n FROM genre_tag_xref GROUP BY kind ORDER BY n DESC
  `).all() as { kind: string; n: number }[];

  // Per-tag crawl state (where the Listopia/tag-page walk last stopped).
  const tagStatsTotals = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN last_page_seen IS NOT NULL THEN 1 ELSE 0 END) AS 'last_page_seen',
      SUM(CASE WHEN estimate_page IS NOT NULL THEN 1 ELSE 0 END) AS 'estimate_page',
      SUM(CASE WHEN estimate_source IS NOT NULL AND estimate_source != '' THEN 1 ELSE 0 END) AS 'estimate_source',
      COUNT(DISTINCT estimate_source) AS 'distinct_sources',
      MAX(updated) AS 'updated_max'
    FROM tag_stats
  `).get() as any;

  // Popular-by-date snapshots (page_key = the dated popular page).
  const popularTotals = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COUNT(DISTINCT page_key) AS 'pages',
      COUNT(DISTINCT book_id) AS 'books',
      SUM(CASE WHEN work_id IS NOT NULL AND work_id != '' THEN 1 ELSE 0 END) AS 'work_id',
      SUM(CASE WHEN stats_ratings IS NOT NULL THEN 1 ELSE 0 END) AS 'stats_ratings',
      SUM(CASE WHEN stats_reviews IS NOT NULL THEN 1 ELSE 0 END) AS 'stats_reviews',
      SUM(CASE WHEN stats_avg IS NOT NULL THEN 1 ELSE 0 END) AS 'stats_avg',
      COUNT(DISTINCT scraped_at) AS 'distinct_scrapes',
      MAX(scraped_at) AS 'scraped_max'
    FROM popular_by_date_book
  `).get() as any;

  // Tag-tail crawl results + the monitor's run ledger.
  const tailTotals = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN books_added > 0 THEN 1 ELSE 0 END) AS 'books_added',
      SUM(CASE WHEN authors_added > 0 THEN 1 ELSE 0 END) AS 'authors_added',
      SUM(COALESCE(books_added, 0)) AS 'books_sum',
      SUM(COALESCE(authors_added, 0)) AS 'authors_sum',
      MIN(last_scraped) AS 'first_min',
      MAX(last_scraped) AS 'last_max'
    FROM tag_tail_scrapes
  `).get() as any;
  const tailMonitorTotals = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN run_completed = 1 THEN 1 ELSE 0 END) AS 'run_completed',
      MAX(run_started_at) AS 'started_max'
    FROM tag_tail_monitor_state
  `).get() as any;

  // Monitored lists: discovery provenance + per-list book ledger state.
  const listLedgerTotals = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN ingested = 1 THEN 1 ELSE 0 END) AS 'ingested',
      SUM(CASE WHEN discovery_page IS NOT NULL THEN 1 ELSE 0 END) AS 'discovery_page',
      SUM(CASE WHEN last_count > 0 THEN 1 ELSE 0 END) AS 'last_count',
      SUM(CASE WHEN seen_book_ids IS NOT NULL AND seen_book_ids != '' THEN 1 ELSE 0 END) AS 'seen_book_ids'
    FROM lists
  `).get() as any;

  // Directory-walk history (one row per walked Listopia tag). `num_lists IS
  // NULL` marks tags walked before membership tracking existed.
  const walkHistoryTotals = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(num_walks) AS 'walks',
      MAX(num_walks) AS 'walks_max',
      SUM(CASE WHEN num_lists IS NOT NULL THEN 1 ELSE 0 END) AS 'lists_known',
      SUM(CASE WHEN num_lists IS NULL THEN 1 ELSE 0 END) AS 'lists_unknown',
      SUM(COALESCE(num_lists, 0)) AS 'lists_sum',
      MIN(first_walked) AS 'first_min',
      MAX(last_walked) AS 'last_max'
    FROM list_tag_walk_history
  `).get() as any;

  // Legacy per-(tag,list) walk membership: written by crawlers started before
  // the 2026/10/07 unification; pending drop once they all exit. Placeholder
  // rows (list_id='') are the 56-tag shell-history seed.
  const legacyWalkTotals = hasTable('list_tag_walks')
    ? (db.prepare(`
    SELECT
      COUNT(*) AS total,
      COUNT(DISTINCT tag_name) AS 'tags',
      SUM(CASE WHEN list_id = '' THEN 1 ELSE 0 END) AS 'placeholder',
      MIN(walked_at) AS 'first_min',
      MAX(walked_at) AS 'last_max'
    FROM list_tag_walks
  `).get() as any)
    : null;

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
    ` ${chalk.gray(`· ${scrapeFailChronic.toLocaleString()} skipped at threshold (${AUTHOR_FAIL_LIMIT}+)`)}`
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

  if (Number(genreDictTotals.total) > 0) {
    console.log(chalk.cyan.bold(`\n📖 Genre dictionary coverage (genres):`));
    console.log(chalk.gray('----------------------------------------------------------------------'));
    console.log(chalk.gray(`  genres             : ${chalk.yellow(Number(genreDictTotals.total).toLocaleString().padStart(7))}`));
    console.log('  ' + formatCoverageLine({ field: 'member_count', populated: Number(genreDictTotals.member_count) || 0, total: Number(genreDictTotals.total) }));
    const gFirst = (genreDictTotals.first_min ?? '').slice(0, 10);
    const gLast = (genreDictTotals.last_max ?? '').slice(0, 10);
    console.log(chalk.gray(`  first seen         : ${chalk.yellow(gFirst || '—')}  last updated ${chalk.yellow(gLast || '—')}`));
  }

  if (Number(genreXrefTotals.total) > 0) {
    console.log(chalk.cyan.bold(`\n🔗 Genre↔tag xref coverage (genre_tag_xref):`));
    console.log(chalk.gray('----------------------------------------------------------------------'));
    console.log(chalk.gray(`  xref rows          : ${chalk.yellow(Number(genreXrefTotals.total).toLocaleString().padStart(7))}`));
    console.log(chalk.gray(`  distinct genres    : ${chalk.yellow(Number(genreXrefTotals.genres).toLocaleString().padStart(7))}`));
    console.log(chalk.gray(`  distinct tags      : ${chalk.yellow(Number(genreXrefTotals.tags).toLocaleString().padStart(7))}`));
    const kinds = genreXrefKinds.map(k => `${k.kind}: ${k.n.toLocaleString()}`).join(' · ');
    console.log(chalk.gray(`  match kinds        : ${chalk.yellow(kinds || '—')}`));
  }

  if (Number(tagStatsTotals.total) > 0) {
    console.log(chalk.cyan.bold(`\n🧭 Tag scan-state coverage (tag_stats):`));
    console.log(chalk.gray('----------------------------------------------------------------------'));
    const statsTotal = Number(tagStatsTotals.total);
    console.log(chalk.gray(`  tracked tags       : ${chalk.yellow(statsTotal.toLocaleString().padStart(7))}`));
    console.log('  ' + formatCoverageLine({ field: 'estimate_source', populated: Number(tagStatsTotals.estimate_source) || 0, total: statsTotal, distinct: Number(tagStatsTotals.distinct_sources) }));
    console.log('  ' + formatCoverageLine({ field: 'estimate_page', populated: Number(tagStatsTotals.estimate_page) || 0, total: statsTotal }));
    console.log('  ' + formatCoverageLine({ field: 'last_page_seen', populated: Number(tagStatsTotals.last_page_seen) || 0, total: statsTotal }));
    console.log(chalk.gray(`  latest update      : ${chalk.yellow(String(tagStatsTotals.updated_max ?? '—'))}`));
  }

  if (Number(popularTotals.total) > 0) {
    console.log(chalk.cyan.bold(`\n📅 Popular-by-date coverage (popular_by_date_book):`));
    console.log(chalk.gray('----------------------------------------------------------------------'));
    const popTotal = Number(popularTotals.total);
    console.log(chalk.gray(`  snapshot rows      : ${chalk.yellow(popTotal.toLocaleString().padStart(7))}`));
    console.log(chalk.gray(`  distinct pages     : ${chalk.yellow(Number(popularTotals.pages).toLocaleString().padStart(7))}`));
    console.log(chalk.gray(`  distinct books     : ${chalk.yellow(Number(popularTotals.books).toLocaleString().padStart(7))}`));
    for (const f of ['work_id', 'stats_ratings', 'stats_reviews', 'stats_avg'] as const) {
      console.log('  ' + formatCoverageLine({ field: f, populated: Number(popularTotals[f]) || 0, total: popTotal }));
    }
    console.log(chalk.gray(`  harvests           : ${chalk.yellow(Number(popularTotals.distinct_scrapes).toLocaleString().padStart(7))} · latest ${chalk.yellow(String(popularTotals.scraped_max ?? '—'))}`));
  }

  if (Number(tailTotals.total) > 0) {
    console.log(chalk.cyan.bold(`\n🌾 Tag-tail scrape coverage (tag_tail_scrapes):`));
    console.log(chalk.gray('----------------------------------------------------------------------'));
    const tailTotal = Number(tailTotals.total);
    console.log(chalk.gray(`  scraped tags       : ${chalk.yellow(tailTotal.toLocaleString().padStart(7))}`));
    console.log('  ' + formatCoverageLine({ field: 'books_added', populated: Number(tailTotals.books_added) || 0, total: tailTotal }));
    console.log('  ' + formatCoverageLine({ field: 'authors_added', populated: Number(tailTotals.authors_added) || 0, total: tailTotal }));
    console.log(chalk.gray(`  yield              : ${chalk.yellow((Number(tailTotals.books_sum) || 0).toLocaleString())} books · ${chalk.yellow((Number(tailTotals.authors_sum) || 0).toLocaleString())} authors`));
    const tFirst = (tailTotals.first_min ?? '').slice(0, 10);
    const tLast = (tailTotals.last_max ?? '').slice(0, 10);
    console.log(chalk.gray(`  scrape range       : ${chalk.yellow(tFirst || '—')} → ${chalk.yellow(tLast || '—')}`));
  }

  if (Number(tailMonitorTotals.total) > 0) {
    console.log(chalk.cyan.bold(`\n🧪 Tag-tail monitor state (tag_tail_monitor_state):`));
    console.log(chalk.gray('----------------------------------------------------------------------'));
    const monTotal = Number(tailMonitorTotals.total);
    console.log(chalk.gray(`  monitor rows       : ${chalk.yellow(monTotal.toLocaleString().padStart(7))}`));
    console.log('  ' + formatCoverageLine({ field: 'run_completed', populated: Number(tailMonitorTotals.run_completed) || 0, total: monTotal }));
    console.log(chalk.gray(`  latest run start   : ${chalk.yellow(String(tailMonitorTotals.started_max ?? '—'))}`));
  }

  if (bookPageTotals && Number(bookPageTotals.total) > 0) {
    console.log(chalk.cyan.bold(`\n📊 Browser book-page field coverage:`));
    console.log(chalk.gray('----------------------------------------------------------------------'));
    for (const stat of computeFieldStats(bookPageTotals, Number(bookPageTotals.total), bookPageDistinct)) {
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

  if (listScrapeTotals && Number(listScrapeTotals.total) > 0) {
    console.log(chalk.cyan.bold(`\n📊 List-tag walk ledger coverage (list_scrapes):`));
    console.log(chalk.gray('----------------------------------------------------------------------'));
    console.log(chalk.gray(`  total lists          : ${chalk.yellow(Number(listScrapeTotals.total).toLocaleString().padStart(7))}`));
    console.log(chalk.gray(`  re-scraped           : ${chalk.yellow(Number(listScrapeTotals.rescraped || 0).toLocaleString().padStart(7))}`));
    const first = (listScrapeTotals.first_min ?? '').slice(0, 10);
    const firstEnd = (listScrapeTotals.first_max ?? '').slice(0, 10);
    const last = (listScrapeTotals.last_max ?? '').slice(0, 10);
    console.log(chalk.gray(`  first scrape range   : ${chalk.yellow(first)} → ${chalk.yellow(firstEnd)}`));
    console.log(chalk.gray(`  latest scrape        : ${chalk.yellow(last)}`));
  }

  if (listTagTotals && Number(listTagTotals.known) > 0) {
    const known = Number(listTagTotals.known) || 0;
    const tagged = Number(listTagTotals.tagged) || 0;
    const remaining = Number(listTagTotals.remaining) || 0;
    const pct = known > 0 ? ((tagged / known) * 100).toFixed(1) : '0.0';
    const tagRows = Number(listTagTotals.tag_rows) || 0;
    const distinctTags = Number(listTagTotals.distinct_tags) || 0;
    console.log(chalk.cyan.bold(`\n🏷️  List-tag harvest coverage (list_tags):`));
    console.log(chalk.gray('----------------------------------------------------------------------'));
    console.log(
      chalk.gray(`  known lists         : ${chalk.yellow(known.toLocaleString().padStart(7))} ${chalk.gray('(lists ∪ list_scrapes ∪ list_walk)')}`
    ));
    console.log(
      chalk.gray(`  tagged              : ${chalk.yellow(tagged.toLocaleString().padStart(7))} ${chalk.yellow(`${pct.padStart(5)}%`)}`) +
      (remaining > 0 ? chalk.gray(` · ${remaining.toLocaleString()} remaining`) : chalk.green(' · ✓ complete'))
    );
    console.log(
      chalk.gray(`  tag rows            : ${chalk.yellow(tagRows.toLocaleString().padStart(7))} ${chalk.gray(`· ${distinctTags.toLocaleString()} distinct tags`)}`)
    );
  }

  if (Number(listLedgerTotals.total) > 0) {
    console.log(chalk.cyan.bold(`\n📚 Monitored lists ledger (lists):`));
    console.log(chalk.gray('----------------------------------------------------------------------'));
    const listsTotal = Number(listLedgerTotals.total);
    console.log(chalk.gray(`  lists on record    : ${chalk.yellow(listsTotal.toLocaleString().padStart(7))}`));
    for (const f of ['ingested', 'discovery_page', 'last_count', 'seen_book_ids'] as const) {
      console.log('  ' + formatCoverageLine({ field: f, populated: Number(listLedgerTotals[f]) || 0, total: listsTotal }));
    }
  }

  if (Number(walkHistoryTotals.total) > 0) {
    console.log(chalk.cyan.bold(`\n🚶 Walk-tag history (list_tag_walk_history):`));
    console.log(chalk.gray('----------------------------------------------------------------------'));
    console.log(chalk.gray(`  walked tags        : ${chalk.yellow(Number(walkHistoryTotals.total).toLocaleString().padStart(7))}`));
    console.log(chalk.gray(`  directory walks    : ${chalk.yellow((Number(walkHistoryTotals.walks) || 0).toLocaleString().padStart(7))} ${chalk.gray(`· max ${(Number(walkHistoryTotals.walks_max) || 0).toLocaleString()} per tag`)}`));
    console.log(
      chalk.gray(`  lists yielded      : ${chalk.yellow((Number(walkHistoryTotals.lists_sum) || 0).toLocaleString().padStart(7))}`) +
      chalk.gray(` · membership known for ${(Number(walkHistoryTotals.lists_known) || 0).toLocaleString()} tags`) +
      ((Number(walkHistoryTotals.lists_unknown) || 0) > 0 ? chalk.yellow(` · ${(Number(walkHistoryTotals.lists_unknown) || 0).toLocaleString()} pre-tracking`) : '')
    );
    const hFirst = (walkHistoryTotals.first_min ?? '').slice(0, 10);
    const hLast = (walkHistoryTotals.last_max ?? '').slice(0, 10);
    console.log(chalk.gray(`  walk range         : ${chalk.yellow(hFirst || '—')} → ${chalk.yellow(hLast || '—')}`));
  }

  if (legacyWalkTotals && Number(legacyWalkTotals.total) > 0) {
    console.log(chalk.cyan.bold(`\n🗄️  Legacy walk membership (list_tag_walks — pending drop):`));
    console.log(chalk.gray('----------------------------------------------------------------------'));
    console.log(chalk.gray(`  membership rows    : ${chalk.yellow(Number(legacyWalkTotals.total).toLocaleString().padStart(7))}`));
    console.log(chalk.gray(`  distinct tags      : ${chalk.yellow(Number(legacyWalkTotals.tags).toLocaleString().padStart(7))}`));
    console.log(chalk.gray(`  placeholder rows   : ${chalk.yellow((Number(legacyWalkTotals.placeholder) || 0).toLocaleString().padStart(7))} ${chalk.gray('· shell-history seed (list_id empty)')}`));
    const lFirst = (legacyWalkTotals.first_min ?? '').slice(0, 10);
    const lLast = (legacyWalkTotals.last_max ?? '').slice(0, 10);
    console.log(chalk.gray(`  walk range         : ${chalk.yellow(lFirst || '—')} → ${chalk.yellow(lLast || '—')}`));
  }

  console.log();
}
