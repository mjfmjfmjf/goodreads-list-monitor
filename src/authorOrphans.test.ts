import { describe, expect, it } from 'vitest';
import { normalizeAuthorName, selectAuthorOrphans, applyOrphanFilters, classifyOrphan, looksLikeNameConcat, authorListUrl } from './authorOrphans.js';
import type { CachedBook, AuthorCache } from './storage.js';

const book = (author: string, ratings: string, opts: { id?: string; title?: string } = {}): CachedBook => ({
  id: Math.random().toString(36).slice(2),
  title: opts.title ?? 'T',
  author,
  authorId: opts.id,
  ratings,
  published: '',
  lastUpdated: '',
});

const cacheWith = (...names: string[]): AuthorCache =>
  Object.fromEntries(names.map(n => [n, { id: '0', slug: n.toLowerCase().replace(/\s+/g, '-'), lastSeen: '' }]));

describe('normalizeAuthorName', () => {
  it('collapses repeated spaces', () => {
    expect(normalizeAuthorName('John  Green')).toBe('John Green');
    expect(normalizeAuthorName('  Dan    Brown  ')).toBe('Dan Brown');
  });

  it('strips a trailing Unknown Author / Unknown / n/a', () => {
    expect(normalizeAuthorName('Ray Bradbury Unknown Author')).toBe('Ray Bradbury');
    expect(normalizeAuthorName('Someone Unknown')).toBe('Someone');
    expect(normalizeAuthorName('Someone n/a')).toBe('Someone');
    expect(normalizeAuthorName('Someone null')).toBe('Someone');
  });

  it('is idempotent', () => {
    expect(normalizeAuthorName(normalizeAuthorName('  John   Green  '))).toBe('John Green');
  });
});

describe('selectAuthorOrphans', () => {
  it('excludes authors already in the author cache', () => {
    const cache = cacheWith('John Green');
    const { orphans } = selectAuthorOrphans(
      [book('John Green', '1000'), book('Jane Austen', '2000')],
      cache
    );
    expect(orphans.map(o => o.normalizedName)).toEqual(['Jane Austen']);
  });

  it('dedups the same authorId across dirty name strings, keeping highest rating', () => {
    const { orphans } = selectAuthorOrphans(
      [
        book('Robert   A.   Heinlein  Unknown', '5000', { id: '1630' }),
        book('Robert A. Heinlein', '9000', { id: '1630' }),
      ],
      {}
    );
    expect(orphans).toHaveLength(1);
    expect(orphans[0].topRatings).toBe(9000);
    expect(orphans[0].authorId).toBe('1630');
  });

  it('excludes an author already hosted in the cache when matched by authorId', () => {
    // "John  Green" is not a name key, but its authorId already lives in the
    // cache -> must NOT be reported as an orphan.
    const cache = cacheWith('John Green');
    cache['John Green'] = { id: '1406384', slug: '1406384.John_Green', lastSeen: '' };
    const { orphans } = selectAuthorOrphans(
      [book('John  Green', '5000000', { id: '1406384' }), book('A Real Newbie', '100', { id: '9999' })],
      cache
    );
    expect(orphans).toHaveLength(1);
    expect(orphans[0].authorId).toBe('9999');
  });

  it('excludes a whitespace-dirty name with no authorId when it normalizes to a cached key', () => {
    // "Michael  Grant" has no authorId, but normalizes to the cached "Michael Grant".
    const cache = cacheWith('Michael Grant');
    cache['Michael Grant'] = { id: '1599723', slug: '1599723.Michael_Grant', lastSeen: '' };
    const { orphans } = selectAuthorOrphans(
      [book('Michael  Grant', '212024'), book('A Real Newbie', '100', { id: '9999' })],
      cache
    );
    expect(orphans).toHaveLength(1);
    expect(orphans[0].normalizedName).toBe('A Real Newbie');
  });

  it('does NOT exclude a whitespace-dirty name whose normalized form is NOT cached', () => {
    const { orphans } = selectAuthorOrphans(
      [book('Paolo  Cognetti', '58836')],
      {}
    );
    expect(orphans).toHaveLength(1);
    expect(orphans[0].normalizedName).toBe('Paolo Cognetti');
  });

  it('skips unknown-author and blank author strings', () => {
    const { orphans } = selectAuthorOrphans(
      [book('Unknown Author', '1000'), book('', '1000'), book('Real Person', '1000')],
      {}
    );
    expect(orphans).toHaveLength(1);
    expect(orphans[0].normalizedName).toBe('Real Person');
  });

  it('keeps one orphan per author even with multiple books under raw names', () => {
    const { orphans } = selectAuthorOrphans(
      [book('A', '100'), book('A', '200')],
      {}
    );
    expect(orphans).toHaveLength(1);
    expect(orphans[0].topRatings).toBe(200);
  });
});

describe('classifyOrphan / looksLikeNameConcat', () => {
  it('flags multi-author concatenations', () => {
    expect(looksLikeNameConcat('Jane AustenAnthea Bell')).toBe(true);
    expect(looksLikeNameConcat('Georges BlondJohn SteinbeckJames A. MichenerHelen Fowler')).toBe(true);
  });

  it('flags role-suffix run-ons like (Author)Name concatenations', () => {
    expect(looksLikeNameConcat('Heinrich Harrer (Author)Dalai Lama XIV')).toBe(true);
    expect(looksLikeNameConcat('Bell (Translator)Zhu')).toBe(true);
  });

  it('does not flag a role suffix on an otherwise single name', () => {
    expect(looksLikeNameConcat('Richard Graves (Translator)')).toBe(false);
  });

  it('does not flag a normal single name', () => {
    expect(looksLikeNameConcat('John Green')).toBe(false);
    expect(looksLikeNameConcat('Paolo Cognetti')).toBe(false);
  });

  it('classifies each bucket correctly', () => {
    expect(classifyOrphan({ rawName: 'Jane AustenAnthea Bell', normalizedName: 'Jane AustenAnthea Bell', authorId: '1265' })).toBe('concat');
    expect(classifyOrphan({ rawName: 'Paolo Cognetti', normalizedName: 'Paolo Cognetti', authorId: undefined })).toBe('no-id');
    expect(classifyOrphan({ rawName: 'Dan Brown', normalizedName: 'Dan Brown', authorId: '630' })).toBe('missing');
  });
});

describe('authorListUrl', () => {
  it('builds a browser URL from just the authorId', () => {
    expect(authorListUrl({ authorId: '630' }))
      .toBe('https://www.goodreads.com/author/show/630');
  });

  it('returns undefined when there is no authorId', () => {
    expect(authorListUrl({ authorId: undefined })).toBeUndefined();
  });
});

describe('applyOrphanFilters', () => {
  const mk = (name: string, ratings: number): any => ({ rawName: name, normalizedName: name, topRatings: ratings });

  it('sorts by top rating descending', () => {
    const out = applyOrphanFilters([mk('Z', 100), mk('A', 9000), mk('B', 500)], {});
    expect(out.map(o => o.topRatings)).toEqual([9000, 500, 100]);
  });

  it('applies min/max ratings and limit', () => {
    const all = [mk('A', 9000), mk('B', 5000), mk('C', 300), mk('D', 70000)];
    expect(applyOrphanFilters(all, { minRatings: '5000' }).map(o => o.normalizedName)).toEqual(['D', 'A', 'B']);
    expect(applyOrphanFilters(all, { maxRatings: '5000' }).map(o => o.normalizedName)).toEqual(['B', 'C']);
    expect(applyOrphanFilters(all, { limit: '2' }).map(o => o.normalizedName)).toEqual(['D', 'A']);
  });
});
