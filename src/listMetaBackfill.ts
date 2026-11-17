import * as cheerio from 'cheerio';
import chalk from 'chalk';
import { getDb } from './db.ts';
import { loadConfig, upsertListMeta, upsertListTags } from './storage.ts';
import { USER_AGENT, parseListMeta, parseListTags } from './scraper.ts';
import { delay, fetchWithRetry, httpCallInfo, isConnectivityError, withConnectivityProbe } from './utils.ts';

const LIST_FETCH_TIMEOUT = 30000;

export interface ListMetaBackfillOptions {
  limit?: number;
  dryRun?: boolean;
  // Test hook: replaces the network read with a supplied HTML body.
  fetchListPage?: (listId: string) => Promise<string>;
}

export interface ListMetaBackfillResult {
  listId: string;
  existed: boolean;
  numBooks?: number;
  numVoters?: number;
  numLikes?: number;
  createdAt?: string;
  createdAtRaw?: string;
  creatorName?: string;
  tagsRecorded: number;
  elapsedMs: number;
}

// A list needs a read when it has no list_meta row at all, or when it has not
// been marked meta-missing and any report-facing field is still NULL. The
// creator requirement is satisfied by EITHER creator_id or creator_name because
// a deleted user has no id, only a name; requiring the id would re-walk those
// lists forever. Rows flagged meta_missing (e.g. dead/static pages with no
// parseable sidebar metadata) are not re-queued.
const MISSING_META_PREDICATE = `m.list_id IS NULL
  OR (COALESCE(m.meta_missing, 0) = 0 AND (
    m.num_books IS NULL
    OR m.num_voters IS NULL
    OR m.num_likes IS NULL
    OR m.created_at IS NULL
    OR (m.creator_id IS NULL AND m.creator_name IS NULL)
  ))`;

// Every list id the DB knows about, ordered by earliest discovery. list_scrapes
// is the primary source (all 122k crawled lists); lists and list_tags add any
// id that was learned through another route before it was ever crawled. The
// NULL-first_scraped sort key puts ids with a known discovery time first.
const CANDIDATE_SQL = `
  WITH known AS (
    SELECT list_id, MIN(first_scraped) AS first_scraped
    FROM list_scrapes
    WHERE list_id IS NOT NULL AND list_id <> ''
    GROUP BY list_id
    UNION ALL
    SELECT list_id, NULL
    FROM lists
    WHERE list_id IS NOT NULL AND list_id <> ''
      AND NOT EXISTS (SELECT 1 FROM list_scrapes s WHERE s.list_id = lists.list_id)
    UNION ALL
    SELECT DISTINCT list_id, NULL
    FROM list_tags
    WHERE list_id IS NOT NULL AND list_id <> ''
      AND NOT EXISTS (SELECT 1 FROM list_scrapes s WHERE s.list_id = list_tags.list_id)
  )
  SELECT k.list_id
  FROM known k
  LEFT JOIN list_meta m ON m.list_id = k.list_id
  WHERE ${MISSING_META_PREDICATE}
  ORDER BY (k.first_scraped IS NULL), k.first_scraped ASC, k.list_id ASC
`;

export function selectListsMissingMeta(): string[] {
  const rows = getDb().prepare(CANDIDATE_SQL).all() as { list_id: string }[];
  return rows.map((row) => row.list_id).filter((id) => !!id);
}

async function fetchListPageOnce(listId: string, cookie: string | undefined): Promise<string> {
  const listPath = listId.includes('/') ? listId : `show/${listId}`;
  const url = `https://www.goodreads.com/list/${listPath}?page=1`;
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
  if (cookie) headers['Cookie'] = cookie;

  const started = Date.now();
  const response = await fetchWithRetry(url, { headers, timeout: LIST_FETCH_TIMEOUT });
  const body = typeof response.data === 'string' ? response.data : String(response.data);
  console.log(chalk.gray(`   ${httpCallInfo(response.status, body.length, Date.now() - started, ['listId', listId])}`));
  return body;
}

// fetchWithRetry gives up on 403/429 immediately and on 202 after its bounded
// backoff. All three mean Goodreads is throttling us, so abort the run instead
// of marching the queue into the block.
function isThrottleError(error: any): boolean {
  const status = error?.response?.status;
  return (
    status === 202 ||
    status === 403 ||
    status === 429 ||
    /throttl|202 \(accepted\)/i.test(String(error?.message ?? ''))
  );
}

function hasAnyMeta(meta: ReturnType<typeof parseListMeta>): boolean {
  return (
    meta.numBooks != null ||
    meta.numVoters != null ||
    meta.numLikes != null ||
    meta.createdAt != null ||
    meta.createdAtRaw != null ||
    meta.creatorId != null ||
    meta.creatorName != null
  );
}

function fmtDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function metaSummary(meta: ReturnType<typeof parseListMeta>, tags: string[]): string {
  const parts: string[] = [];
  if (meta.numBooks != null) parts.push(`${meta.numBooks.toLocaleString()} books`);
  if (meta.numVoters != null) parts.push(`${meta.numVoters.toLocaleString()} voters`);
  if (meta.numLikes != null) parts.push(`${meta.numLikes.toLocaleString()} likes`);
  if (meta.createdAt) parts.push(`created ${meta.createdAt}`);
  if (meta.creatorName) parts.push(`by ${meta.creatorName}`);
  parts.push(`${tags.length} tags`);
  return parts.join(' · ');
}

