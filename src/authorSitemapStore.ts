import { getDb } from './db.ts';
import type { CandidateReason, CandidateScrapeKind, CandidateStatus } from './authorSitemap.ts';

export type SitemapFileStatus = 'pending' | 'downloaded' | 'parsed' | 'done' | 'skipped' | 'error';

export interface SitemapFileRow {
  shardId: number;
  url: string;
  indexLastmod?: string;
  etag?: string;
  lastModified?: string;
  sha256?: string;
  bytesCompressed?: number;
  bytesUncompressed?: number;
  httpStatus?: number;
  durationMs?: number;
  entries?: number;
  lastmodMin?: string;
  lastmodMax?: string;
  newIds?: number;
  changedIds?: number;
  unchangedIds?: number;
  unknownIds?: number;
  errorSkippedIds?: number;
  backCatalogScraped?: number;
  recentScraped?: number;
  skippedRecent?: number;
  skippedUnchanged?: number;
  failedIds?: number;
  previewAt?: string;
  fetchedAt?: string;
  parsedAt?: string;
  processedAt?: string;
  status: SitemapFileStatus;
  error?: string;
}

export interface SitemapCandidateRow {
  authorId: string;
  shardId: number;
  slug?: string;
  sitemapLastmod?: string;
  reason: CandidateReason;
  scrapeKind: CandidateScrapeKind;
  status: CandidateStatus;
  notBefore?: string;
  attempts: number;
  firstSeen: string;
  lastAttempt?: string;
  lastError?: string;
}

const toFileRow = (row: any): SitemapFileRow => ({
  shardId: row.shard_id,
  url: row.url,
  indexLastmod: row.index_lastmod ?? undefined,
  etag: row.etag ?? undefined,
  lastModified: row.last_modified ?? undefined,
  sha256: row.sha256 ?? undefined,
  bytesCompressed: row.bytes_compressed ?? undefined,
  bytesUncompressed: row.bytes_uncompressed ?? undefined,
  httpStatus: row.http_status ?? undefined,
  durationMs: row.duration_ms ?? undefined,
  entries: row.entries ?? undefined,
  lastmodMin: row.lastmod_min ?? undefined,
  lastmodMax: row.lastmod_max ?? undefined,
  newIds: row.new_ids ?? undefined,
  changedIds: row.changed_ids ?? undefined,
  unchangedIds: row.unchanged_ids ?? undefined,
  unknownIds: row.unknown_ids ?? undefined,
  errorSkippedIds: row.error_skipped_ids ?? undefined,
  backCatalogScraped: row.back_catalog_scraped ?? undefined,
  recentScraped: row.recent_scraped ?? undefined,
  skippedRecent: row.skipped_recent ?? undefined,
  skippedUnchanged: row.skipped_unchanged ?? undefined,
  failedIds: row.failed_ids ?? undefined,
  previewAt: row.preview_at ?? undefined,
  fetchedAt: row.fetched_at ?? undefined,
  parsedAt: row.parsed_at ?? undefined,
  processedAt: row.processed_at ?? undefined,
  status: row.status,
  error: row.error ?? undefined,
});

const toCandidateRow = (row: any): SitemapCandidateRow => ({
  authorId: row.author_id,
  shardId: row.shard_id,
  slug: row.slug ?? undefined,
  sitemapLastmod: row.sitemap_lastmod ?? undefined,
  reason: row.reason,
  scrapeKind: row.scrape_kind,
  status: row.status,
  notBefore: row.not_before ?? undefined,
  attempts: row.attempts,
  firstSeen: row.first_seen,
  lastAttempt: row.last_attempt ?? undefined,
  lastError: row.last_error ?? undefined,
});

export function getSitemapFile(shardId: number): SitemapFileRow | undefined {
  const row = getDb().prepare('SELECT * FROM author_sitemap_files WHERE shard_id = ?').get(shardId);
  return row ? toFileRow(row) : undefined;
}

export function listDoneShardIds(): Set<number> {
  const rows = getDb().prepare("SELECT shard_id FROM author_sitemap_files WHERE status = 'done'").all() as { shard_id: number }[];
  return new Set(rows.map((row) => row.shard_id));
}

