import { describe, expect, it } from 'vitest';
import { computePublisherCatalog } from './publisherCatalog.js';
import type { PublisherBookRow } from './publisherCatalog.js';

const row = (publisher: string, workKey: string, ratings: number, avgRating: number | null): PublisherBookRow => ({
  publisher,
  workKey,
  ratings,
  avgRating,
});

describe('computePublisherCatalog', () => {
  const rows = [
    row('Penguin', 'w1', 1000, 4.2),
    row('Penguin', 'w2', 500, 3.9),
    row('Penguin', 'w3', 50, 3.0),
    row('Tor', 'w4', 8000, 4.5),
    row('Tor', 'w5', 3000, 4.1),
    row('Self', 'w6', 2, 5.0),
  ];

  it('sorts by number of distinct works by default', () => {
    const out = computePublisherCatalog(rows, {});
    expect(out.map((p) => p.publisher)).toEqual(['Penguin', 'Tor', 'Self']);
    expect(out.find((p) => p.publisher === 'Penguin')?.books).toBe(3);
  });

  it('collapses editions of the same work into one book', () => {
    const withEditions = [
      ...rows,
      row('Penguin', 'w1', 1000, 4.2),
      row('Penguin', 'w1', 1100, 4.3),
      row('Tor', 'w4', 8000, 4.5),
    ];
    const out = computePublisherCatalog(withEditions, {});
    expect(out.find((p) => p.publisher === 'Penguin')?.books).toBe(3);
    // highest-rated edition of w1 (1100) wins statistically
    expect(out.find((p) => p.publisher === 'Penguin')?.totalRatings).toBe(1100 + 500 + 50);
  });

  it('sorts by average star rating with a minimum ratings floor', () => {
    const out = computePublisherCatalog(rows, { sortBy: 'avgRating', minRatings: '100' });
    // Self is dropped (its only work has 2 < 100 ratings); Tor beats Penguin.
    expect(out.map((p) => p.publisher)).toEqual(['Tor', 'Penguin']);
    expect(out.find((p) => p.publisher === 'Tor')?.avgRating).toBeCloseTo(4.3);
    expect(out.find((p) => p.publisher === 'Penguin')?.avgRating).toBeCloseTo(4.05);
  });

  it('respects minBooks to skip thin publishers', () => {
    const out = computePublisherCatalog(rows, { minBooks: '2' });
    expect(out.map((p) => p.publisher)).toEqual(['Penguin', 'Tor']);
  });

  it('sorts by totalRatings', () => {
    const out = computePublisherCatalog(rows, { sortBy: 'totalRatings' });
    expect(out.map((p) => p.publisher)).toEqual(['Tor', 'Penguin', 'Self']);
  });

  it('keeps publishers with no avg_rating but sorts them last for avgRating', () => {
    const noAvg = [row('A', 'w1', 100, null), row('B', 'w2', 200, 4.0)];
    const out = computePublisherCatalog(noAvg, { sortBy: 'avgRating' });
    expect(out.map((p) => p.publisher)).toEqual(['B', 'A']);
    expect(out.find((p) => p.publisher === 'A')?.avgRating).toBeNull();
  });

  it('applies the limit', () => {
    const out = computePublisherCatalog(rows, { limit: '2' });
    expect(out).toHaveLength(2);
  });
});