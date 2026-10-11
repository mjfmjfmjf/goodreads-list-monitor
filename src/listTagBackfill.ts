import chalk from 'chalk';
import { getDb } from './db.ts';
import { countAuthors, countBooks, loadListTags, syncBooksToCache, type BookCache } from './storage.ts';
import { scrapeListBooks } from './scraper.ts';
import { delay, isConnectivityError, withConnectivityProbe } from './utils.ts';

export interface ListTagBackfillOptions {
  limit?: number;
  dryRun?: boolean;
  // Test hook: the shuffle is the one random thing in a crawl, so it has to be
  // assertable. Production leaves this undefined and uses the default Fisher-Yates.
  shuffle?: (ids: string[]) => string[];
}

export interface ListTagBackfillResult {
  listId: string;
  elapsedMs: number;
  bookCount: number;
  booksAdded: number;
  authorsAdded: number;
  tagsRecorded: number;
}

// Every list id the DB knows about, minus the ones whose tags we already hold.
//
// The union of three bookkeeping tables, because a list can be known to us
// without being in any single one: `list_scrapes` holds every list a walker has
// ever read to the end, `lists` holds monitored/detected lists, and `list_walk`
// holds the checkpointed walk queue. `list_tags` is the only table that answers
// "do we already have this list's tags" — a list absent from it is a candidate.
//
// A left anti-join rather than NOT IN, so a NULL list_id can never wipe the
// result set. Ordering is applied in JS (see shuffleCandidates) because the
// order has to be random.
export function selectListsMissingTags(): string[] {
  const db = getDb();
  // list_walk lives behind ensureListTables(), not initSchema — it only exists on
  // a DB that has run the browser walk. Union it in when present rather than
  // assuming it, so this command works on a fresh DB too.
  const hasListWalk = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='list_walk'").get();
  const sources = ['SELECT list_id FROM lists', 'SELECT list_id FROM list_scrapes'];
  if (hasListWalk) sources.push('SELECT list_id FROM list_walk');
  return db.prepare(sources.join(' UNION ')).all().map((r: any) => r.list_id as string).filter((id) => !!id);
}

