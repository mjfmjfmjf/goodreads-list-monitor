import chalk from 'chalk';
import { Page } from 'playwright';
import { scrapeListsByTag } from './scraper.js';
import { ListWalkerOptions, walkOneList, ensureListTables, listScrapeSkip, setListWalkRow, WalkerSummary } from './listWalker.js';
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
    let curPage = 0;
    listEntries.forEach((l, i) => {
      if (l.page && l.page !== curPage) {
        curPage = l.page;
        console.log(chalk.cyan(`\n   📄 tag-index page ${l.page}:`));
      }
      console.log(chalk.gray(`   ${i + 1}. ${l.id} · ${l.slug || l.url}${l.pagePos ? ` (list ${l.pagePos}/${l.pageTotal} on page)` : ''}`));
    });
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
  // Last tag-index directory page actually enumerated (entries carry their
  // source page), so progress can read "tag page 3/27" instead of a flat ratio.
  const lastTagPage = Math.max(0, ...listEntries.map((l) => l.page ?? 0));
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

  let context = await getBrowserContext();
  const started = Date.now();

  try {
    let curPage = 0;
    for (let i = 0; i < walkable.length; i++) {
      if (summary.capped) break;
      const l = walkable[i];
      if (l.page && l.page !== curPage) {
        curPage = l.page;
        console.log(chalk.cyan(`\n   📄 tag-index page ${l.page}${lastTagPage > 0 ? `/${lastTagPage}` : ''} — starting list ${l.pagePos ?? '?'} of ${l.pageTotal ?? '?'} on this page.`));
      }
      const pageNote = l.page
        ? ` · ${chalk.white(`tag page ${l.page}${lastTagPage > 0 ? `/${lastTagPage}` : ''}`)} · ${chalk.white(`list ${l.pagePos ?? '?'}/${l.pageTotal ?? '?'} on page`)}`
        : '';
      console.log(chalk.gray(`   ── list ${i + 1}/${walkable.length}${pageNote} · ${l.slug || l.id} (${l.id}) ──`));
      let page: Page;
      let pageOpenAttempts = 0;
      while (true) {
        try {
          page = await context.newPage();
          break;
        } catch (err) {
          pageOpenAttempts++;
          if (pageOpenAttempts >= 3) {
            summary.error++;
            console.log(chalk.bold.red(`   💥 list ${i + 1}/${walkable.length} (${l.id}) — ${pageOpenAttempts} attempts to open a tab failed: ${String((err as any)?.message || err).slice(0, 160)}`));
            console.log(chalk.bold.red('      The headed browser is not recoverable — ending the harvest here (progress checked-pointed; re-run to continue from the next list).'));
            return summary;
          }
          // One dead tab shouldn't end the run: tear down the broken context and
          // relaunch the headed window once/twice before giving up.
          console.log(chalk.yellow(`   💥 list ${i + 1}/${walkable.length} (${l.id}) tab open failed (${String((err as any)?.message || err).slice(0, 120)}) — relaunching the browser context...`));
          await closeBrowserContext();
          await delay(3000, 6000);
          context = await getBrowserContext();
        }
      }
      try {
        await walkOneList(page, String(l.id), listOptions, summary, strict, cooldownMs, maxThrottles);
      } catch (err) {
        // Any other throw from the walker (unhandled CRITICAL_NAVIGATION_ERROR,
        // browser teardown race, DB throw...) — catch per-list so the run goes
        // on and the failure is attributed to THIS list, not the whole tag.
        if (!options.dryRun) {
          try { setListWalkRow({ list_id: String(l.id), status: 'error' }); } catch { /* best-effort */ }
        }
        summary.error++;
        console.log(chalk.bold.red(`   ❌ list ${i + 1}/${walkable.length} (${l.id}) crashed the walker: ${String((err as any)?.message || err).slice(0, 160)}`));
        console.log(chalk.yellow('      Continuing with the next list.'));
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