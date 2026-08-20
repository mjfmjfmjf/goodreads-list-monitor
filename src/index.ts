import { Command } from 'commander';
import chalk from 'chalk';
import { checkUpdates, performIngest } from './monitor.js';
import { runAudit, runTagAudit } from './auditor.js';
import { generateTagConfig } from './tagConfig.js';
import { runTagDiscovery, runBulkTagDiscovery } from './discovery.js';
import { runQueueDiscovery } from './queueDiscovery.js';
import { generateBulkConfig } from './bulkConfig.js';
import { runBulkAudit } from './bulkAudit.js';
import { scrapeAndCacheBook } from './singleBook.js';
import { addBookFromBuffer } from './addBook.js';
import { removeBookFromCache } from './removeBook.js';
import { runCheckQueue } from './checkQueue.js';
import { runSummaryByYear } from './summary.js';
import { runSummaryRatings } from './summaryRatings.js';
import { runRatingsHistogram } from './summaryHistogram.js';
import { runSummarySeriesPos } from './summarySeriesPos.js';
import { runTitleCharHistogram } from './titleCharHistogram.js';
import { runBackfillSeriesPos } from './backfillSeriesPos.js';
import { runBackfillPages } from './backfillPages.js';
import { runAvgHistogram } from './summaryAvgHistogram.js';
import { runAuthorTopBooks } from './authorTopBooks.js';
import { runAuthorTopStats } from './authorTopStats.js';
import { runAuthorRescan } from './authorRescan.js';
import { runAuthorOne } from './authorOne.js';
import { runSummaryTop, runSummaryBottom } from './summaryTopRated.js';
import { runBooks } from './books.js';
import { runLibraryQuery } from './library.js';
import { runYearInBooks } from './yearInBooks.js';
import { runLifeInBooks } from './lifeInBooks.js';
import { runFavoriteAuthors } from './favoriteAuthors.js';
import { runPublisherStats } from './publisherStats.js';
import { runShelfStats } from './shelfStats.js';
import { runCommonMonitoredBooks } from './commonMonitoredBooks.js';
import { runCommonUnreviewedMonitoredBooks } from './commonUnreviewedMonitoredBooks.js';
import { runTagGaps, runCacheGaps } from './tagGaps.js';
import { runNextBooks } from './nextBooks.js';
import { runGenreHarvest } from './genreHarvest.js';
import { loadState, saveState, loadConfig } from './storage.js';
import { backupDbSync } from './db.js';

const program = new Command();

program
  .name('goodreads-monitor')
  .description('Monitor Goodreads Listopia lists for new additions')
  .version('1.0.0')
  .showHelpAfterError();

program
  .command('summary-year')
  .description('Show a chronological summary of books in the cache by publication year')
  .action(async () => {
    try {
      await runSummaryByYear();
    } catch (error) {
      console.error(chalk.red.bold('Failed to generate summary:'), (error as any).message);
    }
  });

program
  .command('summary-top')
  .description('Show a numbered list of top-rated books from the cache, sorted by average rating')
  .option('--minAvg <number>', 'Minimum average rating (e.g. 4.3)', '0')
  .option('--maxAvg <number>', 'Maximum average rating (e.g. 4.8)')
  .option('--minRatings <number>', 'Minimum number of ratings (e.g. 10000)', '0')
  .option('--limit <number>', 'Limit output to top N books')
  .action(async (options) => {
    try {
      await runSummaryTop(options);
    } catch (error) {
      console.error(chalk.red.bold('Failed to generate top-rated summary:'), (error as any).message);
    }
  });

program
  .command('summary-bottom')
  .description('Show a numbered list of lowest-rated books from the cache, sorted by average rating')
  .option('--minAvg <number>', 'Minimum average rating (e.g. 3.0)', '0')
  .option('--maxAvg <number>', 'Maximum average rating (e.g. 3.8)')
  .option('--minRatings <number>', 'Minimum number of ratings (e.g. 10000)', '0')
  .option('--limit <number>', 'Limit output to bottom N books')
  .action(async (options) => {
    try {
      await runSummaryBottom(options);
    } catch (error) {
      console.error(chalk.red.bold('Failed to generate lowest-rated summary:'), (error as any).message);
    }
  });

program
  .command('summary-ratings')
  .description('Show a ratings count histogram of books in the cache')
  .option('--hideZero', 'Hide categories with 0 books')
  .action(async (options) => {
    try {
      await runSummaryRatings(options);
    } catch (error) {
      console.error(chalk.red.bold('Failed to generate ratings summary:'), (error as any).message);
    }
  });

program
  .command('ratings-histogram')
  .description('Show a coarse histogram of the number of books in the cache by number of ratings')
  .action(async () => {
    try {
      await runRatingsHistogram();
    } catch (error) {
      console.error(chalk.red.bold('Failed to generate ratings histogram:'), (error as any).message);
    }
  });

program
  .command('series-pos-histogram')
  .description('Show a histogram of the number of books in the cache by series position')
  .action(async () => {
    try {
      await runSummarySeriesPos();
    } catch (error) {
      console.error(chalk.red.bold('Failed to generate series position histogram:'), (error as any).message);
    }
  });

program
  .command('title-char-histogram')
  .description('Show a histogram of the first and last character of book titles in the cache (including punctuation like ? ! . ,)')
  .action(async () => {
    try {
      await runTitleCharHistogram();
    } catch (error) {
      console.error(chalk.red.bold('Failed to generate title character histogram:'), (error as any).message);
    }
  });

