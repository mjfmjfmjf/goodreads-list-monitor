import { describe, expect, it } from 'vitest';
import { wasAuthorPageScraped } from './authorTopStats.js';
import type { AuthorCacheEntry } from './storage.js';

const entry = (extra: Partial<AuthorCacheEntry> = {}): AuthorCacheEntry => ({
  id: '1',
  slug: '1.slug',
  lastSeen: '2026-01-01T00:00:00.000Z',
  ...extra,
});

describe('wasAuthorPageScraped', () => {
  it('is false for a minted-but-never-scraped author (no stats, no catalogPages)', () => {
    expect(wasAuthorPageScraped(entry({}))).toBe(false);
    expect(wasAuthorPageScraped(entry({ catalogPages: undefined }))).toBe(false);
    expect(wasAuthorPageScraped(entry({ catalogPages: 0 }))).toBe(false);
  });

  it('is true when any author-page stat is present', () => {
    expect(wasAuthorPageScraped(entry({ numRatings: '0' }))).toBe(true);
    expect(wasAuthorPageScraped(entry({ averageRating: '0' }))).toBe(true);
    expect(wasAuthorPageScraped(entry({ numReviews: '0' }))).toBe(true);
    expect(wasAuthorPageScraped(entry({ numShelves: '0' }))).toBe(true);
    expect(wasAuthorPageScraped(entry({ numRatings: '100' }))).toBe(true);
  });

  it('is true for a scraped-but-statless author (catalogPages proof, zero stats)', () => {
    expect(wasAuthorPageScraped(entry({ catalogPages: 1 }))).toBe(true);
    expect(wasAuthorPageScraped(entry({ catalogPages: 5 }))).toBe(true);
    expect(wasAuthorPageScraped(entry({ catalogPages: 2 }))).toBe(true);
  });
});