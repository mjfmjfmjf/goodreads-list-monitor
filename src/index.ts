import { Command } from 'commander';
import chalk from 'chalk';
import { checkUpdates, performIngest } from './monitor.js';
import { runAudit, runTagAudit } from './auditor.js';
import { generateTagConfig } from './tagConfig.js';
import { runTagDiscovery } from './discovery.js';
import { runQueueDiscovery } from './queueDiscovery.js';
import { generateBulkConfig } from './bulkConfig.js';
import { runBulkAudit } from './bulkAudit.js';
import { scrapeAndCacheBook } from './singleBook.js';
import { runCheckQueue } from './checkQueue.js';
import { runSummaryByYear } from './summary.js';
import { runSummaryTop, runSummaryBottom } from './summaryTopRated.js';
import { loadState, saveState, loadConfig } from './storage.js';

const program = new Command();

program
  .name('goodreads-monitor')
  .description('Monitor Goodreads Listopia lists for new additions')
  .version('1.0.0');

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
  .command('check-book <bookId>')
  .description('Fetch and cache the latest info for a single book (useful for fixing "Unknown" years)')
  .action(async (bookId) => {
    try {
      await scrapeAndCacheBook(bookId);
    } catch (error) {
      console.error(chalk.red.bold('Failed to check book:'), (error as any).message);
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
  .description('Audit a list for books that do not meet criteria (Ratings OR Year mode)')
  .option('--min <number>', 'Minimum number of ratings allowed (e.g., 1000)')
  .option('--max <number>', 'Maximum number of ratings allowed (e.g., 50000)')
  .option('--minYear <year>', 'Minimum publishing year allowed (e.g., 2010)')
  .option('--maxYear <year>', 'Maximum publishing year allowed (e.g., 2024)')
  .option('--minAvg <number>', 'Minimum average rating (e.g., 4.0)')
  .option('--maxAvg <number>', 'Maximum average rating (e.g., 5.0)')
  .action(async (listId, options) => {
    const hasRatings = options.min !== undefined || options.max !== undefined;
    const hasYear = options.minYear !== undefined || options.maxYear !== undefined;
    const hasAvg = options.minAvg !== undefined || options.maxAvg !== undefined;

    if (hasRatings && hasYear) {
      console.error(chalk.red.bold('Error: You can audit by ratings OR publishing year, but not both at the same time.'));
      process.exit(1);
    }

    if (!hasRatings && !hasYear && !hasAvg) {
      console.error(chalk.red.bold('Error: You must provide at least one criteria (e.g., --min, --minYear, or --minAvg).'));
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
  .action(async (tagName, options) => {
    try {
      await runTagDiscovery(tagName, options);
    } catch (error) {
      console.error(chalk.red.bold('Failed to run tag discovery:'), (error as any).message);
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
  .command('set-user')
  .description('Set the default Goodreads User ID to monitor')
  .argument('<userId>', 'Goodreads User ID')
  .action(async (userId) => {
    const state = await loadState();
    state.userId = userId;
    await saveState(state);
    console.log(chalk.green.bold(`Default User ID set to ${userId}`));
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
