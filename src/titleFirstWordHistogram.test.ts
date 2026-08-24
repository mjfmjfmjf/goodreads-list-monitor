import { describe, it, expect } from 'vitest';
import { computeTitleFirstWordHistogram, extractFirstWord } from './titleFirstWordHistogram.js';

describe('extractFirstWord', () => {
  it('lowercases and returns the first word', () => {
    expect(extractFirstWord('The Hobbit')).toBe('the');
  });

  it('strips leading punctuation and quotes', () => {
    expect(extractFirstWord('"The" Hobbit')).toBe('the');
    expect(extractFirstWord('“A” Book')).toBe('a');
    expect(extractFirstWord('- Dashes First')).toBe('dashes');
    expect(extractFirstWord('[Bracketed] Title')).toBe('bracketed');
    expect(extractFirstWord('"The" Hobbit')).toBe('the');
  });

  it('returns undefined for empty or symbol-only words', () => {
    expect(extractFirstWord('')).toBeUndefined();
    expect(extractFirstWord('???')).toBeUndefined();
  });

  it('handles unicode words', () => {
    expect(extractFirstWord('Évangile de nuit')).toBe('évangile');
  });
});

describe('computeTitleFirstWordHistogram', () => {
  const books = [
    { title: 'The Hobbit' },
    { title: 'The Fellowship of the Ring' },
    { title: 'A Game of Thrones' },
    { title: '"The" Stand' },
    { title: 'Harry Potter and the Sorcerer\'s Stone' },
  ];

  it('groups case-insensitively and sorts by count desc', () => {
    const hist = computeTitleFirstWordHistogram(books);
    expect(hist.total).toBe(5);
    expect(hist.rows[0]).toEqual({ word: 'the', count: 3 });
    expect(hist.distinctWords).toBe(3);
  });

  it('applies the limit after sorting', () => {
    const hist = computeTitleFirstWordHistogram(books, { limit: 2 });
    expect(hist.rows).toHaveLength(2);
    expect(hist.distinctWords).toBe(3);
  });

  it('defaults to all rows when no limit is given', () => {
    const hist = computeTitleFirstWordHistogram(books);
    expect(hist.rows).toHaveLength(3);
  });
});
