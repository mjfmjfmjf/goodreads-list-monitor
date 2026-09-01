import chalk from 'chalk';
import { loadBookCache } from './storage.js';
import type { CachedBook } from './storage.js';
import { parseSeriesPos } from './seriesPos.js';
import { scrapeUserVoteBooks } from './scraper.js';
import type { UserVoteEntry } from './scraper.js';

export const STANDALONE_MIN_RATINGS = 10000;
export const STANDALONE_DEFAULT_VOTE_REF = '9695567';

const parseNum = (s?: string): number => parseInt((s || '0').replace(/,/g, ''), 10) || 0;
const parseAvg = (s?: string): number => parseFloat(s || '0') || 0;

// A standalone has no series marker, no manga volume marker, and is not a
// boxed set — parseSeriesPos returns a number for all three and undefined for
// true standalones.
export function isStandalone(book: CachedBook): boolean {
  return parseSeriesPos(book.title) === undefined;
}

export interface VotedBook {
  vote: UserVoteEntry;
  book: CachedBook;
  avgRating: number;
  ratings: number;
  rank: number;
}

export interface ResortResult {
  // Standalones that qualify — sorted by avg rating desc (ratings as tiebreak).
  keep: VotedBook[];
  // Voted books that are NOT standalone (in a series / boxed set / manga vol)
  // and should be removed from the list.
  notStandalone: VotedBook[];
  // Voted books with no cached entry / no rating data — can't be verified.
  unknown: UserVoteEntry[];
}

// Reorder the user's existing votes: keep only standalone books that qualify,
// and sort by avg rating descending with # ratings as the tiebreaker.
export function resortVotedBooks(
  votes: UserVoteEntry[],
  booksById: Map<string, CachedBook>,
  opts: { minRatings?: number } = {}
): ResortResult {
  const minRatings = opts.minRatings ?? STANDALONE_MIN_RATINGS;

  const keep: VotedBook[] = [];
  const notStandalone: VotedBook[] = [];
  const unknown: UserVoteEntry[] = [];

  for (const vote of votes) {
    const book = booksById.get(vote.bookId);
    if (!book) {
      unknown.push(vote);
      continue;
    }
    const avg = parseAvg(book.avgRating);
    const ratings = parseNum(book.ratings);
    if (ratings <= 0 || avg <= 0) {
      unknown.push(vote);
      continue;
    }
    const entry: VotedBook = { vote, book, avgRating: avg, ratings, rank: 0 };
    if (!isStandalone(book)) notStandalone.push(entry);
    else if (ratings < minRatings) notStandalone.push(entry); // below the bar → drop
    else keep.push(entry);
  }

  keep.sort(
    (a, b) => b.avgRating - a.avgRating || b.ratings - a.ratings
  );

  return { keep, notStandalone, unknown };
}

export interface StandaloneMonitorOptions {
  voteRef?: string;
  minRatings?: string | number;
}

export async function runMonitorTopStandalones(options: StandaloneMonitorOptions = {}): Promise<void> {
  const minRatings = parseInt(String(options.minRatings ?? STANDALONE_MIN_RATINGS), 10) || STANDALONE_MIN_RATINGS;
  const voteRef = options.voteRef || STANDALONE_DEFAULT_VOTE_REF;

  console.log(chalk.cyan.bold('\n📗 Top 100 standalones — reorder your votes'));
  console.log(chalk.gray('   Rule: vote for books already on the list, standalones only,'));
  console.log(chalk.gray('   highest avg rating first (# ratings as tiebreaker).'));
  console.log(chalk.gray(`   Min ratings: ${minRatings.toLocaleString()}+ · work_id: not required`));
  console.log(chalk.gray('------------------------------------------'));

  console.log(chalk.gray('\n   Fetching your votes for this list...'));
  let votes: UserVoteEntry[] = [];
  try {
    votes = await scrapeUserVoteBooks(voteRef);
  } catch (error) {
    console.error(chalk.red.bold('   Failed to fetch votes page:'), (error as any).message);
    return;
  }
  console.log(chalk.gray(`   Found ${votes.length} voted books.`));

  console.log(chalk.gray('   Loading book cache...'));
  const bookCache = loadBookCache();
  const booksById = new Map(Object.entries(bookCache));

  const { keep, notStandalone, unknown } = resortVotedBooks(votes, booksById, { minRatings });
  keep.forEach((v, i) => { v.rank = i + 1; });

  if (notStandalone.length > 0) {
    console.log(chalk.red.bold(`\n🗑️  Remove from your votes — not a standalone (or below ${minRatings.toLocaleString()} ratings):`));
    for (const v of notStandalone) {
      const why = v.ratings < minRatings
        ? `only ${v.ratings.toLocaleString()} ratings`
        : `part of a series / boxed set`;
      console.log(`   #${String(v.vote.position).padStart(4)}. "${v.book.title}" by ${v.book.author} ${chalk.gray(`(${why})`)}`);
    }
  }

  if (unknown.length > 0) {
    console.log(chalk.yellow.bold(`\n❓ Not in the book cache — can't verify standalone status:`));
    for (const v of unknown) {
      console.log(`   #${String(v.position).padStart(4)}. "${v.title}" by ${v.author} ${chalk.gray(`[ID: ${v.bookId}]`)}`);
    }
  }

  console.log(chalk.blue.bold(`\n🔁 Reorder to (${keep.length} standalones, by avg rating ↓):`));

  const fmt = (n: number) => n.toLocaleString('en-US');
  const targetPositions = new Map<number, number>(); // current position -> target rank
  for (const v of keep) {
    const target = v.rank;
    if (v.vote.position !== target) targetPositions.set(v.vote.position, target);
  }

  if (targetPositions.size > 0) {
    console.log(chalk.gray('   Move instructions (old position → new position):'));
    for (const [from, to] of [...targetPositions.entries()].sort((a, b) => a[1] - b[1])) {
      console.log(`   ${String(from).padStart(3)} → ${String(to).padStart(3)}`);
    }
  } else {
    console.log(chalk.gray('   Already in the right order — no moves needed.'));
  }

  console.log('');
  console.log(chalk.gray('   Target order (for reference):'));
  keep.forEach((v, i) => {
    console.log(
      `   ${String(v.rank).padStart(3)}. "${v.book.title}" by ${v.book.author} ${chalk.gray(`(${fmt(v.ratings)} ratings, avg ${v.avgRating.toFixed(2)})`)}`
    );
  });
  console.log('');
}