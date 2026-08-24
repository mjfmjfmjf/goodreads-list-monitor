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

import { parseCatalogPageCount } from './scraper.js';

describe('parseCatalogPageCount', () => {
  it('returns the max page number when pagination exists', () => {
    const html = '<a href="/author/list/3389?page=2">2</a><a href="?page=72">72</a>';
    expect(parseCatalogPageCount(html)).toBe(72);
  });

  it('returns 1 for single-page authors', () => {
    expect(parseCatalogPageCount('<html>no pagination</html>')).toBe(1);
    expect(parseCatalogPageCount('<a href="?page=1">1</a>')).toBe(1);
  });
});
