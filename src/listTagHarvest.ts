import chalk from 'chalk';
import { Page } from 'playwright';
import { scrapeListsByTag } from './scraper.js';
import { ListWalkerOptions, walkOneList, ensureListTables, listScrapeSkip, WalkerSummary } from './listWalker.js';
import { ensureScrapeTables, getBrowserContext, closeBrowserContext } from './browserBookScrape.js';
import { delay } from './utils.js';

export interface ListTagHarvestOptions {
  tag: string;
  limit: number;
  startPage?: number;
  maxPages?: number;
  skipHas: string[];
  relistDays?: number;
  dryRun?: boolean;
  force?: boolean;
  cooldownMs?: number;
  maxConsecutiveThrottles?: number;
}

const emptySummary = (): WalkerSummary => ({
  listsWalked: 0, listsSkipped: 0, processed: 0, ok: 0, throttled: 0,
  missing: 0, error: 0, skipped: 0, captcha: 0, capped: false, chainEnd: false,
});

export async function runListTagHarvest(options: ListTagHarvestOptions): Promise<WalkerSummary> {
  const strict = process.env.GOODREADS_STRICT_THROTTLE === '1';
  const cooldownMs = options.cooldownMs ?? 60_000;
  const maxThrottles = Math.max(0, options.maxConsecutiveThrottles ?? 2);
  const startPage = Math.max(1, options.startPage ?? 1);
  const maxPages = Math.max(1, options.maxPages ?? Infinity);

  console.log(chalk.cyan.bold(`\n🔖 walk-list-tag: tag="${options.tag}" skipHas=[${options.skipHas.join(', ')}] limit=${options.limit} — tag-index pages ${startPage}${maxPages === Infinity ? ' → end' : `-${startPage + maxPages - 1}`}${options.dryRun ? ' (DRY RUN)' : ''}`));
  console.log(chalk.gray('   headed Chromium window (logged-in) — enumerates the lists under the tag, then walks EACH list top-to-bottom harvesting every book with the list-walk book engine (no rating-range chaining).'));

  const listEntries = await scrapeListsByTag(options.tag, { startPage, maxPages });
  console.log(chalk.green.bold(`\n   Found ${listEntries.length} unique lists under tag "${options.tag}".`));
  if (listEntries.length === 0) {
    console.log(chalk.yellow(`   Nothing to walk — does the tag page exist? Try https://www.goodreads.com/list/tag/${options.tag}`));
    return emptySummary();
  }

  const summary = emptySummary();

  if (options.dryRun) {
    listEntries.forEach((l, i) => console.log(chalk.gray(`   ${i + 1}. ${l.id} · ${l.slug || l.url}`)));
    console.log(chalk.yellow(`\n   Dry run — ${listEntries.length} lists would be crawled. Pass without --dry-run to harvest.`));
    return summary;
  }

  ensureScrapeTables();
  ensureListTables();

  // Filter out lists already fully walked (fresh within --relist-days) BEFORE
  // the browser opens, so already-scraped lists don't churn a Page + inter-list
  // delay. Same pure DB check re-runs inside walkOneList at walk time.
  const listOptions: ListWalkerOptions = {
    list: '',
    direction: 'desc',
    limit: options.limit,
    maxLists: 1,
    skipHas: options.skipHas,
    relistDays: options.relistDays ?? 0,
    force: options.force,
    dryRun: options.dryRun,
    cooldownMs,
    maxConsecutiveThrottles: maxThrottles,
    followChain: false,
  };
  const walkable = listEntries.filter((l) => !listScrapeSkip(String(l.id), listOptions));
  const skippedAll = listEntries.length - walkable.length;
  if (skippedAll > 0) {
    const relistNote = (options.relistDays ?? 0) <= 0 ? 'all done lists' : `lists scraped within --relist-days ${options.relistDays}`;
    console.log(chalk.gray(`\n   ⏭  ${skippedAll} of ${listEntries.length} lists already scraped (${relistNote}) — skipping before opening the browser:`));
    for (const l of listEntries) {
      const s = listScrapeSkip(String(l.id), listOptions);
      if (s) console.log(chalk.gray(`   − list ${l.id} [skip] "${s.title}" (scraped ${s.scrapedAt}, ${s.booksNote})`));
    }
  }
  if (walkable.length === 0) {
    console.log(chalk.yellow('\n   Nothing to walk — every list under the tag was already scraped. Use --force or a larger --relist-days to re-walk.'));
    return summary;
  }

  const context = await getBrowserContext();
  const started = Date.now();

  try {
    for (let i = 0; i < walkable.length; i++) {
      if (summary.capped) break;
      const l = walkable[i];
      console.log(chalk.gray(`\n   ── list ${i + 1}/${walkable.length} · ${l.slug || l.id} (${l.id}) ──`));
      const page: Page = await context.newPage();
      try {
        await walkOneList(page, String(l.id), listOptions, summary, strict, cooldownMs, maxThrottles);
      } finally {
        await page.close().catch(() => {});
      }
      if (i < walkable.length - 1 && !summary.capped) {
        await delay(1000, 4000);
      }
    }
  } finally {
    await closeBrowserContext();
  }

  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log(chalk.cyan.bold(`\n🏁 Done: ${summary.listsWalked} lists walked, ${skippedAll + summary.listsSkipped} skipped, ${summary.ok} ok, ${summary.throttled} throttled, ${summary.missing} missing, ${summary.error} error, ${summary.captcha} captcha, ${summary.skipped} books skipped in ${mins}m for tag "${options.tag}".`));
  if (summary.capped) console.log(chalk.gray(`   Stopped: reached the ${options.limit}-book limit. Re-run to continue; harvested books are checkpointed and fully-walked lists are marked done, so they're skipped.`));
  return summary;
}