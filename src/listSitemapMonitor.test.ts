import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-listsitemapmon-test-${process.pid}-${Date.now()}.db`;
});

import { closeDb, getDb } from './db.ts';
import { loadListScrape, upsertListScrape } from './storage.ts';
import { getListSitemapFile } from './listSitemapStore.ts';
import { runListSitemapMonitor, type ListSitemapHttpResponse } from './listSitemapMonitor.ts';
import { LIST_SITEMAP_INDEX_URL } from './listSitemap.ts';
import type { ScrapeListBooksResult } from './scraper.ts';

const shardUrl = (id: number): string => `https://www.goodreads.com/sitemap.${id}.xml.gz`;
const NOW = Date.parse('2026-11-06T00:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
const now = (): number => NOW;
const lastmod = '2026-10-30T00:00:00.000Z';

const indexXml = (locs: string[]): string => `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map((loc) => `<sitemap><loc>${loc}</loc><lastmod>2026-10-31</lastmod></sitemap>`).join('\n')}
</sitemapindex>
`;

const shardXml = (entries: { id: string; lastmod?: string }[]): string => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries
  .map(
    (entry) =>
      `<url><loc>https://www.goodreads.com/list/show/${entry.id}.List_${entry.id}</loc>${entry.lastmod ? `<lastmod>${entry.lastmod}</lastmod>` : ''}</url>`,
  )
  .join('\n')}
