import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-authorsitemapmon-test-${process.pid}-${Date.now()}.db`;
});

import { closeDb, getDb } from './db.ts';
import { AUTHOR_FAIL_LIMIT, countAuthors, getAuthorById, recordAuthorScrapeFailure, upsertAuthorById } from './storage.ts';
import {
  countSitemapCandidates,
  getSitemapFile,
  listReadySitemapCandidates,
  upsertSitemapCandidate,
} from './authorSitemapStore.ts';
import { runAuthorSitemapMonitor, type SitemapHttpResponse } from './authorSitemapMonitor.ts';
import type { AuthorStatsResult } from './scraper.ts';

const INDEX_URL = 'https://www.goodreads.com/siteindex.author.xml';
const shardUrl = (id: number): string => `https://www.goodreads.com/sitemap.${id}.xml.gz`;
const NOW = Date.parse('2026-11-06T00:00:00.000Z');
const now = (): number => NOW;

const indexXml = (locs: string[]): string => `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map((loc) => `<sitemap><loc>${loc}</loc><lastmod>2026-10-31</lastmod></sitemap>`).join('\n')}
</sitemapindex>
`;

const shardXml = (entries: { id: string; lastmod?: string }[]): string => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map((entry) => `<url><loc>https://www.goodreads.com/author/show/${entry.id}.Author_${entry.id}</loc>${entry.lastmod ? `<lastmod>${entry.lastmod}</lastmod>` : ''}</url>`).join('\n')}
</urlset>
`;

interface ResponseOptions {
  status?: number;
  etag?: string;
  lastModified?: string;
}

const response = (
  url: string,
  data: Buffer,
  contentType: string,
  options: ResponseOptions = {},
): SitemapHttpResponse => ({
  url,
  status: options.status ?? 200,
  data,
  contentType,
  contentLength: null,
  etag: options.etag ?? null,
  lastModified: options.lastModified ?? null,
  durationMs: 1,
});

const fakeStats = (id: string): AuthorStatsResult => ({
  stats: {
    name: `Author ${id}`,
    slug: `${id}.Author`,
    numRatings: '10',
    numReviews: '2',
    numShelves: '3',
    averageRating: '4.0',
  },
  booksInserted: 1,
  booksEnriched: 0,
  catalogPages: 1,
});

interface ScrapeCall {
  id: string;
  crawlAllPages: boolean;
  sort?: string;
}

const makeScrape = (result: 'stats' | 'none' = 'stats') => {
  const calls: ScrapeCall[] = [];
  const scrape = async (id: string, _onError?: (reason: string) => void, crawlAllPages = false, sort?: string) => {
    calls.push({ id, crawlAllPages, sort });
    return result === 'stats' ? fakeStats(id) : undefined;
  };
  return { calls, scrape: scrape as any };
};

let tempRoot: string;
let downloadRoot: string;
let logPath: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-sitemap-monitor-test-'));
  downloadRoot = path.join(tempRoot, 'downloads');
  fs.mkdirSync(downloadRoot);
  logPath = path.join(tempRoot, 'authorSitemapMonitor.log');
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = 0;

  const db = getDb();
  db.exec('DELETE FROM authors');
  db.exec('DELETE FROM author_scrape_failures');
  db.exec('DELETE FROM author_sitemap_files');
  db.exec('DELETE FROM author_sitemap_candidates');
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  process.exitCode = 0;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

afterAll(() => {
  closeDb();
  delete process.env.GOODREADS_DB_PATH;
});

const readLog = (): any[] =>
  fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const fetchShard = (
  shardId: number,
  entries: { id: string; lastmod?: string }[],
  options: ResponseOptions = {},
  bodyOverride?: Buffer,
) => {
  const body = bodyOverride ?? gzipSync(Buffer.from(shardXml(entries)));
  const calls: { url: string; headers?: Record<string, string> }[] = [];
  const fetch = async (url: string, _label: string, opts?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: opts?.headers });
    if (url === INDEX_URL) {
      return response(url, Buffer.from(indexXml([shardUrl(shardId)])), 'application/xml');
    }
    if (url === shardUrl(shardId)) return response(url, body, 'application/x-gzip', options);
    throw new Error(`unexpected url ${url}`);
  };
  return { calls, fetch: fetch as any, body };
};

describe('runAuthorSitemapMonitor --dryRun', () => {
  it('defaults to 2 files, reports counts, and writes no author rows', async () => {
    upsertAuthorById('2', { id: '2', slug: '2.Two', lastSeen: '2020-01-01T00:00:00.000Z' });
    upsertAuthorById('3', { id: '3', slug: '3.Three', lastSeen: '2030-01-01T00:00:00.000Z' });
    const authorsBefore = countAuthors();

    const shard178 = gzipSync(
      Buffer.from(
        shardXml([
          { id: '1', lastmod: '2026-10-30T00:00:00-07:00' },
          { id: '2', lastmod: '2026-10-30T00:00:00-07:00' },
          { id: '3', lastmod: '2026-10-30T00:00:00-07:00' },
        ]),
      ),
    );
    const shard179 = gzipSync(Buffer.from(shardXml([{ id: '10', lastmod: '2026-10-30T00:00:00-07:00' }])));

    const calls: string[] = [];
    const fetch = async (url: string): Promise<SitemapHttpResponse> => {
      calls.push(url);
      if (url === INDEX_URL) return response(url, Buffer.from(indexXml([178, 179, 180].map(shardUrl))), 'application/xml');
      if (url === shardUrl(178)) return response(url, shard178, 'application/x-gzip');
      if (url === shardUrl(179)) return response(url, shard179, 'application/x-gzip');
      throw new Error(`unexpected url ${url}`);
    };

    await runAuthorSitemapMonitor({ dryRun: true }, { fetch, logPath, tempRoot: downloadRoot, now });

    expect(calls).toEqual([INDEX_URL, shardUrl(178), shardUrl(179)]);
    expect(countAuthors()).toBe(authorsBefore);
    expect(countSitemapCandidates()).toBe(0);
    expect(fs.readdirSync(downloadRoot)).toEqual([]);

    const records = readLog();
    expect(records.filter((record) => record.event === 'download')).toHaveLength(2);
    expect(records.filter((record) => record.event === 'delete')).toHaveLength(2);
    expect(records.some((record) => record.event === 'summary')).toBe(true);

    const preview = records.find((record) => record.event === 'preview' && record.shard === 178);
    expect(preview).toMatchObject({
      entries: 3,
      uniqueIds: 3,
      new: 1,
      cached: 2,
      changed: 1,
      unchanged: 1,
      unknown: 0,
      errorSkipped: 0,
    });

    expect(getSitemapFile(178)?.status).toBe('parsed');
    expect(getSitemapFile(179)?.status).toBe('parsed');
  });

  it('gives up on an unexpected index loc without downloading any shard', async () => {
    const bad = 'https://www.goodreads.com/sitemap.178.xml';
    const calls: string[] = [];
    const fetch = async (url: string): Promise<SitemapHttpResponse> => {
      calls.push(url);
      return response(url, Buffer.from(indexXml([bad])), 'application/xml');
    };

    await runAuthorSitemapMonitor({ dryRun: true }, { fetch, logPath, tempRoot: downloadRoot, now });

    expect(calls).toEqual([INDEX_URL]);
    expect(process.exitCode).toBe(1);
    expect(fs.readdirSync(downloadRoot)).toEqual([]);
    expect(readLog()).toContainEqual(
      expect.objectContaining({ event: 'error', stage: 'index-validate', url: bad }),
    );
  });

  it('aborts on a connectivity error and removes temp state', async () => {
    const reset: any = new Error('socket reset');
    reset.code = 'ECONNRESET';
    const fetch = async (url: string): Promise<SitemapHttpResponse> => {
      if (url === INDEX_URL) return response(url, Buffer.from(indexXml([shardUrl(178)])), 'application/xml');
      throw reset;
    };

    await expect(
      runAuthorSitemapMonitor({ dryRun: true, files: 1 }, { fetch, logPath, tempRoot: downloadRoot, now }),
    ).rejects.toThrow('socket reset');

    expect(fs.readdirSync(downloadRoot)).toEqual([]);
  });
});

describe('runAuthorSitemapMonitor apply mode', () => {
  const lastmod = '2026-10-30T00:00:00-07:00';

  it('enqueues new/changed and drains only due candidates with the right scrape kind', async () => {
    upsertAuthorById('2', { id: '2', slug: '2.Two', lastSeen: '2026-01-01T00:00:00.000Z', source: 'author_one' });
    upsertAuthorById('3', { id: '3', slug: '3.Three', lastSeen: '2026-10-20T00:00:00.000Z', numRatings: '10' });
    upsertAuthorById('4', { id: '4', slug: '4.Four', lastSeen: '2027-01-01T00:00:00.000Z' });

    const { fetch, calls } = fetchShard(178, [
      { id: '1', lastmod },
      { id: '2', lastmod },
      { id: '3', lastmod },
      { id: '4', lastmod },
    ]);
    const { calls: scrapeCalls, scrape } = makeScrape();

    await runAuthorSitemapMonitor(
      { files: 1, start: 178, authors: 10, minAge: 30 },
      { fetch, scrape, logPath, tempRoot: downloadRoot, now },
    );

    expect(calls.map((call) => call.url)).toEqual([INDEX_URL, shardUrl(178)]);
    expect(scrapeCalls).toEqual([
      { id: '1', crawlAllPages: true, sort: undefined },
      { id: '2', crawlAllPages: false, sort: 'original_publication_year' },
    ]);

    expect(getAuthorById('1')?.source).toBe('author_sitemap_monitor');
    expect(getAuthorById('2')?.source).toBe('author_one');
    expect(getAuthorById('3')?.numRatings).toBe('10');

    const deferredNow = listReadySitemapCandidates({ limit: 0, now: '2026-11-06T00:00:00.000Z' });
    expect(deferredNow).toEqual([]);
    const deferredDue = listReadySitemapCandidates({ limit: 0, now: '2026-12-02T00:00:00.000Z' });
    expect(deferredDue.map((candidate) => candidate.authorId)).toEqual(['3']);
    expect(deferredDue[0]).toMatchObject({ reason: 'changed', scrapeKind: 'recent', status: 'deferred' });

    const file = getSitemapFile(178);
    expect(file).toMatchObject({ status: 'done', backCatalogScraped: 1, recentScraped: 1, newIds: 1, changedIds: 2, unchangedIds: 1 });
    expect(fs.readdirSync(downloadRoot)).toEqual([]);
  });

  it('--enqueueOnly builds the queue without scraping', async () => {
    const { fetch } = fetchShard(178, [{ id: '1', lastmod }]);
    const { calls: scrapeCalls, scrape } = makeScrape();

    await runAuthorSitemapMonitor(
      { files: 1, start: 178, enqueueOnly: true },
      { fetch, scrape, logPath, tempRoot: downloadRoot, now },
    );

    expect(scrapeCalls).toEqual([]);
    const ready = listReadySitemapCandidates({ limit: 0, now: new Date(NOW).toISOString() });
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({ authorId: '1', reason: 'new', scrapeKind: 'back_catalog', status: 'pending' });
    expect(getSitemapFile(178)?.status).toBe('done');
    expect(fs.readdirSync(downloadRoot)).toEqual([]);
  });

  it('never scrapes a retired author and records it as errorSkipped', async () => {
    recordAuthorScrapeFailure('5', 'HTTP 404', AUTHOR_FAIL_LIMIT);
    const { fetch } = fetchShard(178, [{ id: '5', lastmod }]);
    const { calls: scrapeCalls, scrape } = makeScrape();

    await runAuthorSitemapMonitor(
      { files: 1, start: 178 },
      { fetch, scrape, logPath, tempRoot: downloadRoot, now },
    );

    expect(scrapeCalls).toEqual([]);
    expect(countSitemapCandidates()).toBe(0);
    const preview = readLog().find((record) => record.event === 'preview');
    expect(preview).toMatchObject({ new: 1, errorSkipped: 1 });
  });

  it('skips an unchanged shard by hash/size and by HTTP 304 on a later run', async () => {
    const first = fetchShard(178, [{ id: '1', lastmod }], { etag: 'etag-178' });
    await runAuthorSitemapMonitor(
      { files: 1, start: 178, enqueueOnly: true },
      { fetch: first.fetch, scrape: makeScrape().scrape, logPath, tempRoot: downloadRoot, now },
    );

    const second = fetchShard(178, [{ id: '1', lastmod }], {}, first.body);
    await runAuthorSitemapMonitor(
      { files: 1, start: 178, enqueueOnly: true },
      { fetch: second.fetch, scrape: makeScrape().scrape, logPath, tempRoot: downloadRoot, now },
    );
    expect(second.calls[1].headers?.['If-None-Match']).toBe('etag-178');
    expect(readLog().filter((record) => record.event === 'skip' && record.reason === 'hash-size')).toHaveLength(1);

    const conditional = fetchShard(178, [{ id: '1', lastmod }], { status: 304 }, Buffer.alloc(0));
    await runAuthorSitemapMonitor(
      { files: 1, start: 178, enqueueOnly: true },
      { fetch: conditional.fetch, scrape: makeScrape().scrape, logPath, tempRoot: downloadRoot, now },
    );
    expect(conditional.calls[1].headers?.['If-None-Match']).toBe('etag-178');
    expect(readLog().filter((record) => record.event === 'skip' && record.reason === 'http-304')).toHaveLength(1);
  });

  it('--force reparses an unchanged shard', async () => {
    const first = fetchShard(178, [{ id: '1', lastmod }]);
    await runAuthorSitemapMonitor(
      { files: 1, start: 178, enqueueOnly: true },
      { fetch: first.fetch, scrape: makeScrape().scrape, logPath, tempRoot: downloadRoot, now },
    );

    const forced = fetchShard(178, [{ id: '1', lastmod }]);
    await runAuthorSitemapMonitor(
      { files: 1, start: 178, enqueueOnly: true, force: true },
      { fetch: forced.fetch, scrape: makeScrape().scrape, logPath, tempRoot: downloadRoot, now },
    );

    expect(readLog().filter((record) => record.event === 'preview')).toHaveLength(2);
  });

  it('keeps a failed candidate pending until the failure limit, then retires it', async () => {
    recordAuthorScrapeFailure('6', 'HTTP 500', AUTHOR_FAIL_LIMIT - 1);
    const { fetch } = fetchShard(178, [{ id: '6', lastmod }]);
    const { calls: scrapeCalls, scrape } = makeScrape('none');

    await runAuthorSitemapMonitor(
      { files: 1, start: 178 },
      { fetch, scrape, logPath, tempRoot: downloadRoot, now },
    );

    expect(scrapeCalls.map((call) => call.id)).toEqual(['6']);
    expect(countSitemapCandidates()).toBe(0);
  });

  it('drain-only honors --authors and --only', async () => {
    const firstSeen = '2026-11-01T00:00:00.000Z';
    upsertSitemapCandidate({
      authorId: '10', shardId: 178, slug: '10.Ten', sitemapLastmod: '2026-10-31T00:00:00-07:00',
      reason: 'new', scrapeKind: 'back_catalog', status: 'pending', attempts: 0, firstSeen,
    });
    upsertSitemapCandidate({
      authorId: '11', shardId: 178, slug: '11.Eleven', sitemapLastmod: '2026-10-30T00:00:00-07:00',
      reason: 'changed', scrapeKind: 'recent', status: 'pending', attempts: 0, firstSeen,
    });
    upsertSitemapCandidate({
      authorId: '12', shardId: 178, slug: '12.Twelve', sitemapLastmod: '2026-10-29T00:00:00-07:00',
      reason: 'changed', scrapeKind: 'recent', status: 'deferred', notBefore: '2026-11-01T00:00:00.000Z',
      attempts: 0, firstSeen,
    });

    const { calls: scrapeCalls, scrape } = makeScrape();
    await runAuthorSitemapMonitor(
      { authors: 1, only: 'new' },
      { scrape, logPath, tempRoot: downloadRoot, now },
    );

    expect(scrapeCalls).toEqual([{ id: '10', crawlAllPages: true, sort: undefined }]);
    expect(countSitemapCandidates()).toBe(2);
  });
});
