export const LIST_SITEMAP_INDEX_URL = 'https://www.goodreads.com/siteindex.list.xml';

const LIST_SITEMAP_SHARD_RE = /^https:\/\/www\.goodreads\.com\/sitemap\.(\d+)\.xml\.gz$/;
const LIST_SHOW_RE = /\/list\/show\/([^?#\s/<]+)/;

const decodeXmlText = (text: string): string =>
  text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");

const stripBom = (text: string): string => text.replace(/^\uFEFF/, '');

export class ListSitemapIndexError extends Error {
  readonly url: string;

  constructor(url: string) {
    super(`Unexpected list sitemap <loc>: ${url} (expected https://www.goodreads.com/sitemap.<n>.xml.gz)`);
    this.name = 'ListSitemapIndexError';
    this.url = url;
  }
}

export interface ListSitemapShard {
  shardId: number;
  url: string;
  indexLastmod?: string;
}

export interface ListSitemapEntry {
  id: string;
  slug: string;
  lastmod?: string;
}

export interface ParsedListSitemapShard {
  entries: ListSitemapEntry[];
  urlCount: number;
  unparseable: number;
  missingLastmod: number;
  duplicateIds: number;
  lastmodMin?: string;
  lastmodMax?: string;
}

export function parseListLoc(loc: string): { id: string; slug: string } | undefined {
  const match = loc.match(LIST_SHOW_RE);
  if (!match) return undefined;
  const slug = match[1];
  const id = slug.split('.')[0];
  if (!/^\d+$/.test(id)) return undefined;
  return { id, slug };
}

export function parseListSitemapIndex(xml: string): ListSitemapShard[] {
  const text = stripBom(xml);
  const shards: ListSitemapShard[] = [];
  const seen = new Set<number>();

  for (const blockMatch of text.matchAll(/<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi)) {
    const block = blockMatch[1];
    const locMatch = block.match(/<loc\b[^>]*>([\s\S]*?)<\/loc>/i);
    if (!locMatch) throw new ListSitemapIndexError('(missing <loc>)');

    const url = decodeXmlText(locMatch[1]).trim();
    const shardMatch = url.match(LIST_SITEMAP_SHARD_RE);
    if (!shardMatch) throw new ListSitemapIndexError(url);

    const shardId = parseInt(shardMatch[1], 10);
    if (seen.has(shardId)) continue;
    seen.add(shardId);

    const lastmodMatch = block.match(/<lastmod\b[^>]*>([\s\S]*?)<\/lastmod>/i);
    shards.push({
      shardId,
      url,
      indexLastmod: lastmodMatch ? decodeXmlText(lastmodMatch[1]).trim() : undefined,
    });
  }

  return shards;
}

const validLastmod = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  return Number.isNaN(Date.parse(value)) ? undefined : value;
};

export function parseListSitemapShard(xml: string): ParsedListSitemapShard {
  const text = stripBom(xml);
  const byId = new Map<string, ListSitemapEntry>();
  let urlCount = 0;
  let unparseable = 0;
  let missingLastmod = 0;
  let duplicateIds = 0;

  for (const blockMatch of text.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)) {
    urlCount++;
    const block = blockMatch[1];

    const locMatch = block.match(/<loc\b[^>]*>([\s\S]*?)<\/loc>/i);
    if (!locMatch) {
      unparseable++;
      continue;
    }

    const parsed = parseListLoc(decodeXmlText(locMatch[1]).trim());
    if (!parsed) {
      unparseable++;
      continue;
    }

    const lastmodMatch = block.match(/<lastmod\b[^>]*>([\s\S]*?)<\/lastmod>/i);
    const lastmod = validLastmod(lastmodMatch ? decodeXmlText(lastmodMatch[1]).trim() : undefined);
    if (!lastmod) missingLastmod++;

    const existing = byId.get(parsed.id);
    if (existing) {
      duplicateIds++;
      if (lastmod && (!existing.lastmod || Date.parse(lastmod) > Date.parse(existing.lastmod))) {
        existing.lastmod = lastmod;
      }
      continue;
    }

    byId.set(parsed.id, { id: parsed.id, slug: parsed.slug, lastmod });
  }

  let lastmodMin: string | undefined;
  let lastmodMax: string | undefined;
  for (const entry of byId.values()) {
    if (!entry.lastmod) continue;
    if (!lastmodMin || Date.parse(entry.lastmod) < Date.parse(lastmodMin)) lastmodMin = entry.lastmod;
    if (!lastmodMax || Date.parse(entry.lastmod) > Date.parse(lastmodMax)) lastmodMax = entry.lastmod;
  }

  return {
    entries: [...byId.values()],
    urlCount,
    unparseable,
    missingLastmod,
    duplicateIds,
    lastmodMin,
    lastmodMax,
  };
}

export function selectListSitemapShards(
  shards: ListSitemapShard[],
  start: number,
  files: number,
  end?: number,
): ListSitemapShard[] {
  const ordered = [...shards]
    .filter((shard) => shard.shardId >= start)
    .sort((a, b) => a.shardId - b.shardId);
  const bounded = end === undefined ? ordered : ordered.filter((shard) => shard.shardId <= end);
  return bounded.slice(0, files);
}

export type ListSitemapStatus = 'new' | 'stale' | 'recent' | 'unchanged' | 'unknown';

export interface ClassifiedListEntry extends ListSitemapEntry {
  status: ListSitemapStatus;
  lastScraped?: string;
}

export interface ListClassifySummary {
  total: number;
  new: number;
  stale: number;
  recent: number;
  unchanged: number;
  unknown: number;
  toScrape: number;
}

export function classifyListEntries(
  entries: ListSitemapEntry[],
  lastScrapedById: Map<string, string>,
  options: { nowMs: number; minAgeDays: number },
): { entries: ClassifiedListEntry[]; summary: ListClassifySummary } {
  const minAgeMs = Math.max(0, options.minAgeDays) * 24 * 60 * 60 * 1000;
  const summary: ListClassifySummary = {
    total: 0,
    new: 0,
    stale: 0,
    recent: 0,
    unchanged: 0,
    unknown: 0,
    toScrape: 0,
  };

  const classified = entries.map((entry): ClassifiedListEntry => {
    const lastScraped = lastScrapedById.get(entry.id);
    let status: ListSitemapStatus;

    if (!lastScraped) {
      status = 'new';
    } else {
      const lastmodMs = entry.lastmod ? Date.parse(entry.lastmod) : Number.NaN;
      const scrapedMs = Date.parse(lastScraped);
      if (Number.isNaN(lastmodMs) || Number.isNaN(scrapedMs)) {
        status = 'unknown';
      } else if (lastmodMs <= scrapedMs) {
        status = 'unchanged';
      } else if (options.nowMs - scrapedMs < minAgeMs) {
        status = 'recent';
      } else {
        status = 'stale';
      }
    }

    return { ...entry, status, lastScraped };
  });

  summary.total = classified.length;
  for (const entry of classified) {
    summary[entry.status]++;
  }
  summary.toScrape = summary.new + summary.stale;

  return { entries: classified, summary };
}
