import { describe, expect, it } from 'vitest';
import { rankPairings } from './genrePairings.js';

describe('rankPairings', () => {
  const genre = new Set(['a', 'b', 'c']); // 3 books

  it('computes overlap, union, and Jaccard for each candidate', () => {
    const res = rankPairings(genre, [
      { tag: 'ab', books: new Set(['a', 'b']) },        // overlap 2, union 3
      { tag: 'identity', books: new Set(['a', 'b', 'c']) }, // overlap 3, union 3
      { tag: 'disjoint', books: new Set(['x', 'y', 'z']) }, // overlap 0
    ]);
    const byTag = new Map(res.map(r => [r.tag, r]));
    expect(byTag.get('ab')!.overlap).toBe(2);
    expect(byTag.get('ab')!.union).toBe(3);
    expect(byTag.get('ab')!.jaccard).toBeCloseTo(2 / 3);
    expect(byTag.get('ab')!.pct).toBe(66.67);

    expect(byTag.get('identity')!.jaccard).toBe(1);
    expect(byTag.get('identity')!.pct).toBe(100);
    expect(byTag.get('disjoint')!.jaccard).toBe(0);
  });

  it('does not mutate or depend on insertion order of candidate sets', () => {
    const res = rankPairings(genre, [
      { tag: 'x', books: new Set(['x']) },
      { tag: 'ab', books: new Set(['a', 'b']) },
    ]);
    // each candidate independently scored (results unsorted here)
    const byTag = new Map(res.map(r => [r.tag, r]));
    expect(byTag.get('ab')!.overlap).toBe(2);
    expect(byTag.get('x')!.overlap).toBe(0);
  });
});
