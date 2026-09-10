import { describe, expect, it } from 'vitest';
import {
  buildCandidateQuery,
  classifyBookFetch,
  extractEditionsCount,
  extractNextDataJson,
  parseBookPageFromHtml,
  parseSocialSignals,
  BookPageDetails,
} from './bookPageParse.js';

function nextDataHtml(apolloState: any, extraBody = ''): string {
  const next = { props: { pageProps: { apolloState } } };
  return (
    `<!doctype html><html><body>${extraBody}<script id="__NEXT_DATA__" type="application/json">` +
    `${JSON.stringify(next)}</script></body></html>`
  );
}

// The details/stats/genres live inline on the Book (verified live 2026/09).
const BOOK_ID = '2657';
const APOLLO_STATE: Record<string, any> = {
  'Book:kca://book/test': {
    __typename: 'Book',
    id: 'kca://book/test',
    legacyId: 2657,
    title: 'To Kill a Mockingbird',
    titleComplete: 'To Kill a Mockingbird (To Kill a Mockingbird, #1)',
    description: 'Hardcoded fallback description.',
    'description({"stripped":true})': 'A lawyer in the Depression-era South defends a black man.',
    bookGenres: [
      { __typename: 'BookGenre', genre: { __typename: 'Genre', name: 'Fiction', type: '2' } },
      { __typename: 'BookGenre', genre: { __typename: 'Genre', name: 'classics' } },
      { __typename: 'BookGenre', genre: { __typename: 'Genre', name: 'History' } },
    ],
    details: {
      __typename: 'BookDetails',
      asin: '0060935464',
      format: 'Paperback',
      numPages: 336,
      publicationTime: 1067673600000,
      publisher: 'Harper Perennial Modern Classics',
      isbn: '0060935464',
      isbn13: '9780060935467',
      language: { __typename: 'Language', name: 'English' },
    },
    work: { __ref: 'Work:kca://work/test' },
    bookSeries: [{ __typename: 'BookSeries', series: { __ref: 'Series:1' }, position: 1 }],
  },
  'Work:kca://work/test': {
    __typename: 'Work',
    id: 'kca://work/test',
    legacyId: 1,
    details: { __typename: 'WorkDetails', publicationTime: '2006-07-11T07:00:00-07:00' },
    stats: {
      __typename: 'BookStats',
      averageRating: 4.2751,
      ratingsCount: 1343421,
      ratingsCountDist: [9030, 11853, 51713, 303339, 967486],
      textReviewsCount: 61265,
    },
  },
  'Series:1': { __typename: 'Series', id: '1', title: 'To Kill a Mockingbird' },
};

describe('extractNextDataJson', () => {
  it('extracts the __NEXT_DATA__ JSON', () => {
    const html = nextDataHtml({});
    expect(extractNextDataJson(html)).toContain('"apolloState"');
  });

  it('returns null when no __NEXT_DATA__ script exists', () => {
    expect(extractNextDataJson('<html><body>hi</body></html>')).toBeNull();
  });
});

describe('parseBookPageFromHtml', () => {
  it('parses genres, details, stats, series, work id', () => {
    const html = nextDataHtml(APOLLO_STATE, '<a href="/work/editions/3275794">editions</a>');
    const out: BookPageDetails = parseBookPageFromHtml(html, BOOK_ID);

    // NAV_GENRES entries (History) filtered out; genre names as Author on page
    expect(out.genres).toEqual(['Fiction', 'classics']);
    expect(out.ratings).toBe('1,343,421');
    expect(out.avgRating).toBe('4.28');
    expect(out.reviewsCount).toBe('61,265');
    expect(out.ratingsCountDist?.['5']).toBe(967486);
    expect(out.ratingsCountDist?.['1']).toBe(9030);
    expect(out.published).toBe('2006.07.11');
    expect(out.pages).toBe('336');
    expect(out.publisher).toBe('Harper Perennial Modern Classics');
    expect(out.isbn).toBe('0060935464');
    expect(out.isbn13).toBe('9780060935467');
    expect(out.asin).toBe('0060935464');
    expect(out.format).toBe('Paperback');
    expect(out.language).toBe('English');
    expect(out.description).toBe('A lawyer in the Depression-era South defends a black man.');
    expect(out.series).toEqual([{ title: 'To Kill a Mockingbird', position: '1' }]);
    expect(out.workId).toBe('3275794');
  });

  it('returns empty on junk / missing apollo state', () => {
    expect(parseBookPageFromHtml('<html></html>', '1')).toEqual({ genres: [], series: [] });
    expect(parseBookPageFromHtml(nextDataHtml({}), '1')).toEqual({ genres: [], series: [] });
  });

  it('falls back to __ref genres (legacy shape)', () => {
    const state = JSON.parse(JSON.stringify(APOLLO_STATE)) as Record<string, any>;
    state['Book:kca://book/test'].bookGenres = [
      { __typename: 'BookGenre', genre: { __ref: 'Genre:9' } },
    ];
    state['Genre:9'] = { __typename: 'Genre', name: 'Mystery' };
    const out = parseBookPageFromHtml(nextDataHtml(state), BOOK_ID);
    expect(out.genres).toEqual(['Mystery']);
  });

  it('matches book by legacyId string or number', () => {
    const html = nextDataHtml(APOLLO_STATE);
    expect(parseBookPageFromHtml(html, '02657').genres).toEqual(['Fiction', 'classics']);
  });
});

