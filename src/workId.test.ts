import { describe, expect, it } from 'vitest';
import { extractWorkId } from './scraper.js';

describe('extractWorkId', () => {
  it('extracts the id from a work/editions link', () => {
    const html = `<a href="/work/editions/62400415">All editions</a>`;
    expect(extractWorkId(html)).toBe('62400415');
  });

  it('returns the first editions link when several appear', () => {
    const html = `<a href="/work/editions/111">a</a><a href="/work/editions/222">b</a>`;
    expect(extractWorkId(html)).toBe('111');
  });

  it('falls back to an embedded workId field', () => {
    expect(extractWorkId(`{"bookId":"3862393","workId":"62400415"}`)).toBe('62400415');
    expect(extractWorkId(`"workId": 999888`)).toBe('999888');
  });

  it('ignores plain book links and empty input', () => {
    expect(extractWorkId(`<a href="/book/show/3862393">LOTR</a>`)).toBeUndefined();
    expect(extractWorkId('')).toBeUndefined();
    expect(extractWorkId('<html>nothing here</html>')).toBeUndefined();
  });
});