program
  .command('backfill-series-pos')
  .description('Recompute seriesPos for every cached book from its title and save the cache (fixes stale/incorrect values)')
  .action(async () => {
    try {
      await runBackfillSeriesPos();
    } catch (error) {
      console.error(chalk.red.bold('Failed to backfill series positions:'), (error as any).message);
    }
  });

program
  .command('backfill-pages')
  .description('Copy page counts from the cached library export into booksCache.json where the cache has none')
  .option('--library <name>', 'Named libraries are skipped — only your own export can backfill the shared book cache')
  .action(async (options) => {
    try {
      await runBackfillPages(options);
    } catch (error) {
      console.error(chalk.red.bold('Failed to backfill book pages:'), (error as any).message);
    }
  });

program
  .command('avg-histogram')
  .description('Show a histogram of books by average rating, skipping buckets with no books')
  .option('--step <number>', 'Grouping step (default 0.01; 0.01 or less = no grouping)', '0.01')
  .option('--minRatings <number>', 'Only include books with at least this many ratings')
  .option('--maxRatings <number>', 'Only include books with at most this many ratings')
  .action(async (options) => {
    try {
      await runAvgHistogram(options);
    } catch (error) {
      console.error(chalk.red.bold('Failed to generate average rating histogram:'), (error as any).message);
    }
  });

program
  .command('author-top-books <n>')
  .description('For the top N books by ratings (from the book cache, filtered by ratings range), scrape each distinct author once to capture their overall stats (avg rating, ratings, reviews, shelves) into the author cache')
  .addHelpText('after', `
Examples:
  $ npm run author-top-books -- 100
  $ npm run author-top-books -- 100 --minRatings 100000 --maxRatings 500000
  $ ./authorTopBooks.sh 100 --skip`)
  .option('--minRatings <number>', 'Only consider books with at least this many ratings')
  .option('--maxRatings <number>', 'Only consider books with at most this many ratings')
  .option('--skip', 'Skip authors whose stats are already captured in the author cache')
  .action(async (n, options) => {
    const count = parseInt(n, 10);
    if (isNaN(count) || count <= 0) {
      console.error(chalk.red.bold('Error: <n> must be a positive number.'));
      process.exit(1);
    }
    try {
      await runAuthorTopBooks(count, options);
    } catch (error) {
      console.error(chalk.red.bold('Failed to run author top books:'), (error as any).message);
    }
  });

program
  .command('author-rescan')
  .description('Re-scrape the author page for each author matching the reader criteria (--limit/--sortBy/--minRatings/--maxRatings) to refresh their stats in the author cache. Use --rescanMissing to target only authors with no stats yet.')
  .addHelpText('after', `
Examples:
  $ npm run author-rescan -- --limit 50
  $ npm run author-rescan -- --sortBy averageRating --minRatings 100000 --limit 10
  $ npm run author-rescan -- --rescanMissing --limit 500
  $ ./authorRescan.sh --rescanMissing --minAge 30 --limit 500`)
  .option('--limit <number>', 'Number of authors to refresh (default 100)', '100')
  .option('--sortBy <field>', 'Sort field: numRatings, averageRating, numReviews, numShelves (default numRatings)', 'numRatings')
  .option('--minRatings <number>', 'Only consider authors with at least this many ratings')
  .option('--maxRatings <number>', 'Only consider authors with at most this many ratings')
  .option('--minAge <days>', 'Skip authors whose stats were last updated within this many days (default 0 = scrape everything)')
  .action(async (options) => {
    try {
      await runAuthorRescan(options);
    } catch (error) {
      console.error(chalk.red.bold('Failed to run author rescan:'), (error as any).message);
    }
  });

program
  .command('author-one <urlOrSlug>')
  .description('Scrape the overall stats (avg rating, ratings, reviews, shelves) for a single author page and update the author cache. Accepts a full author URL, a slug like 14018357.Steve_the_Noob, or a numeric author ID')
  .addHelpText('after', `
Examples:
  $ npm run author-one -- 14018357.Steve_the_Noob
  $ npm run author-one -- https://www.goodreads.com/author/show/14018357.Steve_the_Noob
  $ ./authorOne.sh 14018357.Steve_the_Noob`)
  .action(async (urlOrSlug) => {
    try {
      await runAuthorOne(urlOrSlug);
    } catch (error) {
      console.error(chalk.red.bold('Failed to update single author:'), (error as any).message);
    }
  });

program
  .command('author-top-stats')
  .description('List top authors from the author cache by a chosen stat (number of ratings, average rating, number of reviews, or number of shelves)')
  .addHelpText('after', `
Examples:
  $ npm run author-top-stats -- --limit 10
  $ npm run author-top-stats -- --sortBy averageRating --limit 20
  $ npm run author-top-stats -- --sortBy averageRating --minRatings 100000 --limit 10
  $ ./authorTopStats.sh --sortBy averageRating --minRatings 100000`)
  .option('--limit <number>', 'Number of authors to return (default 100)', '100')
  .option('--sortBy <field>', 'Sort field: numRatings, averageRating, numReviews, numShelves (default numRatings)', 'numRatings')
  .option('--minRatings <number>', 'Only include authors with at least this many ratings')
  .option('--maxRatings <number>', 'Only include authors with at most this many ratings')
  .action(async (options) => {
    try {
      await runAuthorTopStats(options);
    } catch (error) {
      console.error(chalk.red.bold('Failed to generate author stats summary:'), (error as any).message);
    }
  });

