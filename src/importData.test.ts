import { describe, expect, it } from 'vitest';
import {
  splitCsvLine, decodeBookRow, decodeAuthorRow, mergeBook, mergeAuthor, mergeTags,
  decodeTagBookRow, decodeGenreRow, decodeXrefRow,
} from './importData.js';

describe('splitCsvLine', () => {
  it('splits plain fields', () => {
    expect(splitCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });
  it('handles quoted fields with commas and doubled quotes', () => {
    expect(splitCsvLine('"A, B",x')).toEqual(['A, B', 'x']);
    expect(splitCsvLine('"he said ""hi""","y"')).toEqual(['he said "hi"', 'y']);
  });
  it('returns null for empty fields', () => {
    expect(splitCsvLine('a,,c')).toEqual(['a', null, 'c']);
  });
});

const bookHeaders = ['id', 'title', 'author', 'author_id', 'ratings', 'avg_rating', 'published', 'pages', 'series_pos', 'genres', 'work_id'];

describe('decodeBookRow', () => {
  it('decodes typed fields and genres JSON', () => {
    const row = decodeBookRow(bookHeaders, ['1', 'Animal Farm', 'George Orwell', '3706', '4784802', '4.03', '1945', '141', '2', '["Fiction","Classics"]', '2207778']);
    expect(row).toEqual({
      id: '1', title: 'Animal Farm', author: 'George Orwell', authorId: '3706',
      ratings: 4784802, avgRating: 4.03, published: '1945', pages: 141, seriesPos: 2,
      genres: ['Fiction', 'Classics'], workId: '2207778', isBad: null, tags: undefined,
    });
  });
  it('returns null when id is missing', () => {
    expect(decodeBookRow(bookHeaders, [null, 'X', 'A'])).toBeNull();
  });
});

const authorHeaders = ['name', 'id', 'slug', 'last_seen', 'first_seen', 'average_rating', 'num_ratings', 'num_reviews', 'num_shelves', 'catalog_pages', 'last_error'];

describe('decodeAuthorRow', () => {
  it('decodes typed author fields', () => {
    const row = decodeAuthorRow(authorHeaders, ['George Orwell', '3706', '3706.George_Orwell', '2026-08-28', '2026-08-01', '4.13', '11249733', '365731', '19310363', '46', null]);
    expect(row).toEqual({
      name: 'George Orwell', id: '3706', slug: '3706.George_Orwell', lastSeen: '2026-08-28', firstSeen: '2026-08-01',
      averageRating: 4.13, numRatings: 11249733, numReviews: 365731, numShelves: 19310363,
      catalogPages: 46, lastError: undefined,
    });
  });
});

describe('mergeTags', () => {
  it('unions keys, keeps max for numeric, merges objects', () => {
    const out = mergeTags({ a: 1, b: 2, n: 10 }, { a: 5, c: 3, n: 2, obj: { x: 1 } });
    expect(out).toEqual({ a: 5, b: 2, c: 3, n: 10, obj: { x: 1 } });
  });
  it('adopts incoming wholesale when existing is absent', () => {
    expect(mergeTags(undefined, { a: 1 })).toEqual({ a: 1 });
  });
});

describe('mergeBook', () => {
  const existing = {
    title: 'Known', author: 'A', authorId: '9', ratings: 100, avgRating: 4.0,
    published: '2000', pages: 300, seriesPos: null, genres: ['Fiction'], tags: { x: 1 }, workId: 'w1',
  };

  it('fills blank fields, never overwrites good ones', () => {
    const inc = { id: '1', title: 'Known', author: 'A', authorId: '9', ratings: 50, avgRating: 3.0, published: '2000', pages: 300, genres: ['Fiction'] };
    const { merged, changed } = mergeBook(existing, inc);
    expect(merged.ratings).toBe(100);       // existing higher ratings kept
    expect(merged.avgRating).toBe(4.0);     // existing good avg kept (keep policy)
    expect(merged.pages).toBe(300);
    expect(changed).toBe(false);
  });

  it('unions genres and tags when both exist', () => {
    const inc = { id: '1', genres: ['Fiction', 'Classics'], tags: { y: 2 } };
    const { merged, changed } = mergeBook(existing, inc);
    expect(merged.genres).toEqual(['Fiction', 'Classics']);
    expect(merged.tags).toEqual({ x: 1, y: 2 });
    expect(changed).toBe(true);
  });

  it('fills an empty avgRating under keep policy', () => {
    const { merged } = mergeBook({ ...existing, avgRating: null }, { id: '1', avgRating: 4.5 });
    expect(merged.avgRating).toBe(4.5);
  });

  it('overwrites avgRating under update policy', () => {
    const { merged } = mergeBook(existing, { id: '1', avgRating: 5.0 }, 'update');
    expect(merged.avgRating).toBe(5.0);
  });

  it('does not regress ratings count even under update policy', () => {
    const { merged } = mergeBook(existing, { id: '1', ratings: 10, avgRating: 5.0 }, 'update');
    expect(merged.ratings).toBe(100);
  });

  it('fills blank / unknown published and author only when good incoming', () => {
    const { merged } = mergeBook({ title: 'Unknown', author: 'Unknown' }, { id: '1', title: 'Real Title', author: 'Real Author', published: '1990' });
    expect(merged.title).toBe('Real Title');
    expect(merged.author).toBe('Real Author');
    expect(merged.published).toBe('1990');
  });
});

describe('mergeAuthor', () => {
  it('fills blank fields, keeps good ones, updates last_seen', () => {
    const existing = { id: '9', slug: '9.known', lastSeen: '2026-01-01', firstSeen: '2026-01-01', numRatings: 100, averageRating: 4.0 };
    const inc = { name: 'n', id: '9', slug: '9.known', lastSeen: '2026-08-28', numRatings: 50, averageRating: 3.0 };
    const out = mergeAuthor(existing, inc);
    expect(out.numRatings).toBe(100);
    expect(out.averageRating).toBe(4.0);
    expect(out.lastSeen).toBe('2026-08-28');
    expect(out.firstSeen).toBe('2026-01-01');
  });

  it('takes first_seen from incoming when existing has none', () => {
    const existing = { id: '9', slug: '9.known', lastSeen: '2026-01-01' };
    const inc = { name: 'n', id: '9', slug: '9.known', lastSeen: '2026-08-28', firstSeen: '2026-08-01' };
    const out = mergeAuthor(existing, inc);
    expect(out.firstSeen).toBe('2026-08-01');
  });
});

const tagBookHeaders = ['tag_name', 'book_id', 'position', 'shelved', 'harvested_at'];

describe('decodeTagBookRow', () => {
  it('decodes typed fields', () => {
    expect(decodeTagBookRow(tagBookHeaders, ['to-read', '170448', '3', '200', '2026-08-28T00:00:00Z'])).toEqual({
      tagName: 'to-read', bookId: '170448', position: 3, shelved: 200, harvestedAt: '2026-08-28T00:00:00Z',
    });
  });
  it('returns null when the primary key is incomplete', () => {
    expect(decodeTagBookRow(tagBookHeaders, [null, '170448', '3', '200', null])).toBeNull();
    expect(decodeTagBookRow(tagBookHeaders, ['to-read', null, '3', '200', null])).toBeNull();
  });
});

const genreHeaders = ['name', 'member_count', 'first_seen', 'last_updated'];

describe('decodeGenreRow', () => {
  it('decodes typed fields', () => {
    expect(decodeGenreRow(genreHeaders, ['fiction', '1000000', '2026-08-28', '2026-08-28'])).toEqual({
      name: 'fiction', memberCount: 1000000, firstSeen: '2026-08-28', lastUpdated: '2026-08-28',
    });
  });
  it('returns null when name is missing', () => {
    expect(decodeGenreRow(genreHeaders, [null, '1000000', null, null])).toBeNull();
  });
});

const xrefHeaders = ['genre_name', 'tag_name', 'kind'];

describe('decodeXrefRow', () => {
  it('decodes fields with default kind', () => {
    expect(decodeXrefRow(xrefHeaders, ['fiction', 'fiction', 'cognate'])).toEqual({
      genreName: 'fiction', tagName: 'fiction', kind: 'cognate',
    });
  });
  it('returns null when the primary key is incomplete', () => {
    expect(decodeXrefRow(xrefHeaders, [null, 'fiction', 'exact'])).toBeNull();
  });
});
