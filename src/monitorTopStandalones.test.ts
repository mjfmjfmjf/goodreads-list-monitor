import { describe, expect, it } from 'vitest';

import type { CachedBook } from './storage.js';
import { isStandalone, resortVotedBooks } from './monitorTopStandalones.js';
import type { UserVoteEntry } from './scraper.js';

function book(id: string, over: Partial<CachedBook> = {}): CachedBook {
  return {
    id,
    title: over.title ?? `Book ${id}`,
    author: over.author ?? 'Some Author',
    ratings: over.ratings ?? '10000',
    avgRating: over.avgRating ?? '4.5',
    published: over.published ?? '2000',
    lastUpdated: '2026-01-01',
    workId: over.workId ?? `work-${id}`,
    ...over,
  };
}

function vote(position: number, bookId: string, title = `Book ${bookId}`, author = 'Author'): UserVoteEntry {
  return { position, bookId, title, author };
}

function map(books: CachedBook[]): Map<string, CachedBook> {
  return new Map(books.map(b => [b.id, b]));
}

describe('isStandalone', () => {
  it('true for plain titles', () => {
    expect(isStandalone(book('1', { title: 'The Martian' }))).toBe(true);
  });
  it('false for series markers', () => {
    expect(isStandalone(book('1', { title: 'Oathbringer (The Stormlight Archive, #3)' }))).toBe(false);
  });
  it('false for manga volumes', () => {
    expect(isStandalone(book('1', { title: 'Berserk, Vol. 12' }))).toBe(false);
  });
  it('false for boxed sets', () => {
    expect(isStandalone(book('1', { title: 'The Stormlight Archive (Books 1-3, #1-3)' }))).toBe(false);
  });
  it('true for edition/format parentheticals', () => {
    expect(isStandalone(book('1', { title: 'The Martian (Hardcover)' }))).toBe(true);
  });
});

describe('resortVotedBooks', () => {
  it('sorts kept standalones by avg rating desc, ratings as tiebreaker', () => {
    const books = [
      book('a', { title: 'Alpha', avgRating: '4.2', ratings: '10000' }),
      book('b', { title: 'Beta', avgRating: '4.8', ratings: '12000' }),
      book('c', { title: 'Gamma', avgRating: '4.8', ratings: '15000' }),
      book('d', { title: 'Delta', avgRating: '4.0', ratings: '15000' }),
    ];
    const votes = [
      vote(1, 'd'),
      vote(2, 'a'),
      vote(3, 'b'),
      vote(4, 'c'),
    ];
    const { keep } = resortVotedBooks(votes, map(books));
    expect(keep.map(k => k.vote.bookId)).toEqual(['c', 'b', 'a', 'd']);
  });

  it('drops voted books that are part of a series', () => {
    const books = [
      book('a', { title: 'Alpha' }),
      book('b', { title: 'Oathbringer (The Stormlight Archive, #3)' }),
    ];
    const votes = [vote(1, 'a'), vote(2, 'b')];
    const { keep, notStandalone } = resortVotedBooks(votes, map(books));
    expect(keep.map(k => k.vote.bookId)).toEqual(['a']);
    expect(notStandalone.map(k => k.vote.bookId)).toEqual(['b']);
  });

  it('drops voted books below the min ratings threshold', () => {
    const books = [book('a', { ratings: '5000' }), book('b', { ratings: '20000' })];
    const votes = [vote(1, 'a'), vote(2, 'b')];
    const { keep, notStandalone } = resortVotedBooks(votes, map(books));
    expect(keep.map(k => k.vote.bookId)).toEqual(['b']);
    expect(notStandalone.map(k => k.vote.bookId)).toEqual(['a']);
  });

  it('flags voted books missing from the cache as unknown', () => {
    const books = [book('a', { title: 'Alpha' })];
    const votes = [vote(1, 'a'), vote(2, 'zzz')];
    const { keep, unknown } = resortVotedBooks(votes, map(books));
    expect(keep.map(k => k.vote.bookId)).toEqual(['a']);
    expect(unknown.map(u => u.bookId)).toEqual(['zzz']);
  });

  it('flags books with no rating data as unknown', () => {
    const books = [book('a', { ratings: '0', avgRating: '0' })];
    const votes = [vote(1, 'a')];
    const { keep, unknown } = resortVotedBooks(votes, map(books));
    expect(keep).toHaveLength(0);
    expect(unknown.map(u => u.bookId)).toEqual(['a']);
  });
});