program
  .command('books [pattern]')
  .description('Search the book cache by regex against title, first author\'s last name, or first author\'s first name. Patterns are case-insensitive regexes (e.g. "^j" matches titles starting with j). A bare [pattern] applies to the title.')
  .addHelpText('after', `
Examples:
  $ npm run books -- '^j'
  $ npm run books -- --title '^[jqx]'
  $ npm run books -- --authorLast '^sanderson'
  $ npm run books -- --authorFirst '^brandon' --sort year
  $ npm run books -- --title 'space' --sort avgRating --minRatings 1000 --limit 50
  $ npm run books -- '^j' --excludeReviewed          # uses cached library import
  $ npm run books -- '^j' --excludeReviewed --export ~/Downloads/goodreads_library_export.csv  # refresh cached import
  $ npm run books -- --import ~/Downloads/goodreads_library_export.csv   # import + validate + cache
  $ ./books.sh --authorLast '^s' --limit 20`)
  .option('--title <regex>', 'Match title against this regex')
  .option('--authorLast <regex>', 'Match first author\'s last name against this regex')
  .option('--authorFirst <regex>', 'Match first author\'s first name against this regex')
  .option('--sort <field>', 'Sort by: ratings, avgRating, year, title, author (default ratings)', 'ratings')
  .option('--limit <number>', 'Maximum number of books to show (default 100)', '100')
  .option('--minRatings <number>', 'Only include books with at least this many ratings')
  .option('--maxRatings <number>', 'Only include books with at most this many ratings')
  .option('--minYear <year>', 'Only include books published in or after this year')
  .option('--maxYear <year>', 'Only include books published in or before this year')
  .option('--asc', 'Sort ascending (default: descending for numeric fields, ascending for title/author)')
  .option('--desc', 'Sort descending')
  .option('--includeBad', 'Include books previously marked as bad (repeated fetch failures)')
  .option('--excludeReviewed', 'Exclude books already reviewed in your Goodreads library export (uses cached import; pass --export/--import to refresh)')
  .option('--library <name>', 'Use a named library cache (e.g. --library friend) instead of the default, so multiple people\'s exports don\'t overwrite each other')
  .option('--export <path>', 'Path to a Goodreads library export CSV to import + cache (e.g. ~/Downloads/goodreads_library_export.csv)')
  .option('--import <path>', 'Alias for --export: imports + caches your Goodreads library export CSV')
  .action(async (pattern, options) => {
    try {
      await runBooks({ ...options, pattern, export: options.export || options.import });
    } catch (error) {
      console.error(chalk.red.bold('Failed to search books:'), (error as any).message);
    }
  });

program
  .command('library <query>')
  .description('Run custom queries over your imported Goodreads library export (uses the cached import; pass --export/--import to refresh). Queries: by-char, published-year, missing.')
  .addHelpText('after', `
Examples:
  $ npm run library -- by-char --year 2024
  $ npm run library -- by-char --year 2024 --field authorLast
  $ npm run library -- by-char --year 2024 --field authorFirst
  $ npm run library -- published-year --year 2024
  $ npm run library -- missing --year 2024
  $ npm run library -- by-char --year 2024 --export ~/Downloads/goodreads_library_export.csv  # refresh cache first
  $ npm run year-in-books -- 2026 --library friend --export ~/Downloads/friends_library_export.csv  # someone else's export
  $ ./library.sh by-char --year 2024 --field authorLast`)
  .option('--year <year>', 'Year to filter by (e.g. 2024)')
  .option('--field <field>', 'Character to bucket by: title (default), authorLast, authorFirst')
  .option('--library <name>', 'Use a named library cache (e.g. --library friend) instead of the default, so multiple people\'s exports don\'t overwrite each other')
  .option('--export <path>', 'Path to a Goodreads library export CSV to import + cache (e.g. ~/Downloads/goodreads_library_export.csv)')
  .option('--import <path>', 'Alias for --export: imports + caches your Goodreads library export CSV')
  .action(async (query, options) => {
    try {
      await runLibraryQuery(query, { ...options, export: options.export || options.import });
    } catch (error) {
      console.error(chalk.red.bold('Failed to run library query:'), (error as any).message);
    }
  });

program
  .command('year-in-books [year]')
  .description('Show a text "Year in Books" summary for a year (default: most recent review year): reading stats, ratings, distribution, and the five-star list. Uses the cached library import; pass --export/--import to refresh.')
  .addHelpText('after', `
Examples:
  $ npm run year-in-books -- 2026
  $ npm run year-in-books -- 2026 --export ~/Downloads/goodreads_library_export.csv  # refresh cache first
  $ npm run year-in-books -- 2026 --library friend --export ~/Downloads/friends_library_export.csv  # someone else's export
  $ npm run year-in-books -- 2026 --requireReviews  # only books with review text
  $ ./year-in-books.sh 2026`)
  .option('--library <name>', 'Use a named library cache (e.g. --library friend) instead of the default, so multiple people\'s exports don\'t overwrite each other')
  .option('--export <path>', 'Path to a Goodreads library export CSV to import + cache (e.g. ~/Downloads/goodreads_library_export.csv)')
  .option('--import <path>', 'Alias for --export: imports + caches your Goodreads library export CSV')
  .option('--requireReviews', 'Only count books that also have review text (default: any book with a Date Read in the year)')
  .action(async (year, options) => {
    try {
      await runYearInBooks({ ...options, year, export: options.export || options.import });
    } catch (error) {
      console.error(chalk.red.bold('Failed to run year in books:'), (error as any).message);
    }
  });

