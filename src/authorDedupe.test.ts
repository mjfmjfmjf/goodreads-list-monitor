import { describe, expect, it } from 'vitest';
import { planConsolidation, planRename, collapseName } from './authorDedupe.js';
import type { AuthorRow } from './authorDedupe.js';

function row(name: string, id: string, opts: Partial<AuthorRow> = {}): AuthorRow {
  return {
    name,
    id,
    slug: `${id}.${name.replace(/\s+/g, '_')}`,
    lastSeen: '2026-08-01T00:00:00Z',
    ...opts,
  };
}

describe('collapseName', () => {
  it('collapses internal whitespace runs', () => {
    expect(collapseName('John             Lewis')).toBe('John Lewis');
    expect(collapseName('Allen\tLevi')).toBe('Allen Levi');
    expect(collapseName('  Padded  ')).toBe('Padded');
  });
});

describe('planConsolidation', () => {
  it('returns undefined for a single-row group', () => {
    expect(planConsolidation([row('Solo', '1')])).toBeUndefined();
  });

  it('prefers the stats-bearing variant as keeper', () => {
    const bare = row('Hope Larson(Adapter, Illustrator)', '150820');
    const stats = row('Hope Larson', '150820', { averageRating: 4.1, numRatings: 90000 });
    const plan = planConsolidation([bare, stats])!;
    expect(plan.keep).toBe(stats);
    expect(plan.drop).toEqual([bare]);
  });

  it('keeps the stats-bearing variant and collapses its mangled name', () => {
    const cleanBare = row('Gary Larson', '19928');
    const mangledStats = row('Gary   Larson', '19928', { averageRating: 4.44, numRatings: 143371 });
    const plan = planConsolidation([cleanBare, mangledStats])!;
    expect(plan.keep).toBe(mangledStats);
    expect(plan.drop).toEqual([cleanBare]);
    expect(plan.finalName).toBe('Gary Larson');
  });

  it('prefers clean names over mangled ones with equal stats', () => {
    const mangled = row('John             Lewis', '6429079', { averageRating: 4.44, numRatings: 128504 });
    const clean = row('John Lewis', '6429079', { averageRating: 4.4, numRatings: 100000 });
    const plan = planConsolidation([mangled, clean])!;
    expect(plan.keep).toBe(clean);
    expect(plan.finalName).toBe('John Lewis');
  });

  it('collapses whitespace in the final name', () => {
    const only = row('Virginia      Evans', '51997621', { averageRating: 4.44, numRatings: 828210 });
    const other = row('Virginia      Evans (Reader)', '51997621');
    const plan = planConsolidation([only, other])!;
    expect(plan.finalName).toBe('Virginia Evans');
  });

  it('breaks full ties deterministically by newer lastSeen then name', () => {
    const older = row('A B', '7', { lastSeen: '2026-08-01T00:00:00Z' });
    const newer = row('A B', '7', { lastSeen: '2026-08-09T00:00:00Z' });
    expect(planConsolidation([older, newer])!.keep).toBe(newer);
  });
});

describe('planRename', () => {
  it('renames mangled single rows', () => {
    expect(planRename(row('Rich  Larson', '16463085'))).toEqual({ from: 'Rich  Larson', to: 'Rich Larson' });
  });

  it('leaves clean names alone', () => {
    expect(planRename(row('Jane Austen', '4'))).toBeUndefined();
  });
});
