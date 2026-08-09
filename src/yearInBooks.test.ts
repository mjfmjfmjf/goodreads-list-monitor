import { describe, expect, it } from 'vitest';
import { topStarLevel, parseRating } from './yearInBooks.js';
import { LibraryEntry } from './libraryExport.js';

function entry(myRating: string): LibraryEntry {
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
