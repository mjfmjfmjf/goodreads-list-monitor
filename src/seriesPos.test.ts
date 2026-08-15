import { describe, expect, it } from 'vitest';
import { parseSeriesPos, matchesSeriesPos, SERIES_POS_MULTI, SERIES_POS_STANDALONE } from './seriesPos.js';

describe('parseSeriesPos (general book form)', () => {
  it('parses a single integer position', () => {
    expect(parseSeriesPos('Oathbringer (The Stormlight Archive, #3)')).toBe(3);
    expect(parseSeriesPos('The Way of Kings (The Stormlight Archive, #1)')).toBe(1);
    expect(parseSeriesPos('約束のネバーランド 19 [Yakusoku no Neverland 19] (The Promised Neverland, #19)')).toBe(19);
  });

  it('parses floating-point positions', () => {
    expect(parseSeriesPos('The Edges (Gem Quest, #0.5)')).toBe(0.5);
    expect(parseSeriesPos('Edge of Eternity (Century Trilogy, #3.5)')).toBe(3.5);
  });

  it('parses a bare #N marker without parentheses', () => {
    expect(parseSeriesPos('Stormlight Archive #3')).toBe(3);
  });

  it('labels ranges (#1-3, #1-#7) as SERIES_POS_MULTI boxed sets', () => {
    expect(parseSeriesPos('Anne: The Green Gables Collection (Anne of Green Gables, #1-3, 5, 7-8, Story Girl, #1-2)')).toBe(SERIES_POS_MULTI);
    expect(parseSeriesPos('Dune Box Set (Dune, #1-#3)')).toBe(SERIES_POS_MULTI);
    expect(parseSeriesPos('The Lord of the Rings (The Lord of the Rings, #1-3)')).toBe(SERIES_POS_MULTI);
    expect(parseSeriesPos('The Chronicles of Narnia (The Chronicles of Narnia, #1-7)')).toBe(SERIES_POS_MULTI);
  });

  it('takes the first marker for a book in multiple series (not a boxed set)', () => {
    expect(parseSeriesPos('The Voyage of the Dawn Treader (Chronicles of Narnia, #5) (Publication Order, #3)')).toBe(5);
    expect(parseSeriesPos('The Color of Magic (Discworld, #1; Rincewind, #1)')).toBe(1);
    expect(parseSeriesPos('(Series, #1, #2)')).toBe(1);
  });

  it('returns undefined for standalone books', () => {
    expect(parseSeriesPos('Dune')).toBeUndefined();
    expect(parseSeriesPos('The Great Gatsby')).toBeUndefined();
    expect(parseSeriesPos('Unknown')).toBeUndefined();
    expect(parseSeriesPos('')).toBeUndefined();
  });

  it('ignores # without a following digit', () => {
    expect(parseSeriesPos('C# in a Nutshell')).toBeUndefined();
  });
});

describe('parseSeriesPos (manga — Vol. / Volume form)', () => {
  it('parses the "Vol. N" form', () => {
    expect(parseSeriesPos('Berserk, Vol. 12')).toBe(12);
    expect(parseSeriesPos('One Piece, Vol. 3')).toBe(3);
    expect(parseSeriesPos('Solo Leveling, Vol. 1')).toBe(1);
    expect(parseSeriesPos('Chainsaw Man, Vol.11')).toBe(11);
  });

  it('parses the "Volume N" form', () => {
    expect(parseSeriesPos('One Piece, Volume 23: Vivi\'s Adventure')).toBe(23);
    expect(parseSeriesPos('The Complete Sherlock Holmes, Volume 1')).toBe(1);
  });

  it('labels multi-volume manga omnibuses as SERIES_POS_MULTI', () => {
    expect(parseSeriesPos('Berserk, Vol. 12-14')).toBe(SERIES_POS_MULTI);
    expect(parseSeriesPos('Berserk, Vol. 12 and Vol. 13')).toBe(SERIES_POS_MULTI);
  });

  it('returns undefined when no volume marker is present', () => {
    expect(parseSeriesPos('Volumetric Analysis')).toBeUndefined();
    expect(parseSeriesPos('The Five People You Meet in Heaven')).toBeUndefined();
  });
});

describe('parseSeriesPos (manga — double-bang form)', () => {
  it('parses the "ハイキュー!! N" form, including the bracketed romanization', () => {
    expect(parseSeriesPos('ハイキュー!! 4 [Haikyū!! 4]')).toBe(4);
    expect(parseSeriesPos('ワンピース!! 5 [One Piece!! 5]')).toBe(5);
    expect(parseSeriesPos('[Haikyū!! 4]')).toBe(4);
  });

  it('labels a range as SERIES_POS_MULTI', () => {
    expect(parseSeriesPos('ハイキュー!! 1-3 [Haikyū!! 1-3]')).toBe(SERIES_POS_MULTI);
  });

  it('does not treat the repeated bracketed marker as multi-volume', () => {
    expect(parseSeriesPos('ハイキュー!! 4 [Haikyū!! 4] (Haikyū!!, #4)')).toBe(4);
  });

  it('returns undefined when there is no double-bang marker', () => {
    expect(parseSeriesPos('Dune')).toBeUndefined();
    expect(parseSeriesPos('Play It Again, Sam!!')).toBeUndefined();
  });
});

describe('matchesSeriesPos', () => {
  it('matches exact positions', () => {
    expect(matchesSeriesPos(3, 3)).toBe(true);
    expect(matchesSeriesPos(3, 2)).toBe(false);
    expect(matchesSeriesPos(0.5, 0.5)).toBe(true);
    expect(matchesSeriesPos(3, undefined)).toBe(false);
  });

  it('matches standalone with the -1 sentinel', () => {
    expect(matchesSeriesPos(SERIES_POS_STANDALONE, undefined)).toBe(true);
    expect(matchesSeriesPos(SERIES_POS_STANDALONE, 3)).toBe(false);
  });
});
