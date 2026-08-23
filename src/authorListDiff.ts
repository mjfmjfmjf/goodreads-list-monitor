import chalk from 'chalk';
import { loadAuthorCache, loadBookCache } from './storage.js';
import type { AuthorCacheEntry, CachedBook } from './storage.js';
import { selectAuthors } from './authorTopStats.js';
import type { SelectedAuthor, AuthorTopStatsOptions } from './authorTopStats.js';
import { scrapeUserVoteBooks } from './scraper.js';
import type { UserVoteEntry } from './scraper.js';

export interface RankedAuthor {
  name: string;
  slug?: string;
  id?: string;
  rank: number;
  entry: AuthorCacheEntry;
}

// The author cache is keyed by name, so whitespace-mangled name variants can
// produce multiple entries for the same author (same slug). Collapse those
// duplicates by author identity (id, falling back to slug) and assign fresh,
// gap-free ranks in the incoming sort order.
export function dedupeAuthorsBySlug(selected: SelectedAuthor[]): RankedAuthor[] {
  const seen = new Set<string>();
  const ranked: RankedAuthor[] = [];
  for (const { name, entry } of selected) {
    const key = entry.id || entry.slug?.split('.')[0] || '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    ranked.push({ name, slug: entry.slug, id: entry.id, rank: ranked.length + 1, entry });
  }
  return ranked;
}

function authorKey(idOrSlug: string | undefined): string {
  return String(idOrSlug || '').trim();
}

// ── Paste-ready reference formatting ──────────────────────────────────────
// The list comment supports wiki-style links:
//   [author:John Lewis|6429079]   [book:March: The Trilogy|29844341]
// Book link text drops a trailing series parenthetical ("(Series, #2)").