export function upsertSitemapFile(input: SitemapFileRow): void {
  const row = {
    shardId: input.shardId,
    url: input.url,
    indexLastmod: input.indexLastmod ?? null,
    etag: input.etag ?? null,
    lastModified: input.lastModified ?? null,
    sha256: input.sha256 ?? null,
    bytesCompressed: input.bytesCompressed ?? null,
    bytesUncompressed: input.bytesUncompressed ?? null,
    httpStatus: input.httpStatus ?? null,
    durationMs: input.durationMs ?? null,
    entries: input.entries ?? null,
    lastmodMin: input.lastmodMin ?? null,
    lastmodMax: input.lastmodMax ?? null,
    newIds: input.newIds ?? null,
    changedIds: input.changedIds ?? null,
    unchangedIds: input.unchangedIds ?? null,
    unknownIds: input.unknownIds ?? null,
    errorSkippedIds: input.errorSkippedIds ?? null,
    backCatalogScraped: input.backCatalogScraped ?? null,
    recentScraped: input.recentScraped ?? null,
    skippedRecent: input.skippedRecent ?? null,
    skippedUnchanged: input.skippedUnchanged ?? null,
    failedIds: input.failedIds ?? null,
    previewAt: input.previewAt ?? null,
    fetchedAt: input.fetchedAt ?? null,
    parsedAt: input.parsedAt ?? null,
    processedAt: input.processedAt ?? null,
    status: input.status,
    error: input.error ?? null,
  };

  getDb()
    .prepare(`
      INSERT INTO author_sitemap_files (
        shard_id, url, index_lastmod, etag, last_modified, sha256,
        bytes_compressed, bytes_uncompressed, http_status, duration_ms, entries,
        lastmod_min, lastmod_max, new_ids, changed_ids, unchanged_ids, unknown_ids,
        error_skipped_ids, back_catalog_scraped, recent_scraped, skipped_recent,
        skipped_unchanged, failed_ids, preview_at, fetched_at, parsed_at,
        processed_at, status, error
      ) VALUES (
        @shardId, @url, @indexLastmod, @etag, @lastModified, @sha256,
        @bytesCompressed, @bytesUncompressed, @httpStatus, @durationMs, @entries,
        @lastmodMin, @lastmodMax, @newIds, @changedIds, @unchangedIds, @unknownIds,
        @errorSkippedIds, @backCatalogScraped, @recentScraped, @skippedRecent,
        @skippedUnchanged, @failedIds, @previewAt, @fetchedAt, @parsedAt,
        @processedAt, @status, @error
      )
      ON CONFLICT(shard_id) DO UPDATE SET
        url=excluded.url,
        index_lastmod=COALESCE(excluded.index_lastmod, index_lastmod),
        etag=COALESCE(excluded.etag, etag),
        last_modified=COALESCE(excluded.last_modified, last_modified),
        sha256=COALESCE(excluded.sha256, sha256),
        bytes_compressed=COALESCE(excluded.bytes_compressed, bytes_compressed),
        bytes_uncompressed=COALESCE(excluded.bytes_uncompressed, bytes_uncompressed),
        http_status=COALESCE(excluded.http_status, http_status),
        duration_ms=COALESCE(excluded.duration_ms, duration_ms),
        entries=COALESCE(excluded.entries, entries),
        lastmod_min=COALESCE(excluded.lastmod_min, lastmod_min),
        lastmod_max=COALESCE(excluded.lastmod_max, lastmod_max),
        new_ids=COALESCE(excluded.new_ids, new_ids),
        changed_ids=COALESCE(excluded.changed_ids, changed_ids),
        unchanged_ids=COALESCE(excluded.unchanged_ids, unchanged_ids),
        unknown_ids=COALESCE(excluded.unknown_ids, unknown_ids),
        error_skipped_ids=COALESCE(excluded.error_skipped_ids, error_skipped_ids),
        back_catalog_scraped=COALESCE(excluded.back_catalog_scraped, back_catalog_scraped),
        recent_scraped=COALESCE(excluded.recent_scraped, recent_scraped),
        skipped_recent=COALESCE(excluded.skipped_recent, skipped_recent),
        skipped_unchanged=COALESCE(excluded.skipped_unchanged, skipped_unchanged),
        failed_ids=COALESCE(excluded.failed_ids, failed_ids),
        preview_at=COALESCE(excluded.preview_at, preview_at),
        fetched_at=COALESCE(excluded.fetched_at, fetched_at),
        parsed_at=COALESCE(excluded.parsed_at, parsed_at),
        processed_at=COALESCE(excluded.processed_at, processed_at),
        status=excluded.status,
        error=excluded.error
    `)
    .run(row);
}

