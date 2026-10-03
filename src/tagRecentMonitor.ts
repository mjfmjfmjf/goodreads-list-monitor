import chalk from 'chalk';
import { scrapeShelfBooks } from './scraper.js';
import { computeTagCoverage, loadTagCoverageInputs } from './tagCoverage.js';
import {
  getMeasuredShelfPages,
  loadAuthorCache,
  loadRecentTagTailScrapes,
  loadTagAnchors,
  loadTagTailState,
  saveTagTailState,
  syncAuthorsToCache,
  syncBooksToCache,
  upsertTagTailScrape,
  TagTailState,
} from './storage.js';
import { delay, isConnectivityError, withConnectivityProbe } from './utils.js';

export interface TagRecentMonitorOptions {
  limit?: string | number;
  dryRun?: boolean;
  fresh?: boolean;
  shelfPages?: string | number;
  resumeHorizonHours?: string | number;
  minAgeHours?: string | number;
}

const HORIZON_HOURS_DEFAULT = 36;
const OUTER_SHELF_PAGES_DEFAULT = 25;
const COVERAGE_LIMIT_DEFAULT = 20000;
const PREVIEW_LIMIT = 25;
// Goodreads shelf pages are only reachable up to ~25 in practice for tag shelves
// (the live pagination footer often advertises a larger number that doesn't
// actually return content). Clamp any known/measured page to this ceiling.
const MAX_REACHABLE_SHELF_PAGE = 25;
const formatNum = (n: number): string => n.toLocaleString('en-US');

// ── Pure decision helpers (unit-tested) ─────────────────────────────

// tag_books.position is the book's GLOBAL 1-based shelf position, and Goodreads
// serves 50 books per shelf page.
export const BOOKS_PER_SHELF_PAGE = 50;

// The tail anchor: the last page we have already harvested for this tag, derived
// from the tag_books xref itself (max position / 50). Returns null when the tag
// has no xref rows at all (caller falls back to the measured page count).
//
// A harvest that is much sparser than its max position (e.g. only pages 7-11
// were ever read) means there are un-harvested gaps below us, so we start at
// page 1 and let the footer stop us — the footer only ever extends a read
// forward, so an anchor that is too LOW costs a few extra pages while an anchor
// that is too HIGH (the footer advertises unreachable pages, e.g. 100) 404s.
// The effective tail start: the xref anchor, lowered to a shorter MEASURED page
// count when Goodreads' own footer says the shelf is shorter than our xref
// implies. That is the stale-max-position case (books came off the shelf), and
// lowering here spends one fetch instead of the two the re-anchor path needs
// (refused page + re-anchored page). It can never raise the anchor, so a shelf
// that GREW still gets its forward walk from the xref page.
export function pickAnchorPage(xrefPage: number | null, measuredPage: number | null): number | null {
  if (xrefPage == null) return measuredPage;
  if (measuredPage == null) return xrefPage;
  return Math.min(xrefPage, measuredPage);
}

export function tailAnchorPage(maxPosition: number | null, bookCount: number): number | null {
  if (maxPosition == null || maxPosition < 1) return null;
  if (bookCount < maxPosition * 0.9) return 1; // sparse harvest → fill from the top
  return Math.ceil(maxPosition / BOOKS_PER_SHELF_PAGE);
}

// Where the tail read starts for a tag given its anchor page.
// A null anchor (no xref, no measurement) starts at page 1, exactly like the
// tag's first-ever shelf scrape would.
export function tailReadWindow(anchor: number | null, shelfPages: number): { startPage: number; maxPages: number } {
  const k = anchor != null && anchor >= 1 ? anchor : null;
  const startRaw = k ?? 1;
  const start = Math.min(startRaw, MAX_REACHABLE_SHELF_PAGE);
  const outer = Math.max(shelfPages, startRaw);
  const maxPages = Math.min(outer, MAX_REACHABLE_SHELF_PAGE);
  return { startPage: start < 1 ? 1 : start, maxPages: maxPages < 1 ? 1 : maxPages };
}

// A tail read that comes back EMPTY with known >= 1 means the shelf regressed
// (books removed) or a backfilled estimate overshot the real shelf length —
// scrapeShelfBooks bailed at "Nothing to scan" so nothing was read. Probe page
// 1 once to relearn the real shelf length, then read the tail again.
export function needsTailReprobe(booksRead: number, known: number | null): boolean {
  return booksRead === 0 && known != null && known >= 1;
}

