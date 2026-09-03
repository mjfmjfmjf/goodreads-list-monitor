import { describe, it, expect } from 'vitest';
import { computeFieldStats, formatCoverageLine } from './fieldCoverage.js';
import chalk from 'chalk';

describe('computeFieldStats', () => {
  it('maps SQL aggregate rows to FieldStats with numeric coercion', () => {
    const stats = computeFieldStats({ work_id: 12, genres: null }, 20);
    expect(stats).toEqual([
      { field: 'work_id', populated: 12, total: 20, distinct: undefined },
      { field: 'genres', populated: 0, total: 20, distinct: undefined },
    ]);
  });

  it('attaches distinct counts when a distinct map is provided', () => {
    const stats = computeFieldStats(
      { work_id: 12, pages: 5 },
      20,
      { work_id: 11, pages: 4 },
    );
    expect(stats).toEqual([
      { field: 'work_id', populated: 12, total: 20, distinct: 11 },
      { field: 'pages', populated: 5, total: 20, distinct: 4 },
    ]);
  });

  it('omits distinct for fields missing from the distinct map', () => {
    const stats = computeFieldStats({ work_id: 12, pages: 5 }, 20, { work_id: 11 });
    expect(stats.find(s => s.field === 'pages')?.distinct).toBeUndefined();
  });
});

describe('formatCoverageLine', () => {
  it('shows percent and missing count', () => {
    chalk.level = 0;
    expect(formatCoverageLine({ field: 'work_id', populated: 5, total: 10 })).toContain('50.0%');
    expect(formatCoverageLine({ field: 'work_id', populated: 5, total: 10 })).toContain('(5 missing)');
  });

  it('marks complete fields', () => {
    chalk.level = 0;
    expect(formatCoverageLine({ field: 'title', populated: 100, total: 100 })).toContain('✓ complete');
  });

  it('shows distinct count when present', () => {
    chalk.level = 0;
    expect(formatCoverageLine({ field: 'work_id', populated: 10, total: 20, distinct: 8 })).toContain('8 distinct');
  });
});
