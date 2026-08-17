import { describe, expect, it } from 'vitest';
import { computeTitleCharHistogram } from './titleCharHistogram.js';

describe('computeTitleCharHistogram', () => {
  const book = (title: string) => ({ title });

  it('counts first characters, sorted by count then char', () => {
    const hist = computeTitleCharHistogram([
      book('The Way of Kings'),
      book('The Hobbit'),
      book('Dune'),
      book('Dune Messiah'),
    ]);
    expect(hist.first).toEqual([
      { char: 'D', count: 2 },
      { char: 'T', count: 2 },
    ]);
  });

  it('counts last characters, including punctuation', () => {
    const hist = computeTitleCharHistogram([
      book('Who Goes There?'),
      book('Is it you?'),
      book('The End!'),
      book('Yes!'),
      book('Help.'),
      book('Ready, Player One'),
    ]);
    expect(hist.last).toEqual([
      { char: '!', count: 2 },
      { char: '?', count: 2 },
      { char: '.', count: 1 },
      { char: 'e', count: 1 },
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
