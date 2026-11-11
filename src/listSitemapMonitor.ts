import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import chalk from 'chalk';
import axios from 'axios';
import { getDb } from './db.ts';
import { syncBooksToCache, upsertListScrape, type BookCache } from './storage.ts';
import { scrapeListBooksDetailed, type ScrapeListBooksResult } from './scraper.ts';
import { delay, fmtBytes, httpStatusWord, isConnectivityError, withConnectivityProbe } from './utils.ts';
import {
  LIST_SITEMAP_INDEX_URL,
  ListSitemapIndexError,
  classifyListEntries,
  parseListSitemapIndex,
  parseListSitemapShard,
  selectListSitemapShards,
  type ClassifiedListEntry,
  type ListSitemapEntry,
  type ListSitemapShard,
} from './listSitemap.ts';
import {
  advanceListSitemapCursor,
  beginListSitemapPass,
  completeListSitemapPass,
  getListSitemapFile,
  markListSitemapFileError,
  resumeListSitemapPass,
  type ListSitemapFileRow,
} from './listSitemapStore.ts';

export interface ListSitemapMonitorOptions {
  dryRun?: boolean;
  files?: string | number;
  start?: string | number;
  end?: string | number;
  index?: string;
  force?: boolean;
  maxLists?: string | number;
  minAge?: string | number;
  listMaxPages?: string | number;
}

export interface ListSitemapHttpResponse {
  url: string;
  status: number;
  data: Buffer;
  contentType?: string;
  contentLength?: string | null;
  etag?: string | null;
  lastModified?: string | null;
  durationMs: number;
}

export type ScrapeListBooksFn = (
  listId: string,
  maxPages: number,
  source: string,
) => Promise<ScrapeListBooksResult>;

export interface ListSitemapMonitorDeps {
  fetch?: (url: string, label: string) => Promise<ListSitemapHttpResponse>;
  scrapeList?: ScrapeListBooksFn;
  probe?: <T>(fn: () => Promise<T>, opts?: { label?: string }) => Promise<T>;
  sleep?: (min: number, max: number) => Promise<void>;
  logPath?: string;
  now?: () => number;
}

const LIST_LOOKUP_CHUNK = 500;
const DEFAULT_MIN_AGE_DAYS = 90;

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isGzip = (buffer: Buffer): boolean => buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;

