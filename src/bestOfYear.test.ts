import { describe, expect, it } from 'vitest';
import { applyBestOfYearPublished, resolveYearRange, BEST_OF_YEAR_FIRST } from './bestOfYear.js';

describe('resolveYearRange', () => {
  it('defaults to 1980 through the current year', () => {
    const { start, end } = resolveYearRange();
    expect(start).toBe(BEST_OF_YEAR_FIRST);
    expect(end).toBe(new Date().getFullYear());
  });

  it('honors explicit min and max', () => {
    expect(resolveYearRange('1995', '2005')).toEqual({ start: 1995, end: 2005 });
  });

  it('allows an open-ended max with explicit min', () => {
    const { start, end } = resolveYearRange('2024');
    expect(start).toBe(2024);
    expect(end).toBe(new Date().getFullYear());
  });

  it('rejects an inverted range', () => {
    expect(() => resolveYearRange('2020', '2010')).toThrow(/after/);
  });

  it('falls back to defaults on garbage input', () => {
    expect(resolveYearRange('abc', 'xyz')).toEqual({
      start: BEST_OF_YEAR_FIRST,
      end: new Date().getFullYear(),
    });
  });
});

describe('applyBestOfYearPublished', () => {
  const year = 2021;

  it('fills Unknown and missing publish years with the list year', () => {
    const books = [
      { id: '1', published: 'Unknown' },
      { id: '2' },
      { id: '3', published: '' },
    ];
    const out = applyBestOfYearPublished(books, year);
    expect(out.map(b => b.published)).toEqual(['2021', '2021', '2021']);
  });

  it('keeps real publish years (including full dates)', () => {
    const books = [
      { id: '1', published: '2016' },
      { id: '2', published: '2001.07.19' },
      { id: '3', published: '1999' },
    ];
    const out = applyBestOfYearPublished(books, year);
    expect(out.map(b => b.published)).toEqual(['2016', '2001.07.19', '1999']);
  });

  it('does not mutate the input books', () => {
    const books = [{ id: '1', published: 'Unknown' }];
    applyBestOfYearPublished(books, year);
    expect(books[0].published).toBe('Unknown');
  });
});
