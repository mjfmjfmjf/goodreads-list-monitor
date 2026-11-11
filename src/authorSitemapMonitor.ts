import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import chalk from 'chalk';
import axios from 'axios';
import { getDb } from './db.ts';
import {
  AUTHOR_FAIL_LIMIT,
  clearAuthorScrapeFailure,
  countAuthors,
  isRetiredAuthor,
  loadStrikeMap,
  recordAuthorScrapeFailure,
} from './storage.ts';
import { scrapeAuthorStats } from './scraper.ts';
import type { AuthorStatsResult } from './scraper.ts';
import { storeAuthorStats } from './authorOne.ts';
import { delay, fmtBytes, httpStatusWord, isConnectivityError, parseDelayRange, withConnectivityProbe } from './utils.ts';
import {
  AUTHOR_SITEMAP_INDEX_URL,
  AuthorSitemapIndexError,
  classifySitemapEntries,
  nextSitemapStart,
  parseAuthorSitemapIndex,
  parseAuthorSitemapShard,
  planSitemapCandidates,
  selectSitemapShards,
  type CachedAuthorRow,
  type CandidatePlan,
  type ClassifiedSitemapEntry,
  type SitemapShard,
} from './authorSitemap.ts';
import {
  countSitemapCandidates,
  countSitemapCandidatesForShard,
  deleteSitemapCandidate,
  getSitemapFile,
  incrementSitemapCandidateAttempt,
  listDoneShardIds,
  listReadySitemapCandidates,
  markSitemapFileError,
  markSitemapFileSkipped,
  upsertSitemapCandidate,
  upsertSitemapFile,
} from './authorSitemapStore.ts';

export interface AuthorSitemapMonitorOptions {
  dryRun?: boolean;
  files?: string | number;
  start?: string | number;
  index?: string;
  force?: boolean;
  enqueueOnly?: boolean;
  authors?: string | number;
  minAge?: string | number;
  only?: string;
  multiPage?: boolean;
  withCookie?: boolean;
}

export interface SitemapHttpResponse {
  url: string;
  status: number;
  data: Buffer;
  contentType?: string;
  contentLength?: string | null;
  etag?: string | null;
  lastModified?: string | null;
  durationMs: number;
}

export interface SitemapFetchOptions {
  headers?: Record<string, string>;
}

export type ScrapeAuthorStatsFn = (
  authorSlug: string,
  onError?: (reason: string) => void,
  crawlAllPages?: boolean,
  sort?: string,
  useCookie?: boolean,
) => Promise<AuthorStatsResult | undefined>;

export interface AuthorSitemapMonitorDeps {
  fetch?: (url: string, label: string, options?: SitemapFetchOptions) => Promise<SitemapHttpResponse>;
  scrape?: ScrapeAuthorStatsFn;
  logPath?: string;
  tempRoot?: string;
  now?: () => number;
}

const AUTHOR_LOOKUP_CHUNK = 500;
const DEFAULT_FILES = 2;
const DEFAULT_AUTHORS = 100;
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

function parseOnly(value: string | undefined): 'new' | 'changed' | undefined {
  if (value === undefined) return undefined;
  if (value === 'new' || value === 'changed') return value;
  throw new Error('--only must be "new" or "changed"');
}

function loadAuthorRows(ids: string[]): Map<string, CachedAuthorRow> {
  const rows = new Map<string, CachedAuthorRow>();
  const db = getDb();

  for (let i = 0; i < ids.length; i += AUTHOR_LOOKUP_CHUNK) {
    const chunk = ids.slice(i, i + AUTHOR_LOOKUP_CHUNK);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(',');
    const found = db
      .prepare(`
        SELECT id, last_seen, average_rating, num_ratings, num_reviews, num_shelves, catalog_pages
        FROM authors WHERE id IN (${placeholders})
      `)
      .all(...chunk) as any[];
    for (const row of found) {
      rows.set(row.id, {
        id: row.id,
        lastSeen: row.last_seen ?? undefined,
        averageRating: row.average_rating != null ? String(row.average_rating) : undefined,
        numRatings: row.num_ratings ? String(row.num_ratings) : undefined,
        numReviews: row.num_reviews ? String(row.num_reviews) : undefined,
        numShelves: row.num_shelves ? String(row.num_shelves) : undefined,
        catalogPages: row.catalog_pages ?? undefined,
      });
    }
  }

  return rows;
}

