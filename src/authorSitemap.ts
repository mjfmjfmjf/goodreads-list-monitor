export const AUTHOR_SITEMAP_INDEX_URL = 'https://www.goodreads.com/siteindex.author.xml';

const AUTHOR_SITEMAP_SHARD_RE = /^https:\/\/www\.goodreads\.com\/sitemap\.(\d+)\.xml\.gz$/;
const AUTHOR_SHOW_RE = /\/author\/show\/([^?#\s/<]+)/;

const decodeXmlText = (text: string): string =>
  text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");

const stripBom = (text: string): string => text.replace(/^\uFEFF/, '');

export class AuthorSitemapIndexError extends Error {
  readonly url: string;

  constructor(url: string) {
    super(`Unexpected author sitemap <loc>: ${url} (expected https://www.goodreads.com/sitemap.<n>.xml.gz)`);
    this.name = 'AuthorSitemapIndexError';
    this.url = url;
  }
}

export interface SitemapShard {
  shardId: number;
  url: string;
  indexLastmod?: string;
}

export interface SitemapEntry {
  id: string;
  slug: string;
  lastmod?: string;
}

export interface ParsedSitemapShard {
  entries: SitemapEntry[];
  urlCount: number;
  unparseable: number;
  missingLastmod: number;
  duplicateIds: number;
  lastmodMin?: string;
  lastmodMax?: string;
}

export function parseAuthorLoc(loc: string): { id: string; slug: string } | undefined {
  const match = loc.match(AUTHOR_SHOW_RE);
  if (!match) return undefined;
  const slug = match[1];
  const id = slug.split('.')[0];
  if (!/^\d+$/.test(id)) return undefined;
  return { id, slug };
}

export function parseAuthorSitemapIndex(xml: string): SitemapShard[] {
  const text = stripBom(xml);
  const shards: SitemapShard[] = [];
  const seen = new Set<number>();

  for (const blockMatch of text.matchAll(/<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi)) {
    const block = blockMatch[1];
    const locMatch = block.match(/<loc\b[^>]*>([\s\S]*?)<\/loc>/i);
    if (!locMatch) throw new AuthorSitemapIndexError('(missing <loc>)');

    const url = decodeXmlText(locMatch[1]).trim();
    const shardMatch = url.match(AUTHOR_SITEMAP_SHARD_RE);
    if (!shardMatch) throw new AuthorSitemapIndexError(url);

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

export function parseAuthorSitemapShard(xml: string): ParsedSitemapShard {
  const text = stripBom(xml);
  const byId = new Map<string, SitemapEntry>();
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

    const parsed = parseAuthorLoc(decodeXmlText(locMatch[1]).trim());
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

export function selectSitemapShards(shards: SitemapShard[], start: number, files: number): SitemapShard[] {
  return [...shards]
    .filter((shard) => shard.shardId >= start)
    .sort((a, b) => a.shardId - b.shardId)
    .slice(0, files);
}

export type AuthorSitemapStatus = 'new' | 'changed' | 'unchanged' | 'unknown';

export interface CachedAuthorRow {
  id: string;
  lastSeen?: string;
  averageRating?: string;
  numRatings?: string;
  numReviews?: string;
  numShelves?: string;
  catalogPages?: number;
}

export interface ClassifiedSitemapEntry extends SitemapEntry {
  status: AuthorSitemapStatus;
  errorSkipped: boolean;
}

export interface ClassifySummary {
  total: number;
  new: number;
  cached: number;
  changed: number;
  unchanged: number;
  unknown: number;
  errorSkipped: number;
}

export function classifySitemapEntries(
  entries: SitemapEntry[],
  rows: Map<string, CachedAuthorRow>,
  retiredIds: Set<string>,
): { entries: ClassifiedSitemapEntry[]; summary: ClassifySummary } {
  const summary: ClassifySummary = {
    total: 0,
    new: 0,
    cached: 0,
    changed: 0,
    unchanged: 0,
    unknown: 0,
    errorSkipped: 0,
  };

  const classified = entries.map((entry): ClassifiedSitemapEntry => {
    const row = rows.get(entry.id);
    let status: AuthorSitemapStatus;

    if (!row) {
      status = 'new';
    } else {
      const seenMs = row.lastSeen ? Date.parse(row.lastSeen) : Number.NaN;
      const lastmodMs = entry.lastmod ? Date.parse(entry.lastmod) : Number.NaN;
      if (Number.isNaN(seenMs) || Number.isNaN(lastmodMs)) {
        status = 'unknown';
      } else {
        status = lastmodMs > seenMs ? 'changed' : 'unchanged';
      }
    }

    const errorSkipped = (status === 'new' || status === 'changed') && retiredIds.has(entry.id);
    return { ...entry, status, errorSkipped };
  });

  summary.total = classified.length;
  for (const entry of classified) {
    summary[entry.status]++;
    if (entry.errorSkipped) summary.errorSkipped++;
  }
  summary.cached = summary.total - summary.new;

  return { entries: classified, summary };
}

export function authorPageScraped(row: CachedAuthorRow): boolean {
  return Boolean(
    row.numRatings ||
    row.averageRating ||
    row.numReviews ||
    row.numShelves ||
    (row.catalogPages ?? 0) >= 1,
  );
}

export type CandidateReason = 'new' | 'changed';
export type CandidateScrapeKind = 'back_catalog' | 'recent';
export type CandidateStatus = 'pending' | 'deferred';

export interface CandidateDecision {
  entry: ClassifiedSitemapEntry;
  reason: CandidateReason;
  scrapeKind: CandidateScrapeKind;
  status: CandidateStatus;
  notBefore?: string;
}

export interface CandidatePlan {
  enqueue: CandidateDecision[];
  new: number;
  changed: number;
  changedDeferred: number;
  skippedUnchanged: number;
  skippedRecent: number;
  errorSkipped: number;
  unknown: number;
}

export function planSitemapCandidates(
  classified: ClassifiedSitemapEntry[],
  rows: Map<string, CachedAuthorRow>,
  options: { minAgeDays: number; nowMs?: number },
): CandidatePlan {
  const nowMs = options.nowMs ?? Date.now();
  const cooldownMs = Math.max(0, options.minAgeDays) * 24 * 60 * 60 * 1000;
  const plan: CandidatePlan = {
    enqueue: [],
    new: 0,
    changed: 0,
    changedDeferred: 0,
    skippedUnchanged: 0,
    skippedRecent: 0,
    errorSkipped: 0,
    unknown: 0,
  };

  for (const entry of classified) {
    if (entry.errorSkipped) {
      plan.errorSkipped++;
      continue;
    }

    if (entry.status === 'new') {
      plan.new++;
      plan.enqueue.push({ entry, reason: 'new', scrapeKind: 'back_catalog', status: 'pending' });
      continue;
    }

    if (entry.status === 'unchanged') {
      plan.skippedUnchanged++;
      continue;
    }

    if (entry.status === 'unknown') {
      plan.unknown++;
      continue;
    }

    plan.changed++;
    const row = rows.get(entry.id);
    const seenMs = row?.lastSeen ? Date.parse(row.lastSeen) : Number.NaN;
    if (row && authorPageScraped(row) && !Number.isNaN(seenMs) && cooldownMs > 0 && nowMs - seenMs < cooldownMs) {
      plan.changedDeferred++;
      plan.skippedRecent++;
      plan.enqueue.push({
        entry,
        reason: 'changed',
        scrapeKind: 'recent',
        status: 'deferred',
        notBefore: new Date(seenMs + cooldownMs).toISOString(),
      });
      continue;
    }

    plan.enqueue.push({ entry, reason: 'changed', scrapeKind: 'recent', status: 'pending' });
  }

  return plan;
}

export function nextSitemapStart(shards: SitemapShard[], doneShardIds: Set<number>): number | undefined {
  const ordered = [...shards].sort((a, b) => a.shardId - b.shardId);
  return (ordered.find((shard) => !doneShardIds.has(shard.shardId)) ?? ordered[0])?.shardId;
}
