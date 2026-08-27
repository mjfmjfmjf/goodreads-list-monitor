import chalk from 'chalk';
import { loadBookCache, loadAuthorCache } from './storage.js';
import type { CachedBook, AuthorCache } from './storage.js';

export interface AuthorOrphan {
  rawName: string;
  normalizedName: string;
  authorId?: string;
  topTitle: string;
  topRatings: number;
  knownSlug: boolean;
  category: OrphanCategory;
}

export type OrphanCategory = 'concat' | 'no-id' | 'missing';

export interface AuthorOrphansOptions {
  limit?: string;
  minRatings?: string;
  maxRatings?: string;
  inspect?: boolean;
}

const parseRatings = (b?: CachedBook): number =>
  parseInt((b?.ratings || '0').replace(/,/g, ''), 10) || 0;

// Normalize a book-cache author string. Phase 0 keeps this conservative:
// collapse whitespace, trim, strip a trailing "Unknown Author"/"Unknown"/"n/a".
// Multi-author concatenation splitting is intentionally NOT guessed here — it
// surfaces as a review flag instead.
export function normalizeAuthorName(raw: string): string {
  let s = (raw || '').trim().replace(/\s+/g, ' ');
  s = s.replace(/(\s+unknown(\s+author)?|\s+n\/a|\s+null)$/i, '');
  s = s.trim();
  return s;
}

