import { describe, expect, it } from 'vitest';
import { computeGenreCompare } from './genreCompare.js';

describe('computeGenreCompare', () => {
  it('splits into exact-matched, unmatched genres, and non-genre tags', () => {
    const genres = ['science-fiction', 'fantasy', 'young-adult', 'dark-fantasy'];
    const tags = ['science-fiction', 'fantasy', 'young-adult', 'ya', 'to-read'];
    const { exactMatched, unmatched, nonGenreTags } = computeGenreCompare(genres, tags);

    expect(exactMatched.sort()).toEqual(['fantasy', 'science-fiction', 'young-adult']);
    expect(unmatched).toEqual(['dark-fantasy']);
    expect(nonGenreTags.sort()).toEqual(['to-read', 'ya']);
  });

  it('handles empty tag set (all genres unmatched, no non-genre tags)', () => {
    const { exactMatched, unmatched, nonGenreTags } = computeGenreCompare(['a', 'b'], []);
    expect(exactMatched).toEqual([]);
    expect(unmatched.sort()).toEqual(['a', 'b']);
    expect(nonGenreTags).toEqual([]);
  });

  it('handles empty genre set (all tags are non-genre tags)', () => {
    const { exactMatched, unmatched, nonGenreTags } = computeGenreCompare([], ['x', 'y']);
    expect(exactMatched).toEqual([]);
    expect(unmatched).toEqual([]);
    expect(nonGenreTags.sort()).toEqual(['x', 'y']);
  });
});
