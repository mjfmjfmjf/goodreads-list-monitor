import { describe, expect, it } from 'vitest';
import { queryBookWithAuthor, formatNum, formatAvg, formatBookDetail } from './dbReadBook.js';
import type { BookRow, AuthorRow, BookWithAuthor } from './dbReadBook.js';

function fakeDb(books: Record<string, BookRow>, authors: Record<string, AuthorRow[]>) {
  return {
    prepare(sql: string) {
      return {
        get(...args: unknown[]) {
          if (sql.includes('FROM books WHERE id = ?')) {
            return books[args[0] as string];
          }
          // authors lookup, ordered by last_seen desc, num_ratings desc
          const id = args[0] as string;
          const rows = authors[id] || [];
          return rows.slice().sort((a, b) => {
            const ls = (a.last_seen || '').localeCompare(b.last_seen || '') * -1;
            return ls || ((b.num_ratings || 0) - (a.num_ratings || 0));
          })[0];
        },
      } as any;
    },
  } as any;
}

describe('queryBookWithAuthor', () => {
  it('returns the book with its joined author', () => {
    const db = fakeDb(
      { '1': { id: '1', title: 'Animal Farm', author: 'George Orwell', author_id: '3706', ratings: 4784802, avg_rating: 4.03, published: '1945', work_id: '2207778' } },
      { '3706': [{ name: 'George Orwell', id: '3706', slug: '3706.George_Orwell', average_rating: 4.13, num_ratings: 11249733, catalog_pages: 46, last_seen: '2026-08-28' }] }
    );
    const r = queryBookWithAuthor(db, '1');
    expect(r).not.toBeNull();
    expect(r!.book.title).toBe('Animal Farm');
    expect(r!.author!.name).toBe('George Orwell');
    expect(r!.author!.catalog_pages).toBe(46);
  });

  it('returns null when the book id is absent', () => {
    const db = fakeDb({}, {});
    expect(queryBookWithAuthor(db, 'nope')).toBeNull();
  });

  it('returns author null when the book has no author_id', () => {
    const db = fakeDb({ '9': { id: '9', title: 'X', author: 'A' } }, {});
    const r = queryBookWithAuthor(db, '9');
    expect(r!.author).toBeNull();
  });

  it('prefers the canonical author row among duplicate ids', () => {
    const db = fakeDb(
      { '1': { id: '1', title: 'T', author: 'A', author_id: '3706' } },
      { '3706': [
        { name: 'George  Orwell', id: '3706', last_seen: '2026-01-01' },
        { name: 'George Orwell', id: '3706', num_ratings: 500, last_seen: '2026-08-28' },
      ] }
    );
    const r = queryBookWithAuthor(db, '1');
    expect(r!.author!.name).toBe('George Orwell');
  });
});

describe('formatNum / formatAvg', () => {
  it('formats numbers with locale separators', () => {
    expect(formatNum(4784802)).toBe('4,784,802');
    expect(formatNum(0)).toBe('0');
    expect(formatNum(null)).toBe('—');
    expect(formatNum(undefined)).toBe('—');
  });

  it('formats averages to two decimals', () => {
    expect(formatAvg(4.03)).toBe('4.03');
    expect(formatAvg(4)).toBe('4.00');
    expect(formatAvg(null)).toBe('—');
  });
});

describe('formatBookDetail', () => {
  const d: BookWithAuthor = {
    book: { id: '170448', title: 'Animal Farm', author: 'George Orwell', author_id: '3706', ratings: 4784802, avg_rating: 4.03, published: '1945', work_id: '2207778' },
    author: { name: 'George Orwell', id: '3706', slug: '3706.George_Orwell', average_rating: 4.13, num_ratings: 11249733 },
  };
  it('includes book and author details', () => {
    const out = formatBookDetail(d);
    expect(out).toContain('Animal Farm');
    expect(out).toContain('3706');
    expect(out).toContain('2207778');
    expect(out).toContain('4,784,802');
  });
});
