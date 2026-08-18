import { describe, it, expect } from 'vitest';
import { extractGenresFromHtml, extractGenresFromDom } from './genreHarvest.js';

function makePage(apolloState: Record<string, any>, bookId: string, extraDom = ''): string {
  const bookKey = `Book:${bookId}`;
  apolloState[bookKey] = apolloState[bookKey] || { legacyId: parseInt(bookId, 10) };
  const nextData = JSON.stringify({ props: { pageProps: { apolloState } } });
  return `<html><head><script id="__NEXT_DATA__" type="application/json">${nextData}</script></head><body>${extraDom}</body></html>`;
}

describe('extractGenresFromHtml', () => {
  it('extracts genres from bookGenres referencing Genre keys in apolloState', () => {
    const state: Record<string, any> = {
      'Genre:kca://genre/1': { name: 'Mystery', webUrl: '/genres/mystery' },
      'Genre:kca://genre/2': { name: 'Thriller', webUrl: '/genres/thriller' },
      'Book:44767458': {
        legacyId: 44767458,
        bookGenres: [
          { genre: { __ref: 'Genre:kca://genre/1' } },
          { genre: { __ref: 'Genre:kca://genre/2' } }
        ]
      }
    };
    const html = makePage(state, '44767458');
    expect(extractGenresFromHtml(html, '44767458')).toEqual(['Mystery', 'Thriller']);
  });

  it('returns empty array when no bookGenres present', () => {
    const state: Record<string, any> = {
      'Book:12345': { legacyId: 12345 }
    };
    const html = makePage(state, '12345');
    expect(extractGenresFromHtml(html, '12345')).toEqual([]);
  });

  it('returns empty when __NEXT_DATA__ is missing', () => {
    expect(extractGenresFromHtml('<html><body>hello</body></html>', '123')).toEqual([]);
  });

  it('returns empty when JSON is malformed', () => {
    const html = `<html><head><script id="__NEXT_DATA__" type="application/json">{bad json</script></head><body></body></html>`;
    expect(extractGenresFromHtml(html, '123')).toEqual([]);
  });

  it('handles legacyId as string', () => {
    const state: Record<string, any> = {
      'Genre:kca://genre/10': { name: 'Mystery' },
      'Book:99999': {
        legacyId: '99999',
        bookGenres: [{ genre: { __ref: 'Genre:kca://genre/10' } }]
      }
    };
    const html = makePage(state, '99999');
    expect(extractGenresFromHtml(html, '99999')).toEqual(['Mystery']);
  });

  it('deduplicates genres', () => {
    const state: Record<string, any> = {
      'Genre:kca://genre/1': { name: 'Fiction' },
      'Book:555': {
        legacyId: 555,
        bookGenres: [
          { genre: { __ref: 'Genre:kca://genre/1' } },
          { genre: { __ref: 'Genre:kca://genre/1' } }
        ]
      }
    };
    const html = makePage(state, '555');
    expect(extractGenresFromHtml(html, '555')).toEqual(['Fiction']);
  });
});

describe('extractGenresFromDom', () => {
  it('extracts genre names from genre links', () => {
    const html = `<html><body>
      <a href="/genres/mystery">Mystery</a>
      <a href="/genres/thriller?from=hp">Thriller</a>
    </body></html>`;
    expect(extractGenresFromDom(html)).toEqual(['Mystery', 'Thriller']);
  });

  it('deduplicates', () => {
    const html = `<html><body>
      <a href="/genres/fiction">Fiction</a>
      <a href="/genres/fiction">Fiction</a>
    </body></html>`;
    expect(extractGenresFromDom(html)).toEqual(['Fiction']);
  });

  it('returns empty when no genre links', () => {
    expect(extractGenresFromDom('<html><body>nothing here</body></html>')).toEqual([]);
  });
});
