import chalk from 'chalk';
import { getDb } from './db.ts';
import { hasBookPageTable } from './bookPageGaps.ts';

export type FacetName = 'language' | 'format';

export interface FacetSpec {
  column: 'language' | 'format';
  label: string;
  icon: string;
  npmScript: string;
  wrapper: string;
}

// Whitelisted column names only — these strings are interpolated into SQL, so
// this table is the single gate that keeps that safe.
export const FACETS: Record<FacetName, FacetSpec> = {
  language: {
    column: 'language',
    label: 'Languages',
    icon: '🌍',
    npmScript: 'book-languages',
    wrapper: 'bookLanguages.sh',
  },
  format: {
    column: 'format',
    label: 'Formats',
    icon: '📦',
    npmScript: 'book-formats',
    wrapper: 'bookFormats.sh',
  },
};

export const FACET_NAMES = Object.keys(FACETS) as FacetName[];

export function isFacetName(value: string): value is FacetName {
  return (FACET_NAMES as string[]).includes(value);
}

// Goodreads writes these as literal "we don't know" values rather than NULL.
// They are not real languages/formats, so they never belong in a ranking.
const PLACEHOLDER_VALUES = new Set([
  'unknown',
  'unknown binding',
  'unknown format',
  'n/a',
  'na',
  '-',
  'none',
]);

export interface FacetCatalogOptions {
  limit?: string;
  sortBy?: string;
  minRatings?: string;
  minBooks?: string;
  raw?: boolean;
}

export interface FacetBookRow {
  facetValue: string;
  workKey: string;
  ratings: number;
  avgRating: number | null;
}

export interface RankedFacet {
  value: string;
  works: number;
  totalRatings: number;
  avgRating: number | null;
  variants: string[];
}

export const SORT_FIELDS = ['books', 'avgRating', 'totalRatings'] as const;
export type FacetSortField = (typeof SORT_FIELDS)[number];

const SORT_LABELS: Record<FacetSortField, string> = {
  books: 'Number of Books',
  avgRating: 'Average Rating',
  totalRatings: 'Total Ratings',
};

// `book_page.format` is whatever string the page carried, so the tail is messy:
// 'Paperback', 'paperback' and 'Paperback ' are the same format split three ways.
// Trim + collapse inner whitespace always; case-fold unless --raw, since
// case variants are never a meaningful distinction in this data.
export function normalizeFacetValue(value: string, foldCase = true): string {
  const collapsed = value.trim().replace(/\s+/g, ' ');
  if (!foldCase) return collapsed;
  // Keep the most common casing later; here just produce a stable comparison key.
  return collapsed.toLowerCase();
}

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_VALUES.has(value.trim().replace(/\s+/g, ' ').toLowerCase());
}

// Same work-dedup rule as publisherCatalog: editions of one work collapse, and
// each (facet, work) is represented by its highest-rated edition so counts and
// average ratings aren't inflated by duplicates.
export function computeFacetCatalog(
  rows: FacetBookRow[],
  options: FacetCatalogOptions = {}
): RankedFacet[] {
  const sortBy = (options.sortBy || 'books') as FacetSortField;
  const minRatings = parseInt((options.minRatings || '0').replace(/,/g, ''), 10) || 0;
  const minWorks = parseInt(options.minBooks || '1', 10) || 1;
  const foldCase = !options.raw;

  const reps = new Map<string, FacetBookRow>();
  for (const row of rows) {
    if (row.ratings < minRatings) continue;
    const key = `${normalizeFacetValue(row.facetValue, foldCase)}\u001f${row.workKey}`;
    const prev = reps.get(key);
    if (
      !prev ||
      row.ratings > prev.ratings ||
      (row.ratings === prev.ratings && (row.avgRating ?? 0) > (prev.avgRating ?? 0))
    ) {
      reps.set(key, { ...row });
    }
  }

  // Folded key -> accumulator, tracking which raw spellings fed it.
  const buckets = new Map<
    string,
    {
      display: string;
      counts: Map<string, number>;
      works: number;
      totalRatings: number;
      avgSum: number;
      avgCount: number;
    }
  >();

  for (const rep of reps.values()) {
    const key = normalizeFacetValue(rep.facetValue, foldCase);
    if (!key || isPlaceholder(rep.facetValue)) continue;
    let b = buckets.get(key);
    if (!b) {
      b = { display: rep.facetValue, counts: new Map(), works: 0, totalRatings: 0, avgSum: 0, avgCount: 0 };
      buckets.set(key, b);
    }
    b.works += 1;
    b.totalRatings += rep.ratings;
    if (rep.avgRating != null) {
      b.avgSum += rep.avgRating;
      b.avgCount += 1;
    }
    const raw = rep.facetValue.trim().replace(/\s+/g, ' ');
    b.counts.set(raw, (b.counts.get(raw) ?? 0) + 1);
  }

  const out: RankedFacet[] = [];
  for (const b of buckets.values()) {
    if (b.works < minWorks) continue;
    const spellings = [...b.counts.entries()].sort((x, y) => y[1] - x[1]);
    out.push({
      // Prefer the most frequent spelling as the display label.
      value: spellings[0]?.[0] ?? b.display,
      works: b.works,
      totalRatings: b.totalRatings,
      avgRating: b.avgCount > 0 ? b.avgSum / b.avgCount : null,
      variants: spellings.slice(1).map((s) => s[0]),
    });
  }

  const avg = (f: RankedFacet): number => f.avgRating ?? -1;
  out.sort((a, b) => {
    if (sortBy === 'books') {
      if (a.works !== b.works) return b.works - a.works;
      if (a.totalRatings !== b.totalRatings) return b.totalRatings - a.totalRatings;
    } else if (sortBy === 'avgRating') {
      if (avg(a) !== avg(b)) return avg(b) - avg(a);
      if (a.works !== b.works) return b.works - a.works;
    } else {
      if (a.totalRatings !== b.totalRatings) return b.totalRatings - a.totalRatings;
      if (a.works !== b.works) return b.works - a.works;
    }
    return a.value.localeCompare(b.value);
  });

return out;
}