program
  .command('life-in-books')
  .description('Show a lifetime "Life in Books" summary across all your reviewed years: reading stats, ratings, year-by-year, distribution (letters + publication years), favorite authors, publishers, and bookshelves. Uses the cached library import; pass --export/--import to refresh.')
  .addHelpText('after', `
Examples:
  $ npm run life-in-books
  $ npm run life-in-books --export ~/Downloads/goodreads_library_export.csv  # refresh cache first
  $ npm run life-in-books --requireReviews  # only books with review text
  $ ./life-in-books.sh
  $ npm run life-in-books -- --library friend --export ~/Downloads/friends_library_export.csv  # someone else's export`)
  .option('--library <name>', 'Use a named library cache (e.g. --library friend) instead of the default, so multiple people\'s exports don\'t overwrite each other')
  .option('--export <path>', 'Path to a Goodreads library export CSV to import + cache (e.g. ~/Downloads/goodreads_library_export.csv)')
  .option('--import <path>', 'Alias for --export: imports + caches your Goodreads library export CSV')
  .option('--requireReviews', 'Only count books that also have review text (default: any book with a Date Read)')
  .action(async (options) => {
    try {
      await runLifeInBooks({ ...options, export: options.export || options.import });
    } catch (error) {
      console.error(chalk.red.bold('Failed to run life in books:'), (error as any).message);
    }
  });

program
  .command('favorite-authors')
  .description('Rank your favorite authors by your own star rating, from your read + rated books in the library export (grouped by first author, min book count + top N)')
  .addHelpText('after', `
Examples:
  $ npm run favorite-authors -- --limit 10 --minBooks 3
  $ npm run favorite-authors -- --sortBy books --limit 10
  $ npm run favorite-authors -- --minBooks 5 --limit 20
  $ ./favorite-authors.sh --limit 10 --minBooks 3
  $ npm run favorite-authors -- --export ~/Downloads/goodreads_library_export.csv  # refresh cache first
  $ npm run favorite-authors -- --library friend --export ~/Downloads/friends_library_export.csv  # someone else's export`)
  .option('--limit <number>', 'Number of top authors to show (default 10)', '10')
  .option('--minBooks <number>', 'Minimum number of rated books an author must have (default 3)', '3')
  .option('--sortBy <field>', 'Sort by: avgRating (default) or books', 'avgRating')
  .option('--library <name>', 'Use a named library cache (e.g. --library friend) instead of the default, so multiple people\'s exports don\'t overwrite each other')
  .option('--export <path>', 'Path to a Goodreads library export CSV to import + cache (e.g. ~/Downloads/goodreads_library_export.csv)')
  .option('--import <path>', 'Alias for --export: imports + caches your Goodreads library export CSV')
  .action(async (options) => {
    try {
      await runFavoriteAuthors({ ...options, export: options.export || options.import });
    } catch (error) {
      console.error(chalk.red.bold('Failed to run favorite authors:'), (error as any).message);
    }
  });

program
  .command('publisher-stats')
  .description('Rank your favorite publishers by your own star rating, from your read + rated books in the library export (grouped by publisher, min book count + top N)')
  .addHelpText('after', `
Examples:
  $ npm run publisher-stats -- --limit 10 --minBooks 3
  $ npm run publisher-stats -- --sortBy books --limit 10
  $ npm run publisher-stats -- --minBooks 5 --limit 20
  $ ./publisher-stats.sh --limit 10 --minBooks 3
  $ npm run publisher-stats -- --books --sortBy avgRating --limit 3 --minBooks 10  # also list each publisher's books by your rating
  $ npm run publisher-stats -- --export ~/Downloads/goodreads_library_export.csv  # refresh cache first`)
  .option('--limit <number>', 'Number of top publishers to show (default 10)', '10')
  .option('--minBooks <number>', 'Minimum number of rated books a publisher must have (default 3)', '3')
  .option('--sortBy <field>', 'Sort by: avgRating (default) or books', 'avgRating')
  .option('--books', 'Also list each publisher\'s books, ordered by your rating (descending)')
  .option('--library <name>', 'Use a named library cache (e.g. --library friend) instead of the default, so multiple people\'s exports don\'t overwrite each other')
  .option('--export <path>', 'Path to a Goodreads library export CSV to import + cache (e.g. ~/Downloads/goodreads_library_export.csv)')
  .option('--import <path>', 'Alias for --export: imports + caches your Goodreads library export CSV')
  .action(async (options) => {
    try {
      await runPublisherStats({ ...options, export: options.export || options.import });
    } catch (error) {
      console.error(chalk.red.bold('Failed to run publisher stats:'), (error as any).message);
    }
  });

program
  .command('shelf-stats')
  .description('Show usage of your Bookshelves tags from the library export: per-shelf count and percentage of books, sorted by count (descending) or by shelf name')
  .addHelpText('after', `
Examples:
  $ npm run shelf-stats -- --limit 20
  $ npm run shelf-stats -- --sortBy name --limit 50
  $ npm run shelf-stats -- --minCount 5 --limit 10
  $ ./shelf-stats.sh --limit 20
  $ npm run shelf-stats -- --export ~/Downloads/goodreads_library_export.csv  # refresh cache first`)
  .option('--limit <number>', 'Number of top shelves to show (default 20)', '20')
  .option('--sortBy <field>', 'Sort by: count (default, descending) or name', 'count')
  .option('--minCount <number>', 'Minimum number of books a shelf must have to be shown (default 0)', '0')
  .option('--library <name>', 'Use a named library cache (e.g. --library friend) instead of the default, so multiple people\'s exports don\'t overwrite each other')
  .option('--export <path>', 'Path to a Goodreads library export CSV to import + cache (e.g. ~/Downloads/goodreads_library_export.csv)')
  .option('--import <path>', 'Alias for --export: imports + caches your Goodreads library export CSV')
  .action(async (options) => {
    try {
      await runShelfStats({ ...options, export: options.export || options.import });
    } catch (error) {
      console.error(chalk.red.bold('Failed to run shelf stats:'), (error as any).message);
    }
  });

