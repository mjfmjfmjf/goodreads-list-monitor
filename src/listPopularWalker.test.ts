import { describe, expect, it } from 'vitest';
import { shouldMarkScraped } from './listPopularWalker.js';

describe('shouldMarkScraped', () => {
  it('marks a full crawl as scraped', () => {
    expect(shouldMarkScraped(100, undefined, 7)).toBe(true);
    expect(shouldMarkScraped(1, undefined, 7)).toBe(true);
  });

  it('does not mark empty results as scraped', () => {
    expect(shouldMarkScraped(0, undefined, 7)).toBe(false);
  });

  it('does not mark partial (capped) crawls as scraped', () => {
    expect(shouldMarkScraped(100, 20, 7)).toBe(false);
    expect(shouldMarkScraped(0, 20, 7)).toBe(false);
  });

  it('never marks anything when skipDays is 0 or negative', () => {
    expect(shouldMarkScraped(100, undefined, 0)).toBe(false);
    expect(shouldMarkScraped(100, undefined, -1)).toBe(false);
  });
});