export function loadFacetRows(facet: FacetName): FacetBookRow[] {
  const db = getDb();
  const column = FACETS[facet].column;
  const rows = db.prepare(`
    SELECT bp.${column} AS facet_value,
           COALESCE(NULLIF(b.work_id, ''), b.id) AS work_key,
           b.ratings AS ratings,
           b.avg_rating AS avg_rating
    FROM book_page bp
    JOIN books b ON b.id = bp.book_id
    WHERE bp.${column} IS NOT NULL AND bp.${column} <> ''
      AND b.is_bad = 0
  `).all() as any[];
  return rows.map((r) => ({
    facetValue: String(r.facet_value),
    workKey: String(r.work_key),
    ratings: Number(r.ratings) || 0,
    avgRating: r.avg_rating != null ? Number(r.avg_rating) : null,
  }));
}

export async function runFacetCatalog(facet: FacetName, options: FacetCatalogOptions = {}): Promise<void> {
  const spec = FACETS[facet];
  if (!hasBookPageTable()) {
    console.error(chalk.red.bold('The book_page table does not exist — no browser book-page scrapes have run yet.'));
    return;
  }

  const sortBy = (options.sortBy || 'books') as FacetSortField;
  if (!SORT_FIELDS.includes(sortBy as any)) {
    console.error(chalk.red.bold(`Error: --sortBy must be one of: ${SORT_FIELDS.join(', ')}`));
    process.exit(1);
  }

  const minRatings = parseInt((options.minRatings || '0').replace(/,/g, ''), 10) || 0;
  const minWorks = parseInt(options.minBooks || '1', 10) || 1;
  const limit = parseInt(options.limit || '25', 10);
  const foldCase = !options.raw;

  const allRows = loadFacetRows(facet);
  const distinctRaw = new Set(allRows.map((r) => r.facetValue.trim().replace(/\s+/g, ' '))).size;
  const rankedAll = computeFacetCatalog(allRows, options);
  const ranked = rankedAll.slice(0, limit);

  console.log(chalk.cyan.bold(`\n${spec.icon} Top ${spec.label} by ${SORT_LABELS[sortBy]}`));
  console.log(
    chalk.gray(
      `   Criteria: Min Books: ${minWorks.toLocaleString()} distinct works, Min Ratings: ${minRatings.toLocaleString()} per work`
    )
  );
  console.log(
    chalk.gray(
      `   Showing ${ranked.length.toLocaleString()} of ${rankedAll.length.toLocaleString()} entries from ${allRows.length.toLocaleString()} scraped rows`
    )
  );
  console.log(
    chalk.gray(
      `   ${distinctRaw.toLocaleString()} distinct raw values → ${rankedAll.length.toLocaleString()} ${foldCase ? 'after folding' : 'kept as-is (--raw)'} · placeholder values excluded`
    )
  );
  console.log(chalk.gray('------------------------------------------'));

  if (ranked.length === 0) {
    console.log(chalk.yellow(`   No ${facet === 'language' ? 'languages' : 'formats'} found matching the criteria.`));
    return;
  }

  for (let i = 0; i < ranked.length; i++) {
    const f = ranked[i];
    const avg = f.avgRating != null ? `Avg Rating: ${chalk.green.bold(f.avgRating.toFixed(2))}` : 'Avg Rating: N/A';
    const works = `Books: ${chalk.yellow(f.works.toLocaleString())}`;
    const total = f.totalRatings > 0 ? `Total Ratings: ${chalk.gray(f.totalRatings.toLocaleString())}` : 'Total Ratings: N/A';
    const variants =
      f.variants.length > 0
        ? `\n      ${chalk.gray(`also: ${f.variants.slice(0, 4).join(', ')}${f.variants.length > 4 ? ` (+${f.variants.length - 4})` : ''}`)}`
        : '';
    console.log(`${(i + 1).toString().padStart(4, ' ')}. ${f.value}\n      ${works}, ${avg}, ${total}${variants}`);
  }

  console.log(chalk.gray('------------------------------------------'));
}