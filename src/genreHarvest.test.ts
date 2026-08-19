import { describe, it, expect } from 'vitest';
import { extractBookDetailsFromHtml, extractGenresFromDom } from './genreHarvest.js';

function makePage(apolloState: Record<string, any>, bookId: string, extraDom = ''): string {
  const bookKey = `Book:${bookId}`;
  apolloState[bookKey] = apolloState[bookKey] || { legacyId: parseInt(bookId, 10) };
  const nextData = JSON.stringify({ props: { pageProps: { apolloState } } });
  return `<html><head><script id="__NEXT_DATA__" type="application/json">${nextData}</script></head><body>${extraDom}</body></html>`;
}

describe('extractBookDetailsFromHtml', () => {
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
    const result = extractBookDetailsFromHtml(html, '44767458');
    expect(result.genres).toEqual(['Mystery', 'Thriller']);
  });

  it('returns empty genres when no bookGenres present', () => {
    const state: Record<string, any> = {
      'Book:12345': { legacyId: 12345 }
    };
    const html = makePage(state, '12345');
    expect(extractBookDetailsFromHtml(html, '12345').genres).toEqual([]);
  });

  it('returns empty when __NEXT_DATA__ is missing', () => {
    expect(extractBookDetailsFromHtml('<html><body>hello</body></html>', '123').genres).toEqual([]);
  });

  it('returns empty when JSON is malformed', () => {
    const html = `<html><head><script id="__NEXT_DATA__" type="application/json">{bad json</script></head><body></body></html>`;
    expect(extractBookDetailsFromHtml(html, '123').genres).toEqual([]);
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
    expect(extractBookDetailsFromHtml(html, '99999').genres).toEqual(['Mystery']);
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
    expect(extractBookDetailsFromHtml(html, '555').genres).toEqual(['Fiction']);
  });

  it('extracts ratings from work stats', () => {
    const state: Record<string, any> = {
      'Book:100': {
        legacyId: 100,
        work: { __ref: 'Work:w1' },
        bookGenres: []
      },
      'Work:w1': {
        stats: { ratingsCount: 12345, averageRating: 4.32 }
      }
    };
    const html = makePage(state, '100');
    const result = extractBookDetailsFromHtml(html, '100');
    expect(result.ratings).toBe('12,345');
    expect(result.avgRating).toBe('4.32');
  });

  it('extracts ratings from book stats directly', () => {
    const state: Record<string, any> = {
      'Book:200': {
        legacyId: 200,
        stats: { ratingsCount: 999, averageRating: 3.5 },
        bookGenres: []
      }
    };
    const html = makePage(state, '200');
    const result = extractBookDetailsFromHtml(html, '200');
    expect(result.ratings).toBe('999');
    expect(result.avgRating).toBe('3.50');
  });

  it('extracts published date from work details', () => {
    const state: Record<string, any> = {
      'Book:300': {
        legacyId: 300,
        work: { __ref: 'Work:w2' },
        bookGenres: []
      },
      'Work:w2': {
        details: { publicationTime: 1609459200000 } // 2021-01-01
      }
    };
    const html = makePage(state, '300');
    const result = extractBookDetailsFromHtml(html, '300');
    expect(result.published).toMatch(/^\d{4}\.\d{2}\.\d{2}$/);
  });

  it('extracts pages from book details', () => {
    const state: Record<string, any> = {
      'Book:400': {
        legacyId: 400,
        details: { numPages: 350 },
        bookGenres: []
      }
    };
    const html = makePage(state, '400');
    const result = extractBookDetailsFromHtml(html, '400');
    expect(result.pages).toBe('350');
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
