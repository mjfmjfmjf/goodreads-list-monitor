import { getDb } from './db.ts';

export type ListSitemapFileStatus = 'pending' | 'in_progress' | 'done' | 'error';

export interface ListSitemapFileRow {
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
  cursorListId?: string;
  cursorIndex?: number;
  processedEntries: number;
  newIds: number;
  staleIds: number;
  recentIds: number;
  unchangedIds: number;
  unknownIds: number;
  scraped: number;
  failed: number;
  goneIds: number;
  cappedIds: number;
  passStartedAt?: string;
  passCompletedAt?: string;
  fetchedAt?: string;
  parsedAt?: string;
  status: ListSitemapFileStatus;
  error?: string;
}

const toFileRow = (row: any): ListSitemapFileRow => ({
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
  cursorListId: row.cursor_list_id ?? undefined,
  cursorIndex: row.cursor_index ?? undefined,
  processedEntries: row.processed_entries ?? 0,
  newIds: row.new_ids ?? 0,
  staleIds: row.stale_ids ?? 0,
  recentIds: row.recent_ids ?? 0,
  unchangedIds: row.unchanged_ids ?? 0,
  unknownIds: row.unknown_ids ?? 0,
  scraped: row.scraped ?? 0,
  failed: row.failed ?? 0,
  goneIds: row.gone_ids ?? 0,
  cappedIds: row.capped_ids ?? 0,
  passStartedAt: row.pass_started_at ?? undefined,
  passCompletedAt: row.pass_completed_at ?? undefined,
  fetchedAt: row.fetched_at ?? undefined,
  parsedAt: row.parsed_at ?? undefined,
  status: row.status,
  error: row.error ?? undefined,
});

export function getListSitemapFile(shardId: number): ListSitemapFileRow | undefined {
  const row = getDb().prepare('SELECT * FROM list_sitemap_files WHERE shard_id = ?').get(shardId);
  return row ? toFileRow(row) : undefined;
}

export interface ListSitemapPassInput {
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
  fetchedAt: string;
  parsedAt: string;
  passStartedAt: string;
}

const passParams = (input: ListSitemapPassInput) => ({
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
  fetchedAt: input.fetchedAt,
  parsedAt: input.parsedAt,
  passStartedAt: input.passStartedAt,
});

export function beginListSitemapPass(input: ListSitemapPassInput): void {
  getDb()
    .prepare(`
      INSERT INTO list_sitemap_files (
        shard_id, url, index_lastmod, etag, last_modified, sha256,
        bytes_compressed, bytes_uncompressed, http_status, duration_ms, entries,
        lastmod_min, lastmod_max, cursor_list_id, cursor_index, processed_entries,
        new_ids, stale_ids, recent_ids, unchanged_ids, unknown_ids, scraped,
        failed, gone_ids, capped_ids, pass_started_at, pass_completed_at,
        fetched_at, parsed_at, status, error
      ) VALUES (
        @shardId, @url, @indexLastmod, @etag, @lastModified, @sha256,
        @bytesCompressed, @bytesUncompressed, @httpStatus, @durationMs, @entries,
        @lastmodMin, @lastmodMax, NULL, NULL, 0,
        0, 0, 0, 0, 0, 0,
        0, 0, 0, @passStartedAt, NULL,
        @fetchedAt, @parsedAt, 'in_progress', NULL
      )
      ON CONFLICT(shard_id) DO UPDATE SET
        url=excluded.url,
        index_lastmod=excluded.index_lastmod,
        etag=excluded.etag,
        last_modified=excluded.last_modified,
        sha256=excluded.sha256,
        bytes_compressed=excluded.bytes_compressed,
        bytes_uncompressed=excluded.bytes_uncompressed,
        http_status=excluded.http_status,
        duration_ms=excluded.duration_ms,
        entries=excluded.entries,
        lastmod_min=excluded.lastmod_min,
        lastmod_max=excluded.lastmod_max,
        cursor_list_id=NULL,
        cursor_index=NULL,
        processed_entries=0,
        new_ids=0,
        stale_ids=0,
        recent_ids=0,
        unchanged_ids=0,
        unknown_ids=0,
        scraped=0,
        failed=0,
        gone_ids=0,
        capped_ids=0,
        pass_started_at=excluded.pass_started_at,
        pass_completed_at=NULL,
        fetched_at=excluded.fetched_at,
        parsed_at=excluded.parsed_at,
        status='in_progress',
        error=NULL
    `)
    .run(passParams(input));
}

export function resumeListSitemapPass(input: ListSitemapPassInput): void {
  getDb()
    .prepare(`
      UPDATE list_sitemap_files SET
        url=@url,
        index_lastmod=@indexLastmod,
        etag=@etag,
        last_modified=@lastModified,
        sha256=@sha256,
        bytes_compressed=@bytesCompressed,
        bytes_uncompressed=@bytesUncompressed,
        http_status=@httpStatus,
        duration_ms=@durationMs,
        entries=@entries,
        lastmod_min=@lastmodMin,
        lastmod_max=@lastmodMax,
        fetched_at=@fetchedAt,
        parsed_at=@parsedAt,
        status='in_progress',
        error=NULL
      WHERE shard_id=@shardId
    `)
    .run(passParams(input));
}

export interface ListSitemapCursorInput {
  shardId: number;
  cursorListId: string | null;
  cursorIndex: number | null;
  processedEntries: number;
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

export function advanceListSitemapCursor(input: ListSitemapCursorInput): void {
  getDb()
    .prepare(`
      UPDATE list_sitemap_files SET
        cursor_list_id=@cursorListId,
        cursor_index=@cursorIndex,
        processed_entries=@processedEntries,
        new_ids=@newIds,
        stale_ids=@staleIds,
        recent_ids=@recentIds,
        unchanged_ids=@unchangedIds,
        unknown_ids=@unknownIds,
        scraped=@scraped,
        failed=@failed,
        gone_ids=@goneIds,
        capped_ids=@cappedIds
      WHERE shard_id=@shardId
    `)
    .run(input);
}

export function completeListSitemapPass(shardId: number, completedAt: string): void {
  getDb()
    .prepare("UPDATE list_sitemap_files SET status='done', pass_completed_at=?, error=NULL WHERE shard_id=?")
    .run(completedAt, shardId);
}

export function markListSitemapFileError(shardId: number, message: string): void {
  getDb()
    .prepare("UPDATE list_sitemap_files SET status='error', error=?, pass_completed_at=? WHERE shard_id=?")
    .run(message.slice(0, 500), new Date().toISOString(), shardId);
}
