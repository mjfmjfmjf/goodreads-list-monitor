import { describe, expect, it } from 'vitest';
import { topStarLevel, parseRating, readingDays, renderStats, computeTagCounts } from './yearInBooks.js';
import { LibraryEntry } from './libraryExport.js';

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