function parsePositiveInt(value: string | number | undefined, fallback: number, name: string): number {
  const raw = value ?? fallback;
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseNonNegativeInt(value: string | number | undefined, fallback: number, name: string): number {
  const raw = value ?? fallback;
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function listLabel(entry: ListSitemapEntry): string {
  const readable = entry.slug.replace(/^\d+\./, '').replace(/[_\-.]+/g, ' ').trim();
  return readable || entry.slug || entry.id;
}

function loadLastScraped(ids: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const db = getDb();

  for (let i = 0; i < ids.length; i += LIST_LOOKUP_CHUNK) {
    const chunk = ids.slice(i, i + LIST_LOOKUP_CHUNK);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT list_id, last_scraped FROM list_scrapes WHERE list_id IN (${placeholders})`)
      .all(...chunk) as any[];
    for (const row of rows) map.set(row.list_id, row.last_scraped);
  }

  return map;
}

class JsonlLogger {
  constructor(private readonly file: string) {}

  write(record: Record<string, unknown>): void {
    try {
      fs.appendFileSync(this.file, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
    } catch (error) {
      console.log(chalk.yellow(`warning: could not append to ${this.file}: ${errorMessage(error)}`));
    }
  }
}

const defaultFetch = async (url: string, label: string): Promise<ListSitemapHttpResponse> => {
  const started = Date.now();
  const response = await withConnectivityProbe(
    () =>
      axios.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
        timeout: 60_000,
        validateStatus: (status) => status >= 200 && status < 300,
      }),
    { label },
  );

  return {
    url: (response.request as any)?.res?.responseUrl ?? url,
    status: response.status,
    data: Buffer.from(response.data ?? new Uint8Array()),
    contentType: response.headers['content-type'] as string | undefined,
    contentLength: (response.headers['content-length'] as string | undefined) ?? null,
    etag: (response.headers['etag'] as string | undefined) ?? null,
    lastModified: (response.headers['last-modified'] as string | undefined) ?? null,
    durationMs: Date.now() - started,
  };
};

interface PassCounters {
  newIds: number;
  staleIds: number;
  recentIds: number;
  unchangedIds: number;
  unknownIds: number;
  scraped: number;
  failed: number;
  goneIds: number;
  cappedIds: number;
}

const emptyCounters = (): PassCounters => ({
  newIds: 0,
  staleIds: 0,
  recentIds: 0,
  unchangedIds: 0,
  unknownIds: 0,
  scraped: 0,
  failed: 0,
  goneIds: 0,
  cappedIds: 0,
});

const countersFromRow = (row: ListSitemapFileRow): PassCounters => ({
  newIds: row.newIds,
  staleIds: row.staleIds,
  recentIds: row.recentIds,
  unchangedIds: row.unchangedIds,
  unknownIds: row.unknownIds,
  scraped: row.scraped,
  failed: row.failed,
  goneIds: row.goneIds,
  cappedIds: row.cappedIds,
});

const statusKey = (status: ClassifiedListEntry['status']): keyof PassCounters => {
  switch (status) {
    case 'new':
      return 'newIds';
    case 'stale':
      return 'staleIds';
    case 'recent':
      return 'recentIds';
    case 'unchanged':
      return 'unchangedIds';
    default:
      return 'unknownIds';
  }
};

export async function runListSitemapMonitor(
  options: ListSitemapMonitorOptions = {},
  deps: ListSitemapMonitorDeps = {},
): Promise<void> {
  const dryRun = !!options.dryRun;
  const force = !!options.force;
  const minAgeDays = parseNonNegativeInt(options.minAge, DEFAULT_MIN_AGE_DAYS, '--minAge');
  const maxLists = parseNonNegativeInt(options.maxLists, 0, '--maxLists');
  const listMaxPages = options.listMaxPages === undefined
    ? Infinity
    : parsePositiveInt(options.listMaxPages, 1, '--listMaxPages');
  const indexUrl = options.index || LIST_SITEMAP_INDEX_URL;
  const fetch = deps.fetch ?? defaultFetch;
  const scrapeList = deps.scrapeList ?? scrapeListBooksDetailed;
  const probe = deps.probe ?? withConnectivityProbe;
  const sleep = deps.sleep ?? delay;
  const now = deps.now ?? Date.now;
  const nowIso = () => new Date(now()).toISOString();
  const runId = `${nowIso().replace(/[:.]/g, '-')}-${process.pid}`;
  const logPath = deps.logPath ?? path.join(process.cwd(), 'listSitemapMonitor.log');
  const logger = new JsonlLogger(logPath);
  const bookCache: BookCache = {};

  const end = options.end === undefined ? undefined : parsePositiveInt(options.end, 1, '--end');
  if (end !== undefined && options.files !== undefined) {
    throw new Error('--end and --files are mutually exclusive');
  }
  if (end !== undefined && options.start === undefined) {
    throw new Error('--end requires --start');
  }
  const files = end !== undefined
    ? Number.POSITIVE_INFINITY
    : options.files === undefined
      ? Number.POSITIVE_INFINITY
      : parsePositiveInt(options.files, 1, '--files');

  let budget = maxLists === 0 ? Number.POSITIVE_INFINITY : maxLists;

  const totals = {
    shards: 0,
    skippedShards: 0,
    failedShards: 0,
    entries: 0,
    bytesCompressed: 0,
    bytesUncompressed: 0,
    downloadMs: 0,
    ...emptyCounters(),
    booksInserted: 0,
    booksEnriched: 0,
  };

  console.log(chalk.cyan.bold(dryRun ? '\nList sitemap monitor (dry run)' : '\nList sitemap monitor (apply)'));
  console.log(
    chalk.gray(
      `   run=${runId} index=${indexUrl} files=${files === Number.POSITIVE_INFINITY ? 'all' : files} start=${options.start ?? 'first'} minAge=${minAgeDays}d maxLists=${maxLists === 0 ? 'unlimited' : maxLists}`,
    ),
  );

  let indexResponse: ListSitemapHttpResponse;
  try {
    indexResponse = await fetch(indexUrl, 'list sitemap index');
  } catch (error) {
    logger.write({ runId, event: 'error', stage: 'index', url: indexUrl, message: errorMessage(error) });
    throw error;
  }

  logger.write({
    runId,
    event: 'index',
    url: indexUrl,
    finalUrl: indexResponse.url,
    httpStatus: indexResponse.status,
    bytes: indexResponse.data.length,
    durationMs: indexResponse.durationMs,
  });
  console.log(
    `index [${httpStatusWord(indexResponse.status)}] http=${indexResponse.status} size=${fmtBytes(indexResponse.data.length)} dur=${(indexResponse.durationMs / 1000).toFixed(3)}s`,
  );

  let shards: ListSitemapShard[];
  try {
    shards = parseListSitemapIndex(indexResponse.data.toString('utf8'));
  } catch (error) {
    if (error instanceof ListSitemapIndexError) {
      logger.write({ runId, event: 'error', stage: 'index-validate', url: error.url, message: error.message });
      console.error(chalk.red.bold(`Refusing to continue: ${error.message}`));
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  if (shards.length === 0) {
    logger.write({ runId, event: 'error', stage: 'index', url: indexUrl, message: 'index contained no shards' });
    console.error(chalk.red.bold('Refusing to continue: the list sitemap index contained no shards.'));
    process.exitCode = 1;
    return;
  }

  const start = options.start === undefined
    ? [...shards].sort((a, b) => a.shardId - b.shardId)[0].shardId
    : parsePositiveInt(options.start, 1, '--start');
  const selected = selectListSitemapShards(shards, start, files, end);
  if (selected.length === 0) {
    logger.write({ runId, event: 'error', stage: 'select', start, files, message: 'no shards at or after --start' });
    console.error(chalk.red.bold(`Refusing to continue: no shards at or after --start ${start}.`));
    process.exitCode = 1;
    return;
  }

  for (let i = 0; i < selected.length; i++) {
    const shard = selected[i];
    if (i > 0) await sleep(1000, 2000);

    const prior = getListSitemapFile(shard.shardId);
    let response: ListSitemapHttpResponse;
    try {
      response = await fetch(shard.url, `sitemap.${shard.shardId}`);
    } catch (error) {
      if (isConnectivityError(error)) throw error;
      totals.failedShards++;
      const message = errorMessage(error);
      logger.write({ runId, event: 'error', shard: shard.shardId, url: shard.url, message });
      console.error(chalk.red(`sitemap.${shard.shardId}.xml.gz failed: ${message}`));
      if (!dryRun) markListSitemapFileError(shard.shardId, message);
      continue;
    }

    const compressed = response.data;
    const sha256 = createHash('sha256').update(compressed).digest('hex');
    const uncompressed = isGzip(compressed) ? gunzipSync(compressed) : compressed;
    const parsed = parseListSitemapShard(uncompressed.toString('utf8'));

    logger.write({
      runId,
      event: 'download',
      shard: shard.shardId,
      url: shard.url,
      finalUrl: response.url,
      httpStatus: response.status,
      bytes: compressed.length,
      uncompressedBytes: uncompressed.length,
      durationMs: response.durationMs,
      sha256,
      entries: parsed.urlCount,
      uniqueIds: parsed.entries.length,
      duplicates: parsed.duplicateIds,
      unparseable: parsed.unparseable,
      missingLastmod: parsed.missingLastmod,
    });

    const lastScraped = loadLastScraped(parsed.entries.map((entry) => entry.id));
    const { entries: classified, summary } = classifyListEntries(parsed.entries, lastScraped, {
      nowMs: now(),
      minAgeDays,
    });

    const resuming = !force
      && prior?.status === 'in_progress'
      && prior.sha256 === sha256
      && prior.cursorIndex !== undefined;
    const startIndex = resuming ? Math.min(prior!.cursorIndex! + 1, classified.length) : 0;
    const counters = resuming ? countersFromRow(prior!) : emptyCounters();

    totals.entries += parsed.entries.length;
    totals.bytesCompressed += compressed.length;
    totals.bytesUncompressed += uncompressed.length;
    totals.downloadMs += response.durationMs;

    const position = `[${i + 1}/${selected.length}]`;
    console.log(
      chalk.cyan.bold(
        `\n${position} sitemap.${shard.shardId}.xml.gz  ${parsed.entries.length.toLocaleString('en-US')} entries  ${resuming ? `resuming at #${startIndex}` : 'new pass'}`,
      ),
    );
    console.log(
      `   download [${httpStatusWord(response.status)}] http=${response.status} size=${fmtBytes(compressed.length)} -> ${fmtBytes(uncompressed.length)} dur=${(response.durationMs / 1000).toFixed(3)}s`,
    );
    console.log(
      `   entries=${parsed.urlCount.toLocaleString('en-US')} unique=${parsed.entries.length.toLocaleString('en-US')} duplicates=${parsed.duplicateIds.toLocaleString('en-US')} unparseable=${parsed.unparseable.toLocaleString('en-US')} missingLastmod=${parsed.missingLastmod.toLocaleString('en-US')}`,
    );
    console.log(`   lastmod=${parsed.lastmodMin ?? '-'}..${parsed.lastmodMax ?? '-'}`);
    console.log(
      `   new=${summary.new.toLocaleString('en-US')} stale=${summary.stale.toLocaleString('en-US')} recent=${summary.recent.toLocaleString('en-US')} unchanged=${summary.unchanged.toLocaleString('en-US')} unknown=${summary.unknown.toLocaleString('en-US')}`,
    );

    logger.write({
      runId,
      event: 'preview',
      shard: shard.shardId,
      entries: parsed.urlCount,
      uniqueIds: parsed.entries.length,
      duplicates: parsed.duplicateIds,
      unparseable: parsed.unparseable,
      missingLastmod: parsed.missingLastmod,
      lastmodMin: parsed.lastmodMin ?? null,
      lastmodMax: parsed.lastmodMax ?? null,
      ...summary,
      resuming,
      startIndex,
    });

    if (dryRun) {
      totals.skippedShards++;
      continue;
    }

    totals.shards++;

    const passInput = {
      shardId: shard.shardId,
      url: shard.url,
      indexLastmod: shard.indexLastmod,
      etag: response.etag ?? undefined,
      lastModified: response.lastModified ?? undefined,
      sha256,
      bytesCompressed: compressed.length,
      bytesUncompressed: uncompressed.length,
      httpStatus: response.status,
      durationMs: response.durationMs,
      entries: parsed.entries.length,
      lastmodMin: parsed.lastmodMin,
      lastmodMax: parsed.lastmodMax,
      fetchedAt: nowIso(),
      parsedAt: nowIso(),
      passStartedAt: nowIso(),
    };
    if (resuming) resumeListSitemapPass(passInput);
    else beginListSitemapPass(passInput);

    let stoppedForConnectivity = false;
    let stoppedForBudget = false;

    for (let idx = startIndex; idx < classified.length; idx++) {
      const entry = classified[idx];
      const needsScrape = entry.status === 'new' || entry.status === 'stale';

      if (needsScrape && budget <= 0) {
        stoppedForBudget = true;
        break;
      }

      counters[statusKey(entry.status)]++;

      if (needsScrape) {
        budget--;
        const label = listLabel(entry);
        let result: ScrapeListBooksResult;
        try {
          result = await probe(async () => {
            const scraped = await scrapeList(entry.id, listMaxPages, 'list_sitemap_monitor');
            if (isConnectivityError(scraped.error)) throw scraped.error;
            return scraped;
          }, { label: `list ${entry.id}` });
        } catch (error) {
          if (isConnectivityError(error)) {
            stoppedForConnectivity = true;
            break;
          }
          counters.failed++;
          const message = errorMessage(error);
          logger.write({ runId, event: 'failure', shard: shard.shardId, list: entry.id, message });
          console.log(chalk.red(`   [${idx + 1}/${classified.length}] ${label} (${entry.id}) — failed: ${message}`));
          advanceListSitemapCursor({
            shardId: shard.shardId,
            cursorListId: entry.id,
            cursorIndex: idx,
            processedEntries: idx + 1,
            ...counters,
          });
          if (idx < classified.length - 1) await sleep(1000, 3000);
          continue;
        }

        if (result.completed) {
          const outcome = await syncBooksToCache(result.books, bookCache);
          upsertListScrape(entry.id, label, nowIso(), result.books.length);
          counters.scraped++;
          totals.booksInserted += outcome.inserted;
          totals.booksEnriched += outcome.updated;
          logger.write({
            runId,
            event: 'scrape',
            shard: shard.shardId,
            list: entry.id,
            status: entry.status,
            pages: result.pagesRead,
            books: result.books.length,
            booksInserted: outcome.inserted,
            booksEnriched: outcome.updated,
          });
          console.log(
            chalk.green(`   [${idx + 1}/${classified.length}] ${label} (${entry.id}) — ${entry.status} → scraped ${result.books.length} books`),
          );
        } else if (result.lastStatus === 404 || result.lastStatus === 410) {
          upsertListScrape(entry.id, label, nowIso(), 0);
          counters.goneIds++;
          logger.write({ runId, event: 'gone', shard: shard.shardId, list: entry.id, httpStatus: result.lastStatus });
          console.log(chalk.yellow(`   [${idx + 1}/${classified.length}] ${label} (${entry.id}) — gone (HTTP ${result.lastStatus})`));
        } else if (
          listMaxPages !== Infinity
          && !result.error
          && result.lastStatus !== undefined
          && result.lastStatus >= 200
          && result.lastStatus < 300
        ) {
          counters.cappedIds++;
          logger.write({ runId, event: 'capped', shard: shard.shardId, list: entry.id, pages: result.pagesRead });
          console.log(chalk.gray(`   [${idx + 1}/${classified.length}] ${label} (${entry.id}) — capped at ${result.pagesRead} pages (not marked)`));
        } else {
          counters.failed++;
          const message = result.error ? errorMessage(result.error) : `incomplete (HTTP ${result.lastStatus ?? '-'})`;
          logger.write({ runId, event: 'failure', shard: shard.shardId, list: entry.id, message });
          console.log(chalk.red(`   [${idx + 1}/${classified.length}] ${label} (${entry.id}) — failed: ${message}`));
        }

        if (idx < classified.length - 1) await sleep(1000, 3000);
      } else {
        console.log(
          chalk.gray(
            `   [${idx + 1}/${classified.length}] ${listLabel(entry)} (${entry.id}) — ${entry.status}`,
          ),
        );
      }

      advanceListSitemapCursor({
        shardId: shard.shardId,
        cursorListId: entry.id,
        cursorIndex: idx,
        processedEntries: idx + 1,
        ...counters,
      });
    }

    for (const key of ['newIds', 'staleIds', 'recentIds', 'unchangedIds', 'unknownIds', 'scraped', 'failed', 'goneIds', 'cappedIds'] as const) {
      totals[key] += counters[key];
    }

    if (stoppedForConnectivity) {
      logger.write({ runId, event: 'error', shard: shard.shardId, message: 'connectivity lost during pass' });
      console.error(chalk.red.bold('\n🛑 Network error — stopping; progress saved.'));
      break;
    }

    if (stoppedForBudget) {
      const processedEntries = counters.newIds + counters.staleIds + counters.recentIds + counters.unchangedIds + counters.unknownIds;
      logger.write({ runId, event: 'budget', shard: shard.shardId, processedEntries });
      console.log(chalk.yellow.bold('\n⏸  --maxLists reached — progress saved; re-run to continue.'));
      break;
    }

    completeListSitemapPass(shard.shardId, nowIso());
    logger.write({
      runId,
      event: 'pass-done',
      shard: shard.shardId,
      entries: parsed.entries.length,
      ...counters,
      booksInserted: totals.booksInserted,
      booksEnriched: totals.booksEnriched,
    });

    console.log(chalk.cyan.bold(`🏁 sitemap.${shard.shardId}.xml.gz pass done`));
    console.log(
      `   processed=${(counters.newIds + counters.staleIds + counters.recentIds + counters.unchangedIds + counters.unknownIds).toLocaleString('en-US')} / ${classified.length.toLocaleString('en-US')}`,
    );
    console.log(
      `   new=${counters.newIds.toLocaleString('en-US')} stale=${counters.staleIds.toLocaleString('en-US')} scraped=${counters.scraped.toLocaleString('en-US')} gone=${counters.goneIds.toLocaleString('en-US')} failed=${counters.failed.toLocaleString('en-US')} capped=${counters.cappedIds.toLocaleString('en-US')}`,
    );
    console.log(
      `   recent=${counters.recentIds.toLocaleString('en-US')} unchanged=${counters.unchangedIds.toLocaleString('en-US')} unknown=${counters.unknownIds.toLocaleString('en-US')}`,
    );
  }

  logger.write({
    runId,
    event: 'summary',
    ...totals,
  });

  console.log(chalk.cyan.bold(dryRun ? '\nDry-run summary' : '\nApply summary'));
  console.log(
    `   shards: ${totals.shards} walked, ${totals.skippedShards} previewed, ${totals.failedShards} failed`,
  );
  console.log(
    `   entries: ${totals.entries.toLocaleString('en-US')} · downloaded ${fmtBytes(totals.bytesCompressed)} -> ${fmtBytes(totals.bytesUncompressed)} in ${(totals.downloadMs / 1000).toFixed(1)}s`,
  );
  if (!dryRun) {
    console.log(
      `   new=${totals.newIds.toLocaleString('en-US')} stale=${totals.staleIds.toLocaleString('en-US')} scraped=${totals.scraped.toLocaleString('en-US')} gone=${totals.goneIds.toLocaleString('en-US')} failed=${totals.failed.toLocaleString('en-US')} capped=${totals.cappedIds.toLocaleString('en-US')}`,
    );
    console.log(
      `   recent=${totals.recentIds.toLocaleString('en-US')} unchanged=${totals.unchangedIds.toLocaleString('en-US')} unknown=${totals.unknownIds.toLocaleString('en-US')}`,
    );
    console.log(
      `   books: ${totals.booksInserted.toLocaleString('en-US')} new / ${totals.booksEnriched.toLocaleString('en-US')} enriched`,
    );
  }

  if (totals.shards === 0 && totals.skippedShards === 0 && totals.failedShards === 0) process.exitCode = 1;
}
