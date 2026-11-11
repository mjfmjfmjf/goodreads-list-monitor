import { describe, expect, it } from 'vitest';
import {
  ListSitemapIndexError,
  classifyListEntries,
  parseListLoc,
  parseListSitemapIndex,
  parseListSitemapShard,
  selectListSitemapShards,
  type ListSitemapEntry,
  type ListSitemapShard,
} from './listSitemap.ts';

const shardUrl = (id: number): string => `https://www.goodreads.com/sitemap.${id}.xml.gz`;

const indexXml = (locs: string[]): string => `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map((loc) => `<sitemap><loc>${loc}</loc><lastmod>2026-10-31</lastmod></sitemap>`).join('\n')}
</sitemapindex>
`;

const shardXml = (entries: { id: string; slug?: string; lastmod?: string }[]): string => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries
  .map(
    (entry) =>
      `<url><loc>https://www.goodreads.com/list/show/${entry.id}.${entry.slug ?? `List_${entry.id}`}</loc>${entry.lastmod ? `<lastmod>${entry.lastmod}</lastmod>` : ''}</url>`,
  )
  .join('\n')}
</urlset>
`;

describe('parseListLoc', () => {
  it('splits the list id from the slug', () => {
    expect(parseListLoc('https://www.goodreads.com/list/show/123.Some_List')).toEqual({
      id: '123',
      slug: '123.Some_List',
    });
  });

  it('rejects non-list and non-numeric ids', () => {
    expect(parseListLoc('https://www.goodreads.com/author/show/123.Foo')).toBeUndefined();
    expect(parseListLoc('https://www.goodreads.com/list/show/notanid.Foo')).toBeUndefined();
  });
});

describe('parseListSitemapIndex', () => {
  it('parses shard ids, urls, and lastmods', () => {
    const shards = parseListSitemapIndex(indexXml([shardUrl(388), shardUrl(390)]));
    expect(shards).toEqual([
      { shardId: 388, url: shardUrl(388), indexLastmod: '2026-10-31' },
      { shardId: 390, url: shardUrl(390), indexLastmod: '2026-10-31' },
    ]);
  });

  it('dedupes repeated shard ids', () => {
    expect(parseListSitemapIndex(indexXml([shardUrl(388), shardUrl(388)]))).toHaveLength(1);
  });

  it('throws on an unexpected loc', () => {
    expect(() => parseListSitemapIndex(indexXml(['https://www.goodreads.com/sitemap.388.xml']))).toThrow(
      ListSitemapIndexError,
    );
  });
});

describe('parseListSitemapShard', () => {
  it('parses entries, dedupes ids, and tracks bad/missing lastmods', () => {
    const parsed = parseListSitemapShard(
      shardXml([
        { id: '1', lastmod: '2026-10-01' },
        { id: '2' },
        { id: '1', slug: 'One_Dupe', lastmod: '2026-11-01' },
        { id: '3', lastmod: 'not-a-date' },
        { id: '4', lastmod: '2026-09-01' },
      ]) + '<url><loc>https://www.goodreads.com/author/show/9.Nope</loc></url>',
    );

    expect(parsed.urlCount).toBe(6);
    expect(parsed.entries.map((entry) => entry.id)).toEqual(['1', '2', '3', '4']);
    expect(parsed.duplicateIds).toBe(1);
    expect(parsed.unparseable).toBe(1);
    expect(parsed.missingLastmod).toBe(2);
    expect(parsed.entries[0]).toEqual({ id: '1', slug: '1.List_1', lastmod: '2026-11-01' });
    expect(parsed.lastmodMin).toBe('2026-09-01');
    expect(parsed.lastmodMax).toBe('2026-11-01');
  });
});

describe('selectListSitemapShards', () => {
  const shards: ListSitemapShard[] = [390, 388, 389].map((shardId) => ({
    shardId,
    url: shardUrl(shardId),
  }));

  it('orders, starts, and limits', () => {
    expect(selectListSitemapShards(shards, 388, 2).map((s) => s.shardId)).toEqual([388, 389]);
    expect(selectListSitemapShards(shards, 389, Infinity).map((s) => s.shardId)).toEqual([389, 390]);
  });

  it('honors an inclusive end', () => {
    expect(selectListSitemapShards(shards, 388, Infinity, 389).map((s) => s.shardId)).toEqual([388, 389]);
  });
});

describe('classifyListEntries', () => {
  const nowMs = Date.parse('2026-11-06T00:00:00.000Z');
  const lastmod = '2026-10-30T00:00:00.000Z';
  const entries: ListSitemapEntry[] = [
    { id: 'new', slug: 'new.New', lastmod },
    { id: 'unchanged', slug: 'unchanged.Unchanged', lastmod },
    { id: 'recent', slug: 'recent.Recent', lastmod },
    { id: 'stale', slug: 'stale.Stale', lastmod },
    { id: 'unknown', slug: 'unknown.Unknown', lastmod },
    { id: 'no-lastmod', slug: 'no-lastmod.No_Lastmod' },
  ];

  const lastScraped = new Map<string, string>([
    ['unchanged', '2026-11-01T00:00:00.000Z'],
    ['recent', '2026-10-01T00:00:00.000Z'],
    ['stale', '2026-01-01T00:00:00.000Z'],
    ['unknown', 'not-a-date'],
    ['no-lastmod', '2026-10-01T00:00:00.000Z'],
  ]);

  it('applies the new/unchanged/recent/stale/unknown matrix', () => {
    const { entries: classified, summary } = classifyListEntries(entries, lastScraped, {
      nowMs,
      minAgeDays: 90,
    });

    expect(classified.map((entry) => [entry.id, entry.status])).toEqual([
      ['new', 'new'],
      ['unchanged', 'unchanged'],
      ['recent', 'recent'],
      ['stale', 'stale'],
      ['unknown', 'unknown'],
      ['no-lastmod', 'unknown'],
    ]);
    expect(summary).toMatchObject({
      total: 6,
      new: 1,
      stale: 1,
      recent: 1,
      unchanged: 1,
      unknown: 2,
      toScrape: 2,
    });
  });

  it('treats a zero minAge as no recency window', () => {
    const { summary } = classifyListEntries(entries, lastScraped, { nowMs, minAgeDays: 0 });
    expect(summary.recent).toBe(0);
    expect(summary.stale).toBe(2);
  });
});