program
  .command('common-monitored-books')
  .description('Find books that appear in the most monitored lists (from state.json) and print their cached book info')
  .addHelpText('after', `
Examples:
  $ npm run common-monitored-books -- --limit 20
  $ npm run common-monitored-books -- --limit 50`)
  .option('--limit <number>', 'Number of top books to show (default 20)', '20')
  .action(async (options) => {
    try {
      await runCommonMonitoredBooks(options);
    } catch (error) {
      console.error(chalk.red.bold('Failed to find common monitored books:'), (error as any).message);
    }
  });

program
  .command('common-unreviewed-monitored-books')
  .description('Find books that appear in the most monitored lists (from state.json) that you have NOT reviewed, and print their cached book info. Uses the cached library import; pass --export/--import to refresh.')
  .addHelpText('after', `
Examples:
  $ npm run common-unreviewed-monitored-books -- --limit 20
  $ npm run common-unreviewed-monitored-books -- --limit 50
  $ npm run common-unreviewed-monitored-books -- --terse --limit 50  # one line per book
  $ npm run common-unreviewed-monitored-books -- --library friend --export ~/Downloads/friends_library_export.csv  # someone else's export
  $ ./commonUnreviewedMonitoredBooks.sh --limit 20`)
  .option('--limit <number>', 'Number of top books to show (default 20)', '20')
  .option('--terse', 'One line per book (book link, author, publish year, list count)')
  .option('--library <name>', 'Use a named library cache (e.g. --library friend) instead of the default, so multiple people\'s exports don\'t overwrite each other')
  .option('--export <path>', 'Path to a Goodreads library export CSV to import + cache (e.g. ~/Downloads/goodreads_library_export.csv)')
  .option('--import <path>', 'Alias for --export: imports + caches your Goodreads library export CSV')
  .action(async (options) => {
    try {
      await runCommonUnreviewedMonitoredBooks(options);
    } catch (error) {
      console.error(chalk.red.bold('Failed to find common unreviewed monitored books:'), (error as any).message);
    }
  });

program
  .command('tag-gaps <tag>')
  .description('Scan a Goodreads shelf (e.g. picture-books) and list up to N books per "missing" review gap (title / author first name / author last name letters + publication years) for a year')
  .addHelpText('after', `
Examples:
  $ npm run tag-gaps -- picture-books
  $ npm run tag-gaps -- picture-books --year 2026 --pages 25 --limit 3
  $ ./tag-gaps.sh picture-books --year 2026`)
  .option('--pages <number>', 'Number of shelf pages to scan (default 25)', '25')
  .option('--year <year>', 'Review year for the missing audit (default: most recent year with reviews)')
  .option('--limit <number>', 'How many books to report per missing bucket (default 3)', '3')
  .option('--minTags <number>', 'Minimum shelf tag count to include (default 0)', '0')
  .option('--library <name>', 'Use a named library cache (e.g. --library friend) instead of the default, so multiple people\'s exports don\'t overwrite each other')
  .option('--export <path>', 'Path to a Goodreads library export CSV to import + cache first (e.g. ~/Downloads/goodreads_library_export.csv)')
  .option('--import <path>', 'Alias for --export: imports + caches your Goodreads library export CSV')
  .action(async (tag, options) => {
    try {
      await runTagGaps(tag, { ...options, export: options.export || options.import });
    } catch (error) {
      console.error(chalk.red.bold('Failed to find tag gaps:'), (error as any).message);
    }
  });

program
  .command('cache-gaps')
  .description('Like tag-gaps but scans the book cache (sorted by ratings) instead of a shelf: list up to N books per "missing" review gap (title / author first name / author last name letters + publication years) for a year')
  .addHelpText('after', `
Examples:
  $ npm run cache-gaps -- --year 2026
  $ npm run cache-gaps -- --year 2026 --limit 3
  $ ./cacheGaps.sh --year 2026`)
  .option('--year <year>', 'Review year for the missing audit (default: most recent year with reviews)')
  .option('--limit <number>', 'How many books to report per missing bucket (default 3)', '3')
  .option('--library <name>', 'Use a named library cache (e.g. --library friend) instead of the default, so multiple people\'s exports don\'t overwrite each other')
  .option('--export <path>', 'Path to a Goodreads library export CSV to import + cache first (e.g. ~/Downloads/goodreads_library_export.csv)')
  .option('--import <path>', 'Alias for --export: imports + caches your Goodreads library export CSV')
  .action(async (options) => {
    try {
      await runCacheGaps({ ...options, export: options.export || options.import });
    } catch (error) {
      console.error(chalk.red.bold('Failed to find cache gaps:'), (error as any).message);
    }
  });

program
  .command('next-books <tag>')
  .description('Scan a Goodreads shelf (e.g. picture-books) and list the next N books you haven\'t reviewed yet')
  .addHelpText('after', `
Examples:
  $ npm run next-books -- picture-books --limit 10
  $ npm run next-books -- picture-books --pages 25 --limit 10
  $ ./next-books.sh picture-books --limit 10`)
  .option('--pages <number>', 'Number of shelf pages to scan (default 25)', '25')
  .option('--limit <number>', 'How many unreviewed books to list (default 10)', '10')
  .option('--minTags <number>', 'Minimum shelf tag count to include (default 0)', '0')
  .option('--library <name>', 'Use a named library cache (e.g. --library friend) instead of the default, so multiple people\'s exports don\'t overwrite each other')
  .option('--export <path>', 'Path to a Goodreads library export CSV to import + cache first (e.g. ~/Downloads/goodreads_library_export.csv)')
  .option('--import <path>', 'Alias for --export: imports + caches your Goodreads library export CSV')
  .action(async (tag, options) => {
    try {
      await runNextBooks(tag, { ...options, export: options.export || options.import });
    } catch (error) {
      console.error(chalk.red.bold('Failed to find next books:'), (error as any).message);
    }
  });

