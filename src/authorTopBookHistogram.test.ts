import { describe, expect, it } from 'vitest';
import { computeAuthorTopBookHistogram, buildAuthorBucketBuckets } from './authorTopBookHistogram.js';
import type { CachedBook } from './storage.js';

const book = (author: string, ratings: string, opts: { authorId?: string } = {}): CachedBook => ({
  id: Math.random().toString(36).slice(2),
  title: 'T',
  author,
  authorId: opts.authorId,
  ratings,
  published: '',
  lastUpdated: '',
});

describe('buildAuthorBucketBuckets', () => {
  it('collapses millions into one > 1,000,000 band', () => {
    const b = buildAuthorBucketBuckets();
    expect(b[0].label).toBe('> 1,000,000');
    expect(b[0].min).toBe(1_000_000);
    expect(b[0].max).toBe(Infinity);
    expect(b[1].label).toBe('900,000 to 999,999');
  });

  it('collapses thousands into 1,000 to 10,000 and hundreds into 100 to 1,000', () => {
    const b = buildAuthorBucketBuckets();
    expect(b[19]).toMatchObject({ label: '1,000 to 10,000', min: 1_000, max: 9_999 });
    expect(b[20]).toMatchObject({ label: '100 to 1,000', min: 100, max: 999 });
  });

  it('keeps tens and units granular', () => {
    const b = buildAuthorBucketBuckets();
    expect(b[29].label).toBe('10 to 19');
    expect(b[b.length - 1].label).toBe('0');
  });
});

describe('computeAuthorTopBookHistogram', () => {
  it('bins each author by their single highest-rated book', () => {
    // A: highest book = 5,000,000 (> 1,000,000 band, idx 0),
    // B: highest = 90,000 (90,000 to 99,999, idx 10)
    const books = [
      book('A', '80,000'), book('A', '5,000,000'),
      book('B', '80,000'), book('B', '90,000'),
    ];
    const { counts } = computeAuthorTopBookHistogram(books);
    expect(counts[0]).toBe(1);
    expect(counts[10]).toBe(1);
    expect(counts[11]).toBe(0); // 80,000 to 89,999
    expect(counts[14]).toBe(0); // no author has 500k-599k top book
  });

  it('ignores a book with fewer ratings than the author already has', () => {
    const books = [
      book('A', '10'), book('A', '3'), book('A', '7'),
    ];
    const { counts, totalAuthors } = computeAuthorTopBookHistogram(books);
    expect(totalAuthors).toBe(1);
    expect(counts[29]).toBe(1); // 10 to 19
    expect(counts[36]).toBe(0); // 3 — not counted
  });

  it('counts each author once even with a comma-formatted rating', () => {
    const { totalAuthors } = computeAuthorTopBookHistogram([
      book('A', '500000'), book('A', '500,000'),
    ]);
    expect(totalAuthors).toBe(1);
  });

  it('groups unknown/empty authors under Unknown', () => {
    const { totalAuthors } = computeAuthorTopBookHistogram([
      book('', '4,000'), book('Unknown', '4,000'),
    ]);
    expect(totalAuthors).toBe(1);
  });

  it('reports which authors are in the author cache', () => {
    const books = [book('A', '4000'), book('B', '5000')];
    const authorNames = new Set(['A']);
    const { totalAuthors, inAuthorCache, notInAuthorCache } =
      computeAuthorTopBookHistogram(books, authorNames);
    expect(totalAuthors).toBe(2);
    expect(inAuthorCache).toBe(1);
    expect(notInAuthorCache).toBe(1);
  });

  it('counts an author once across mangled name strings when authorId matches', () => {
    // Same authorId, two different name strings -> one author (id wins over name).
    const books = [
      book('Jane AustenAnthea Bell', '5000', { authorId: '1265' }),
      book('Jane Austen', '9000', { authorId: '1265' }),
    ];
    const { counts, totalAuthors } = computeAuthorTopBookHistogram(books);
    expect(totalAuthors).toBe(1);
    expect(counts[19]).toBe(1); // top book 9000 lands in '1,000 to 10,000' band
  });

  it('matches an author as in-cache by authorId even when the name is absent', () => {
    const books = [book('John  Green', '5000000', { authorId: '1406384' })];
    // known name set does NOT contain 'John  Green' (normalized 'John Green'),
    // but knownAuthorIds contains 1406384 -> in-cache.
    const authorNames = new Set<string>([]);
    const authorIds = new Set(['1406384']);
    const { inAuthorCache, notInAuthorCache } =
      computeAuthorTopBookHistogram(books, authorNames, authorIds);
    expect(inAuthorCache).toBe(1);
    expect(notInAuthorCache).toBe(0);
  });

  it('handles an empty cache', () => {
    const { counts, totalAuthors } = computeAuthorTopBookHistogram([]);
    expect(totalAuthors).toBe(0);
    expect(counts.every(c => c === 0)).toBe(true);
  });
});
