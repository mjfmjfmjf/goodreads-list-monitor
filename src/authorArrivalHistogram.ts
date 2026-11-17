import { getDb } from './db.ts';

// Author arrival ("new authors by first-seen day"): the data behind the Overall
// → Authors added report and the HTML form of `./authorHist.sh --by day`.
// Unlike books-added there is no fixed window: buckets are every contiguous UTC
// day from the data's own min(first_seen) to max(first_seen), including empty
// days. `num_ratings` is the author-level rating count.

export interface AuthorArrivalBucket {
  label: string; // YYYY-MM-DD
  added: number;
  total: number;
  avgRatings: number;
  maxRatings: number;
}

export interface AuthorArrivalSummary {
  buckets: AuthorArrivalBucket[];
  totalAuthors: number;
  missingFirstSeen: number;
  beforeWindow: number;
  addedInWindow: number;
  earliestFirstSeen: string | null;
}

export interface AuthorArrivalRow {
  day: string; // YYYY-MM-DD
  count: number;
  ratingSum: number;
  maxRatings: number;
}

// Pure builder: turn the SQL group-by rows into the contiguous day series the
// page renders. Bounds are injectable so tests do not depend on the live data.
export function buildAuthorArrivalBuckets(input: {
  start: string;
  end: string;
  grouped: AuthorArrivalRow[];
  totalAuthors: number;
  missingFirstSeen: number;
  beforeWindow: number;
  earliestFirstSeen: string | null;
}): AuthorArrivalSummary {
  const empty = (): AuthorArrivalSummary => ({
    buckets: [],
    totalAuthors: input.totalAuthors,
    missingFirstSeen: input.missingFirstSeen,
    beforeWindow: input.beforeWindow,
    addedInWindow: 0,
    earliestFirstSeen: input.earliestFirstSeen,
  });

  const start = new Date(`${input.start}T00:00:00Z`);
  const end = new Date(`${input.end}T00:00:00Z`);
  if (!input.start || !input.end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return empty();
  }

  const buckets: AuthorArrivalBucket[] = [];
  const byLabel = new Map<string, AuthorArrivalBucket>();
  for (let t = start.getTime(); t <= end.getTime(); t += 24 * 60 * 60 * 1000) {
    const label = new Date(t).toISOString().slice(0, 10);
    const bucket: AuthorArrivalBucket = { label, added: 0, total: 0, avgRatings: 0, maxRatings: 0 };
    buckets.push(bucket);
    byLabel.set(label, bucket);
  }

  const ratingSum = new Map<string, number>();
  for (const row of input.grouped) {
    const bucket = byLabel.get(row.day);
    if (!bucket) continue; // rows outside the requested bounds
    bucket.added += row.count;
    ratingSum.set(row.day, (ratingSum.get(row.day) ?? 0) + row.ratingSum);
    bucket.maxRatings = Math.max(bucket.maxRatings, row.maxRatings || 0);
  }

  for (const bucket of buckets) {
    bucket.avgRatings =
      bucket.added > 0 ? Math.round((ratingSum.get(bucket.label) ?? 0) / bucket.added) : 0;
  }

  let running = input.beforeWindow;
  let addedInWindow = 0;
  for (const bucket of buckets) {
    running += bucket.added;
    bucket.total = running;
    addedInWindow += bucket.added;
  }

  return {
    buckets,
    totalAuthors: input.totalAuthors,
    missingFirstSeen: input.missingFirstSeen,
    beforeWindow: input.beforeWindow,
    addedInWindow,
    earliestFirstSeen: input.earliestFirstSeen,
  };
}

// DB-backed loader. `bounds` lets tests pin the window; production uses the
// data's own min/max first_seen day.
export function loadAuthorArrivalBuckets(
  bounds: { start?: string; end?: string } = {},
): AuthorArrivalSummary {
  const db = getDb();
  const fmt = '%Y-%m-%d';

  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN first_seen IS NULL OR first_seen = '' THEN 1 ELSE 0 END) AS missing,
      MIN(first_seen) AS earliest,
      MIN(strftime('${fmt}', first_seen)) AS min_day,
      MAX(strftime('${fmt}', first_seen)) AS max_day
    FROM authors
  `).get() as {
    total: number;
    missing: number | null;
    earliest: string | null;
    min_day: string | null;
    max_day: string | null;
  };

  const start = bounds.start ?? totals.min_day ?? '';
  const end = bounds.end ?? totals.max_day ?? '';

  if (!start || !end) {
    return buildAuthorArrivalBuckets({
      start,
      end,
      grouped: [],
      totalAuthors: Number(totals.total) || 0,
      missingFirstSeen: Number(totals.missing) || 0,
      beforeWindow: 0,
      earliestFirstSeen: totals.earliest ?? null,
    });
  }

  const beforeWindow = Number(
    (db.prepare(
      `SELECT COUNT(*) AS c FROM authors
       WHERE first_seen IS NOT NULL AND first_seen != ''
         AND strftime('${fmt}', first_seen) < ?`,
    ).get(start) as { c: number }).c,
  );

  const grouped = db.prepare(`
    SELECT
      strftime('${fmt}', first_seen) AS day,
      COUNT(*) AS count,
      COALESCE(SUM(num_ratings), 0) AS ratingSum,
      COALESCE(MAX(num_ratings), 0) AS maxRatings
    FROM authors
    WHERE first_seen IS NOT NULL AND first_seen != ''
      AND strftime('${fmt}', first_seen) >= ?
      AND strftime('${fmt}', first_seen) <= ?
    GROUP BY day
    ORDER BY day ASC
  `).all(start, end) as AuthorArrivalRow[];

  return buildAuthorArrivalBuckets({
    start,
    end,
    grouped,
    totalAuthors: Number(totals.total) || 0,
    missingFirstSeen: Number(totals.missing) || 0,
    beforeWindow,
    earliestFirstSeen: totals.earliest ?? null,
  });
}