program
  .command('check-book <bookIdOrUrl>')
  .description('Fetch and cache the latest info for a single book via direct HTTP lookup using logged-in credentials')
  .action(async (bookIdOrUrl) => {
    try {
      const match = bookIdOrUrl.match(/\/book\/show\/(\d+)/);
      const bookId = match ? match[1] : bookIdOrUrl.trim().replace(/[^\d]/g, '');
      await scrapeAndCacheBook(bookId);
    } catch (error) {
      console.error(chalk.red.bold('Failed to check book:'), (error as any).message);
    }
  });

program
  .command('add-book <bookId> [rawInput...]')
  .description('Add or update a book in the cache using text/HTML from your copy-paste buffer')
  .option('--data <text>', 'Raw text or HTML from copy-paste buffer')
  .option('--title <title>', 'Explicit book title')
  .option('--author <author>', 'Explicit author name')
  .option('--ratings <number>', 'Explicit ratings count')
  .option('--avg <number>', 'Explicit average rating')
  .option('--published <date>', 'Explicit published date or year')
  .action(async (bookId, rawInputArray, options) => {
    try {
      const rawInputArg = options.data || (rawInputArray && rawInputArray.length ? rawInputArray.join(' ') : undefined);
      await addBookFromBuffer(bookId, rawInputArg, options);
    } catch (error) {
      console.error(chalk.red.bold('Failed to add book to cache:'), (error as any).message);
    }
  });

program
  .command('remove-book <ids...>')
  .description('Remove one or more books from the local book cache (booksCache.json)')
  .action(async (ids) => {
    try {
      await removeBookFromCache(ids);
    } catch (error) {
      console.error(chalk.red.bold('Failed to remove book from cache:'), (error as any).message);
    }
  });

program
  .command('check-queue')
  .description('Automatically find all books in the cache with "Unknown" or suspicious years and attempt to fix them')
  .option('--force', 'Re-check every book in the cache, even if they have a valid year')
  .option('--force-bad', 'Include and retry books previously marked as "bad" (repeated failures)')
  .option('--since <YYYYMMDDHHMM>', 'Re-check books updated after this local time')
  .option('--until <YYYYMMDDHHMM>', 'Re-check books updated before this local time')
  .action(async (options) => {
    try {
      // Commander converts kebab-case --force-bad to camelCase forceBad
      await runCheckQueue(options);
    } catch (error) {
      console.error(chalk.red.bold('Failed to run check-queue:'), (error as any).message);
    }
  });

program
  .command('check')
  .description('Check for updates on your lists (detects additions and removals since last run)')
  .argument('[userId]', 'Goodreads User ID')
  .action(async (userIdArg) => {
    const state = await loadState();
    const userId = userIdArg || state.userId;

    if (!userId) {
      console.error(chalk.red.bold('Error: No User ID provided. Use "set-user <id>" or provide it as an argument.'));
      process.exit(1);
    }

    try {
      await checkUpdates(userId);
    } catch (error) {
      console.error(chalk.red.bold('Failed to check updates:'), (error as any).message);
    }
  });

program
  .command('ingest')
  .description('Perform a full ingest of all book titles for all lists')
  .argument('[userId]', 'Goodreads User ID')
  .option('--force', 'Force re-ingestion of all lists even if already ingested')
  .action(async (userIdArg, options) => {
    const state = await loadState();
    const userId = userIdArg || state.userId;

    if (!userId) {
      console.error(chalk.red.bold('Error: No User ID provided.'));
      process.exit(1);
    }

    try {
      await performIngest(userId, options.force);
    } catch (error) {
      console.error(chalk.red.bold('Failed to ingest:'), (error as any).message);
    }
  });

program
  .command('audit <listId>')
  .description('Audit a list for books that do not meet criteria (Ratings OR Year OR Avg Rating OR Regex mode)')
  .addHelpText('after', `
Examples:
  $ npm run audit -- 1234 --min 1000
  $ npm run audit -- 1234 --titleRegex '^j'
  $ npm run audit -- 1234 --authorLastRegex '^sanderson' --maxYear 1999
  $ npm run audit -- 1234 --seriesPos 1       # flag books not in series position 1
  $ npm run audit -- 1234 --seriesPos -1      # flag any book that is NOT standalone
  $ ./bulkAudit.sh  # reads regex criteria from bulkAuditConfig.json`)
  .option('--min <number>', 'Minimum number of ratings allowed (e.g., 1000)')
  .option('--max <number>', 'Maximum number of ratings allowed (e.g., 50000)')
  .option('--minYear <year>', 'Minimum publishing year allowed (e.g., 2010)')
  .option('--maxYear <year>', 'Maximum publishing year allowed (e.g., 2024)')
  .option('--minAvg <number>', 'Minimum average rating (e.g., 4.0)')
  .option('--maxAvg <number>', 'Maximum average rating (e.g., 5.0)')
  .option('--seriesPos <number>', 'Require books at this exact series position (e.g. 1, 2, 0.5); use -1 to require standalone books')
  .option('--titleRegex <regex>', 'Flag books whose title does NOT match this regex (case-insensitive)')
  .option('--authorLastRegex <regex>', 'Flag books whose first author\'s last name does NOT match this regex')
  .option('--authorFirstRegex <regex>', 'Flag books whose first author\'s first name does NOT match this regex')
  .action(async (listId, options) => {
    const hasRatings = options.min !== undefined || options.max !== undefined;
    const hasYear = options.minYear !== undefined || options.maxYear !== undefined;
    const hasAvg = options.minAvg !== undefined || options.maxAvg !== undefined;
    const hasRegex = options.titleRegex !== undefined || options.authorLastRegex !== undefined || options.authorFirstRegex !== undefined;
    const hasSeriesPos = options.seriesPos !== undefined;

    if (hasRatings && hasYear) {
      console.error(chalk.red.bold('Error: You can audit by ratings OR publishing year, but not both at the same time.'));
      process.exit(1);
    }

    if (hasSeriesPos && isNaN(parseFloat(options.seriesPos))) {
      console.error(chalk.red.bold(`Error: Invalid --seriesPos "${options.seriesPos}". Use a number (e.g. 1, 0.5) or -1 for standalone.`));
      process.exit(1);
    }

    if (!hasRatings && !hasYear && !hasAvg && !hasRegex && !hasSeriesPos) {
      console.error(chalk.red.bold('Error: You must provide at least one criteria (e.g., --min, --minYear, --minAvg, --titleRegex, or --seriesPos).'));
      process.exit(1);
    }

    try {
      await runAudit(listId, options);
    } catch (error) {
      console.error(chalk.red.bold('Failed to run audit:'), (error as any).message);
    }
  });

