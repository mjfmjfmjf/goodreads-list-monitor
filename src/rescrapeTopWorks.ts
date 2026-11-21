import chalk from 'chalk';
import { streamRows } from './storage.ts';
import { normalizeWorkTitle } from './publishSite.ts';
import { runBrowserBookScrape, type ScrapeRunSummary } from './browserBookScrape.ts';

// Union-of-top-N rescrape for popular English works. The Playwright/book-page
// write path is reused wholesale from browserBookScrape; this module only
// decides WHICH editions to refresh. See PLAN-browser-book-scraper.md.

export const DEFAULT_TOP_N = 2000;
export const DEFAULT_MIN_AGE_DAYS = 3;

export type WorkMetric = 'ratings' | 'reviews' | 'currentlyReading' | 'toRead' | 'editions';

export const WORK_METRICS: { key: WorkMetric; label: string }[] = [
  { key: 'ratings', label: 'ratings' },
  { key: 'reviews', label: 'reviews' },
  { key: 'currentlyReading', label: 'currently reading' },
  { key: 'toRead', label: 'to read' },
  { key: 'editions', label: 'edition count' },
];

export interface EnglishWorkCandidate {
  bookId: string;
  workId: string;
  title: string;
  author: string;
  authorId: string;
  ratings: number;
  reviews: number;
  currentlyReading: number;
  toRead: number;
  editions: number;
  lastScrapeStatus: string | null;
  lastScrapedAt: string | null;
}

export interface RescrapeSelection {
  bookIds: string[];
  unionSize: number;
  freshSkipped: number;
  topByMetric: Record<WorkMetric, string[]>;
}

export interface RescrapeTopWorksOptions {
  limit?: string;
  minAge?: string;
  dryRun?: boolean;
  cooldownMs?: string;
  maxConsecutiveThrottles?: string;
}

interface EnglishWorkRow {
  id: string;
  work_id: string;
  title: string;
  author: string;
  author_id: string | null;
  ratings: string | number;
  reviews: string | number | null;
  currently_reading: string | number | null;
  to_read: string | number | null;
  editions_count: string | number | null;
  scrape_status: string | null;
  last_scraped: string | null;
}

// Same "works (English)" scope as publishSite's ENGLISH_WORKS_SQL: one row per
// work_id, the highest-ratings edition whose book_page.language is English.
// browser_scrape is joined here so the recency filter needs no extra query.
const ENGLISH_WORKS_SQL = `
  WITH english AS (
    SELECT b.id, b.work_id, b.title, b.author, b.author_id, b.ratings,
           CAST(REPLACE(bp.reviews_count, ',', '') AS INTEGER) AS reviews,
           bp.currently_reading, bp.to_read, bp.editions_count,
           bs.status AS scrape_status, bs.scraped_at AS last_scraped,
           ROW_NUMBER() OVER (
             PARTITION BY b.work_id
             ORDER BY b.ratings DESC, CAST(b.id AS INTEGER) ASC
           ) AS rn
    FROM book_page bp
    JOIN books b ON b.id = bp.book_id
    LEFT JOIN browser_scrape bs ON bs.book_id = b.id
    WHERE bp.language = 'English'
      AND b.work_id IS NOT NULL AND b.work_id != ''
      AND b.is_bad = 0 AND b.requires_auth = 0
  )
  SELECT id, work_id, title, author, author_id, ratings, reviews,
         currently_reading, to_read, editions_count, scrape_status, last_scraped
  FROM english
  WHERE rn = 1
`;

const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

export function metricValue(work: EnglishWorkCandidate, metric: WorkMetric): number {
  return work[metric];
}

// Goodreads occasionally reuses a work_id for the same title/author. Collapse
// those with the same key publishSite.dedupeEnglishWorks uses, keeping the
// most-rated edition (then lowest numeric id).
export function dedupeWorkCandidates(works: EnglishWorkCandidate[]): EnglishWorkCandidate[] {
  const best = new Map<string, EnglishWorkCandidate>();
  for (const work of works) {
    const title = normalizeWorkTitle(work.title);
    const authorKey = work.authorId || work.author.trim().toLowerCase();
    const key = title ? `${title}|${authorKey}` : `work:${work.workId || work.bookId}`;
    const current = best.get(key);
    if (!current || work.ratings > current.ratings ||
        (work.ratings === current.ratings && num(work.bookId) < num(current.bookId))) {
      best.set(key, work);
    }
  }
  return [...best.values()];
}

export function loadEnglishWorkCandidates(): EnglishWorkCandidate[] {
  const rows: EnglishWorkCandidate[] = [];
  for (const row of streamRows<EnglishWorkRow>(ENGLISH_WORKS_SQL)) {
    rows.push({
      bookId: row.id,
      workId: row.work_id,
      title: row.title ?? '',
      author: row.author ?? '',
      authorId: row.author_id ?? '',
      ratings: num(row.ratings),
      reviews: num(row.reviews),
      currentlyReading: num(row.currently_reading),
      toRead: num(row.to_read),
      editions: num(row.editions_count),
      lastScrapeStatus: row.scrape_status ?? null,
      lastScrapedAt: row.last_scraped ?? null,
    });
  }
  return dedupeWorkCandidates(rows);
}