describe('parseSocialSignals', () => {
  it('reads CURRENTLY_READING and TO_READ counts from ROOT_QUERY', () => {
    const state = {
      ROOT_QUERY: {
        getSocialSignals: [
          { __typename: 'SocialSignal', name: 'CURRENTLY_READING', count: 289322, shelfPhrase: 'are currently reading' },
          { __typename: 'SocialSignal', name: 'TO_READ', count: 1839214, shelfPhrase: 'want to read' },
        ],
      },
    };
    const signals = parseSocialSignals(nextDataHtml(state));
    expect(signals).toEqual({ currentlyReading: 289322, toRead: 1839214 });
  });

  it('ignores non-signal arrays and missing data', () => {
    const state = { ROOT_QUERY: { something: [{ __typename: 'Other', name: 'X', count: 5 }] } };
    expect(parseSocialSignals(nextDataHtml(state))).toEqual({});
    expect(parseSocialSignals('<html></html>')).toEqual({});
  });
});

describe('extractEditionsCount', () => {
  it('parses logged-in "Show all N editions" text', () => {
    expect(extractEditionsCount('<a>Show all 886 editions</a>')).toBe(886);
  });

  it('handles commas and non-breaking spaces', () => {
    expect(extractEditionsCount('<a>Show all 1,234\u00a0editions</a>')).toBe(1234);
    expect(extractEditionsCount('<a>Show all\u00a01,234 editions</a>')).toBe(1234);
  });

  it('returns undefined when no editions line exists', () => {
    expect(extractEditionsCount('<html><body>books 884</body></html>')).toBeUndefined();
    expect(extractEditionsCount('<a>Book details &amp; editions</a>')).toBeUndefined();
  });
});

describe('classifyBookFetch', () => {
  const okHtml = nextDataHtml({}) + ' '.repeat(2000);

  it('classifies HTTP semantics', () => {
    expect(classifyBookFetch({ httpStatus: 200, bytes: okHtml.length, html: okHtml })).toBe('ok');
    expect(classifyBookFetch({ httpStatus: 202, bytes: 2417 })).toBe('throttled');
    expect(classifyBookFetch({ httpStatus: 403, bytes: 117 })).toBe('throttled');
    expect(classifyBookFetch({ httpStatus: 429, bytes: 0 })).toBe('throttled');
    expect(classifyBookFetch({ httpStatus: 404, bytes: 500 })).toBe('missing');
    expect(classifyBookFetch({ httpStatus: 200, bytes: 117, html: '<html></html>' })).toBe('error');
    expect(classifyBookFetch({ networkError: true })).toBe('error');
    expect(classifyBookFetch({})).toBe('error');
  });
});

describe('buildCandidateQuery', () => {
  it('defaults to books without genres, ratings desc', () => {
    const { sql, params } = buildCandidateQuery({ skipHas: ['genres'], sort: 'ratingsDesc', limit: 10 });
    expect(sql).toContain('genres IS NULL');
    expect(sql).toContain('ORDER BY ratings DESC, id ASC LIMIT ?');
    expect(params).toEqual([10]);
  });

  it('supports multiple skip criteria + minRatings + random sort', () => {
    const { sql, params } = buildCandidateQuery({ skipHas: ['genres', 'work-id'], minRatings: 100, sort: 'random', limit: 5 });
    expect(sql).toContain('genres IS NULL');
    expect(sql).toContain('work_id IS NULL');
    expect(sql).toContain('ratings >= ?');
    expect(sql).toContain('ORDER BY RANDOM()');
    expect(params).toEqual([100, 5]);
  });

  it('accepts string skipHas and tags criterion', () => {
    const { sql } = buildCandidateQuery({ skipHas: 'tags', sort: 'ratingsAsc', limit: 1 });
    expect(sql).toContain('tags IS NULL');
    expect(sql).toContain('ORDER BY ratings ASC, id ASC');
  });

  it('throws on unknown criterion or sort', () => {
    expect(() => buildCandidateQuery({ skipHas: ['nonsense'], sort: 'ratingsDesc', limit: 1 })).toThrow(/skip-has/);
    expect(() => buildCandidateQuery({ skipHas: ['genres'], sort: 'bogus', limit: 1 })).toThrow(/--sort/);
  });
});