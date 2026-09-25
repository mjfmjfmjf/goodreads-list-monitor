import fs from 'fs-extra';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Isolate storage to a temp DB before db.js is loaded so renderTags can read
// real tag_books / genre_tag_xref rows offline.
vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-yearinbooks-${process.pid}-${Date.now()}.db`;
});

const DB_FILE = process.env.GOODREADS_DB_PATH!;

import { topStarLevel, parseRating, readingDays, renderStats, computeTagCounts, computeGenreVotes, computeGenreVoteByBook, renderTags, SectionContext } from './yearInBooks.js';
import type { TagBookRow } from './storage.js';
import { closeDb, getDb } from './db.js';
import { upsertTagBooks, replaceGenreTagXref } from './storage.js';
import { LibraryEntry } from './libraryExport.js';

afterAll(() => {
  closeDb();
  delete process.env.GOODREADS_DB_PATH;
  for (const suffix of ['', '-wal', '-shm']) fs.removeSync(DB_FILE + suffix);
});

function entry(myRating: string, overrides: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    id: '1',
    title: 'Book',
    author: 'Author',
    shelf: 'read',
    dateRead: '2026/01/01',
    hasReview: false,
    review: '',
    published: '2020',
    myRating,
    pages: '200',
    publisher: 'Pub',
    bookshelves: '',
    ...overrides,
  };
}

describe('parseRating', () => {
  it('parses a numeric star rating', () => {
    expect(parseRating(entry('5'))).toBe(5);
    expect(parseRating(entry('4'))).toBe(4);
  });
  it('returns undefined for missing or zero ratings', () => {
    expect(parseRating(entry(''))).toBeUndefined();
    expect(parseRating(entry('0'))).toBeUndefined();
    expect(parseRating(entry('n/a'))).toBeUndefined();
  });
});

describe('topStarLevel', () => {
  it('returns 5 when five-star books exist', () => {
    expect(topStarLevel([entry('5'), entry('4'), entry('3')])).toBe(5);
  });
  it('falls back to 4 when there are no five-star ratings', () => {
    expect(topStarLevel([entry('4'), entry('4'), entry('1')])).toBe(4);
  });
  it('falls back through the top rating present', () => {
    expect(topStarLevel([entry('3'), entry('2')])).toBe(3);
    expect(topStarLevel([entry('1')])).toBe(1);
  });
  it('returns 0 when nothing is rated', () => {
    expect(topStarLevel([entry(''), entry('0')])).toBe(0);
  });
});

describe('readingDays', () => {
  const now = new Date();
  const currentYear = now.getFullYear();

  it('current year uses Jan 1 → today', () => {
    const start = new Date(currentYear, 0, 1);
    const expected = Math.max(1, Math.round((now.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)));
    expect(readingDays(currentYear, [entry('5', { dateRead: `${currentYear}/01/01` })])).toBe(expected);
  });

  it('first year uses first-book date → Dec 31 of that year', () => {
    const all = [
      entry('5', { dateRead: '2018/05/01' }),
      entry('4', { dateRead: '2019/03/10' }),
      entry('3', { dateRead: '2022/07/01' }),
    ];
    // 2018 is the first year: May 1 → Dec 31 = 245 days (May 1 stays, count to Dec 31 inclusive)
    const days = readingDays(2018, all);
    const span = (new Date(2018, 11, 31).getTime() - new Date(2018, 4, 1).getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(Math.round(span));
  });

  it('non-current, non-first years use the full year (365 for 2021)', () => {
    const all = [
      entry('5', { dateRead: '2018/03/01' }),
      entry('4', { dateRead: '2021/06/01' }),
    ];
    expect(readingDays(2021, all)).toBe(365);
  });

  it('leap years use 366', () => {
    const all = [entry('5', { dateRead: '2018/03/01' }), entry('4', { dateRead: '2020/06/01' })];
    expect(readingDays(2020, all)).toBe(366);
  });
});

describe('renderStats per-day', () => {
  it('adds per-day line with denominator in days when perDay context given', () => {
    const all = [entry('5', { dateRead: '2021/01/01' })];
    const lines = renderStats([entry('5', { pages: '300', dateRead: '2021/01/01' })], { year: 2021, allEntries: all });
    expect(lines.some(l => l.includes('Per day'))).toBe(true);
    expect(lines[0]).toContain('Books read: 1');
    expect(lines[1]).toContain('Pages read: 300');
  });

  it('omits per-day line without perDay context', () => {
    const lines = renderStats([entry('5', { pages: '300' })]);
    expect(lines.some(l => l.includes('Per day'))).toBe(false);
  });
});

describe('computeTagCounts', () => {
  const tagRow = (tagName: string, bookId: string) => ({
    tagName,
    bookId,
    harvestedAt: '2026-01-01T00:00:00.000Z',
  });

  it('counts how many books share each tag, biggest first', () => {
    const entries = [
      entry('5', { id: '1' }),
      entry('5', { id: '2' }),
      entry('5', { id: '3' }),
    ];
    const rows = [
      tagRow('fantasy', '1'),
      tagRow('fantasy', '2'),
      tagRow('science-fiction', '1'),
      tagRow('mystery', '1'),
    ];
    const counts = computeTagCounts(entries, rows);
    expect(counts).toEqual([
      { tag: 'fantasy', count: 2, pct: 66.66666666666666 },
      { tag: 'mystery', count: 1, pct: 33.33333333333333 },
      { tag: 'science-fiction', count: 1, pct: 33.33333333333333 },
    ]);
  });

  it('does not double-count a book that appears multiple times in one tag', () => {
    const entries = [entry('5', { id: '1' })];
    const rows = [
      tagRow('fantasy', '1'),
      tagRow('fantasy', '1'),
      tagRow('fantasy', '1'),
    ];
    expect(computeTagCounts(entries, rows)).toEqual([{ tag: 'fantasy', count: 1, pct: 100 }]);
  });

  it('breaks ties alphabetically', () => {
    const entries = [entry('5', { id: '1' })];
    const rows = [tagRow('zebra', '1'), tagRow('alpha', '1')];
    const counts = computeTagCounts(entries, rows);
    expect(counts.map(c => c.tag)).toEqual(['alpha', 'zebra']);
  });

  it('ignores books (and tags) not present in the year entries', () => {
    const entries = [entry('5', { id: '1' })];
    const rows = [
      tagRow('fantasy', '1'),
      tagRow('fantasy', '99'),
      tagRow('history', '99'),
    ];
    const counts = computeTagCounts(entries, rows);
    expect(counts).toEqual([{ tag: 'fantasy', count: 1, pct: 100 }]);
  });

  it('returns an empty list when no year book is tagged', () => {
    const entries = [entry('5', { id: '1' })];
    expect(computeTagCounts(entries, [tagRow('fantasy', '99')])).toEqual([]);
  });
});

describe('computeGenreVotes', () => {
  const voteRow = (tagName: string, bookId: string, position?: number) => ({
    tagName,
    bookId,
    position,
    harvestedAt: '2026-01-01T00:00:00.000Z',
  });
  const xref = (pairs: Array<[string, string]>) => new Map(pairs);

  it('gives each book one vote, to the genre of its best-position tag', () => {
    const entries = [entry('5', { id: '1' })];
    const rows = [
      voteRow('fantasy', '1', 5),
      voteRow('science-fiction', '1', 1),
    ];
    const votes = computeGenreVotes(entries, rows, xref([['science-fiction', 'Science Fiction'], ['fantasy', 'Fantasy']]));
    expect(votes).toEqual([{ genre: 'Science Fiction', votes: 1, pct: 100 }]);
  });

  it('folds multiple tags of one genre, using the best position among them', () => {
    const entries = [entry('5', { id: '1' })];
    const rows = [
      voteRow('sci-fi', '1', 3),
      voteRow('science-fiction', '1', 1),
      voteRow('fantasy', '1', 2),
    ];
    const votes = computeGenreVotes(entries, rows, xref([['sci-fi', 'Science Fiction'], ['science-fiction', 'Science Fiction'], ['fantasy', 'Fantasy']]));
    expect(votes).toEqual([{ genre: 'Science Fiction', votes: 1, pct: 100 }]);
  });

  it('breaks a best-position tie by more mapping tags, then alphabetically', () => {
    const entries = [entry('5', { id: '1' })];
    const rows = [
      voteRow('fantasy', '1', 1),
      voteRow('science-fiction', '1', 1),
      voteRow('sci-fi', '1', 5),
    ];
    const votes = computeGenreVotes(entries, rows, xref([['fantasy', 'Fantasy'], ['science-fiction', 'Science Fiction'], ['sci-fi', 'Science Fiction']]));
    expect(votes).toEqual([{ genre: 'Science Fiction', votes: 1, pct: 100 }]);
  });

  it('abstains when no genre-mapped tag has a shelf position and there is no book-page genre', () => {
    const entries = [entry('5', { id: '1' })];
    const rows = [voteRow('fantasy', '1')];
    const votes = computeGenreVotes(entries, rows, xref([['fantasy', 'Fantasy']]));
    expect(votes).toEqual([]);
  });

  it('falls back to the first book-page genre when no positioned genre tag exists', () => {
    const entries = [entry('5', { id: '1' })];
    const rows = [voteRow('fantasy', '1')]; // genre-mapped but no position
    const bookCache = {
      '1': { id: '1', title: 'A', author: 'X', ratings: '0', published: '', lastUpdated: '', genres: ['Picture Books', 'Storytime'] },
    };
    const votes = computeGenreVotes(entries, rows, xref([['fantasy', 'Fantasy']]), bookCache);
    expect(votes).toEqual([{ genre: 'Picture Books', votes: 1, pct: 100 }]);
  });

  it('uses the positioned vote over the book-page fallback when both exist', () => {
    const entries = [entry('5', { id: '1' })];
    const rows = [voteRow('science-fiction', '1', 1)];
    const bookCache = {
      '1': { id: '1', title: 'A', author: 'X', ratings: '0', published: '', lastUpdated: '', genres: ['Picture Books', 'Storytime'] },
    };
    const votes = computeGenreVotes(entries, rows, xref([['science-fiction', 'Science Fiction']]), bookCache);
    expect(votes).toEqual([{ genre: 'Science Fiction', votes: 1, pct: 100 }]);
  });

  it('maps a book-page fallback genre to its canonical slug via normalization', () => {
    const entries = [entry('5', { id: '1' }), entry('5', { id: '2' })];
    const rows = [voteRow('fantasy', '1', 5)];
    const xrefMap = xref([['fantasy', 'Fantasy'], ['picture-books', 'picture-books']]);
    const bookCache = {
      '2': { id: '2', title: 'B', author: 'Y', ratings: '0', published: '', lastUpdated: '', genres: ['Picture Books', 'childrens'] },
    };
    const votes = computeGenreVotes(entries, rows, xrefMap, bookCache);
    // book 1 -> Fantasy (positioned); book 2 -> "Picture Books" normalized to "picture-books"
    expect(votes[0]).toEqual({ genre: 'Fantasy', votes: 1, pct: 50 });
    expect(votes.map(v => v.genre)).toContain('picture-books');
    expect(votes.find(v => v.genre === 'picture-books')).toEqual({ genre: 'picture-books', votes: 1, pct: 50 });
  });

  it('keeps an unmapped book-page genre as its own bucket', () => {
    const entries = [entry('5', { id: '1' })];
    const rows: TagBookRow[] = [];
    const bookCache = {
      '1': { id: '1', title: 'A', author: 'X', ratings: '0', published: '', lastUpdated: '', genres: ['Science Fiction Fantasy'] },
    };
    const votes = computeGenreVotes(entries, rows, xref([['fantasy', 'Fantasy']]), bookCache);
    expect(votes).toEqual([{ genre: 'Science Fiction Fantasy', votes: 1, pct: 100 }]);
  });

  it('counts each book once across the year entries', () => {
    const entries = [entry('5', { id: '1' }), entry('5', { id: '2' })];
    const rows = [
      voteRow('fantasy', '1', 2),
      voteRow('history', '2', 1),
    ];
    const votes = computeGenreVotes(entries, rows, xref([['fantasy', 'Fantasy'], ['history', 'History']]));
    expect(votes).toEqual([
      { genre: 'Fantasy', votes: 1, pct: 50 },
      { genre: 'History', votes: 1, pct: 50 },
    ]);
  });

  it('sorts by votes descending, then alphabetically', () => {
    const entries = [entry('5', { id: '1' }), entry('5', { id: '2' }), entry('5', { id: '3' })];
    const rows = [
      voteRow('fantasy', '1', 1),
      voteRow('history', '2', 1),
      voteRow('fantasy', '3', 1),
    ];
    const votes = computeGenreVotes(entries, rows, xref([['fantasy', 'Fantasy'], ['history', 'History']]));
    expect(votes).toEqual([
      { genre: 'Fantasy', votes: 2, pct: 66.66666666666666 },
      { genre: 'History', votes: 1, pct: 33.33333333333333 },
    ]);
  });
});

describe('renderTags', () => {
  const ctx = (n: number): SectionContext => ({
    entries: Array.from({ length: n }, (_, i) => entry('5', { id: String(i + 1) })),
    bookCache: {},
    reviewYear: 2026,
  });
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

  beforeEach(() => {
    getDb().exec('DELETE FROM tag_books; DELETE FROM genre_tag_xref;');
  });

  it('lists only the top 100 tags, numbered, and notes the truncation', () => {
    const tags = Array.from({ length: 120 }, (_, i) => `tag-${String(i).padStart(3, '0')}`);
    for (const t of tags) upsertTagBooks(t, [{ id: '1' }]);

    const lines = renderTags(ctx(1)).map(strip);
    expect(lines[0]).toContain('120 distinct tags across 1 of 1 books');
    expect(lines[0]).toContain('showing top 100');
    expect(lines[2]).toContain('1. tag-000: 1 (100.0%)');
    expect(lines[101]).toContain('100. tag-099: 1 (100.0%)');
    expect(lines.some(l => l.includes('101.'))).toBe(false);
  });

  it('adds a genre section for tags mapped in genre_tag_xref', () => {
    upsertTagBooks('fantasy', [{ id: '1' }, { id: '2' }]);
    upsertTagBooks('history', [{ id: '1' }]);
    replaceGenreTagXref('fantasy', [{ tagName: 'fantasy', kind: 'exact' }]);
    replaceGenreTagXref('history', [{ tagName: 'history', kind: 'exact' }]);

    const lines = renderTags(ctx(2)).map(strip);
    expect(lines.some(l => l.includes('Genres (folding tag aliases):'))).toBe(true);
    expect(lines.some(l => l.includes('1. fantasy: 2 (100.0%)'))).toBe(true);
    expect(lines.some(l => l.includes('2. history: 1 (50.0%)'))).toBe(true);
  });

  it('folds tag aliases into the canonical genre with a union count', () => {
    upsertTagBooks('picture-books', [{ id: '1' }, { id: '2' }]);
    upsertTagBooks('picture-book', [{ id: '2' }, { id: '3' }]);
    replaceGenreTagXref('picture-books', [
      { tagName: 'picture-books', kind: 'cognate' },
      { tagName: 'picture-book', kind: 'cognate' },
    ]);

    const lines = renderTags(ctx(3)).map(strip);
    // one canonical row for the genre, counting books in EITHER alias
    const headerIdx = lines.findIndex(l => l.includes('Genres (folding tag aliases):'));
    const genreLines = lines.slice(headerIdx + 1).filter(l => /^\s*\d+\. /.test(l));
    expect(genreLines).toHaveLength(1);
    expect(genreLines[0]).toContain('picture-books: 3 (100.0%) (2 tags)');
  });

  it('shows a hint when no tag maps to a canonical genre yet', () => {
    upsertTagBooks('tbr', [{ id: '1' }]);
    const lines = renderTags(ctx(1)).map(strip);
    expect(lines.some(l => l.includes('no tags map to a canonical genre yet'))).toBe(true);
  });

  it('renders a best-position vote block when ctx.voteGenres is set', () => {
    upsertTagBooks('fantasy', [{ id: '1', position: 5 }, { id: '2', position: 1 }]);
    upsertTagBooks('science-fiction', [{ id: '1', position: 1 }]);
    replaceGenreTagXref('fantasy', [{ tagName: 'fantasy', kind: 'exact' }]);
    replaceGenreTagXref('science-fiction', [{ tagName: 'science-fiction', kind: 'exact' }]);

    const voteCtx = { ...ctx(2), voteGenres: true };
    const lines = renderTags(voteCtx).map(strip);
    expect(lines.some(l => l.includes('Genres (best-position vote — each book votes once):'))).toBe(true);
    // book 1: science-fiction at position 1 beats fantasy at 5 → Science Fiction
    // book 2: fantasy at position 1 → Fantasy
    const headerIdx = lines.findIndex(l => l.includes('Genres (best-position vote — each book votes once):'));
    const voteLines = lines.slice(headerIdx + 1).filter(l => /^\s*\d+\. /.test(l));
    expect(voteLines[0]).toContain('fantasy: 1 (50.0%)');
    expect(voteLines[1]).toContain('science-fiction: 1 (50.0%)');
  });

  it('renders an abstain hint when no voted genre exists', () => {
    upsertTagBooks('fantasy', [{ id: '1' }]);
    replaceGenreTagXref('fantasy', [{ tagName: 'fantasy', kind: 'exact' }]);

    const voteCtx = { ...ctx(1), voteGenres: true };
    const lines = renderTags(voteCtx).map(strip);
    expect(lines.some(l => l.includes('no book has a voted genre'))).toBe(true);
  });

  it('falls back to books.genres[0] for the vote when no positioned tag maps to a genre', () => {
    upsertTagBooks('tbr', [{ id: '1', position: 3 }]); // tag with no genre mapping
    replaceGenreTagXref('fantasy', [{ tagName: 'fantasy', kind: 'exact' }]);

    const voteCtx = {
      ...ctx(2),
      voteGenres: true,
      bookCache: {
        '1': {
          id: '1', title: 'A', author: 'One', ratings: '0', published: '', lastUpdated: '',
          genres: ['Picture Books', 'Childrens', 'Storytime'],
        },
        // book '2' has no cache entry → no vote
      },
    };
    const lines = renderTags(voteCtx).map(strip);
    const headerIdx = lines.findIndex(l => l.includes('Genres (best-position vote — each book votes once):'));
    const voteLines = lines.slice(headerIdx + 1).filter(l => /^\s*\d+\. /.test(l));
    // book 1 has no genre-mapped positioned tag, so it votes fallback -> "Picture Books"
    expect(voteLines[0]).toContain('Picture Books: 1 (50.0%)');
    // book 2 has no genres at all -> reported as no-vote
    expect(lines.some(l => l.includes('1 of 2 books had no voted genre'))).toBe(true);
  });

  it('drills into --voteBooks and lists the books with their ranked genres', () => {
    upsertTagBooks('picture-books', [{ id: '1', position: 2 }, { id: '2', position: 1 }]);
    upsertTagBooks('childrens', [{ id: '1', position: 3 }]);
    upsertTagBooks('picture-book', [{ id: '3', position: 1 }]);
    replaceGenreTagXref('picture-books', [{ tagName: 'picture-books', kind: 'exact' }, { tagName: 'picture-book', kind: 'cognate' }]);
    replaceGenreTagXref('childrens', [{ tagName: 'childrens', kind: 'exact' }]);

    const voteCtx: SectionContext = {
      entries: [
        entry('5', { id: '1', title: 'A', author: 'One' }),
        entry('5', { id: '2', title: 'B', author: 'Two' }),
        entry('5', { id: '3', title: 'C', author: 'Three' }),
      ],
      bookCache: {
        '1': {
          id: '1', title: 'A', author: 'One', ratings: '0', published: '', lastUpdated: '', genres: ['picture-books', 'childrens', 'family'],
        },
      },
      reviewYear: 2026,
      voteGenres: true,
      voteBooks: 'picture-book', // tag name → canonical genre picture-books
    };
    const lines = renderTags(voteCtx).map(strip);

    // book 1 votes picture-books (pos 2 via picture-books, beats childrens pos 3);
    // book 2 votes picture-books (pos 1); book 3 votes picture-books (pos 1 via picture-book).
    // book 1 also lists its book-page genres.
    const headerIdx = lines.findIndex(l => l.includes('Books that voted for "picture-books"'));
    expect(headerIdx).toBeGreaterThan(-1);
    expect(lines[headerIdx]).toContain('(3)');

    const bookLines = lines.slice(headerIdx + 1);
    expect(bookLines[0]).toContain('B — Two');
    expect(bookLines[0]).toContain('via picture-books @ pos 1');
    expect(bookLines.some(l => l.includes('A — One') && l.includes('picture-books @ pos 2'))).toBe(true);
    expect(bookLines.some(l => l.includes('C — Three'))).toBe(true);
    expect(bookLines.some(l => l.includes('book page genres: picture-books, childrens, family'))).toBe(true);
  });

  it('shows a valid-genre hint when --voteBooks names an unknown genre', () => {
    upsertTagBooks('fantasy', [{ id: '1', position: 1 }]);
    replaceGenreTagXref('fantasy', [{ tagName: 'fantasy', kind: 'exact' }]);

    const voteCtx = { ...ctx(1), voteGenres: true, voteBooks: 'nope' };
    const lines = renderTags(voteCtx).map(strip);
    expect(lines.some(l => l.includes('no book voted for "nope" — check the genre list above'))).toBe(true);
  });
});