function isFresh(work: EnglishWorkCandidate, minAgeDays: number, nowMs: number): boolean {
  if (work.lastScrapeStatus !== 'ok' || !work.lastScrapedAt) return false;
  const scrapedMs = Date.parse(work.lastScrapedAt);
  if (!Number.isFinite(scrapedMs)) return false;
  return nowMs - scrapedMs < minAgeDays * 86_400_000;
}

// Five independent top-N lists, unioned: a work is eligible if it ranks in the
// top N for ANY metric. The recency cutoff is applied to that union (not before
// ranking) so the per-metric top N still reflects the current stored data.
export function selectRescrapeCandidates(
  works: EnglishWorkCandidate[],
  topN: number,
  minAgeDays: number,
  nowMs = Date.now(),
): RescrapeSelection {
  const n = Math.max(0, Math.floor(topN));
  const topByMetric = {} as Record<WorkMetric, string[]>;
  const union = new Set<string>();

  for (const { key } of WORK_METRICS) {
    const ranked = [...works].sort((a, b) =>
      metricValue(b, key) - metricValue(a, key) ||
      num(a.bookId) - num(b.bookId) ||
      a.bookId.localeCompare(b.bookId)
    );
    const ids = ranked.slice(0, n).map((work) => work.bookId);
    topByMetric[key] = ids;
    for (const id of ids) union.add(id);
  }

  const byId = new Map(works.map((work) => [work.bookId, work]));
  const freshIds = new Set<string>();
  for (const id of union) {
    const work = byId.get(id);
    if (work && isFresh(work, minAgeDays, nowMs)) freshIds.add(id);
  }
  const bookIds = [...union]
    .filter((id) => !freshIds.has(id))
    .sort((a, b) => num(a) - num(b) || a.localeCompare(b));

  return { bookIds, unionSize: union.size, freshSkipped: freshIds.size, topByMetric };
}

export async function runRescrapeTopWorks(options: RescrapeTopWorksOptions = {}): Promise<ScrapeRunSummary> {
  const topN = Math.max(1, Number(options.limit ?? DEFAULT_TOP_N) || DEFAULT_TOP_N);
  const minAgeDays = Math.max(0, Number(options.minAge ?? DEFAULT_MIN_AGE_DAYS) || 0);
  const dryRun = !!options.dryRun;

  console.log(chalk.cyan.bold('\n🔁 rescrape-top-works (Playwright / headed Chromium)'));
  console.log(chalk.gray(`   Union of top ${topN.toLocaleString('en-US')} English works by each of: ${WORK_METRICS.map((m) => m.label).join(', ')}.`));
  console.log(chalk.gray(`   Recency: skip editions with a successful scrape in the last ${minAgeDays} day(s).`));

  const works = loadEnglishWorkCandidates();
  console.log(chalk.gray(`   English work editions in scope: ${works.length.toLocaleString('en-US')}`));
  const selection = selectRescrapeCandidates(works, topN, minAgeDays);
  for (const metric of WORK_METRICS) {
    console.log(chalk.gray(`      ${metric.label.padEnd(18)} ${selection.topByMetric[metric.key].length.toLocaleString('en-US')}`));
  }
  console.log(chalk.cyan(`   Union: ${selection.unionSize.toLocaleString('en-US')} work(s); ${selection.freshSkipped.toLocaleString('en-US')} skipped as recently scraped; ${selection.bookIds.length.toLocaleString('en-US')} to rescrape.`));

  if (dryRun) {
    const byId = new Map(works.map((work) => [work.bookId, work]));
    for (const id of selection.bookIds.slice(0, 100)) {
      const work = byId.get(id);
      console.log(`   ${id}\t${work?.ratings ?? 0}\t${work?.title ?? ''}`);
    }
    if (selection.bookIds.length > 100) {
      console.log(chalk.gray(`   … and ${(selection.bookIds.length - 100).toLocaleString('en-US')} more (--dryRun prints the first 100).`));
    }
    console.log(chalk.gray('   (--dryRun: no network, no DB writes)'));
    return { total: selection.bookIds.length, processed: 0, ok: 0, throttled: 0, missing: 0, error: 0, skipped: 0, elapsedMs: 0 };
  }

  if (selection.bookIds.length === 0) {
    console.log(chalk.green('   Nothing to do — every top work was scraped within the recency window.'));
    return { total: 0, processed: 0, ok: 0, throttled: 0, missing: 0, error: 0, skipped: 0, elapsedMs: 0 };
  }

  // The runner passes all ids into one `WHERE id IN (...)` query; SQLite's
  // compiled variable limit is ~32k, and a much larger N would make no sense
  // at 2-4s pacing anyway. Fail clearly instead of hitting a driver error.
  if (selection.bookIds.length > 30_000) {
    throw new Error(`${selection.bookIds.length.toLocaleString('en-US')} works to rescrape exceeds the 30,000-id batch limit — lower -n and run in stages.`);
  }

  // force=true is intentional: the recency decision above is authoritative.
  // The existing runner supplies the single headed window, 2–4s pacing,
  // checkpointing, parsing, and book_page writes for the selected editions.
  return runBrowserBookScrape({
    limit: selection.bookIds.length,
    candidateBookIds: selection.bookIds,
    engine: 'browser',
    skipHas: [],
    sort: 'ratingsDesc',
    force: true,
    cooldownMs: options.cooldownMs !== undefined ? Number(options.cooldownMs) : undefined,
    maxConsecutiveThrottles: options.maxConsecutiveThrottles !== undefined
      ? Number(options.maxConsecutiveThrottles)
      : undefined,
  });
}
