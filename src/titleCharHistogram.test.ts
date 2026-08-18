import { describe, expect, it } from 'vitest';
import { computeTitleCharHistogram } from './titleCharHistogram.js';
import { stripTitleSuffix } from './utils.js';

describe('stripTitleSuffix', () => {
  it('strips trailing series info with number', () => {
    expect(stripTitleSuffix('Yukon Ho! (Calvin and Hobbes, #3)')).toBe('Yukon Ho!');
    expect(stripTitleSuffix('Harry Potter and the Half-Blood Prince (Harry Potter, #6)')).toBe('Harry Potter and the Half-Blood Prince');
  });

  it('strips trailing format tags', () => {
    expect(stripTitleSuffix('The Heidi Chronicles (Paperback)')).toBe('The Heidi Chronicles');
    expect(stripTitleSuffix('Sand and Foam (Hardcover)')).toBe('Sand and Foam');
  });

  it('strips trailing series ranges', () => {
    expect(stripTitleSuffix('Harry Potter Boxed Set, Books 1-5 (Harry Potter, #1-5)')).toBe('Harry Potter Boxed Set, Books 1-5');
  });

  it('strips trailing series without #', () => {
    expect(stripTitleSuffix('Rising from the Plains (Annals of the Former World, 3)')).toBe('Rising from the Plains');
  });

  it('leaves titles without trailing parens unchanged', () => {
    expect(stripTitleSuffix('Dune')).toBe('Dune');
    expect(stripTitleSuffix('The Way of Kings')).toBe('The Way of Kings');
  });

  it('handles empty title', () => {
    expect(stripTitleSuffix('')).toBe('');
  });
});

describe('computeTitleCharHistogram', () => {
  const book = (title: string) => ({ title });

  it('counts first characters after stripping series suffixes', () => {
    const hist = computeTitleCharHistogram([
      book('Yukon Ho! (Calvin and Hobbes, #3)'),
      book('The Way of Kings (The Stormlight Archive, #1)'),
      book('The Hobbit'),
      book('Dune'),
    ]);
    expect(hist.first).toEqual([
      { char: 'T', count: 2 },
      { char: 'D', count: 1 },
      { char: 'Y', count: 1 },
    ]);
  });

  it('counts last characters after stripping series suffixes', () => {
    const hist = computeTitleCharHistogram([
      book('Yukon Ho! (Calvin and Hobbes, #3)'),
      book('Weirdos from Another Planet! (Calvin and Hobbes, #4)'),
      book('The End.'),
      book('Help.'),
    ]);
    expect(hist.last).toEqual([
      { char: '!', count: 2 },
      { char: '.', count: 2 },
    ]);
  });

  it('treats ? ! . and , as first characters too', () => {
    const hist = computeTitleCharHistogram([
      book('? Strange Title'),
      book('! Another One'),
      book('. Dot Start'),
      book(', Comma Start'),
    ]);
    expect(hist.first).toEqual([
      { char: '!', count: 1 },
      { char: ',', count: 1 },
      { char: '.', count: 1 },
      { char: '?', count: 1 },
    ]);
  });

  it('skips empty titles', () => {
    const hist = computeTitleCharHistogram([book(''), book('')]);
    expect(hist).toEqual({ first: [], last: [], total: 2 });
  });

  it('handles an empty cache', () => {
    expect(computeTitleCharHistogram([])).toEqual({ first: [], last: [], total: 0 });
  });
});