const SERIES_SUFFIX_RE = /\s*\([^()]*,\s*#\d+(?:[-–]\d+)*\)\s*$/;

// Link text must not contain raw square brackets or it nests inside the
// [author:...|id] / [book:...|id] syntax itself; render them as parens.
const safeLinkText = (text: string): string => text.replace(/\[/g, '(').replace(/\]/g, ')');

export function stripSeriesSuffix(title: string): string {
  const stripped = title.replace(SERIES_SUFFIX_RE, '').trim();
  return stripped || title.trim();
}

export function formatAuthorRef(author: { name: string; id?: string }): string {
  return author.id ? `[author:${safeLinkText(author.name)}|${author.id}]` : author.name;
}

export function formatBookRef(book: { title: string; id?: string }): string {
  return book.id ? `[book:${safeLinkText(stripSeriesSuffix(book.title))}|${book.id}]` : book.title;
}

export interface DroppedAuthor {
  position: number;
  bookId: string;
  title: string;
  author: string;
  authorId?: string;
  currentRank?: number;
}

export interface ListDiff {
  dropped: DroppedAuthor[];
  additions: RankedAuthor[];
}

// Compare the authors currently represented on a Listopia list (via vote
// entries) against a deduped author ranking. `limit` is the list size: an
// author is considered "on" the list only while inside the top `limit`.
export function diffVotesVsRanking(votes: UserVoteEntry[], ranked: RankedAuthor[], limit: number): ListDiff {
  const topIds = new Set<string>();
  for (const r of ranked.slice(0, limit)) {
    topIds.add(authorKey(r.id));
    if (r.slug) topIds.add(authorKey(r.slug));
  }

  const rankByKey = new Map<string, number>();
  for (const r of ranked) {
    rankByKey.set(authorKey(r.id), r.rank);
    if (r.slug) rankByKey.set(authorKey(r.slug), r.rank);
  }

  const dropped: DroppedAuthor[] = [];
  const votedKeys = new Set<string>();
  for (const vote of votes) {
    const keys = [vote.authorId, vote.authorSlug].map(authorKey).filter(Boolean);
    for (const k of keys) votedKeys.add(k);
    if (!keys.some(k => topIds.has(k))) {
      dropped.push({
        position: vote.position,
        bookId: vote.bookId,
        title: vote.title,
        author: vote.author,
        authorId: vote.authorId,
        currentRank: keys.map(k => rankByKey.get(k)).find(v => v !== undefined),
      });
    }
  }
  dropped.sort((a, b) => a.position - b.position);

  const additions = ranked.slice(0, limit).filter(r => {
    const keys = [r.id, r.slug].map(authorKey).filter(Boolean);
    return !keys.some(k => votedKeys.has(k));
  });

  return { dropped, additions };
}

// Pick the cached book with the most ratings for an author id. Bad books are
// excluded; ties break on higher average rating, then title.
export function pickTopBook(books: CachedBook[], authorId: string): CachedBook | undefined {
  const parseNum = (s?: string): number => parseInt((s || '0').replace(/,/g, ''), 10) || 0;

  let best: CachedBook | undefined;
  for (const book of books) {
    if (!book.authorId || book.authorId !== authorId) continue;
    if (book.isBad) continue;
    if (
      !best ||
      parseNum(book.ratings) > parseNum(best.ratings) ||
      (parseNum(book.ratings) === parseNum(best.ratings) &&
        (parseFloat(book.avgRating || '0') > parseFloat(best.avgRating || '0') ||
          (parseFloat(book.avgRating || '0') === parseFloat(best.avgRating || '0') &&
            book.title.localeCompare(best.title) < 0)))
    ) {
      best = book;
    }
  }
  return best;
}

// A suggestion should be the author's highest-rated book that has at least
// this many ratings; below the bar, ratings counts are too thin to trust.
export const SUGGESTION_MIN_RATINGS = 1000;

const bookRatingsCount = (b: CachedBook): number => parseInt((b.ratings || '').replace(/,/g, ''), 10) || 0;
const bookAvgScore = (b: CachedBook): number => parseFloat(b.avgRating || '0') || 0;

export interface BookSuggestion {
  book?: CachedBook;
  // true when the pick met SUGGESTION_MIN_RATINGS; false means it is a
  // fallback (most-rated book available) because nothing cleared the bar.
  qualified: boolean;
}

// Highest average rating among books with >= minRatings (ties: more ratings,
// then title). If no book clears the bar, fall back to the most-rated one and
// flag it so callers can mark the suggestion as low-confidence.
export function pickSuggestionBook(books: CachedBook[], authorId: string, minRatings: number = SUGGESTION_MIN_RATINGS): BookSuggestion {
  const eligible = books.filter(b => b.authorId === authorId && !b.isBad);
  const strong = eligible.filter(b => bookRatingsCount(b) >= minRatings);
  if (strong.length > 0) {
    const best = [...strong].sort((a, b) =>
      bookAvgScore(b) - bookAvgScore(a) ||
      bookRatingsCount(b) - bookRatingsCount(a) ||
      a.title.localeCompare(b.title)
    )[0];
    return { book: best, qualified: true };
  }
  return { book: pickTopBook(eligible, authorId), qualified: false };
}

// Assign each addition to a freed slot: best-ranked author gets the lowest
// freed position; overflow goes past maxPosition.
export function assignSuggestedPositions(additionsCount: number, freedPositions: number[], maxPosition: number): number[] {
  const sorted = [...freedPositions].sort((a, b) => a - b);
  const positions: number[] = [];
  for (let i = 0; i < additionsCount; i++) {
    positions.push(i < sorted.length ? sorted[i] : maxPosition + i - sorted.length + 1);
  }
  return positions;
}

// ── Move / replace detection ──────────────────────────────────────────────

export interface MoveInstruction {
  position: number; // the slot the vote currently occupies ("from")
  targetRank: number; // where the author ranks live now ("to")
  bookId: string;
  title: string;
  author: string;
  authorId?: string;
}

// Voted authors still inside the top `limit` whose vote slot no longer matches
// their live rank need to be moved.
export function computeMoves(votes: UserVoteEntry[], ranked: RankedAuthor[], limit: number): MoveInstruction[] {
  const rankByKey = new Map<string, number>();
  for (const r of ranked) {
    if (r.rank > limit) continue;
    rankByKey.set(authorKey(r.id), r.rank);
    if (r.slug) rankByKey.set(authorKey(r.slug), r.rank);
  }

  const moves: MoveInstruction[] = [];
  for (const vote of votes) {
    const keys = [vote.authorId, vote.authorSlug].map(authorKey).filter(Boolean);
    const target = keys.map(k => rankByKey.get(k)).find(v => v !== undefined);
    if (target !== undefined && vote.position !== target) {
      moves.push({
        position: vote.position,
        targetRank: target,
        bookId: vote.bookId,
        title: vote.title,
        author: vote.author,
        authorId: vote.authorId,
      });
    }
  }
  return moves.sort((a, b) => a.targetRank - b.targetRank);
}

export interface ReplacementInstruction {
  position: number;
  votedBook: { id: string; title: string };
  suggestedBook: CachedBook;
  author: string;
  authorId?: string;
}

// Staying authors whose voted book is not their best qualified candidate
// (highest-rated with >= minRatings) could swap in that better book without
// changing position. Only confident picks qualify — never a fallback pick.
export function computeReplacements(
  votes: UserVoteEntry[],
  ranked: RankedAuthor[],
  limit: number,
  booksByAuthor: Map<string, CachedBook[]>,
  minRatings: number = SUGGESTION_MIN_RATINGS
): ReplacementInstruction[] {
  const moves = computeMoves(votes, ranked, limit);
  const moveTargets = new Set(moves.map(m => m.bookId));

  const replacements: ReplacementInstruction[] = [];
  for (const vote of votes) {
    if (moveTargets.has(vote.bookId)) continue;
    const keys = [vote.authorId, vote.authorSlug].map(authorKey).filter(Boolean);
    const authorId = keys.find(k => /^\d+$/.test(k));
    if (!authorId) continue;
    const suggestion = pickSuggestionBook(booksByAuthor.get(authorId) || [], authorId, minRatings);
    if (!suggestion.qualified || !suggestion.book) continue;
    if (suggestion.book.id === vote.bookId) continue;
    replacements.push({
      position: vote.position,
      votedBook: { id: vote.bookId, title: vote.title },
      suggestedBook: suggestion.book,
      author: vote.author,
      authorId: vote.authorId,
    });
  }

  return replacements.sort((a, b) => a.position - b.position);
}

// True when we have captured stats for this author. Authors without stats
// are invisible to the ranking, so a "dropped" verdict for them is unreliable.
export function authorStatsPresent(entry: AuthorCacheEntry | undefined): boolean {
  return Boolean(entry && entry.averageRating && entry.numRatings);
}

const formatRatings = (n: number): string => n.toLocaleString('en-US');

async function runAuthorListDiff(options: AuthorTopStatsOptions & { userVoteUrl?: string }): Promise<void> {
  const userVoteRef = options.userVoteUrl || '10400982';
  const sortBy = options.sortBy || 'averageRating';
  const minRatings = options.minRatings || '100000';
  const limit = options.limit ? parseInt(options.limit, 10) : 100;

  console.log(chalk.cyan.bold(`\n📋 Author/List membership check`));
  console.log(chalk.gray(`   Votes page: ${userVoteRef}`));
  console.log(chalk.gray(`   Ranking: top ${limit} authors by ${sortBy} (min ratings ${minRatings})`));
  console.log(chalk.gray('------------------------------------------'));

  console.log(chalk.gray('   Loading author ranking...'));
  const authorCache = await loadAuthorCache();
  // Rank well past the cutoff so we can report where dropped authors landed.
  const { authors: selected } = selectAuthors(authorCache, { sortBy, minRatings, limit: '1000000' });
  const ranked = dedupeAuthorsBySlug(selected);

  console.log(chalk.gray(`   Fetching votes page...`));
  const votes = await scrapeUserVoteBooks(userVoteRef);
  console.log(chalk.gray(`   Found ${votes.length} voted books.`));

  const { dropped, additions } = diffVotesVsRanking(votes, ranked, limit);

  // Split dropped into authors we can judge (stats cached) and ones whose
  // stats were never captured — the latter must not get removal directions,
  // only a nudge to fetch their stats first.
  const entryById = new Map<string, AuthorCacheEntry>();
  for (const entry of Object.values(authorCache)) {
    if (entry.id) entryById.set(String(entry.id), entry);
  }
  const verifiable: DroppedAuthor[] = [];
  const unverifiable: DroppedAuthor[] = [];
  for (const d of dropped) {
    (d.authorId && !authorStatsPresent(entryById.get(d.authorId)) ? unverifiable : verifiable).push(d);
  }

  console.log(chalk.gray('   Resolving suggested books...'));
  const bookCache = await loadBookCache();
  const booksByAuthor = new Map<string, CachedBook[]>();
  for (const book of Object.values(bookCache)) {
    if (!book.authorId) continue;
    const list = booksByAuthor.get(book.authorId);
    if (list) list.push(book);
    else booksByAuthor.set(book.authorId, [book]);
  }

  const freedPositions = verifiable.map(d => d.position);
  const maxPosition = Math.max(limit, ...votes.map(v => v.position));
  const suggestedPositions = assignSuggestedPositions(additions.length, freedPositions, maxPosition);
  const moves = computeMoves(votes, ranked, limit);
  const replacements = computeReplacements(votes, ranked, limit, booksByAuthor);

  if (
    verifiable.length === 0 && unverifiable.length === 0 &&
    additions.length === 0 && moves.length === 0 && replacements.length === 0
  ) {
    console.log(chalk.green.bold('\n✅ List matches the current top ' + limit + '. Nothing to change.'));
    return;
  }

  const suggestionText = (book: CachedBook | undefined, qualified: boolean): string => {
    if (!book) return chalk.yellow('no rated book found in book db');
    const ratings = formatRatings(bookRatingsCount(book));
    const flag = qualified ? '' : chalk.yellow(` ⚠️ below ${formatRatings(SUGGESTION_MIN_RATINGS)} ratings`);
    return `"${book.title}" [ID: ${book.id}]` + chalk.gray(` (${ratings} ratings, avg ${book.avgRating || '?'})`) + flag;
  };

  if (moves.length > 0) {
    console.log(chalk.blue.bold(`\n🔁 Out of position (${moves.length}):`));
    for (const m of moves) {
      console.log(
        `   #${String(m.position).padStart(3)} → #${m.targetRank}: "${m.title}" by ${m.author}` +
        chalk.gray(m.authorId ? ` [ID: ${m.authorId}]` : '')
      );
    }
  }

  if (unverifiable.length > 0) {
    console.log(chalk.yellow.bold(`\n❓ Can't verify (${unverifiable.length}) — no cached author stats:`));
    for (const d of unverifiable) {
      const hint = d.authorId
        ? ` — run ./authorOne.sh https://www.goodreads.com/author/show/${d.authorId} then rerun`
        : '';
      console.log(
        `   #${String(d.position).padStart(3)}: "${d.title}" by ${d.author}` +
        chalk.gray(d.authorId ? ` [ID: ${d.authorId}]${hint}` : hint)
      );
    }
  }

  if (verifiable.length > 0) {
    console.log(chalk.red.bold(`\n🗑️  No longer in the top ${limit} (${verifiable.length}):`));
    for (const d of verifiable) {
      const now = d.currentRank !== undefined ? `now #${d.currentRank}` : 'no longer ranked';
      console.log(
        `   ${String(d.position).padStart(4)}. "${d.title}" by ${d.author}` +
        chalk.gray(` — ${d.authorId ? `[ID: ${d.authorId}] ` : ''}${now}`)
      );
    }
  }

  if (additions.length > 0) {
    console.log(chalk.green.bold(`\n✨ Qualifying authors missing from the list (${additions.length}):`));
    const rows = additions.map((a, i) => {
      const suggestion = a.id ? pickSuggestionBook(booksByAuthor.get(a.id) || [], a.id) : { book: undefined, qualified: false };
      return { author: a, position: suggestedPositions[i], ...suggestion };
    });
    for (const { author, position, book, qualified } of rows) {
      console.log(
        `   add at position ${position}: ${author.name}` +
        chalk.gray(` (#${author.rank}, ${author.id ? `[ID: ${author.id}]` : ''})`) +
        `\n         → ${suggestionText(book, qualified)}`
      );
    }
  }

  if (replacements.length > 0) {
    console.log(chalk.yellow.bold(`\n🔄 Better book available for voted authors (${replacements.length}):`));
    for (const r of replacements) {
      console.log(
        `   at #${r.position}: ${r.author}` +
        chalk.gray(` — swap "${r.votedBook.title}" [ID: ${r.votedBook.id}]`) +
        `\n         → ${suggestionText(r.suggestedBook, true)}`
      );
    }
  }

  // Paste-ready instructions in execution order: removals free the slots,
  // additions fill them, moves settle positions, replaces polish quality.
  // Paste-ready instructions in execution order: removals free the slots,
  // additions fill them, moves settle positions, replaces polish quality.
  // Unverifiable authors are intentionally absent — fetch their stats first.
  console.log(chalk.cyan('\n   Paste-ready:'));
  for (const d of verifiable) {
    const now = d.currentRank !== undefined ? `now #${d.currentRank}` : 'now ?';
    console.log(`   removed ${formatAuthorRef({ name: d.author, id: d.authorId })} ${formatBookRef({ title: d.title, id: d.bookId })} - was #${d.position}, ${now}`);
  }
  for (let i = 0; i < additions.length; i++) {
    const author = additions[i];
    const position = suggestedPositions[i];
    const { book } = author.id ? pickSuggestionBook(booksByAuthor.get(author.id) || [], author.id) : { book: undefined };
    if (book) {
      console.log(`   add ${formatAuthorRef(author)} ${formatBookRef(book)} - to #${position}`);
    } else {
      console.log(`   add ${formatAuthorRef(author)} - to #${position}`);
    }
  }
  for (const m of moves) {
    console.log(`   move ${formatAuthorRef({ name: m.author, id: m.authorId })} ${formatBookRef({ title: m.title, id: m.bookId })} - from #${m.position} to #${m.targetRank}`);
  }
  for (const r of replacements) {
    console.log(
      `   replace ${formatAuthorRef({ name: r.author, id: r.authorId })} ${formatBookRef({ title: r.votedBook.title, id: r.votedBook.id })}` +
      ` with ${formatBookRef(r.suggestedBook)}`
    );
  }

  console.log('');
}

export { runAuthorListDiff };