// Metadata backfill, NOT a crawl: this reads page 1 of a list, records the
// header metadata + sidebar tags, and never touches list_scrapes or book rows.
export async function runListMetaBackfill(
  options: ListMetaBackfillOptions = {},
): Promise<ListMetaBackfillResult[]> {
  const dryRun = !!options.dryRun;

  console.log(chalk.cyan.bold('\n📋 List metadata backfill'));

  const candidates = selectListsMissingMeta();
  console.log(
    chalk.gray(`   ${candidates.length.toLocaleString()} known lists are missing list_meta fields`),
  );

  if (candidates.length === 0) {
    console.log(chalk.green('   ✅ Every known list already has its metadata — nothing to do.'));
    return [];
  }

  // No default limit: the point is to work the backlog down, and a completed
  // list drops out of the candidate query, so re-running resumes naturally.
  const limit = options.limit && options.limit > 0 ? options.limit : candidates.length;
  const queue = candidates.slice(0, limit);
  console.log(
    chalk.gray(
      `   Reading page 1 of ${queue.length.toLocaleString()} lists, earliest-discovered first${dryRun ? ' (DRY RUN — reading nothing)' : ''}`,
    ),
  );
  console.log(chalk.gray('------------------------------------------'));

  if (dryRun) {
    queue.slice(0, 50).forEach((id, i) => console.log(chalk.gray(`   ${i + 1}. ${id}`)));
    if (queue.length > 50) console.log(chalk.gray(`   … and ${queue.length - 50} more`));
    console.log(chalk.yellow(`\n   Dry run — ${queue.length} lists would be read. Pass without --dryRun to backfill.`));
    return [];
  }

  let fetchPage = options.fetchListPage;
  if (!fetchPage) {
    const cookie = (await loadConfig()).cookie;
    fetchPage = (listId: string) => fetchListPageOnce(listId, cookie);
  }
  const db = getDb();
  const rowExists = db.prepare('SELECT 1 FROM list_meta WHERE list_id = ?');

  const results: ListMetaBackfillResult[] = [];
  const runStart = Date.now();
  let failed = 0;
  let noMeta = 0;
  let added = 0;
  let filled = 0;
  let tagsFound = 0;

  for (let i = 0; i < queue.length; i++) {
    const listId = queue[i];
    const started = Date.now();
    const existed = !!rowExists.get(listId);

    let html: string;
    try {
      html = await withConnectivityProbe(() => fetchPage(listId), { label: `list ${listId}` });
    } catch (error: any) {
      if (isConnectivityError(error)) throw error;
      if (isThrottleError(error)) {
        console.log(
          chalk.red.bold(
            `\n   🛑 Goodreads throttled on list ${listId} — stopping. Progress is saved; re-run later to continue.`,
          ),
        );
        throw error;
      }
      // A dead/404 list must never end the run — that is the failure mode this
      // backlog is full of.
      failed++;
      console.log(
        chalk.gray(`   ⏭  [${i + 1}/${queue.length}] list ${listId} — ${error?.message ?? 'failed'}`),
      );
      continue;
    }

    const $ = cheerio.load(html);
    const meta = parseListMeta($);
    const tags = parseListTags($);

    try {
      upsertListMeta(listId, meta);
      if (tags.length > 0) upsertListTags(listId, tags);
    } catch (error: any) {
      failed++;
      console.log(
        chalk.gray(`   ⏭  [${i + 1}/${queue.length}] list ${listId} — write failed: ${error?.message ?? error}`),
      );
      continue;
    }

    const elapsedMs = Date.now() - started;
    const hasMeta = hasAnyMeta(meta);
    if (hasMeta) {
      if (existed) filled++;
      else added++;
      tagsFound += tags.length;
      results.push({
        listId,
        existed,
        numBooks: meta.numBooks,
        numVoters: meta.numVoters,
        numLikes: meta.numLikes,
        createdAt: meta.createdAt,
        createdAtRaw: meta.createdAtRaw,
        creatorName: meta.creatorName,
        tagsRecorded: tags.length,
        elapsedMs,
      });
      console.log(
        chalk.gray(`   [${i + 1}/${queue.length}] list ${listId} — ${metaSummary(meta, tags)} · ${fmtDuration(elapsedMs)}`),
      );
    } else {
      // No parseable sidebar metadata (often dead/deleted pages or static lists).
      // Record the outcome so this list is not re-queued forever; flag static
      // lists explicitly when the page states "This is a static list."
      try {
        upsertListMeta(listId, { metaMissing: true, isStatic: meta.isStatic });
      } catch (error: any) {
        failed++;
        console.log(
          chalk.gray(`   ⏭  [${i + 1}/${queue.length}] list ${listId} — write failed: ${error?.message ?? error}`),
        );
        if (i < queue.length - 1) await delay();
        continue;
      }
      noMeta++;
      const reason = meta.isStatic ? 'no metadata on the page (static list)' : 'no metadata on the page';
      console.log(chalk.gray(`   [${i + 1}/${queue.length}] list ${listId} — ${reason}`));
    }

    if (i < queue.length - 1) {
      await delay();
    }
  }

  const totalMs = Date.now() - runStart;
  console.log(chalk.cyan.bold('\n🏁 List metadata backfill complete'));
  console.log(
    chalk.gray(
      `   ${added.toLocaleString()} added · ${filled.toLocaleString()} filled · ${noMeta.toLocaleString()} with no metadata · ${failed.toLocaleString()} unreadable · ${tagsFound.toLocaleString()} tag rows · ${fmtDuration(totalMs)}`,
    ),
  );

  const remaining = selectListsMissingMeta().length;
  if (remaining > 0) {
    console.log(
      chalk.gray(`   Still queued: ${remaining.toLocaleString()} lists. Re-run the same command to continue.`),
    );
  } else {
    console.log(chalk.gray('   Queue empty — re-running now finds nothing to do.'));
  }
  console.log(chalk.gray('------------------------------------------'));
  return results;
}