export function filterListsMissingTags(listIds: string[]): string[] {
  const known = new Set<string>();
  for (const row of getDb().prepare('SELECT DISTINCT list_id FROM list_tags').all() as any[]) {
    known.add(row.list_id);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of listIds) {
    if (!id || known.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// Random order, and the reason is throttling rather than taste: candidates are
// dominated by long-dead list ids from years of crawls, and walking them in id
// order means every run hits the same 404 cluster first and dies at the same
// place. Randomizing spreads the dead ids across the whole queue so a run makes
// progress on live lists between them.
export function shuffleCandidates<T>(ids: string[], rng = Math.random): string[] {
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const fmt = (ms: number): string => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

export async function runListTagBackfill(options: ListTagBackfillOptions = {}): Promise<ListTagBackfillResult[]> {
  const dryRun = !!options.dryRun;

  console.log(chalk.cyan.bold(`\n🏷️  List tag backfill`));

  const allKnown = selectListsMissingTags();
  const filtered = filterListsMissingTags(allKnown);
  const candidates = options.shuffle ? options.shuffle(filtered) : shuffleCandidates(filtered);
  console.log(
    chalk.gray(
      `   ${allKnown.length.toLocaleString()} known lists · ${candidates.length.toLocaleString()} with no list_tags row`,
    ),
  );

  if (candidates.length === 0) {
    console.log(chalk.green('   ✅ Every known list already has its tags recorded — nothing to do.'));
    return [];
  }

  // No default limit: the point of this command is to work the backlog down, and
  // it resumes naturally because a listed list now has a list_tags row.
  const limit = options.limit && options.limit > 0 ? options.limit : candidates.length;
  const queue = candidates.slice(0, limit);
  console.log(chalk.gray(`   Reading page 1 of ${queue.length.toLocaleString()} lists, in random order${dryRun ? ' (DRY RUN — reading nothing)' : ''}`));
  console.log(chalk.gray('------------------------------------------'));

  if (dryRun) {
    queue.forEach((id, i) => console.log(chalk.gray(`   ${i + 1}. ${id}`)));
    console.log(chalk.yellow(`\n   Dry run — ${queue.length} lists would be read. Pass without --dryRun to harvest.`));
    return [];
  }

  // Empty in-run cache: syncBooksToCache merges against the live SQLite row, and
  // loadBookCache() would materialize all ~11.5M books (AGENTS.md: never).
  const bookCache: BookCache = {};
  const results: ListTagBackfillResult[] = [];
  const runStart = Date.now();
  let failed = 0;
  let noTags = 0;
  let tagsFound = 0;

  for (let i = 0; i < queue.length; i++) {
    const listId = queue[i];
    const booksBefore = countBooks();
    const authorsBefore = countAuthors();
    const started = Date.now();

    let books;
    try {
      // Only page 1: the tag block repeats on every page, so one read per list
      // gets the whole tag set, and this keeps the command to one request a list.
      books = await withConnectivityProbe(() => scrapeListBooks(listId, 1), { label: `list ${listId}` });
    } catch (error: any) {
      // A dead list id must not end the run — that is the failure mode this
      // command exists to survive. Only a connectivity outage aborts (and even
      // then only after withConnectivityProbe has already waited it out).
      if (isConnectivityError(error)) throw error;
      failed++;
      console.log(chalk.gray(`   ⏭  [${i + 1}/${queue.length}] list ${listId} — ${error?.message ?? 'failed'}`));
      continue;
    }

    const booksAdded = countBooks() - booksBefore;
    const authorsAdded = countAuthors() - authorsBefore;
    const tags = loadListTags(listId);
    const elapsedMs = Date.now() - started;

    if (tags.length === 0) {
      noTags++;
      console.log(chalk.gray(`   [${i + 1}/${queue.length}] list ${listId} — read ${books.length} books, no tags on this list`));
    } else {
      tagsFound += tags.length;
      results.push({ listId, elapsedMs, bookCount: books.length, booksAdded, authorsAdded, tagsRecorded: tags.length });
      console.log(
        chalk.gray(
          `   [${i + 1}/${queue.length}] list ${listId} — ${fmt(elapsedMs)} · ${books.length} books · +${booksAdded} books · +${authorsAdded} authors · ${tags.length} tags`,
        ),
      );
    }

    if (i < queue.length - 1) {
      await delay(1000, 4000);
    }
  }

  const totalMs = Date.now() - runStart;
  const totalBooks = results.reduce((n, r) => n + r.bookCount, 0);
  const totalAddedBooks = results.reduce((n, r) => n + r.booksAdded, 0);
  const totalAddedAuthors = results.reduce((n, r) => n + r.authorsAdded, 0);

  console.log(cyanHeader());
  console.log(
    chalk.gray(
      `   ${results.length.toLocaleString()} lists tagged · ${tagsFound.toLocaleString()} tag rows written · ${noTags.toLocaleString()} lists had no tags · ${failed.toLocaleString()} unreadable · ${fmt(totalMs)} · ${totalBooks.toLocaleString()} books read · +${totalAddedBooks.toLocaleString()} books · +${totalAddedAuthors.toLocaleString()} authors`,
    ),
  );
  if (results.length > 0) {
    const remaining = candidates.length - results.length - noTags;
    console.log(
      chalk.gray(
        remaining > 0
          ? `   Still queued: ${remaining.toLocaleString()} lists. Re-run the same command to continue.`
          : '   Queue empty — re-running now finds nothing to do.',
      ),
    );
  }
  console.log(chalk.gray('------------------------------------------'));
  return results;
}

function cyanHeader(): string {
  return chalk.cyan.bold('\n🏁 List tag backfill complete');
}