function loadRetiredIds(): Set<string> {
  const retired = new Set<string>();
  for (const [id, failCount] of loadStrikeMap()) {
    if ((failCount ?? 0) >= AUTHOR_FAIL_LIMIT) retired.add(id);
  }
  return retired;
}

function earlierLastmod(current: string | undefined, candidate: string | undefined): string | undefined {
  if (!candidate) return current;
  if (!current || Date.parse(candidate) < Date.parse(current)) return candidate;
  return current;
}

function laterLastmod(current: string | undefined, candidate: string | undefined): string | undefined {
  if (!candidate) return current;
  if (!current || Date.parse(candidate) > Date.parse(current)) return candidate;
  return current;
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

const defaultFetch = async (
  url: string,
  label: string,
  options: SitemapFetchOptions = {},
): Promise<SitemapHttpResponse> => {
  const started = Date.now();
  const response = await withConnectivityProbe(
    () =>
      axios.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
        timeout: 60_000,
        headers: options.headers,
        validateStatus: (status) => (status >= 200 && status < 300) || status === 304,
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

interface DrainStats {
  backCatalogScraped: number;
  recentScraped: number;
  noStats: number;
  failed: number;
  errorSkipped: number;
  attempts: number;
  booksInserted: number;
  booksEnriched: number;
  stoppedForConnectivity: boolean;
}

const emptyDrain = (): DrainStats => ({
  backCatalogScraped: 0,
  recentScraped: 0,
  noStats: 0,
  failed: 0,
  errorSkipped: 0,
  attempts: 0,
  booksInserted: 0,
  booksEnriched: 0,
  stoppedForConnectivity: false,
});

interface DrainOptions {
  limit: number;
  shardId?: number;
  only?: 'new' | 'changed';
  multiPage: boolean;
  withCookie: boolean;
  scrape: ScrapeAuthorStatsFn;
  delayMin: number;
  delayMax: number;
  nowIso: string;
}

async function drainCandidates(options: DrainOptions): Promise<DrainStats> {
  const stats = emptyDrain();
  if (options.limit < 0) return stats;

  const ready = listReadySitemapCandidates({
    limit: options.limit,
    shardId: options.shardId,
    only: options.only,
    now: options.nowIso,
  });

  for (let i = 0; i < ready.length; i++) {
    const candidate = ready[i];

    if (isRetiredAuthor(candidate.authorId)) {
      deleteSitemapCandidate(candidate.authorId);
      stats.errorSkipped++;
      continue;
    }

    const kind = options.multiPage ? 'back_catalog' : candidate.scrapeKind;
    const scrapeKindLabel = kind === 'back_catalog' ? 'back catalog' : 'recent';
    console.log(
      chalk.white.bold(
        `[${i + 1}/${ready.length}] ${candidate.slug || candidate.authorId} (${candidate.authorId}) — ${scrapeKindLabel}`,
      ),
    );

    let failReason = 'no_stats_line';
    let result: AuthorStatsResult | undefined;
    try {
      result = await withConnectivityProbe(
        () =>
          options.scrape(
            candidate.authorId,
            (reason) => {
              failReason = reason;
            },
            kind === 'back_catalog',
            kind === 'back_catalog' ? undefined : 'original_publication_year',
            options.withCookie,
          ),
        { label: `author sitemap ${candidate.authorId}` },
      );
    } catch (error) {
      if (isConnectivityError(error)) {
        stats.stoppedForConnectivity = true;
        console.error(
          chalk.red.bold(`\n🛑 Network error (${(error as any).code} — ${(error as any).message}) — stopping; progress saved.`),
        );
        return stats;
      }

      stats.failed++;
      stats.attempts++;
      const message = errorMessage(error);
      incrementSitemapCandidateAttempt(candidate.authorId, message);
      recordAuthorScrapeFailure(candidate.authorId, message);
      console.error(chalk.red(`   ❌ ${candidate.authorId} — ${message}`));
      if (isRetiredAuthor(candidate.authorId)) {
        deleteSitemapCandidate(candidate.authorId);
        stats.errorSkipped++;
      }
      if (i < ready.length - 1) await delay(options.delayMin, options.delayMax);
      continue;
    }

    stats.attempts++;

    if (!result) {
      stats.noStats++;
      recordAuthorScrapeFailure(candidate.authorId, failReason);
      incrementSitemapCandidateAttempt(candidate.authorId, failReason);
      const retired = isRetiredAuthor(candidate.authorId);
      console.log(
        chalk.yellow(
          `   ⚠️ no stats line${retired ? ` — retired at ${AUTHOR_FAIL_LIMIT} failures` : ''}`,
        ),
      );
      if (retired) {
        deleteSitemapCandidate(candidate.authorId);
        stats.errorSkipped++;
      }
      if (i < ready.length - 1) await delay(options.delayMin, options.delayMax);
      continue;
    }

    clearAuthorScrapeFailure(candidate.authorId);
    const stored = storeAuthorStats(
      { id: candidate.authorId, slug: candidate.slug || candidate.authorId },
      result,
      'author_sitemap_monitor',
    );
    deleteSitemapCandidate(candidate.authorId);
    if (kind === 'back_catalog') stats.backCatalogScraped++;
    else stats.recentScraped++;
    stats.booksInserted += result.booksInserted;
    stats.booksEnriched += result.booksEnriched;

    const booksNote = result.booksInserted || result.booksEnriched
      ? chalk.gray(` · ${result.booksInserted} new / ${result.booksEnriched} enriched books`)
      : '';
    console.log(
      `   ${chalk.green.bold(stored.stats.numRatings ?? 'n/a')} ratings · ` +
      `${chalk.yellow(stored.stats.numReviews ?? 'n/a')} reviews · ` +
      `${chalk.cyan(stored.stats.numShelves ?? 'n/a')} shelves${booksNote}`,
    );

    if (i < ready.length - 1) await delay(options.delayMin, options.delayMax);
  }

  return stats;
}

function enqueueCandidates(
  shardId: number,
  plan: CandidatePlan,
  classified: ClassifiedSitemapEntry[],
  nowIso: string,
): number {
  for (const entry of classified) {
    if (entry.errorSkipped) deleteSitemapCandidate(entry.id);
  }

  for (const decision of plan.enqueue) {
    upsertSitemapCandidate({
      authorId: decision.entry.id,
      shardId,
      slug: decision.entry.slug,
      sitemapLastmod: decision.entry.lastmod,
      reason: decision.reason,
      scrapeKind: decision.scrapeKind,
      status: decision.status,
      notBefore: decision.notBefore,
      attempts: 0,
      firstSeen: nowIso,
    });
  }

  return plan.enqueue.length;
}

export async function runAuthorSitemapMonitor(
  options: AuthorSitemapMonitorOptions = {},
  deps: AuthorSitemapMonitorDeps = {},
): Promise<void> {
  const dryRun = !!options.dryRun;
  const enqueueOnly = !!options.enqueueOnly;
  const force = !!options.force;
  const multiPage = !!options.multiPage;
  const withCookie = !!options.withCookie;
  const minAgeDays = parseNonNegativeInt(options.minAge, DEFAULT_MIN_AGE_DAYS, '--minAge');
  const authorsOption = parseNonNegativeInt(options.authors, DEFAULT_AUTHORS, '--authors');
  const files = parsePositiveInt(options.files, DEFAULT_FILES, '--files');
  const only = parseOnly(options.only);
  const indexUrl = options.index || AUTHOR_SITEMAP_INDEX_URL;
  const fetch = deps.fetch ?? defaultFetch;
  const scrape = deps.scrape ?? scrapeAuthorStats;
  const now = deps.now ?? Date.now;
  const runId = `${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const logPath = deps.logPath ?? path.join(process.cwd(), 'authorSitemapMonitor.log');
  const logger = new JsonlLogger(logPath);
  const tempDir = fs.mkdtempSync(path.join(deps.tempRoot ?? os.tmpdir(), 'author-sitemap-'));
  const nowIso = () => new Date(now()).toISOString();
  const drainOnly = !dryRun && !enqueueOnly && options.files === undefined && options.authors !== undefined;

  const [authorDelayMin, authorDelayMax] = parseDelayRange(
    process.env.GR_AUTHOR_DELAY_MS,
    withCookie ? 2000 : 1000,
    withCookie ? 5000 : 1800,
  );

  const totals = {
    bytesCompressed: 0,
    bytesUncompressed: 0,
    downloadMs: 0,
    urlCount: 0,
    uniqueIds: 0,
    unparseable: 0,
    missingLastmod: 0,
    duplicates: 0,
    new: 0,
    changed: 0,
    changedDeferred: 0,
    unchanged: 0,
    unknown: 0,
    errorSkipped: 0,
    skippedRecent: 0,
    skippedUnchanged: 0,
    enqueued: 0,
    backCatalogScraped: 0,
    recentScraped: 0,
    noStats: 0,
    failed: 0,
    scrapeErrorSkipped: 0,
    booksInserted: 0,
    booksEnriched: 0,
    tempDeleted: 0,
    authorsBefore: 0,
    authorsAfter: 0,
  };
  let processed = 0;
  let failedShards = 0;
  let skippedShards = 0;
  let lastmodMin: string | undefined;
  let lastmodMax: string | undefined;
  let authorsBefore = 0;
  let budget = authorsOption === 0 ? Number.POSITIVE_INFINITY : authorsOption;

  const deleteTemp = (tempPath: string | undefined, shardId: number): void => {
    if (!tempPath) return;
    try {
      fs.unlinkSync(tempPath);
      totals.tempDeleted++;
      logger.write({ runId, event: 'delete', shard: shardId, path: tempPath, deleted: true });
    } catch (error) {
      logger.write({
        runId,
        event: 'delete',
        shard: shardId,
        path: tempPath,
        deleted: false,
        message: errorMessage(error),
      });
      console.log(chalk.yellow(`warning: could not delete ${tempPath}: ${errorMessage(error)}`));
    }
  };

  const printAggregate = (): void => {
    console.log(chalk.cyan.bold(dryRun ? '\nDry-run summary' : '\nApply summary'));
    console.log(
      `   shards: ${processed} processed, ${skippedShards} skipped unchanged, ${failedShards} failed`,
    );
    console.log(
      `   downloaded: ${fmtBytes(totals.bytesCompressed)} compressed -> ${fmtBytes(totals.bytesUncompressed)} uncompressed in ${(totals.downloadMs / 1000).toFixed(1)}s`,
    );
    console.log(
      `   entries: ${totals.urlCount.toLocaleString('en-US')} urls, ${totals.uniqueIds.toLocaleString('en-US')} unique (${totals.duplicates.toLocaleString('en-US')} duplicates, ${totals.unparseable.toLocaleString('en-US')} unparseable, ${totals.missingLastmod.toLocaleString('en-US')} missing lastmod)`,
    );
    console.log(`   lastmod: ${lastmodMin ?? '-'}..${lastmodMax ?? '-'}`);
    console.log(
      `   new=${totals.new.toLocaleString('en-US')} cached=${(totals.uniqueIds - totals.new).toLocaleString('en-US')} changed=${totals.changed.toLocaleString('en-US')} unchanged=${totals.unchanged.toLocaleString('en-US')} unknown=${totals.unknown.toLocaleString('en-US')} errorSkipped=${totals.errorSkipped.toLocaleString('en-US')}`,
    );
    if (!dryRun) {
      console.log(
        `   enqueued=${totals.enqueued.toLocaleString('en-US')} (deferred=${totals.changedDeferred.toLocaleString('en-US')}) · scraped backCatalog=${totals.backCatalogScraped.toLocaleString('en-US')} recent=${totals.recentScraped.toLocaleString('en-US')} · noStats=${totals.noStats.toLocaleString('en-US')} failed=${totals.failed.toLocaleString('en-US')} retiredDuringDrain=${totals.scrapeErrorSkipped.toLocaleString('en-US')}`,
      );
      console.log(
        `   books: ${totals.booksInserted.toLocaleString('en-US')} new / ${totals.booksEnriched.toLocaleString('en-US')} enriched`,
      );
    }
    console.log(`   temp files deleted: ${totals.tempDeleted}`);
    console.log(
      `   authors rows: ${totals.authorsBefore.toLocaleString('en-US')} -> ${totals.authorsAfter.toLocaleString('en-US')}${totals.authorsBefore === totals.authorsAfter ? ' (unchanged)' : ' (CHANGED)'}`,
    );
  };

  try {
    console.log(chalk.cyan.bold(drainOnly ? '\nAuthor sitemap monitor (queue drain)' : dryRun ? '\nAuthor sitemap monitor (dry run)' : '\nAuthor sitemap monitor (apply)'));

    if (drainOnly) {
      authorsBefore = countAuthors();
      const drain = await drainCandidates({
        limit: budget === Number.POSITIVE_INFINITY ? 0 : budget,
        only,
        multiPage,
        withCookie,
        scrape,
        delayMin: authorDelayMin,
        delayMax: authorDelayMax,
        nowIso: nowIso(),
      });
      totals.backCatalogScraped = drain.backCatalogScraped;
      totals.recentScraped = drain.recentScraped;
      totals.noStats = drain.noStats;
      totals.failed = drain.failed;
      totals.scrapeErrorSkipped = drain.errorSkipped;
      totals.booksInserted = drain.booksInserted;
      totals.booksEnriched = drain.booksEnriched;
      totals.authorsBefore = authorsBefore;
      totals.authorsAfter = countAuthors();

      logger.write({
        runId,
        event: 'drain',
        ...drain,
        pendingRemaining: countSitemapCandidates(),
      });
      printAggregate();
      return;
    }

    console.log(
      chalk.gray(`   run=${runId} index=${indexUrl} files=${files} start=${options.start ?? 'next-unprocessed'} dryRun=${dryRun} enqueueOnly=${enqueueOnly} authors=${authorsOption === 0 ? 'unlimited' : authorsOption} minAge=${minAgeDays}d`),
    );

    let indexResponse: SitemapHttpResponse;
    try {
      indexResponse = await fetch(indexUrl, 'author sitemap index');
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

    let shards: SitemapShard[];
    try {
      shards = parseAuthorSitemapIndex(indexResponse.data.toString('utf8'));
    } catch (error) {
      if (error instanceof AuthorSitemapIndexError) {
        logger.write({ runId, event: 'error', stage: 'index-validate', url: error.url, message: error.message });
        console.error(chalk.red.bold(`Refusing to continue: ${error.message}`));
        process.exitCode = 1;
        return;
      }
      throw error;
    }

    if (shards.length === 0) {
      logger.write({ runId, event: 'error', stage: 'index', url: indexUrl, message: 'index contained no shards' });
      console.error(chalk.red.bold('Refusing to continue: the author sitemap index contained no shards.'));
      process.exitCode = 1;
      return;
    }

    const start = options.start !== undefined
      ? parsePositiveInt(options.start, 178, '--start')
      : nextSitemapStart(shards, listDoneShardIds()) ?? 178;
    const selected = selectSitemapShards(shards, start, files);
    if (selected.length === 0) {
      logger.write({ runId, event: 'error', stage: 'select', start, files, message: 'no shards at or after --start' });
      console.error(chalk.red.bold(`Refusing to continue: no shards at or after --start ${start}.`));
      process.exitCode = 1;
      return;
    }
    if (selected.length < files) {
      console.log(chalk.yellow(`Only ${selected.length} shard(s) available at or after ${start} (requested ${files}).`));
    }

    authorsBefore = countAuthors();

    for (let i = 0; i < selected.length; i++) {
      const shard = selected[i];
      if (i > 0) await delay(1000, 2000);

      const prior = getSitemapFile(shard.shardId);
      const conditionalSkip = prior?.status === 'done' && !force;
      const headers: Record<string, string> = {};
      if (conditionalSkip) {
        if (prior?.etag) headers['If-None-Match'] = prior.etag;
        if (prior?.lastModified) headers['If-Modified-Since'] = prior.lastModified;
      }

      let tempPath: string | undefined;
      let drained = emptyDrain();
      try {
        const response = await fetch(shard.url, `sitemap.${shard.shardId}`, conditionalSkip ? { headers } : undefined);

        if (response.status === 304 && conditionalSkip) {
          skippedShards++;
          markSitemapFileSkipped(shard.shardId, nowIso(), 'done');
          logger.write({
            runId,
            event: 'skip',
            shard: shard.shardId,
            url: shard.url,
            reason: 'http-304',
            httpStatus: 304,
            durationMs: response.durationMs,
          });
          console.log(chalk.gray(`[${i + 1}/${selected.length}] sitemap.${shard.shardId}.xml.gz unchanged (304)`));
          continue;
        }

        const compressed = response.data;
        const sha256 = createHash('sha256').update(compressed).digest('hex');

        if (
          conditionalSkip &&
          prior?.sha256 === sha256 &&
          prior.bytesCompressed === compressed.length
        ) {
          skippedShards++;
          markSitemapFileSkipped(shard.shardId, nowIso(), 'done');
          logger.write({
            runId,
            event: 'skip',
            shard: shard.shardId,
            url: shard.url,
            reason: 'hash-size',
            httpStatus: response.status,
            sha256,
            bytes: compressed.length,
            durationMs: response.durationMs,
          });
          console.log(chalk.gray(`[${i + 1}/${selected.length}] sitemap.${shard.shardId}.xml.gz unchanged (hash)`));
          continue;
        }

        tempPath = path.join(tempDir, `sitemap.${shard.shardId}.xml.gz`);
        fs.writeFileSync(tempPath, compressed);

        logger.write({
          runId,
          event: 'download',
          shard: shard.shardId,
          url: shard.url,
          finalUrl: response.url,
          httpStatus: response.status,
          bytes: compressed.length,
          durationMs: response.durationMs,
          contentType: response.contentType ?? null,
          contentLength: response.contentLength ?? null,
          etag: response.etag ?? null,
          lastModified: response.lastModified ?? null,
          sha256,
          tempPath,
        });

        const uncompressed = isGzip(compressed) ? gunzipSync(compressed) : compressed;
        const parsed = parseAuthorSitemapShard(uncompressed.toString('utf8'));
        const rows = loadAuthorRows(parsed.entries.map((entry) => entry.id));
        const retired = loadRetiredIds();
        const { entries: classified, summary } = classifySitemapEntries(parsed.entries, rows, retired);
        const plan = planSitemapCandidates(classified, rows, { minAgeDays, nowMs: now() });

        processed++;
        totals.bytesCompressed += compressed.length;
        totals.bytesUncompressed += uncompressed.length;
        totals.downloadMs += response.durationMs;
        totals.urlCount += parsed.urlCount;
        totals.uniqueIds += parsed.entries.length;
        totals.unparseable += parsed.unparseable;
        totals.missingLastmod += parsed.missingLastmod;
        totals.duplicates += parsed.duplicateIds;
        totals.new += summary.new;
        totals.changed += summary.changed;
        totals.changedDeferred += plan.changedDeferred;
        totals.unchanged += summary.unchanged;
        totals.unknown += summary.unknown;
        totals.errorSkipped += summary.errorSkipped;
        totals.skippedRecent += plan.skippedRecent;
        totals.skippedUnchanged += plan.skippedUnchanged;
        lastmodMin = earlierLastmod(lastmodMin, parsed.lastmodMin);
        lastmodMax = laterLastmod(lastmodMax, parsed.lastmodMax);

        const previewRecord = {
          runId,
          event: 'preview',
          shard: shard.shardId,
          entries: parsed.urlCount,
          uniqueIds: parsed.entries.length,
          duplicates: parsed.duplicateIds,
          unparseable: parsed.unparseable,
          missingLastmod: parsed.missingLastmod,
          bytesUncompressed: uncompressed.length,
          lastmodMin: parsed.lastmodMin ?? null,
          lastmodMax: parsed.lastmodMax ?? null,
          ...summary,
          skippedRecent: plan.skippedRecent,
          skippedUnchanged: plan.skippedUnchanged,
          changedDeferred: plan.changedDeferred,
        };

        console.log(chalk.cyan.bold(`\n[${i + 1}/${selected.length}] sitemap.${shard.shardId}.xml.gz`));
        console.log(
          `   download [${httpStatusWord(response.status)}] http=${response.status} size=${fmtBytes(compressed.length)} -> ${fmtBytes(uncompressed.length)} dur=${(response.durationMs / 1000).toFixed(3)}s`,
        );
        console.log(
          `   preview entries=${parsed.urlCount.toLocaleString('en-US')} unique=${parsed.entries.length.toLocaleString('en-US')} duplicates=${parsed.duplicateIds.toLocaleString('en-US')} unparseable=${parsed.unparseable.toLocaleString('en-US')}`,
        );
        console.log(`   lastmod=${parsed.lastmodMin ?? '-'}..${parsed.lastmodMax ?? '-'}`);
        console.log(
          `   new=${summary.new.toLocaleString('en-US')} cached=${summary.cached.toLocaleString('en-US')} changed=${summary.changed.toLocaleString('en-US')} unchanged=${summary.unchanged.toLocaleString('en-US')} unknown=${summary.unknown.toLocaleString('en-US')} errorSkipped=${summary.errorSkipped.toLocaleString('en-US')}`,
        );
        console.log(
          chalk.gray(
            `   skipped unchanged=${plan.skippedUnchanged.toLocaleString('en-US')} recent<${minAgeDays}d=${plan.skippedRecent.toLocaleString('en-US')} error=${plan.errorSkipped.toLocaleString('en-US')} · enqueue pending=${(plan.new + plan.changed - plan.changedDeferred).toLocaleString('en-US')} deferred=${plan.changedDeferred.toLocaleString('en-US')}`,
          ),
        );
        logger.write(previewRecord);

        const previewAt = nowIso();
        upsertSitemapFile({
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
          newIds: summary.new,
          changedIds: summary.changed,
          unchangedIds: summary.unchanged,
          unknownIds: summary.unknown,
          errorSkippedIds: summary.errorSkipped,
          skippedRecent: plan.skippedRecent,
          skippedUnchanged: plan.skippedUnchanged,
          previewAt,
          fetchedAt: previewAt,
          parsedAt: previewAt,
          status: 'parsed',
        });

        if (!dryRun) {
          const enqueued = enqueueCandidates(shard.shardId, plan, classified, previewAt);
          totals.enqueued += enqueued;
        }

        deleteTemp(tempPath, shard.shardId);
        tempPath = undefined;

        if (!dryRun && !enqueueOnly && budget !== 0) {
          drained = await drainCandidates({
            limit: budget === Number.POSITIVE_INFINITY ? 0 : budget,
            shardId: shard.shardId,
            only,
            multiPage,
            withCookie,
            scrape,
            delayMin: authorDelayMin,
            delayMax: authorDelayMax,
            nowIso: nowIso(),
          });
          totals.backCatalogScraped += drained.backCatalogScraped;
          totals.recentScraped += drained.recentScraped;
          totals.noStats += drained.noStats;
          totals.failed += drained.failed;
          totals.scrapeErrorSkipped += drained.errorSkipped;
          totals.booksInserted += drained.booksInserted;
          totals.booksEnriched += drained.booksEnriched;
          budget = budget === Number.POSITIVE_INFINITY ? budget : Math.max(0, budget - drained.attempts);

          if (drained.stoppedForConnectivity) {
            logger.write({ runId, event: 'error', shard: shard.shardId, message: 'connectivity lost during drain' });
          }
        }

        const pendingRemaining = countSitemapCandidatesForShard(shard.shardId);
        const processedAt = nowIso();
        if (!dryRun) {
          upsertSitemapFile({
            shardId: shard.shardId,
            url: shard.url,
            backCatalogScraped: drained.backCatalogScraped,
            recentScraped: drained.recentScraped,
            failedIds: drained.failed,
            processedAt,
            status: drained.stoppedForConnectivity ? 'parsed' : 'done',
          });
        }

        logger.write({
          runId,
          event: 'file-done',
          shard: shard.shardId,
          enqueued: dryRun ? 0 : plan.enqueue.length,
          backCatalogScraped: drained.backCatalogScraped,
          recentScraped: drained.recentScraped,
          noStats: drained.noStats,
          failed: drained.failed,
          scrapeErrorSkipped: drained.errorSkipped,
          pendingRemaining,
          booksInserted: drained.booksInserted,
          booksEnriched: drained.booksEnriched,
        });

        const skippedTotal = plan.skippedUnchanged + plan.skippedRecent + plan.errorSkipped;
        console.log(
          chalk.cyan.bold(
            `🏁 sitemap.${shard.shardId}.xml.gz ${dryRun ? 'previewed' : enqueueOnly ? 'enqueued' : 'done'}`,
          ),
        );
        console.log(
          `   skipped=${skippedTotal.toLocaleString('en-US')} (unchanged=${plan.skippedUnchanged.toLocaleString('en-US')}, recent<${minAgeDays}d=${plan.skippedRecent.toLocaleString('en-US')}, error=${plan.errorSkipped.toLocaleString('en-US')})`,
        );
        if (!dryRun) {
          console.log(
            `   enqueued=${plan.enqueue.length.toLocaleString('en-US')} · recentScraped=${drained.recentScraped.toLocaleString('en-US')} backCatalogScraped=${drained.backCatalogScraped.toLocaleString('en-US')}`,
          );
          console.log(
            `   noStats=${drained.noStats.toLocaleString('en-US')} failed=${drained.failed.toLocaleString('en-US')} pendingRemaining=${pendingRemaining.toLocaleString('en-US')}`,
          );
          if (drained.booksInserted || drained.booksEnriched) {
            console.log(
              chalk.gray(`   books: ${drained.booksInserted.toLocaleString('en-US')} new / ${drained.booksEnriched.toLocaleString('en-US')} enriched`),
            );
          }
        }

        if (drained.stoppedForConnectivity) {
          console.error(chalk.red.bold('   Progress saved; re-run when your connection is back.'));
          totals.authorsBefore = authorsBefore;
          totals.authorsAfter = countAuthors();
          printAggregate();
          return;
        }
      } catch (error) {
        deleteTemp(tempPath, shard.shardId);
        tempPath = undefined;
        if (isConnectivityError(error)) throw error;
        failedShards++;
        const message = errorMessage(error);
        logger.write({ runId, event: 'error', shard: shard.shardId, url: shard.url, message });
        console.error(chalk.red(`sitemap.${shard.shardId}.xml.gz failed: ${message}`));
        if (!dryRun) markSitemapFileError(shard.shardId, message);
      } finally {
        deleteTemp(tempPath, shard.shardId);
      }
    }

    totals.authorsBefore = authorsBefore;
    totals.authorsAfter = countAuthors();

    logger.write({
      runId,
      event: 'summary',
      ...totals,
      lastmodMin: lastmodMin ?? null,
      lastmodMax: lastmodMax ?? null,
      processed,
      skippedShards,
      failedShards,
    });

    printAggregate();

    if (processed === 0 && skippedShards === 0) process.exitCode = 1;
  } finally {
    try {
      fs.rmdirSync(tempDir);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        console.log(chalk.yellow(`warning: temp directory not removed (not empty): ${tempDir}`));
      }
    }
  }
}
