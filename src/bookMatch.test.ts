import { describe, expect, it } from 'vitest';
import { splitAuthorNames, authorFirstAndLast, compileRegex, matchesRegex } from './bookMatch.js';

describe('splitAuthorNames', () => {
  it('returns an empty list for missing or Unknown authors', () => {
    expect(splitAuthorNames('')).toEqual([]);
    expect(splitAuthorNames('Unknown')).toEqual([]);
  });
  it('splits on commas, ampersands, and "and"', () => {
    expect(splitAuthorNames('Terry Pratchett, Neil Gaiman')).toEqual(['Terry Pratchett', 'Neil Gaiman']);
    expect(splitAuthorNames('Barbara Kingsolver & Terry McMillan')).toEqual(['Barbara Kingsolver', 'Terry McMillan']);
    expect(splitAuthorNames('Alan Moore and David Lloyd')).toEqual(['Alan Moore', 'David Lloyd']);
  });
  it('keeps a single author intact', () => {
    expect(splitAuthorNames('Lois McMaster Bujold')).toEqual(['Lois McMaster Bujold']);
  });
});

describe('authorFirstAndLast', () => {
  it('extracts first and last tokens, stripping roles', () => {
    expect(authorFirstAndLast('Brandon Sanderson (Goodreads Author)')).toEqual({ first: 'Brandon', last: 'Sanderson' });
  });
  it('handles multi-token names and empty input', () => {
    expect(authorFirstAndLast('Lois McMaster Bujold')).toEqual({ first: 'Lois', last: 'Bujold' });
    expect(authorFirstAndLast('')).toEqual({ first: '', last: '' });
  });
});

describe('compileRegex / matchesRegex', () => {
  it('matches on title regex', () => {
    expect(matchesRegex({ title: 'Dune', author: 'Frank Herbert' }, { titleRegex: '^dune$' })).toBe(true);
    expect(matchesRegex({ title: 'God Emperor of Dune', author: 'Frank Herbert' }, { titleRegex: '^dune$' })).toBe(false);
  });
  it('matches on author last name', () => {
    expect(matchesRegex({ title: 'Dune', author: 'Frank Herbert' }, { authorLastRegex: 'herbert' })).toBe(true);
    expect(matchesRegex({ title: 'Dune', author: 'Frank Herbert' }, { authorLastRegex: 'kafka' })).toBe(false);
  });
  it('compiles case-insensitively', () => {
    expect(compileRegex('dune').test('DUNE')).toBe(true);
  });
});