</urlset>
`;

interface ResponseOptions {
  status?: number;
  etag?: string;
  lastModified?: string;
}

const response = (url: string, data: Buffer, options: ResponseOptions = {}): ListSitemapHttpResponse => ({
  url,
  status: options.status ?? 200,
  data,
  contentType: 'application/x-gzip',
  contentLength: null,
  etag: options.etag ?? null,
  lastModified: options.lastModified ?? null,
  durationMs: 1,
});

interface ShardSpec {
  shardId: number;
  entries: { id: string; lastmod?: string }[];
  options?: ResponseOptions;
}

const fetchShards = (specs: ShardSpec[]) => {
  const calls: { url: string; label: string }[] = [];
  const bodies = new Map<number, Buffer>();

  const fetch = async (url: string, label: string): Promise<ListSitemapHttpResponse> => {
    calls.push({ url, label });
    if (url === LIST_SITEMAP_INDEX_URL) {
      return response(url, Buffer.from(indexXml(specs.map((spec) => shardUrl(spec.shardId)))));
    }
    for (const spec of specs) {
      if (url === shardUrl(spec.shardId)) {
        const body = gzipSync(Buffer.from(shardXml(spec.entries)));
        bodies.set(spec.shardId, body);
        return response(url, body, spec.options);
      }
    }
    throw new Error(`unexpected url ${url}`);
  };

  return { calls, fetch, bodies };
};

const book = (id: string) => ({
  id,
  title: `Book ${id}`,
  author: 'Author',
  authorId: '1',
  authorSlug: '1.Author',
  position: 1,
  ratings: '10',
  avgRating: '4.0',
  published: '2020',
  page: 1,
});

const completed = (books: any[] = []): ScrapeListBooksResult => ({
  books,
  pagesRead: 1,
  completed: true,
});

interface ScrapeCall {
  id: string;
  maxPages: number;
  source: string;
}

const makeScrape = (handler: (id: string) => ScrapeListBooksResult | Promise<ScrapeListBooksResult>) => {
  const calls: ScrapeCall[] = [];
  const scrape = async (id: string, maxPages: number, source: string): Promise<ScrapeListBooksResult> => {
    calls.push({ id, maxPages, source });
    return handler(id);
  };
  return { calls, scrape };
};

const noSleep = async (): Promise<void> => {};
const fastProbe = async <T>(fn: () => Promise<T>): Promise<T> => fn();

let tempRoot: string;
let logPath: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-listsitemap-monitor-test-'));
  logPath = path.join(tempRoot, 'listSitemapMonitor.log');
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = 0;

  const db = getDb();
  db.exec('DELETE FROM list_scrapes');
  db.exec('DELETE FROM list_sitemap_files');
  db.exec('DELETE FROM books');
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

const readLog = (): any[] => {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

describe('runListSitemapMonitor --dryRun', () => {
  it('downloads and classifies every shard but writes nothing', async () => {
    const { fetch, calls } = fetchShards([
      { shardId: 388, entries: [{ id: '1', lastmod }] },
      { shardId: 389, entries: [{ id: '2', lastmod }] },
    ]);
    const { calls: scrapeCalls, scrape } = makeScrape(() => completed());

    await runListSitemapMonitor({ dryRun: true }, { fetch, scrapeList: scrape, sleep: noSleep, logPath, now });

    expect(calls.map((call) => call.url)).toEqual([LIST_SITEMAP_INDEX_URL, shardUrl(388), shardUrl(389)]);
    expect(scrapeCalls).toEqual([]);
    expect(getListSitemapFile(388)).toBeUndefined();
    expect(loadListScrape('1')).toBeUndefined();

    const records = readLog();
    expect(records.filter((record) => record.event === 'download')).toHaveLength(2);
    expect(records.filter((record) => record.event === 'preview')).toHaveLength(2);
    expect(records.some((record) => record.event === 'summary')).toBe(true);
  });

  it('aborts on an unexpected index loc without downloading a shard', async () => {
    const calls: string[] = [];
    const fetch = async (url: string): Promise<ListSitemapHttpResponse> => {
      calls.push(url);
      return response(url, Buffer.from(indexXml(['https://www.goodreads.com/sitemap.388.xml'])));
    };

    await runListSitemapMonitor({}, { fetch, logPath, now });

    expect(calls).toEqual([LIST_SITEMAP_INDEX_URL]);
    expect(process.exitCode).toBe(1);
    expect(readLog()).toContainEqual(
      expect.objectContaining({ event: 'error', stage: 'index-validate' }),
    );
  });

  it('rejects --files together with --end', async () => {
    const fetch = async (): Promise<ListSitemapHttpResponse> => {
      throw new Error('should not fetch');
    };

    await expect(
      runListSitemapMonitor({ files: 1, end: 390 }, { fetch, logPath, now }),
    ).rejects.toThrow('mutually exclusive');
  });

  it('requires --start when --end is given', async () => {
    const fetch = async (): Promise<ListSitemapHttpResponse> => {
      throw new Error('should not fetch');
    };

    await expect(
      runListSitemapMonitor({ end: 390 }, { fetch, logPath, now }),
    ).rejects.toThrow('requires --start');
  });
});

describe('runListSitemapMonitor apply mode', () => {
  it('scrapes only new and stale lists and marks completed crawls', async () => {
    upsertListScrape('2', 'Two', '2026-11-01T00:00:00.000Z');
    upsertListScrape('3', 'Three', '2026-10-01T00:00:00.000Z');
    upsertListScrape('4', 'Four', '2026-01-01T00:00:00.000Z');
    upsertListScrape('5', 'Five', 'not-a-date');

    const { fetch } = fetchShards([
      { shardId: 388, entries: ['1', '2', '3', '4', '5'].map((id) => ({ id, lastmod })) },
    ]);
    const { calls, scrape } = makeScrape((id) => completed([book(`b${id}`)]));

    await runListSitemapMonitor(
      { start: 388, files: 1 },
      { fetch, scrapeList: scrape, sleep: noSleep, logPath, now },
    );

    expect(calls.map((call) => call.id)).toEqual(['1', '4']);
    expect(calls[0]).toMatchObject({ maxPages: Infinity, source: 'list_sitemap_monitor' });

    expect(getListSitemapFile(388)).toMatchObject({
      status: 'done',
      entries: 5,
      newIds: 1,
      staleIds: 1,
      recentIds: 1,
      unchangedIds: 1,
      unknownIds: 1,
      scraped: 2,
      failed: 0,
    });
    expect(loadListScrape('1')?.lastScraped).toBe(NOW_ISO);
    expect(loadListScrape('1')?.numScraped).toBe(1);
    expect(loadListScrape('1')?.numBooksScraped).toBe(1);
    expect(loadListScrape('4')?.lastScraped).toBe(NOW_ISO);
    expect(loadListScrape('4')?.numScraped).toBe(2); // seeded once above, then re-scraped
    expect(loadListScrape('4')?.numBooksScraped).toBe(1);
    expect(loadListScrape('2')?.lastScraped).toBe('2026-11-01T00:00:00.000Z');
    expect(loadListScrape('3')?.lastScraped).toBe('2026-10-01T00:00:00.000Z');
    expect(loadListScrape('5')?.lastScraped).toBe('not-a-date');
  });

  it('does not mark a --listMaxPages-capped crawl as scraped', async () => {
    const { fetch } = fetchShards([{ shardId: 388, entries: [{ id: '1', lastmod }] }]);
    const { scrape } = makeScrape(() => ({ books: [], pagesRead: 1, completed: false, lastStatus: 200 }));

    await runListSitemapMonitor(
      { start: 388, files: 1, listMaxPages: 1 },
      { fetch, scrapeList: scrape, sleep: noSleep, logPath, now },
    );

    expect(loadListScrape('1')).toBeUndefined();
    expect(getListSitemapFile(388)).toMatchObject({ status: 'done', cappedIds: 1, scraped: 0, failed: 0 });
  });

  it('marks a 404/410 list as gone so it is not retried', async () => {
    const { fetch } = fetchShards([{ shardId: 388, entries: [{ id: '1', lastmod }] }]);
    const { scrape } = makeScrape(() => ({ books: [], pagesRead: 1, completed: false, lastStatus: 404 }));

    await runListSitemapMonitor(
      { start: 388, files: 1 },
      { fetch, scrapeList: scrape, sleep: noSleep, logPath, now },
    );

    expect(loadListScrape('1')?.lastScraped).toBe(NOW_ISO);
    expect(loadListScrape('1')?.numScraped).toBe(1);
    expect(loadListScrape('1')?.numBooksScraped).toBe(0);
    expect(getListSitemapFile(388)).toMatchObject({ status: 'done', goneIds: 1, scraped: 0, failed: 0 });
  });

  it('records a non-connectivity failure without marking the list', async () => {
    const { fetch } = fetchShards([{ shardId: 388, entries: [{ id: '1', lastmod }] }]);
    const { scrape } = makeScrape(() => ({ books: [], pagesRead: 1, completed: false, lastStatus: 500 }));

    await runListSitemapMonitor(
      { start: 388, files: 1 },
      { fetch, scrapeList: scrape, sleep: noSleep, logPath, now },
    );

    expect(loadListScrape('1')).toBeUndefined();
    expect(getListSitemapFile(388)).toMatchObject({ status: 'done', failed: 1, scraped: 0 });
  });

  it('saves the cursor on a connectivity error and resumes from it', async () => {
    const entries = ['1', '2', '3'].map((id) => ({ id, lastmod }));

    const first = fetchShards([{ shardId: 388, entries }]);
    const firstScrape = makeScrape((id) => {
      if (id === '2') {
        const error: any = new Error('socket reset');
        error.code = 'ECONNRESET';
        throw error;
      }
      return completed();
    });

    await runListSitemapMonitor(
      { start: 388, files: 1 },
      { fetch: first.fetch, scrapeList: firstScrape.scrape, probe: fastProbe, sleep: noSleep, logPath, now },
    );

    expect(firstScrape.calls.map((call) => call.id)).toEqual(['1', '2']);
    expect(getListSitemapFile(388)).toMatchObject({ status: 'in_progress', cursorIndex: 0, scraped: 1 });
    expect(loadListScrape('1')?.lastScraped).toBe(NOW_ISO);

    const second = fetchShards([{ shardId: 388, entries }]);
    const secondScrape = makeScrape(() => completed());

    await runListSitemapMonitor(
      { start: 388, files: 1 },
      { fetch: second.fetch, scrapeList: secondScrape.scrape, sleep: noSleep, logPath, now },
    );

    expect(secondScrape.calls.map((call) => call.id)).toEqual(['2', '3']);
    expect(getListSitemapFile(388)).toMatchObject({ status: 'done', scraped: 3 });
    const previews = readLog().filter((record) => record.event === 'preview');
    expect(previews[previews.length - 1]).toMatchObject({ resuming: true, startIndex: 1 });
  });

  it('honors --maxLists, saves progress, and resumes on the next run', async () => {
    const entries = ['1', '2', '3'].map((id) => ({ id, lastmod }));

    const first = fetchShards([{ shardId: 388, entries }]);
    const firstScrape = makeScrape(() => completed());
    await runListSitemapMonitor(
      { start: 388, files: 1, maxLists: 1 },
      { fetch: first.fetch, scrapeList: firstScrape.scrape, sleep: noSleep, logPath, now },
    );

    expect(firstScrape.calls.map((call) => call.id)).toEqual(['1']);
    expect(getListSitemapFile(388)).toMatchObject({ status: 'in_progress', cursorIndex: 0, scraped: 1 });

    const second = fetchShards([{ shardId: 388, entries }]);
    const secondScrape = makeScrape(() => completed());
    await runListSitemapMonitor(
      { start: 388, files: 1 },
      { fetch: second.fetch, scrapeList: secondScrape.scrape, sleep: noSleep, logPath, now },
    );

    expect(secondScrape.calls.map((call) => call.id)).toEqual(['2', '3']);
    expect(getListSitemapFile(388)?.status).toBe('done');
  });

  it('re-walks a finished shard as a new pass without re-scraping unchanged lists', async () => {
    const entries = [{ id: '1', lastmod }];

    const first = fetchShards([{ shardId: 388, entries }]);
    const firstScrape = makeScrape(() => completed());
    await runListSitemapMonitor(
      { start: 388, files: 1 },
      { fetch: first.fetch, scrapeList: firstScrape.scrape, sleep: noSleep, logPath, now },
    );
    expect(firstScrape.calls.map((call) => call.id)).toEqual(['1']);

    const second = fetchShards([{ shardId: 388, entries }]);
    const secondScrape = makeScrape(() => completed());
    await runListSitemapMonitor(
      { start: 388, files: 1 },
      { fetch: second.fetch, scrapeList: secondScrape.scrape, sleep: noSleep, logPath, now },
    );

    expect(secondScrape.calls).toEqual([]);
    const previews = readLog().filter((record) => record.event === 'preview');
    expect(previews[previews.length - 1]).toMatchObject({ resuming: false, unchanged: 1 });
    expect(getListSitemapFile(388)?.status).toBe('done');
  });
});
