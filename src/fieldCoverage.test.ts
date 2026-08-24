import { describe, it, expect } from 'vitest';
import { computeFieldStats, formatCoverageLine } from './fieldCoverage.js';
import chalk from 'chalk';

describe('computeFieldStats', () => {
  it('maps SQL aggregate rows to FieldStats with numeric coercion', () => {
    const stats = computeFieldStats({ work_id: 12, genres: null }, 20);
    expect(stats).toEqual([
      { field: 'work_id', populated: 12, total: 20 },
      { field: 'genres', populated: 0, total: 20 },
    ]);
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
});
