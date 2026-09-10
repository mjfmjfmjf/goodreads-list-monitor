import { describe, expect, it } from 'vitest';
import { shouldSkipList } from './listTagWalker.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = '2026-09-08T00:00:00.000Z';

describe('shouldSkipList', () => {
  it('skips lists scraped within the window', () => {
    expect(shouldSkipList('2026-09-07T00:00:00.000Z', NOW, 7)).toBe(true); // 1 day old
    expect(shouldSkipList('2026-09-01T00:00:00.000Z', NOW, 7)).toBe(true); // 7 days old
  });

  it('does not skip lists older than the window', () => {
    expect(shouldSkipList('2026-08-31T23:59:59.000Z', NOW, 7)).toBe(false); // just over 7 days
    expect(shouldSkipList('2025-09-08T00:00:00.000Z', NOW, 7)).toBe(false);
  });

  it('never skips when skipDays is 0 or negative', () => {
    expect(shouldSkipList('2026-09-07T23:59:59.000Z', NOW, 0)).toBe(false);
    expect(shouldSkipList('2026-09-07T23:59:59.000Z', NOW, -1)).toBe(false);
  });

  it('handles unparseable timestamps by not skipping', () => {
    expect(shouldSkipList('garbage', NOW, 7)).toBe(false);
  });
});

// Boundary: a scrape exactly skipDays old ("in the last 7 days") IS skipped.
expect(shouldSkipList(new Date(Date.parse(NOW) - 7 * DAY).toISOString(), NOW, 7)).toBe(true);