program
  .command('tag-audit <tag> <listId>')
  .description('Cross-reference a Goodreads shelf with a list to find missing or low-tag books')
  .option('--max <number>', 'Maximum number of ratings required for a book to be eligible', '0')
  .option('--min <number>', 'Minimum number of ratings required for a book to be eligible', '0')
  .option('--minTags <number>', 'Minimum number of times a book must be shelved with this tag', '0')
  .option('--minYear <year>', 'Minimum publishing year allowed')
  .option('--maxYear <year>', 'Maximum publishing year allowed')
  .option('--minAvg <number>', 'Minimum average rating')
  .option('--maxAvg <number>', 'Maximum average rating')
  .action(async (tag, listId, options) => {
    try {
      await runTagAudit(tag, listId, options);
    } catch (error) {
      console.error(chalk.red.bold('Failed to run tag audit:'), (error as any).message);
    }
  });

program
  .command('tag-config <hubListId> <tagName>')
  .description('Generate a tag configuration file by scraping a Listopia hub page')
  .action(async (hubListId, tagName) => {
    try {
      await generateTagConfig(hubListId, tagName);
    } catch (error) {
      console.error(chalk.red.bold('Failed to generate tag config:'), (error as any).message);
    }
  });

program
  .command('tag-discovery <tagName>')
  .description('Run a batch of audits for all lists defined in a tag config')
  .option('--minTags <number>', 'Minimum tag count (applied to all audits in the batch)', '0')
  .option('--minAvg <number>', 'Global minimum average rating')
  .option('--maxAvg <number>', 'Global maximum average rating')
  .option('--shelfPages <range>', 'Pages of the shelf to scan (default 1-25; e.g. "7-11", "1-10")', '1-25')
  .option('--cacheOnly', 'Only parse shelf books into book cache and skip list audits')
  .action(async (tagName, options) => {
    try {
      let shelfPageStart = '1';
      let shelfPageEnd = '25';
      if (options.shelfPages) {
        const rangeMatch = options.shelfPages.match(/^(\d+)(?:-(\d+))?$/);
        if (!rangeMatch) {
          console.error(chalk.red.bold(`Invalid shelf pages range: "${options.shelfPages}". Use "N" or "N-M" (e.g. "7-11", "1-10").`));
          process.exit(1);
        }
        shelfPageStart = rangeMatch[1];
        shelfPageEnd = rangeMatch[2] || rangeMatch[1];
      }
      await runTagDiscovery(tagName, { ...options, shelfPageStart, shelfPageEnd });
    } catch (error) {
      console.error(chalk.red.bold('Failed to run tag discovery:'), (error as any).message);
    }
  });

program
  .command('bulk-tag-discovery')
  .description('Run tag discovery for top shelves discovered on Goodreads (https://www.goodreads.com/shelf)')
  .option('--start <number>', 'Starting shelf index (1-based, default 1)', '1')
  .option('--count <number>', 'Number of shelves to process (default 10)', '10')
  .option('--pages <range>', 'Pages of the top shelves list to fetch (default 1-25; e.g. "1-25", "24-25", "24")', '1-25')
  .option('--shelfPages <range>', 'Pages of each shelf to scan (default 1-25; e.g. "7-11", "1-10")', '1-25')
  .option('--minTags <number>', 'Minimum tag count (applied to all audits in the batch)', '0')
  .option('--minAvg <number>', 'Global minimum average rating')
  .option('--maxAvg <number>', 'Global maximum average rating')
  .option('--audits', 'Run list audits for tags that have a tag config file (defaults to cache-only mode)')
  .option('--cacheOnly', 'Only parse shelf books into book cache and skip list audits (default behavior)')
  .action(async (options) => {
    try {
      await runBulkTagDiscovery(options);
    } catch (error) {
      console.error(chalk.red.bold('Failed to run bulk tag discovery:'), (error as any).message);
    }
  });

program
  .command('queue-discovery')
  .description('Discover missing books for lists in a bulk config using cached queued books')
  .argument('[configFile]', 'Optional path to a custom bulk config file (defaults to bulkAuditConfig.json)')
  .option('--sortBy <type>', 'Sort candidates by: year, ratings, or avg', 'ratings')
  .option('--minAvg <number>', 'Global minimum average rating')
  .option('--maxAvg <number>', 'Global maximum average rating')
  .option('--listId <id>', 'Only run discovery for this list ID')
  .action(async (configFile, options) => {
    try {
      await runQueueDiscovery(configFile, options);
    } catch (error) {
      console.error(chalk.red.bold('Failed to run queue discovery:'), (error as any).message);
    }
  });

