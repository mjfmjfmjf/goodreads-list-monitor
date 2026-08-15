import { describe, expect, it } from 'vitest';
import { formatDuration, formatBookLink } from './utils.js';

describe('formatDuration', () => {
  it('formats sub-minute runs', () => {
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(45000)).toBe('0m');
  });

  it('formats minutes', () => {
    expect(formatDuration(60000)).toBe('1m');
    expect(formatDuration(5 * 60000 + 30000)).toBe('5m');
  });

  it('formats hours and minutes', () => {
    expect(formatDuration(60 * 60000)).toBe('1h 0m');
    expect(formatDuration(2 * 3600000 + 18 * 60000)).toBe('2h 18m');
  });

  it('truncates seconds', () => {
    expect(formatDuration(3600000 + 60000 + 59000)).toBe('1h 1m');
  });
});

describe('formatBookLink', () => {
  it('builds a well-formed link for a plain title', () => {
    expect(formatBookLink('Dune', '1')).toBe('[book:Dune|1]');
  });

  it('strips nested brackets from the title', () => {
    expect(formatBookLink('約束のネバーランド 19 [Yakusoku no Neverland 19] (The Promised Neverland, #19)', '51925212')).toBe(
      '[book:約束のネバーランド 19 Yakusoku no Neverland 19 (The Promised Neverland, #19)|51925212]'
    );
  });

  it('strips pipe characters from the title', () => {
    expect(formatBookLink('Title | Part', '7')).toBe('[book:Title Part|7]');
  });

  it('strips leading/trailing brackets and collapses spaces', () => {
    expect(formatBookLink('[Hello] World', '3')).toBe('[book:Hello World|3]');
    expect(formatBookLink('A  [B]  C', '4')).toBe('[book:A B C|4]');
  });
});

