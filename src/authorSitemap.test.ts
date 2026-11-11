import { describe, expect, it } from 'vitest';
import {
  AuthorSitemapIndexError,
  authorPageScraped,
  classifySitemapEntries,
  nextSitemapStart,
  parseAuthorLoc,
  parseAuthorSitemapIndex,
  parseAuthorSitemapShard,
  planSitemapCandidates,
  selectSitemapShards,
  type CachedAuthorRow,
  type SitemapEntry,
  type SitemapShard,
} from './authorSitemap.ts';

const indexXml = (locs: string[]): string => `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map((loc) => `  <sitemap>
    <loc>${loc}</loc>
    <lastmod>2026-10-31</lastmod>
  </sitemap>`).join('\n')}
</sitemapindex>
`;

const shardUrl = (id: number): string => `https://www.goodreads.com/sitemap.${id}.xml.gz`;

const shardXml = (entries: { id: string; lastmod?: string }[]): string => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map((entry) => `  <url>
    <loc>https://www.goodreads.com/author/show/${entry.id}.Author_${entry.id}</loc>
    ${entry.lastmod ? `<lastmod>${entry.lastmod}</lastmod>` : ''}
    <changefreq>weekly</changefreq>
  </url>`).join('\n')}
</urlset>
`;

describe('parseAuthorSitemapIndex', () => {
  it('parses shard ids, urls, and index lastmod', () => {
    const shards = parseAuthorSitemapIndex(indexXml([shardUrl(178), shardUrl(179), shardUrl(367)]));
    expect(shards).toEqual([
      { shardId: 178, url: shardUrl(178), indexLastmod: '2026-10-31' },
      { shardId: 179, url: shardUrl(179), indexLastmod: '2026-10-31' },
      { shardId: 367, url: shardUrl(367), indexLastmod: '2026-10-31' },
    ]);
  });

  it('uses the index loc verbatim and tolerates non-contiguous shard ids', () => {
    const shards = parseAuthorSitemapIndex(indexXml([shardUrl(200), shardUrl(178), shardUrl(400)]));
    expect(shards.map((shard) => shard.shardId)).toEqual([200, 178, 400]);
    expect(shards[0].url).toBe(shardUrl(200));
  });

  it('throws with the offending loc when the filename does not match', () => {
    const bad = 'https://www.goodreads.com/sitemap.178.xml';
    expect(() => parseAuthorSitemapIndex(indexXml([bad]))).toThrow(AuthorSitemapIndexError);
    try {
      parseAuthorSitemapIndex(indexXml([bad]));
    } catch (error) {
      expect((error as AuthorSitemapIndexError).url).toBe(bad);
    }
  });

  it('throws for a different host or path', () => {
    expect(() => parseAuthorSitemapIndex(indexXml(['https://example.com/sitemap.178.xml.gz']))).toThrow(
      AuthorSitemapIndexError,
    );
    expect(() => parseAuthorSitemapIndex(indexXml(['https://www.goodreads.com/other.178.xml.gz']))).toThrow(
      AuthorSitemapIndexError,
    );
  });

  it('throws when an entry has no loc', () => {
    expect(() => parseAuthorSitemapIndex('<sitemapindex><sitemap></sitemap></sitemapindex>')).toThrow(
      AuthorSitemapIndexError,
    );
  });
});

describe('parseAuthorSitemapShard', () => {
  it('parses ids, slugs, and lastmod, and keeps the latest duplicate', () => {
    const parsed = parseAuthorSitemapShard(
      shardXml([
        { id: '1', lastmod: '2026-10-01T00:00:00-07:00' },
        { id: '2', lastmod: '2024-08-20T00:00:00-07:00' },
        { id: '1', lastmod: '2026-10-30T00:00:00-07:00' },
      ]),
    );

    expect(parsed.urlCount).toBe(3);
    expect(parsed.duplicateIds).toBe(1);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries.find((entry) => entry.id === '1')).toEqual({
      id: '1',
      slug: '1.Author_1',
      lastmod: '2026-10-30T00:00:00-07:00',
    });
    expect(parsed.lastmodMin).toBe('2024-08-20T00:00:00-07:00');
    expect(parsed.lastmodMax).toBe('2026-10-30T00:00:00-07:00');
  });

  it('counts missing or invalid lastmod and unparseable blocks', () => {
    const xml = `<urlset>
      <url><loc>https://www.goodreads.com/author/show/3.Three</loc></url>
      <url><loc>https://www.goodreads.com/author/show/4.Four</loc><lastmod>not-a-date</lastmod></url>
      <url><loc>https://example.com/not-an-author</loc></url>
      <url></url>
    </urlset>`;
    const parsed = parseAuthorSitemapShard(xml);
    expect(parsed.urlCount).toBe(4);
    expect(parsed.unparseable).toBe(2);
    expect(parsed.missingLastmod).toBe(2);
    expect(parsed.entries.map((entry) => entry.id).sort()).toEqual(['3', '4']);
  });

  it('requires a numeric author id', () => {
    expect(parseAuthorLoc('https://www.goodreads.com/author/show/123.Slug')).toEqual({ id: '123', slug: '123.Slug' });
    expect(parseAuthorLoc('https://www.goodreads.com/author/show/abc.Slug')).toBeUndefined();
  });
});

describe('selectSitemapShards', () => {
  const shards: SitemapShard[] = [178, 179, 180, 190].map((id) => ({ shardId: id, url: shardUrl(id) }));

  it('selects at most the requested count, starting at --start', () => {
    expect(selectSitemapShards(shards, 179, 2).map((shard) => shard.shardId)).toEqual([179, 180]);
  });

  it('handles fewer available shards and an out-of-range start', () => {
    expect(selectSitemapShards(shards, 181, 5).map((shard) => shard.shardId)).toEqual([190]);
    expect(selectSitemapShards(shards, 200, 2)).toEqual([]);
  });
});

describe('classifySitemapEntries', () => {
  const entries: SitemapEntry[] = [
    { id: '1', slug: '1.One', lastmod: '2026-10-30T00:00:00-07:00' },
    { id: '2', slug: '2.Two', lastmod: '2026-10-30T00:00:00-07:00' },
    { id: '3', slug: '3.Three', lastmod: '2026-10-30T00:00:00-07:00' },
    { id: '4', slug: '4.Four', lastmod: '2026-10-30T00:00:00-07:00' },
    { id: '5', slug: '5.Five' },
  ];
  const rows = new Map<string, CachedAuthorRow>([
    ['2', { id: '2', lastSeen: '2020-01-01T00:00:00.000Z' }],
    ['3', { id: '3', lastSeen: '2027-01-01T00:00:00.000Z' }],
    ['4', { id: '4' }],
    ['5', { id: '5', lastSeen: '2020-01-01T00:00:00.000Z' }],
  ]);

  it('classifies new, changed, unchanged, and unknown', () => {
    const { entries: classified, summary } = classifySitemapEntries(entries, rows, new Set());

    expect(classified.map((entry) => entry.status)).toEqual(['new', 'changed', 'unchanged', 'unknown', 'unknown']);
    expect(summary).toEqual({
      total: 5,
      new: 1,
      cached: 4,
      changed: 1,
      unchanged: 1,
      unknown: 2,
      errorSkipped: 0,
    });
  });

  it('marks retired new/changed authors as errorSkipped without hiding raw counts', () => {
    const { summary } = classifySitemapEntries(entries, rows, new Set(['1', '2', '3']));
    expect(summary.new).toBe(1);
    expect(summary.changed).toBe(1);
    expect(summary.unchanged).toBe(1);
    expect(summary.errorSkipped).toBe(2);
  });
});

describe('planSitemapCandidates', () => {
  const nowMs = Date.parse('2026-11-06T00:00:00.000Z');
  const lastmod = '2026-10-30T00:00:00-07:00';

  const planFor = (rows: Map<string, CachedAuthorRow>, retired = new Set<string>(), minAgeDays = 30) => {
    const entries: SitemapEntry[] = [
      { id: '1', slug: '1.New', lastmod },
      { id: '2', slug: '2.Due', lastmod },
      { id: '3', slug: '3.Deferred', lastmod },
      { id: '4', slug: '4.Unchanged', lastmod },
      { id: '5', slug: '5.Missing', lastmod },
      { id: '6', slug: '6.Retired', lastmod },
    ];
    const { entries: classified } = classifySitemapEntries(entries, rows, retired);
    return planSitemapCandidates(classified, rows, { minAgeDays, nowMs });
  };

  it('enqueues new as back-catalog and due changed as recent', () => {
    const plan = planFor(
      new Map([
        ['2', { id: '2', lastSeen: '2026-01-01T00:00:00.000Z' }],
        ['3', { id: '3', lastSeen: '2026-10-20T00:00:00.000Z', numRatings: '10' }],
        ['4', { id: '4', lastSeen: '2027-01-01T00:00:00.000Z' }],
        ['5', { id: '5' }],
      ]),
      new Set(['6']),
    );

    const byId = new Map(plan.enqueue.map((decision) => [decision.entry.id, decision]));
    expect(byId.get('1')).toMatchObject({ reason: 'new', scrapeKind: 'back_catalog', status: 'pending' });
    expect(byId.get('2')).toMatchObject({ reason: 'changed', scrapeKind: 'recent', status: 'pending' });
    expect(byId.get('3')).toMatchObject({ reason: 'changed', scrapeKind: 'recent', status: 'deferred' });
    expect(byId.get('3')?.notBefore).toBe(new Date(Date.parse('2026-10-20T00:00:00.000Z') + 30 * 86400000).toISOString());
    expect(byId.has('4')).toBe(false);
    expect(byId.has('5')).toBe(false);

    expect(plan.new).toBe(1);
    expect(plan.changed).toBe(2);
    expect(plan.changedDeferred).toBe(1);
    expect(plan.skippedUnchanged).toBe(1);
    expect(plan.skippedRecent).toBe(1);
    expect(plan.unknown).toBe(1);
  });

  it('does not defer a mint-only row (no author-page stats) inside the window', () => {
    const plan = planFor(
      new Map([['2', { id: '2', lastSeen: '2026-10-20T00:00:00.000Z' }]]),
    );
    const decision = plan.enqueue.find((entry) => entry.entry.id === '2');
    expect(decision).toMatchObject({ status: 'pending', scrapeKind: 'recent' });
    expect(plan.changedDeferred).toBe(0);
  });

  it('treats retired new/changed authors as errorSkipped and never enqueues them', () => {
    const plan = planFor(new Map(), new Set(['6']));
    expect(plan.errorSkipped).toBe(1);
    expect(plan.enqueue.some((entry) => entry.entry.id === '6')).toBe(false);
  });
});

describe('authorPageScraped', () => {
  it('recognizes a real scrape and ignores a mint-only row', () => {
    expect(authorPageScraped({ id: '1', numRatings: '5' })).toBe(true);
    expect(authorPageScraped({ id: '2', catalogPages: 1 })).toBe(true);
    expect(authorPageScraped({ id: '3', lastSeen: '2026-01-01T00:00:00.000Z' })).toBe(false);
  });
});

describe('nextSitemapStart', () => {
  const shards: SitemapShard[] = [178, 179, 180].map((id) => ({ shardId: id, url: shardUrl(id) }));

  it('picks the first shard that is not done, wrapping to the first when all are done', () => {
    expect(nextSitemapStart(shards, new Set([178]))).toBe(179);
    expect(nextSitemapStart(shards, new Set([178, 179]))).toBe(180);
    expect(nextSitemapStart(shards, new Set([178, 179, 180]))).toBe(178);
  });
});
