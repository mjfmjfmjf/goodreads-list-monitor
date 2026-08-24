import { describe, expect, it } from 'vitest';
import { computeSeriesPosHistogram } from './summarySeriesPos.js';

describe('computeSeriesPosHistogram', () => {
  const book = (title: string, seriesPos?: number) => ({ title, seriesPos });

  it('counts books per series position, sorted ascending', () => {
    const hist = computeSeriesPosHistogram([
      book('Oathbringer (The Stormlight Archive, #3)', 3),
      book('The Way of Kings (The Stormlight Archive, #1)', 1),
      book('Words of Radiance (The Stormlight Archive, #2)', 2),
      book('Oathbringer (The Stormlight Archive, #3)', 3),
      book('Dune'),
    ]);
    expect(hist).toEqual({
      standalone: 1,
      multiVolume: 0,
      rows: [
        { pos: 1, count: 1 },
        { pos: 2, count: 1 },
        { pos: 3, count: 2 },
      ],
      total: 5,
    });
  });

  it('parses positions from titles when the cache value is missing', () => {
    const hist = computeSeriesPosHistogram([
      book('Berserk, Vol. 12'),
      book('ハイキュー!! 4 [Haikyū!! 4]'),
      book('One Piece, Volume 23: Vivi\'s Adventure'),
      book('Dune'),
    ]);
    expect(hist.standalone).toBe(1);
    expect(hist.rows).toEqual([
      { pos: 4, count: 1 },
      { pos: 12, count: 1 },
      { pos: 23, count: 1 },
    ]);
  });

  it('separates multi-volume collections from single positions', () => {
    const hist = computeSeriesPosHistogram([
      book('Berserk, Vol. 12-14'),
      book('Dune Box Set (Dune, #1-#3)', 99.99),
      book('Oathbringer (The Stormlight Archive, #3)', 3),
    ]);
    expect(hist.multiVolume).toBe(2);
    expect(hist.rows).toEqual([{ pos: 3, count: 1 }]);
  });

  it('prefers a fresh title parse over the cached seriesPos', () => {
    const hist = computeSeriesPosHistogram([
      book('The Way of Kings (The Stormlight Archive, #1)', 1),
      book('The Way of Kings (The Stormlight Archive, #1)', 5),
    ]);
    expect(hist.rows).toEqual([{ pos: 1, count: 2 }]);
  });

  it('falls back to the cached seriesPos when the title has no marker', () => {
    const hist = computeSeriesPosHistogram([
      book('Dune', 3),
    ]);
    expect(hist.rows).toEqual([{ pos: 3, count: 1 }]);
  });

  it('handles floating-point positions like novellas', () => {
    const hist = computeSeriesPosHistogram([
      book('The Edges (Gem Quest, #0.5)', 0.5),
      book('Edge of Eternity (Century Trilogy, #3.5)', 3.5),
    ]);
    expect(hist.rows).toEqual([
      { pos: 0.5, count: 1 },
      { pos: 3.5, count: 1 },
    ]);
  });

  it('handles an empty cache', () => {
    expect(computeSeriesPosHistogram([])).toEqual({
      standalone: 0,
      multiVolume: 0,
      rows: [],
      total: 0,
    });
  });

  it('sorts rows by count descending with --byCount, ties broken by position', () => {
    const hist = computeSeriesPosHistogram([
      book('A (#1)'),
      book('B (#2)'),
      book('C (#2)'),
      book('D (#3)'),
      book('E (#3)'),
      book('F (#3)'),
    ], { byCount: true });
    expect(hist.rows).toEqual([
      { pos: 3, count: 3 },
      { pos: 2, count: 2 },
      { pos: 1, count: 1 },
    ]);
  });
});
