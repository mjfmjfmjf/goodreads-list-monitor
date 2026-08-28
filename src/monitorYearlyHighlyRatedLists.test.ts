import { describe, expect, it } from 'vitest';
import { computeYearlyDistinctWorks, mapYearListSizes } from './monitorYearlyHighlyRatedLists.js';

describe('computeYearlyDistinctWorks', () => {
  it('counts distinct works per year at the 4.4/4.5/4.6 thresholds', () => {
    const out = computeYearlyDistinctWorks([
      { year: 2024, maxAvg: 4.7 },
      { year: 2024, maxAvg: 4.45 },
      { year: 2024, maxAvg: 4.3 },
      { year: 2025, maxAvg: 4.55 },
      { year: 2025, maxAvg: 4.6 },
    ]);
    expect(out).toEqual([
      { year: 2024, gte44: 2, gte45: 1, gte46: 1 },
      { year: 2025, gte44: 2, gte45: 2, gte46: 1 },
    ]);
  });

  it('sorts years ascending and skips empty ones', () => {
    const out = computeYearlyDistinctWorks([
      { year: 2026, maxAvg: 4.9 },
      { year: 2012, maxAvg: 3.0 },
    ]);
    expect(out.map(c => c.year)).toEqual([2012, 2026]);
    expect(out[0]).toEqual({ year: 2012, gte44: 0, gte45: 0, gte46: 0 });
  });

  it('returns empty for no input', () => {
    expect(computeYearlyDistinctWorks([])).toEqual([]);
  });
});

describe('mapYearListSizes', () => {
  it('maps "Highest Rated Books of YYYY" titles to year -> lastCount', () => {
    const out = mapYearListSizes({
      '250123': { title: 'Highest Rated Books of 2024', lastCount: 90 },
      '419195': { title: 'Highest Rated Books of 2015', lastCount: 126 },
    });
    expect(out.get(2024)).toBe(90);
    expect(out.get(2015)).toBe(126);
  });

  it('handles the "by avg rating" suffix', () => {
    const out = mapYearListSizes({
      '419829': { title: 'Highest Rated Books of 2025 by avg rating', lastCount: 55 },
    });
    expect(out.get(2025)).toBe(55);
  });

  it('ignores lists without a year title or a lastCount', () => {
    const out = mapYearListSizes({
      'abc': { title: 'Some Other List', lastCount: 10 },
      'def': { title: 'Highest Rated Books of 2016', lastCount: undefined },
    });
    expect(out.size).toBe(0);
  });
});