// Resume an in-flight pass (run_completed=0, started within the horizon)
// instead of re-reading every tag on an interrupted restart. --fresh forces a
// clean pass.
export function shouldResumePass(state: TagTailState | undefined, now: string, horizonHours: number, fresh: boolean): boolean {
  if (fresh || !state || state.runCompleted) return false;
  const ageMs = Date.parse(now) - Date.parse(state.runStartedAt);
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= horizonHours * 3600 * 1000;
}

// ── The walker ──────────────────────────────────────────────────────

// Tail-scrape every tag the greedy set-cover needs to reach 100% tag_books
// coverage, to discover NEW books and NEW authors. Each tag's tail is read
// only — from its previously-known last page through the live last page (the
// pagination footer drives the stop), so computed set-cover tags with stable
// shelves cost ~1 fetch and tags that grew a page cost ~2. New books are
// synced into the book cache and new authors minted, then the pass state is
// persisted so an interrupted run resumes where it stopped. See
// PLAN-tag-recent-monitor.md.
export async function runTagRecentMonitor(options: TagRecentMonitorOptions = {}): Promise<void> {
  const limit = parseInt(String(options.limit ?? COVERAGE_LIMIT_DEFAULT), 10) || COVERAGE_LIMIT_DEFAULT;
  const shelfPages = parseInt(String(options.shelfPages ?? OUTER_SHELF_PAGES_DEFAULT), 10) || OUTER_SHELF_PAGES_DEFAULT;
  const horizonHours = parseInt(String(options.resumeHorizonHours ?? HORIZON_HOURS_DEFAULT), 10) || HORIZON_HOURS_DEFAULT;
  // Age gate: skip a tag whose tail was read within this many hours. A pass is
  // a full re-check of every covered tag, and a stable shelf yields nothing, so
  // the gate is what makes a recurring run cheap (e.g. 168 = weekly). 0 = off.
  const minAgeHours = Math.max(0, parseInt(String(options.minAgeHours ?? '0'), 10) || 0);
  const dryRun = !!options.dryRun;
  const fresh = !!options.fresh;

  if (limit < 1) throw new Error(`Invalid limit: ${options.limit}`);
  if (shelfPages < 1) throw new Error(`Invalid shelf pages: ${options.shelfPages}`);

  console.log(chalk.cyan.bold('\n🔎 Tag recent monitor — tail-scraping every covered tag for NEW books/authors'));
  console.log(chalk.gray(`   Shelf cap ${shelfPages} page(s) per tag (outer wall — the live footer drives the real stop), ${dryRun ? 'dry run (no scraping)' : 'scraping'}.`));

  // 1. The covered tag list: the greedy set-cover over tag_books, in pick
  //    order, ending at (or as near as possible to) 100% coverage.
  console.log(chalk.gray('   Loading tag_books + computing set-cover order...'));
  const { rows, ratingsByBook } = loadTagCoverageInputs();
  const { rows: covered, totalBooks, totalTags } = computeTagCoverage(rows, limit, ratingsByBook);
  const stopPct = covered.length > 0 ? covered[covered.length - 1].pct : 0;
  console.log(chalk.gray(`   ${formatNum(totalBooks)} unique books across ${formatNum(totalTags)} tags → ${covered.length.toLocaleString()} tag(s) cover ${stopPct.toFixed(3)}%.`));

  // 2. Pass state: resume an interrupted/recent partial pass, else start new.
  const now = new Date().toISOString();
  const state = loadTagTailState();
  const resuming = shouldResumePass(state, now, horizonHours, fresh);
  const runStartedAt = resuming ? state!.runStartedAt : now;
  if (resuming) {
    console.log(chalk.yellow(`   Resuming interrupted pass (started ${runStartedAt})${dryRun ? ' — would skip tags already tail-scraped in it' : ''}.`));
  } else if (!dryRun) {
    saveTagTailState({ runStartedAt, runCompleted: false });
    console.log(chalk.gray('   Starting a new pass.'));
  }

  // Tags whose tail was read after run_started_at were done in this pass.
  const already = resuming ? loadRecentTagTailScrapes(runStartedAt) : new Set<string>();

  // Tags read too recently to be worth re-checking. Counted, not logged per tag
  // (that would be thousands of near-identical lines), and never re-saved as a
  // pass row — the age gate is a filter on top of the sweep, not a pass state.
  const freshSince = minAgeHours > 0
    ? new Date(Date.now() - minAgeHours * 3600 * 1000).toISOString()
    : null;
  const tooFresh = freshSince ? loadRecentTagTailScrapes(freshSince) : new Set<string>();
  if (tooFresh.size > 0) {
    console.log(chalk.gray(`   Age gate: skipping ${formatNum(tooFresh.size)} covered tag(s) scraped in the last ${minAgeHours}h (--minAgeHours).`));
  }

  // Where we've already harvested each tag, from the tag_books xref itself
  // (max position / 50) — no live request needed, and unlike the footer's
  // advertised page count it is always a page we can actually fetch. The
  // measured page count is only a fallback for a tag with no xref rows, and
  // the estimate_page backfill is ignored entirely (shelf_book_count/50 can be
  // orders of magnitude off — real "manga" estimates 125,293 pages).
  const anchors = loadTagAnchors(covered.map(c => c.tag));
  let fromXref = 0;
  let lowered = 0;
  let fromTop = 0;
  for (const [, a] of anchors) {
    const xrefPage = tailAnchorPage(a.maxPosition, a.bookCount);
    if (xrefPage == null) fromTop++;
    else if (a.measuredPage != null && a.measuredPage < xrefPage) lowered++;
    else fromXref++;
  }
  console.log(chalk.gray(`   Tail anchors: ${formatNum(fromXref)} from the tag_books xref, ${formatNum(lowered)} lowered to a shorter measured page count, ${formatNum(fromTop)} from page 1.`));

  // One author cache for the whole run — scrapeShelfBooks runs with
  // skipAuthorSync, so every author minted is counted by our own sync.
  const authorCache = loadAuthorCache();

  let processed = 0;
  let skipped = 0;
  let skippedFresh = 0;
  let totalRead = 0;
  let newBooks = 0;
  let newAuthors = 0;
  let reprobed = 0;

  if (dryRun && covered.length > PREVIEW_LIMIT) {
    console.log(chalk.gray(`\n   (dry run — showing the first ${PREVIEW_LIMIT} of ${covered.length.toLocaleString()} covered tags...)\n`));
  }

  for (const [idx, cov] of covered.entries()) {
    const tag = cov.tag;
    if (tooFresh.has(tag)) {
      skippedFresh++;
      continue;
    }
    const info = anchors.get(tag);
    const xrefPage = tailAnchorPage(info?.maxPosition ?? null, info?.bookCount ?? 0);
    const measured = info?.measuredPage ?? null;
    const anchor = pickAnchorPage(xrefPage, measured);
    const { startPage, maxPages: maxReadPages } = tailReadWindow(anchor, shelfPages);

    if (already.has(tag)) {
      skipped++;
      console.log(chalk.gray(`   ⏭  Skipping "${tag}" — already tail-scraped this pass.`));
      continue;
    }

    const cappedNote = anchor != null && anchor > MAX_REACHABLE_SHELF_PAGE ? ` (capped to ${startPage})` : '';
    const anchorSrc = xrefPage == null
      ? (measured != null ? `measured page ${measured}` : 'no anchor → page 1')
      : (measured != null && measured < xrefPage ? `xref page ${xrefPage} lowered to measured page ${measured}` : `xref page ${xrefPage}`);
    console.log(chalk.yellow.bold(`\n   🌐 [${idx + 1}/${covered.length}] "${tag}" (+${formatNum(cov.newBooks)} new to the cover · ${cov.pct.toFixed(2)}% cumulative · anchor: ${anchorSrc}${cappedNote})`));

    if (dryRun) {
      console.log(chalk.gray(`      (dry run — would read pages ${startPage}→live last page, capped at ${maxReadPages})`));
      if (idx + 1 >= PREVIEW_LIMIT && idx + 1 < covered.length) break;
      continue;
    }

    try {
      // Main tail read: from the previously-known last page (clamped to the
      // reachable ceiling), letting the live pagination footer drive the stop.
      let shelfBooks = await withConnectivityProbe(
        () => scrapeShelfBooks(tag, 0, maxReadPages, startPage, { skipAuthorSync: true }),
        { label: `tag-recent-monitor (tail "${tag}")` }
      );
      let hint = `read pages ${startPage}→live last page`;

      // Empty result with a known page: the tail page was unreachable (shelf
      // shrank) or the measured count overshot. Probe page 1 once to relearn
      // the real length, then read the new tail — only if it actually
      // regressed below the page we just tried. The probe's books are kept
      // either way; that page fetch is never thrown away.
      if (needsTailReprobe(shelfBooks.length, anchor)) {
        const probe = await withConnectivityProbe(
          () => scrapeShelfBooks(tag, 0, 1, 1, { skipAuthorSync: true }),
          { label: `tag-recent-monitor (reprobe "${tag}")` }
        );
        const live = getMeasuredShelfPages(tag) ?? xrefPage ?? 0;
        if (live >= 1 && live < startPage) {
          reprobed++;
          hint = `shelf shrank (tried page ${startPage}, now ${live}) → re-probed from the new last page`;
          shelfBooks = probe.concat(
            await withConnectivityProbe(
              () => scrapeShelfBooks(tag, 0, Math.max(maxReadPages, live), live, { skipAuthorSync: true }),
              { label: `tag-recent-monitor (tail "${tag}")` }
            )
          );
        } else {
          hint = `empty tail page — shelf length unchanged (${live} pages), keeping the probe's ${probe.length} book(s)`;
          shelfBooks = shelfBooks.concat(probe);
        }
      }

      const bookOutcome = await syncBooksToCache(shelfBooks, {});
      const authorsAdded = syncAuthorsToCache(shelfBooks, authorCache);

      const measuredNow = getMeasuredShelfPages(tag);
      upsertTagTailScrape(tag, { lastPageSeen: measuredNow, booksAdded: bookOutcome.inserted, authorsAdded });

      processed++;
      totalRead += shelfBooks.length;
      newBooks += bookOutcome.inserted;
      newAuthors += authorsAdded;

      console.log(chalk.green.bold(`      ✅ "${tag}": ${shelfBooks.length} tail books, +${bookOutcome.inserted} new books, +${authorsAdded} authors (${hint}).`));
    } catch (err: any) {
      if (isConnectivityError(err)) {
        console.log(chalk.red.bold(`\n🛑 Aborting walker: network error (${err.code} — ${err.message}).`));
        console.log(chalk.red.bold(`   Progress is saved; re-run to resume where the pass stopped.`));
        printSummary(processed, skipped, skippedFresh, covered.length, totalRead, newBooks, newAuthors, resuming, runStartedAt, null);
        return;
      }
      console.error(chalk.red.bold(`   ❌ Error tail-scraping tag "${tag}":`), err.message);
    }

    await delay(1000, 3000);
  }

  // Pass complete — mark it done so the next run re-checks everything.
  if (!dryRun) {
    saveTagTailState({ runStartedAt, runCompleted: true });
    console.log(chalk.green.bold('\n🎉 Pass complete — tagged done.'));
  }
  printSummary(processed, skipped, skippedFresh, covered.length, totalRead, newBooks, newAuthors, resuming, runStartedAt, reprobed);
}

function printSummary(
  processed: number,
  skipped: number,
  skippedFresh: number,
  totalPlanned: number,
  totalRead: number,
  newBooks: number,
  newAuthors: number,
  resuming: boolean,
  runStartedAt: string,
  reprobed: number | null,
): void {
  const gates = [`skipped (already this pass): ${skipped}`];
  if (skippedFresh > 0) gates.push(`skipped (inside --minAgeHours): ${skippedFresh}`);
  console.log(chalk.cyan.bold(`\n${resuming ? '↩️  Resumed pass' : '🏁 Pass'} summary — tail-scraped: ${processed}, ${gates.join(', ')}, of ${totalPlanned} covered tag(s).`));
  if (processed === 0 && skippedFresh > 0) {
    console.log(chalk.gray('   Every covered tag is inside the age gate — nothing to check this run.'));
  }
  console.log(chalk.green.bold(`   Tail books read: ${formatNum(totalRead)} (+${formatNum(newBooks)} NEW in cache), authors added: ${formatNum(newAuthors)}.`));
  if (reprobed !== null && reprobed > 0) console.log(chalk.gray(`   Shrunken shelves re-probed: ${reprobed}.`));
  console.log(chalk.gray(`   Pass started ${runStartedAt}.`));
}