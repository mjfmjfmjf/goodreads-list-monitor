// Pure helpers for turning a Goodreads ratings histogram into scalar summary
// statistics. `book_page.ratings_dist` stores the raw histogram as JSON — a map
// from star value (1..5) to the number of ratings at that value, e.g.
// {"5":967486,"4":303339,...}. These helpers recompute the dependent columns
// (mean/median/mode/variance/stddev/skewness/kurtosis/total) whenever a fresh
// distribution is written, and drive the offline backfill. Kept free of
// network/DB side effects so they can be unit-tested.

export interface RatingsStats {
  total: number;
  mean: number;
  median: number;
  mode: number;
  variance: number;
  stddev: number;
  skewness: number | null;
  kurtosis: number | null;
}

// The book_page column shape, ready to spread into an upsert. Every field is
// null when the distribution is missing/empty/unparseable so a write always
// overwrites stale derived values with a consistent state.
export interface RatingsStatsColumns {
  ratings_mean: number | null;
  ratings_median: number | null;
  ratings_mode: number | null;
  ratings_variance: number | null;
  ratings_stddev: number | null;
  ratings_skewness: number | null;
  ratings_kurtosis: number | null;
  ratings_total: number | null;
}

const NULL_COLUMNS: RatingsStatsColumns = {
  ratings_mean: null,
  ratings_median: null,
  ratings_mode: null,
  ratings_variance: null,
  ratings_stddev: null,
  ratings_skewness: null,
  ratings_kurtosis: null,
  ratings_total: null,
};

// Accepts either a raw JSON string (as stored in book_page.ratings_dist), an
// already-parsed record, null, or undefined. Non-finite / non-positive counts
// and non-finite star values are dropped; an empty result returns null.
export function parseRatingsDist(raw: unknown): Record<string, number> | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === 'null') return null;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const out: Record<string, number> = {};
  let any = false;
  for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
    const star = Number(key);
    const n = Number(count);
    if (!Number.isFinite(star) || !Number.isFinite(n) || n <= 0) continue;
    out[String(star)] = n;
    any = true;
  }
  return any ? out : null;
}

function sortedEntries(dist: Record<string, number>): [number, number][] {
  return Object.entries(dist)
    .map(([star, count]) => [Number(star), Number(count)] as [number, number])
    .filter(([star, count]) => star > 0 && count > 0)
    .sort((a, b) => a[0] - b[0]);
}

// Population moments over the discrete star values. `skewness` is the third
// standardized moment; `kurtosis` is the EXCESS kurtosis (normal = 0). Both are
// null when the distribution has zero spread (all ratings identical), where the
// standardized moments are undefined.
export function computeRatingsStats(dist: Record<string, number> | null | undefined): RatingsStats | null {
  if (!dist) return null;
  const entries = sortedEntries(dist);
  if (entries.length === 0) return null;

  let total = 0;
  let weighted = 0;
  for (const [star, count] of entries) {
    total += count;
    weighted += star * count;
  }
  if (total <= 0) return null;

  const mean = weighted / total;

  let variance = 0;
  let m3 = 0;
  let m4 = 0;
  for (const [star, count] of entries) {
    const d = star - mean;
    variance += count * d * d;
    m3 += count * d * d * d;
    m4 += count * d * d * d * d;
  }
  variance /= total;
  const stddev = Math.sqrt(variance);

  // Median: smallest star where the cumulative count reaches half the total.
  let cumulative = 0;
  let median = entries[entries.length - 1][0];
  for (const [star, count] of entries) {
    cumulative += count;
    if (cumulative >= total / 2) {
      median = star;
      break;
    }
  }

  // Mode: highest count, ties broken toward the lower star value.
  let mode = entries[0][0];
  let modeCount = -1;
  for (const [star, count] of entries) {
    if (count > modeCount) {
      mode = star;
      modeCount = count;
    }
  }

  const skewness = stddev > 0 ? (m3 / total) / (stddev * stddev * stddev) : null;
  const kurtosis = stddev > 0 ? (m4 / total) / (stddev * stddev * stddev * stddev) - 3 : null;

  return {
    total,
    mean,
    median,
    mode,
    variance,
    stddev,
    skewness,
    kurtosis,
  };
}

// One-call helper for the DB write paths: parse a stored ratings_dist value and
// return the column payload. Never throws; an absent/invalid distribution maps
// to all-nulls so a write can't leave stale derived columns behind.
export function ratingsStatsColumns(rawDist: unknown): RatingsStatsColumns {
  const stats = computeRatingsStats(parseRatingsDist(rawDist));
  if (!stats) return NULL_COLUMNS;
  return {
    ratings_mean: stats.mean,
    ratings_median: stats.median,
    ratings_mode: stats.mode,
    ratings_variance: stats.variance,
    ratings_stddev: stats.stddev,
    ratings_skewness: stats.skewness,
    ratings_kurtosis: stats.kurtosis,
    ratings_total: stats.total,
  };
}