program
  .command('gen-bulk-config')
  .description('Generate a bulk audit configuration from all your lists and tag configs')
  .action(async () => {
    try {
      await generateBulkConfig();
    } catch (error) {
      console.error(chalk.red.bold('Failed to generate bulk config:'), (error as any).message);
    }
  });

program
  .command('bulk-audit')
  .description('Run a sequential audit for every list defined in a bulk config file')
  .argument('[configFile]', 'Optional path to a custom bulk audit config file (defaults to bulkAuditConfig.json)')
  .action(async (configFile) => {
    try {
      await runBulkAudit(configFile);
    } catch (error) {
      console.error(chalk.red.bold('Failed to run bulk audit:'), (error as any).message);
    }
  });

program
  .command('genre-harvest')
  .description('Slowly fetch book pages from Goodreads to harvest genres into the book cache. Picks random books with enough ratings and no genres yet. Sleeps on throttle; exits on second consecutive throttle.')
  .addHelpText('after', `
Examples:
  $ npm run genre-harvest
  $ npm run genre-harvest -- --limit 20 --minRatings 50000
  $ npm run genre-harvest -- --delay 60
  $ ./genreHarvest.sh --limit 50`)
  .option('--limit <number>', 'Maximum number of books to process (default 100)', '100')
  .option('--minRatings <number>', 'Minimum number of ratings a book must have (default 1000)', '1000')
  .option('--delay <number>', 'Seconds to wait between requests (default 30)', '30')
  .option('--delayJitter <number>', 'Extra seconds of random jitter added to each delay (default 0). E.g. --delay 20 --delayJitter 10 = 20-30s between requests', '0')
  .option('--throttleSleep <number>', 'Seconds to sleep on throttle before retrying (default 300). Second consecutive throttle exits.', '300')
  .action(async (options) => {
    try {
      await runGenreHarvest(options);
    } catch (error) {
      console.error(chalk.red.bold('Failed to run genre harvest:'), (error as any).message);
    }
  });

program
  .command('set-user')
  .description('Set the default Goodreads User ID to monitor')
  .argument('<userId>', 'Goodreads User ID')
  .action(async (userId) => {
    const state = await loadState();
    state.userId = userId;
    await saveState(state);
    console.log(chalk.green.bold(`Default User ID set to ${userId}`));
  });

program
  .command('backup')
  .description('Backup the SQLite database (keeps last 7 daily backups)')
  .action(() => {
    backupDbSync();
    console.log(chalk.green.bold('✅ Database backed up to backups/'));
  });

async function checkTokenExpiration() {
  try {
    const config = await loadConfig();
    if (!config.cookie) {
      return;
    }

    const match = config.cookie.match(/jwt_token=([^;]+)/);
    if (!match) {
      if (config.cookie.includes('at-main') || config.cookie.includes('session-token')) {
        console.log(chalk.green('🔑 Goodreads session cookies found (No JWT present to verify expiration date).\n'));
      } else {
        console.log(chalk.yellow('⚠️  Warning: No active session cookies or jwt_token found in your config.json cookie.\n'));
      }
      return;
    }

    let jwtToken = match[1].trim();
    if (jwtToken.startsWith('"') && jwtToken.endsWith('"')) {
      jwtToken = jwtToken.slice(1, -1);
    }

    const parts = jwtToken.split('.');
    if (parts.length !== 3) {
      console.log(chalk.yellow('⚠️  Warning: The jwt_token in your config.json cookie is not a valid JWT.'));
      return;
    }

    const payloadJson = Buffer.from(parts[1], 'base64').toString('utf8');
    const payload = JSON.parse(payloadJson);
    if (payload && typeof payload.exp === 'number') {
      const expTimestamp = payload.exp * 1000;
      const expirationDate = new Date(expTimestamp);
      const currentDate = new Date();

      if (currentDate.getTime() > expTimestamp) {
        console.log(chalk.red.bold(`❌ WARNING: Your Goodreads authentication token EXPIRED on ${expirationDate.toLocaleString()}.`));
        console.log(chalk.red(`   Please update the "cookie" field in config.json with a fresh session cookie.\n`));
      } else {
        const timeDiff = expTimestamp - currentDate.getTime();
        const daysRemaining = (timeDiff / (1000 * 60 * 60 * 24)).toFixed(1);
        console.log(chalk.green(`🔑 Token is active (Expires: ${expirationDate.toLocaleString()} - ${daysRemaining} days remaining).\n`));
      }
    }
  } catch (error) {
    console.log(chalk.yellow(`⚠️  Warning: Failed to parse authentication token: ${(error as any).message}`));
  }
}

async function main() {
  const startTime = Date.now();
  
  try {
    await checkTokenExpiration();
    // Default to 'check' if no command is provided
    if (!process.argv.slice(2).length) {
      await program.parseAsync([...process.argv, 'check']);
    } else {
      await program.parseAsync(process.argv);
    }
  } catch (error) {
    console.error(chalk.red.bold('\nFatal error:'), (error as any).message);
  } finally {
    const duration = (Date.now() - startTime) / 1000;
    const minutes = Math.floor(duration / 60);
    const seconds = (duration % 60).toFixed(1);
    
    console.log(chalk.cyan.bold(`\n⏱️  Total run time: ${minutes > 0 ? `${minutes}m ` : ''}${seconds}s`));
  }
}

main();