// Heuristic for "this looks like multiple authors concatenated into one string"
// without a separator — e.g. "Jane AustenAnthea Bell", "John  GreenJeff Woodman".
// We do NOT try to split it; we only flag it so the user can review those
// separately from genuinely-missing single authors.
export function looksLikeNameConcat(s: string): boolean {
  const n = normalizeAuthorName(s);
  // Detect a run-together boundary: a letter/digit immediately followed by an
  // uppercase letter where a space/separator normally belongs. E.g.
  // "AustenAnthea" -> nA, "SteinbeckJames" -> kJ, "MichenerHelen" -> rH.
  // A normal "First Last" has a space there, so it won't match.
  return /[a-zÀ-ÿ0-9'][A-ZÀ-Þ]/.test(n);
}

// Classify an orphan into one of three actionable buckets.
//   concat  -> a single string that appears to hold multiple author names
//   no-id   -> clean-ish single name but NO authorId (can't build a URL from id)
//   missing -> a single, genuinely-uncached author WITH an authorId we can scrape
export function classifyOrphan(o: Pick<AuthorOrphan, 'rawName' | 'normalizedName' | 'authorId'>): OrphanCategory {
  const n = o.normalizedName;
  if (looksLikeNameConcat(n)) return 'concat';
  if (!o.authorId) return 'no-id';
  return 'missing';
}

// Build a Goodreads author URL from just the authorId. You only type the id in
// the browser; Goodreads supplies the slug segment itself when it redirects.
export function authorListUrl(o: Pick<AuthorOrphan, 'authorId'>): string | undefined {
  const id = o.authorId;
  if (!id) return undefined;
  return `https://www.goodreads.com/author/show/${id}`;
}

// Collapse distinct dirty author strings that normalize to the same key, so we
// don't list the same real author twice (e.g. "John  Green" and "John Green").
export function selectAuthorOrphans(
  books: CachedBook[],
  authorCache: AuthorCache
): { orphans: AuthorOrphan[]; knownSlugs: Map<string, string> } {
  // (authorId?) -> { rawName, topTitle, topRatings }
  const byId = new Map<string, { rawName: string; topTitle: string; topRatings: number }>();

  // authorId -> slug index from the author cache, so an author already hosted
  // there (under any name key, e.g. exact or differently-spaced key) is not
  // reported as a fresh orphan. This is what prevents the "John  Green" false
  // positive: the same id 1406384 already lives in the cache.
  const knownByAuthorId = new Map<string, string>();
  for (const entry of Object.values(authorCache)) {
    if (entry.id) knownByAuthorId.set(String(entry.id), entry.slug);
  }

  for (const book of books) {
    const raw = (book.author || '').trim();
    if (!raw || raw.toLowerCase() === 'unknown author') continue;
    // Already a known author-cache key (raw or whitespace-normalized), OR the
    // same authorId is hosted there. Covers both the "John  Green" (has id)
    // and "Michael  Grant" + missing authorId (no id to match) false orphans.
    if (authorCache[raw]) continue;
    if (authorCache[normalizeAuthorName(raw)]) continue;
    const r = parseRatings(book);
    if (book.authorId && knownByAuthorId.has(String(book.authorId))) continue;
    const id = book.authorId ?? raw;
    const cur = byId.get(id);
    if (!cur || r > cur.topRatings) {
      byId.set(id, { rawName: raw, topTitle: book.title, topRatings: r });
    }
  }

  const orphans: AuthorOrphan[] = [];
  for (const [id, v] of byId) {
    const normalizedName = normalizeAuthorName(v.rawName);
    const orphan: AuthorOrphan = {
      rawName: v.rawName,
      normalizedName,
      authorId: id !== v.rawName ? id : undefined,
      topTitle: v.topTitle,
      topRatings: v.topRatings,
      knownSlug: false,
      category: 'missing',
    };
    orphan.category = classifyOrphan(orphan);
    orphans.push(orphan);
  }

  return { orphans, knownSlugs: new Map() };
}

export function applyOrphanFilters(
  orphans: AuthorOrphan[],
  options: AuthorOrphansOptions
): AuthorOrphan[] {
  let out = orphans;
  const min = options.minRatings !== undefined ? parseInt(options.minRatings.replace(/,/g, ''), 10) || 0 : 0;
  const max = options.maxRatings !== undefined ? parseInt(options.maxRatings.replace(/,/g, ''), 10) || 0 : Infinity;
  if (min > 0) out = out.filter(o => o.topRatings >= min);
  if (max !== Infinity) out = out.filter(o => o.topRatings <= max);

  out = out.slice().sort((a, b) => b.topRatings - a.topRatings || a.rawName.localeCompare(b.rawName));

  const limit = options.limit ? parseInt(options.limit, 10) : 50;
  return out.slice(0, limit);
}

// Mark each orphan whose authorId matches an already-known author-cache slug.
// This is the cross-run dedup signal: those aren't really "missing".
export function annotateKnownSlugs(
  orphans: AuthorOrphan[],
  authorCache: AuthorCache
): void {
  // Phase 0: we can't resolve authorId -> slug without network/DB slug store,
  // so only flag exact name-key matches (already excluded) — left as a no-op
  // placeholder until the authorId->slug resolution ships (Phase 1).
  for (const o of orphans) {
    o.knownSlug = !!authorCache[o.normalizedName];
  }
}

const formatNum = (n: number): string => n.toLocaleString('en-US');

const CATEGORY_LABEL: Record<OrphanCategory, string> = {
  concat: 'multi-author',
  'no-id': 'no author id',
  missing: 'genuinely missing',
};

const CATEGORY_COLOR: Record<OrphanCategory, (s: string) => string> = {
  concat: s => chalk.red(s),
  'no-id': s => chalk.yellow(s),
  missing: s => chalk.green(s),
};

export async function runAuthorOrphans(options: AuthorOrphansOptions = {}): Promise<void> {
  const bookCache = await loadBookCache();
  const authorCache = await loadAuthorCache();

  const books = Object.values(bookCache);
  const { orphans } = selectAuthorOrphans(books, authorCache);
  const filtered = applyOrphanFilters(orphans, options);
  annotateKnownSlugs(filtered, authorCache);
  const inspect = !!options.inspect;

  console.log(chalk.cyan.bold('\n📇 Book-cache authors missing from the author cache'));
  console.log(chalk.gray(`   Distinct orphan authors (normalized): ${formatNum(orphans.length)} · showing ${formatNum(filtered.length)} (by top book rating, desc)${inspect ? ' · --inspect' : ''}`));

  if (filtered.length === 0) {
    console.log(chalk.yellow('   No orphans match the criteria.'));
    return;
  }

  // Bucket breakout (over ALL orphans, not just the shown slice).
  const bucketCounts: Record<OrphanCategory, number> = { concat: 0, 'no-id': 0, missing: 0 };
  for (const o of orphans) bucketCounts[o.category]++;
  const bump = filtered.length < orphans.length
    ? ` (of ${formatNum(orphans.length)} total: ` +
      `[${CATEGORY_COLOR.concat(CATEGORY_LABEL.concat)} ${formatNum(bucketCounts.concat)}, ` +
      `${CATEGORY_COLOR['no-id'](CATEGORY_LABEL['no-id'])} ${formatNum(bucketCounts['no-id'])}, ` +
      `${CATEGORY_COLOR.missing(CATEGORY_LABEL.missing)} ${formatNum(bucketCounts.missing)}])`
    : `  [${CATEGORY_COLOR.concat(CATEGORY_LABEL.concat)} ${formatNum(bucketCounts.concat)}, ` +
      `${CATEGORY_COLOR['no-id'](CATEGORY_LABEL['no-id'])} ${formatNum(bucketCounts['no-id'])}, ` +
      `${CATEGORY_COLOR.missing(CATEGORY_LABEL.missing)} ${formatNum(bucketCounts.missing)}]`;
  console.log(chalk.gray(`   Buckets: ${bump}`));
  console.log(chalk.gray(`   Legend: ${CATEGORY_COLOR.concat('multi-author (concat string)')} · ${CATEGORY_COLOR['no-id']('no author id')} · ${CATEGORY_COLOR.missing('genuinely missing, scrapeable')}`));

  const RANK = 'RANK'.length;
  const IDW = Math.max('AUTHOR ID'.length, ...filtered.map(o => (o.authorId || '-').length));
  const NAME = Math.max('AUTHOR (NORMALIZED)'.length, ...filtered.map(o => o.normalizedName.length));
  const RCTX = Math.max('RATINGS'.length, ...filtered.map(o => formatNum(o.topRatings).length));

  console.log(chalk.gray('-'.repeat(RANK + 2 + IDW + 2 + NAME + 2 + RCTX + 2 + 12)));
  console.log(
    chalk.white(
      'RANK'.padEnd(RANK) + '  ' +
      'AUTHOR ID'.padEnd(IDW) + '  ' +
      'AUTHOR (NORMALIZED)'.padEnd(NAME) + '  ' +
      'RATINGS'.padStart(RCTX) + '  ' +
      'TYPE'.padEnd(16)
    )
  );
  console.log(chalk.gray('-'.repeat(RANK + 2 + IDW + 2 + NAME + 2 + RCTX + 2 + 12)));

  filtered.forEach((o, i) => {
    const url = inspect ? authorListUrl(o) : undefined;
    console.log(
      `${String(i + 1).padEnd(RANK)}  ` +
      `${chalk.gray((o.authorId || '-').padEnd(IDW))}  ` +
      `${chalk.white(o.normalizedName.padEnd(NAME))}  ` +
      `${chalk.yellow(formatNum(o.topRatings).padStart(RCTX))}  ` +
      `${CATEGORY_COLOR[o.category](CATEGORY_LABEL[o.category]).padEnd(16)}` +
      (url ? `\n     ${chalk.cyan(url)}` : `\n     ${chalk.gray(`(no authorId — cannot build a scrape URL; needs name search)`)}`)
    );
  });

  console.log(chalk.gray('-'.repeat(RANK + 2 + IDW + 2 + NAME + 2 + RCTX + 2 + 12)));
  console.log(chalk.cyan.bold(`Orphans: ${formatNum(orphans.length)}`));
}
