import chalk from 'chalk';
import { getDb } from './db.js';
import { loadBookCache } from './storage.js';
import type { CachedBook } from './storage.js';
import { SERIES_POS_MULTI } from './seriesPos.js';
import { scrapeUserVoteBooks } from './scraper.js';
import type { UserVoteEntry } from './scraper.js';

export const MIN_RATINGS = 10000;
export const LIST_SIZE = 100;
export const DEFAULT_VOTE_REF = '7700658';

// Matches the "(Series Name, #N)" (or "... #N, Part M of K") suffix Goodreads
// appends to series books. Accepts both "(Name, #N)" and "(Name #N)" forms.
// Also strips trailing edition/format parentheticals (Hardcover, Paperback,
// [Dramatized Adaptation], etc.) that can precede or follow the series paren.
const EDITION_SUFFIX_RE = /(?:\(([^(){}]*?(?:edition|paperback|hardcover|dramatized|adaptation|ebook|audio|unabridged|boxed|omnibus|bundle|collection)[^(){}]*?)\)|\[[^\]]*(?:dramatized|adaptation|edition|audiobook|audio)[^\]]*\])\s*$/i;

// Returns the series name parsed from a Goodreads-style title suffix:
//   - "(Series Name, #N)" / "(Series Name #N)" / "(Series Name, #N, Part M of K)"
//   - manga "Vol. N" form, e.g. "... Tian Guan Ci Fu (Novel) Vol. 8"
// returns undefined for standalone / unparseable titles.
export function extractSeriesName(title: string): string | undefined {
  if (!title) return undefined;

  // Series bracket "(Series, #N)" — allows "(Name #N)" (no comma), a trailing
  // ", Part M of K" or other suffix, and any trailing "[...]" brackets.
  const seriesMatch = title.match(/^(.+?)\s*\(([^()]+?)\s*#\s*\d+(?:\.\d+)?(?:\s*-\s*#?\s*\d+)?(?:\s*,[^)]*)?\)\s*(?:\[[^\]]*\]\s*)*$/);
  if (seriesMatch) {
    const name = seriesMatch[2].trim().replace(/[,\s]+$/, '');
    if (name) return name;
  }

  // Manga volume form: title ends in ", Vol. N" / ", Volume N" (some have a
  // parenthetical format token directly before it, e.g. "(Novel) Vol. 8").
  // Derive the series as everything before the volume token.
  const cleanMangaBase = (base: string): string =>
    base
      .trim()
      .replace(/\s+(?:deluxe\s+edition|limited\s+edition|collector'?s?\s+edition|paperback|hardcover)\s*$/i, '');

  const volMatch = title.match(/^(.+?)\s*,\s*(?:volumes?|vol\.?|volume)\s*\d+(?:\s*-\s*\d+)?\s*$/i);
  if (volMatch) {
    const base = cleanMangaBase(volMatch[1]);
    if (base) return base;
  }
  const volMatchParen = title.match(/^(.+?)\s*\([^()]*\)\s*(?:volumes?|vol\.?|volume)\s*\d+(?:\s*-\s*\d+)?\s*$/i);
  if (volMatchParen) {
    const base = cleanMangaBase(volMatchParen[1]);
    if (base) return base;
  }
  // Manga volume + trailing format paren: "BASE, Vol. N (Paperback)".
  const volMatchFormat = title.match(/^(.+?)\s*,\s*(?:volumes?|vol\.?|volume)\s*\d+(?:\s*-\s*\d+)?\s*\([^()]*\)\s*$/i);
  if (volMatchFormat) {
    const base = cleanMangaBase(volMatchFormat[1]);
    if (base) return base;
  }

  return undefined;
}

// Normalize a series name so "The Stormlight Archive," / "the stormlight
// archive" / "The Stormlight Archive " collapse together.
export function normalizeSeriesName(name: string): string {
  const collapsed = name.toLowerCase().replace(/\s+/g, ' ').trim();
  return collapsed.replace(/^the\s+/, '');
}

// A book is considered a boxed/multi-volume set when its parsed series
// position is the MULTI sentinel (99.99), e.g. "Harry Potter Series Box Set
// (Harry Potter, #1-7)".
export function isBoxSet(book: CachedBook): boolean {
  return book.seriesPos === SERIES_POS_MULTI;
}

export interface RankedBook {
  book: CachedBook;
  rank: number;
  avgRating: number;
  ratings: number;
  seriesName?: string; // normalized series key, when the title carries one
}

export interface RankedResult {
  approved: RankedBook[];
  excluded: { book: CachedBook; reason: 'missing-work-id' | 'box-set' | 'duplicate-edition' | 'series' }[];
}

const parseNum = (s?: string): number => parseInt((s || '0').replace(/,/g, ''), 10) || 0;
const parseAvg = (s?: string): number => parseFloat(s || '0') || 0;

function isStandaloneLike(book: CachedBook): boolean {
  // Books with no series suffix in the title are treated as standalone.
  return extractSeriesName(book.title) === undefined;
}

// Edition-collapse key: editions of the same Goodreads work share a work_id,
// so the key is simply the work_id. (Eligible input is guaranteed to have one.)
function editionKey(b: CachedBook): string {
  if (b.workId) return `work::${b.workId}`;
  return `id::${b.id}`;
}

// Normalize a title for the edition-level fallback key: lowercase, strip a
// trailing "(Series, #N)"-style suffix, edition/format parentheticals, bracket
// tokens, and punctuation. Only used if a work_id is unexpectedly missing.
export function normalizeBaseTitle(title: string): string {
  const withoutSeries = title
    .replace(/\s*\([^()]*#[^()]*\)\s*$/i, '')
    .replace(/\s*\[[^\]]*\]\s*$/g, '')
    .replace(/\s*\([^()]*(?:edition|paperback|hardcover|ebook|audio|unabridged|adaptation|trilogy|boxed)[^()]*\)\s*$/i, '');
  return withoutSeries
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,'’"!?:;]/g, '')
    .trim();
}

// Eligible work-level snapshot: each editionKey keeps only its highest-average-
// rating representative edition; losing variants are reported as exclusions.
function representativePerWork(books: CachedBook[]): { winners: CachedBook[]; losers: CachedBook[] } {
  const best = new Map<string, CachedBook>();
  const losers: CachedBook[] = [];
  for (const book of books) {
    const k = editionKey(book);
    const cur = best.get(k);
    if (
      !cur ||
      parseAvg(book.avgRating) > parseAvg(cur.avgRating) ||
      (parseAvg(book.avgRating) === parseAvg(cur.avgRating) && parseNum(book.ratings) > parseNum(cur.ratings))
    ) {
      if (cur) losers.push(cur);
      best.set(k, book);
    } else {
      losers.push(book);
    }
  }
  return { winners: [...best.values()], losers };
}

// Build the top-N list per the rules:
//   1. books with >= minRatings ratings
//   2. exclude box sets (seriesPos == MULTI)
//   3. collapse edition variants of the same work (same normalized base title
//      + author, highest avg rating wins)
//   4. only one book (the highest-rated) per series; standalone books always
//      compete on their own.
// Rank by average rating (desc), ties broken by more ratings.
export function computeTopRated(
  books: CachedBook[],
  opts: { minRatings?: number; limit?: number } = {}
): RankedResult {
  const minRatings = opts.minRatings ?? MIN_RATINGS;
  const limit = opts.limit ?? LIST_SIZE;

  const eligible = books.filter(b => {
    if (b.isBad) return false;
    if (parseNum(b.ratings) < minRatings) return false;
    if (parseAvg(b.avgRating) <= 0) return false;
    return true;
  });

  // work_id is required: books without one can't be edition-deduped reliably,
  // so they're excluded (and reported) rather than ranked.
  const withWorkId: CachedBook[] = [];
  const excluded: RankedResult['excluded'] = [];
  for (const b of eligible) {
    if (b.workId) withWorkId.push(b);
    else excluded.push({ book: b, reason: 'missing-work-id' });
  }

  const representatives = representativePerWork(withWorkId);

  for (const b of representatives.losers) excluded.push({ book: b, reason: 'duplicate-edition' });
  const notBox: CachedBook[] = [];
  for (const b of representatives.winners) {
    if (isBoxSet(b)) excluded.push({ book: b, reason: 'box-set' });
    else notBox.push(b);
  }

  // One-per-series: group series books by normalized series name and keep the
  // highest avg rating; standalone books aren't grouped. Edition-duplicate
  // representatives have already been collapsed per workId above.
  const seriesBest = new Map<string, CachedBook>();
  const standalone: CachedBook[] = [];
  const seriesExcluded: CachedBook[] = [];
  for (const b of notBox) {
    const name = extractSeriesName(b.title);
    if (name === undefined) {
      standalone.push(b);
    } else {
      const key = normalizeSeriesName(name);
      const cur = seriesBest.get(key);
      if (
        !cur ||
        parseAvg(b.avgRating) > parseAvg(cur.avgRating) ||
        (parseAvg(b.avgRating) === parseAvg(cur.avgRating) && parseNum(b.ratings) > parseNum(cur.ratings))
      ) {
        if (cur) seriesExcluded.push(cur);
        seriesBest.set(key, b);
      } else {
        seriesExcluded.push(b);
      }
    }
  }
  for (const b of seriesExcluded) excluded.push({ book: b, reason: 'series' });

  const combined = [...standalone, ...seriesBest.values()];
  combined.sort(
    (a, b) => parseAvg(b.avgRating) - parseAvg(a.avgRating) || parseNum(b.ratings) - parseNum(a.ratings)
  );

  const approved: RankedBook[] = combined.slice(0, limit).map((book, i) => ({
    book,
    rank: i + 1,
    avgRating: parseAvg(book.avgRating),
    ratings: parseNum(book.ratings),
    seriesName: extractSeriesName(book.title) !== undefined ? normalizeSeriesName(extractSeriesName(book.title)!) : undefined,
  }));

  return { approved, excluded };
}

export interface TopRatedDiff {
  dropped: (UserVoteEntry & { currentRank?: number })[];
  additions: RankedBook[];
  moves: {
    position: number;
    targetRank: number;
    bookId: string;
    title: string;
    author: string;
  }[];
}

// Compare the books a user voted for (on the Listopia list) against the
// computed top-N. A voted book that is no longer in the top-N is "dropped"
// (with its current rank if still ranked); qualifying books not voted are
// "additions". Voted books whose vote position no longer matches their rank
// are "moves". The list has `limit` slots; only voted slots inside the first
// `limit` positions are considered.
export function diffTopRated(votes: UserVoteEntry[], ranked: RankedBook[], limit: number): TopRatedDiff {
  const rankByBookId = new Map<string, number>();
  for (const r of ranked) rankByBookId.set(r.book.id, r.rank);

  // Books occupying the first `limit` voted slots.
  const firstLimitVotes = votes.filter(v => v.position <= limit);
  const votedAtSlot = new Map<number, UserVoteEntry>();
  for (const v of firstLimitVotes) {
    const existing = votedAtSlot.get(v.position);
    if (!existing || (v.bookId && existing.bookId && v.bookId !== existing.bookId)) {
      // Last one wins per slot; dedupe exact (position, bookId) duplicates.
      votedAtSlot.set(v.position, v);
    }
  }
  const votedByBookId = new Map<string, UserVoteEntry>();
  for (const v of votedAtSlot.values()) {
    if (!votedByBookId.has(v.bookId)) votedByBookId.set(v.bookId, v);
  }

  const dropped: TopRatedDiff['dropped'] = [];
  for (const [bookId, vote] of votedByBookId) {
    const currentRank = rankByBookId.get(bookId);
    if (currentRank === undefined) {
      // In a voted slot but no longer ranked in the top-N.
      dropped.push({ ...vote, currentRank: undefined });
    }
  }

  const additions: RankedBook[] = [];
  const votedBookIdSet = new Set(votedByBookId.keys());
  for (const r of ranked) {
    if (!votedBookIdSet.has(r.book.id)) additions.push(r);
  }

  const moves: TopRatedDiff['moves'] = [];
  for (const v of firstLimitVotes) {
    const target = rankByBookId.get(v.bookId);
    if (target !== undefined && v.position !== target) {
      moves.push({
        position: v.position,
        targetRank: target,
        bookId: v.bookId,
        title: v.title,
        author: v.author,
      });
    }
  }
  moves.sort((a, b) => a.position - b.position);

  return { dropped: dropped.sort((a, b) => a.position - b.position), additions, moves };
}

export interface MonitorOptions {
  voteRef?: string;
  limit?: string | number;
  minRatings?: string | number;
  listId?: string;
}

export async function runMonitorTopRatedList(options: MonitorOptions = {}): Promise<void> {
  const limit = parseInt(String(options.limit ?? LIST_SIZE), 10) || LIST_SIZE;
  const minRatings = parseInt(String(options.minRatings ?? MIN_RATINGS), 10) || MIN_RATINGS;
  const voteRef = options.voteRef || DEFAULT_VOTE_REF;

  console.log(chalk.cyan.bold('\n🏆 Top 100 highest-rated books monitor'));
  console.log(chalk.gray('   Rules: ≥10,000 ratings, no box sets, one book (highest-rated) per series, work_id required'));
  console.log(chalk.gray(`   Rating cutoff: ${minRatings.toLocaleString()}+ ratings · list size: ${limit}`));
  console.log(chalk.gray('------------------------------------------'));

  const bookCache = loadBookCache();
  console.log(chalk.gray(`   Loaded ${Object.keys(bookCache).length.toLocaleString()} cached books.`));
  const books = Object.values(bookCache);

  const rc = computeTopRated(books, { minRatings, limit });
  const { approved, excluded } = rc;

  const nWorkId = excluded.filter(e => e.reason === 'missing-work-id').length;
  const nBox = excluded.filter(e => e.reason === 'box-set').length;
  const nSeries = excluded.filter(e => e.reason === 'series').length;
  const nDup = excluded.filter(e => e.reason === 'duplicate-edition').length;
  console.log(chalk.gray(`   ${approved.length} approved · ${nWorkId} no work_id excluded · ${nBox} box sets excluded · ${nSeries} series runners-up excluded · ${nDup} duplicate editions excluded`));
  console.log('');

  // ── Table ──────────────────────────────────────────────────────────
  const rankW = Math.max(String(limit).length, 4);
  const headerCell = (s: string, w: number) => s.padStart(w);
  const line = (cells: string[]) => cells.join(' | ');
  const header = line([
    headerCell('Rank', rankW),
    'Title'.padEnd(52),
    'Author'.padEnd(22),
    headerCell('Avg', 5),
    headerCell('Ratings', 9),
    'Series'.padEnd(22),
  ]);
  console.log(chalk.gray(header));
  console.log(chalk.gray('-'.repeat(header.length)));
  const fmt = (n: number) => n.toLocaleString('en-US');
  for (const r of approved) {
    const seriesLabel = r.seriesName || (extractSeriesName(r.book.title) ? normalizeSeriesName(extractSeriesName(r.book.title)!) : '—');
    console.log(
      line([
        headerCell(String(r.rank), rankW),
        r.book.title.slice(0, 52).padEnd(52),
        r.book.author.slice(0, 22).padEnd(22),
        headerCell(r.avgRating.toFixed(2), 5),
        headerCell(fmt(r.ratings), 9),
        seriesLabel.slice(0, 22).padEnd(22),
      ])
    );
  }
  console.log(chalk.gray('-'.repeat(header.length)));

  // ── Vote diff ──────────────────────────────────────────────────────
  console.log(chalk.gray('\n   Fetching your votes for this list...'));
  let votes: UserVoteEntry[] = [];
  try {
    votes = await scrapeUserVoteBooks(voteRef);
  } catch (error) {
    console.error(chalk.red.bold('   Failed to fetch votes page:'), (error as any).message);
    return;
  }
  console.log(chalk.gray(`   Found ${votes.length} voted books.`));

  const { dropped, additions, moves } = diffTopRated(votes, approved, limit);

  if (dropped.length === 0 && additions.length === 0 && moves.length === 0) {
    console.log(chalk.green.bold('\n✅ Your votes exactly match the computed top-' + limit + '. Nothing to change.'));
  }

  if (moves.length > 0) {
    console.log(chalk.blue.bold(`\n🔁 Out of position (${moves.length}):`));
    for (const m of moves) {
      console.log(`   #${String(m.position).padStart(3)} → #${String(m.targetRank).padStart(3)}: "${m.title}" by ${m.author}`);
    }
  }

  if (dropped.length > 0) {
    console.log(chalk.red.bold(`\n🗑️  Voted books no longer in the top ${limit} (${dropped.length}):`));
    for (const d of dropped) {
      const now = d.currentRank !== undefined ? `now #${d.currentRank}` : 'no longer ranked';
      console.log(`   ${String(d.position).padStart(4)}. "${d.title}" by ${d.author} ${chalk.gray(`— ${now}`)}`);
    }
  }

  if (additions.length > 0) {
    console.log(chalk.green.bold(`\n✨ Qualifying books missing from your votes (${additions.length}):`));
    for (const a of additions) {
      console.log(`   #${String(a.rank).padStart(4)}: "${a.book.title}" by ${a.book.author} ${chalk.gray(`(${fmt(a.ratings)} ratings, avg ${a.avgRating.toFixed(2)})`)}`);
    }
  }

  console.log('');
}