export function markSitemapFileSkipped(shardId: number, fetchedAt: string, status: SitemapFileStatus = 'done'): void {
  getDb()
    .prepare("UPDATE author_sitemap_files SET fetched_at = ?, status = ? WHERE shard_id = ?")
    .run(fetchedAt, status, shardId);
}

export function markSitemapFileError(shardId: number, message: string): void {
  getDb()
    .prepare("UPDATE author_sitemap_files SET status = 'error', error = ?, processed_at = ? WHERE shard_id = ?")
    .run(message.slice(0, 500), new Date().toISOString(), shardId);
}

export function upsertSitemapCandidate(input: SitemapCandidateRow): void {
  getDb()
    .prepare(`
      INSERT INTO author_sitemap_candidates (
        author_id, shard_id, slug, sitemap_lastmod, reason, scrape_kind,
        status, not_before, attempts, first_seen, last_attempt, last_error
      ) VALUES (
        @authorId, @shardId, @slug, @sitemapLastmod, @reason, @scrapeKind,
        @status, @notBefore, @attempts, @firstSeen, @lastAttempt, @lastError
      )
      ON CONFLICT(author_id) DO UPDATE SET
        shard_id=excluded.shard_id,
        slug=COALESCE(excluded.slug, slug),
        sitemap_lastmod=CASE
          WHEN excluded.sitemap_lastmod IS NULL THEN sitemap_lastmod
          WHEN sitemap_lastmod IS NULL OR excluded.sitemap_lastmod > sitemap_lastmod THEN excluded.sitemap_lastmod
          ELSE sitemap_lastmod
        END,
        reason=CASE WHEN excluded.reason = 'new' OR reason = 'new' THEN 'new' ELSE 'changed' END,
        scrape_kind=CASE
          WHEN excluded.scrape_kind = 'back_catalog' OR scrape_kind = 'back_catalog' THEN 'back_catalog'
          ELSE 'recent'
        END,
        status=excluded.status,
        not_before=excluded.not_before,
        last_attempt=COALESCE(last_attempt, excluded.last_attempt),
        last_error=COALESCE(last_error, excluded.last_error)
    `)
    .run({
      authorId: input.authorId,
      shardId: input.shardId,
      slug: input.slug ?? null,
      sitemapLastmod: input.sitemapLastmod ?? null,
      reason: input.reason,
      scrapeKind: input.scrapeKind,
      status: input.status,
      notBefore: input.notBefore ?? null,
      attempts: input.attempts,
      firstSeen: input.firstSeen,
      lastAttempt: input.lastAttempt ?? null,
      lastError: input.lastError ?? null,
    });
}

export function deleteSitemapCandidate(authorId: string): void {
  getDb().prepare('DELETE FROM author_sitemap_candidates WHERE author_id = ?').run(authorId);
}

export function incrementSitemapCandidateAttempt(authorId: string, error: string): void {
  getDb()
    .prepare(`
      UPDATE author_sitemap_candidates
      SET attempts = attempts + 1, last_attempt = ?, last_error = ?
      WHERE author_id = ?
    `)
    .run(new Date().toISOString(), error.slice(0, 500), authorId);
}

export function listReadySitemapCandidates(options: {
  limit: number;
  shardId?: number;
  only?: CandidateReason;
  now?: string;
}): SitemapCandidateRow[] {
  const where = [
    "(status = 'pending' OR (status = 'deferred' AND not_before IS NOT NULL AND not_before <= @now))",
  ];
  const params: Record<string, unknown> = { now: options.now ?? new Date().toISOString() };
  if (options.shardId !== undefined) {
    where.push('shard_id = @shardId');
    params.shardId = options.shardId;
  }
  if (options.only) {
    where.push('reason = @only');
    params.only = options.only;
  }
  const limitSql = options.limit > 0 ? 'LIMIT @limit' : '';
  if (options.limit > 0) params.limit = options.limit;

  const rows = getDb()
    .prepare(`
      SELECT * FROM author_sitemap_candidates
      WHERE ${where.join(' AND ')}
      ORDER BY sitemap_lastmod DESC, shard_id, author_id
      ${limitSql}
    `)
    .all(params) as any[];
  return rows.map(toCandidateRow);
}

export function countSitemapCandidatesForShard(shardId: number): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM author_sitemap_candidates WHERE shard_id = ?')
    .get(shardId) as { n: number };
  return row.n;
}

export function countSitemapCandidates(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM author_sitemap_candidates').get() as { n: number };
  return row.n;
}
