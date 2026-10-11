import { describe, expect, it, vi, afterAll } from 'vitest';
import chalk from 'chalk';

vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-nexttagwalk-test-${process.pid}-${Date.now()}.db`;
});

import { runNextTagWalk, unwalkedTags } from './nextTagWalk.ts';
import { closeDb, getDb } from './db.ts';
import { recordListTagWalkHistory, upsertListTags } from './storage.ts';

afterAll(() => {
  closeDb();
  delete process.env.GOODREADS_DB_PATH;
});

const row = (tagName: string, lists: number, lastSeen = '2026-10-05T00:00:00.000Z') => ({ tagName, lists, lastSeen });

describe('unwalkedTags', () => {
  it('ranks every tag by number of lists when nothing has been walked', () => {
    const rows = [row('romance', 10), row('fiction', 49), row('fantasy', 32)];
    expect(unwalkedTags(rows, []).map(r => r.tagName)).toEqual(['fiction', 'fantasy', 'romance']);
  });

  it('excludes walked tags and keeps the rest in biggest-first order', () => {
    const rows = [row('romance', 10), row('fiction', 49), row('fantasy', 32), row('mystery', 5)];
    const out = unwalkedTags(rows, ['fiction']);
    expect(out.map(r => r.tagName)).toEqual(['fantasy', 'romance', 'mystery']);
  });

  it('applies minLists before ranking', () => {
    const rows = [row('fiction', 49), row('fantasy', 32), row('mystery', 2)];
    expect(unwalkedTags(rows, [], 3).map(r => r.tagName)).toEqual(['fiction', 'fantasy']);
    expect(unwalkedTags(rows, [], 2).map(r => r.tagName)).toEqual(['fiction', 'fantasy', 'mystery']);
  });

  it('returns an empty list when every tag has been walked', () => {
    const rows = [row('romance', 10), row('fiction', 49)];
    expect(unwalkedTags(rows, ['romance', 'fiction'])).toEqual([]);
  });

  it('is case-insensitive on BOTH sides (Goodreads lowercases tags)', () => {
    const rows = [row('Dutch', 10), row('fiction', 49), row('FICTION', 1)];
    expect(unwalkedTags(rows, ['dutch', 'fiction']).map(r => r.tagName)).toEqual([]);
    expect(unwalkedTags(rows, ['FICTION', 'DUTCH']).map(r => r.tagName)).toEqual([]);
  });

  it('is stable across input order', () => {
    const rows = [row('b', 5), row('a', 5), row('c', 9)];
    expect(unwalkedTags(rows, [])).toEqual(unwalkedTags([...rows].reverse(), []));
  });

  it('handles an empty input', () => {
    expect(unwalkedTags([], [])).toEqual([]);
  });
});

describe('runNextTagWalk', () => {
  const render = async (options: Parameters<typeof runNextTagWalk>[0] = {}) => {
    chalk.level = 0;
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runNextTagWalk({ dryRun: true, ...options });
    const lines = out.mock.calls.map((c) => c.join(' '));
    out.mockRestore();
    return lines;
  };

  it('dryRun lists ALL unwalked tags, biggest first, without crawling', async () => {
    const db = getDb();
    db.exec('DELETE FROM list_tags; DELETE FROM list_tag_walk_history; DELETE FROM list_tag_walks');
    upsertListTags('L1', ['fiction']);
    upsertListTags('L2', ['romance']);
    upsertListTags('L3', ['romance']);
    upsertListTags('L4', ['fantasy']);
    recordListTagWalkHistory('romance', 2);

    const lines = await render();
    expect(lines.some((l) => l.includes('Dry run — 2 unwalked tags found'))).toBe(true);
    const fiction = lines.find((l) => l.includes('fiction'));
    const fantasy = lines.find((l) => l.includes('fantasy'));
    expect(fiction).toBeTruthy();
    expect(fantasy).toBeTruthy();
    expect(fiction).toContain('1 list');
    expect(fantasy).toContain('1 list');
    // romance was walked → excluded from the list.
    expect(lines.some((l) => l.includes('romance'))).toBe(false);
  });

  it('reports when every tag has been walked', async () => {
    const db = getDb();
    db.exec('DELETE FROM list_tags; DELETE FROM list_tag_walk_history; DELETE FROM list_tag_walks');
    upsertListTags('L1', ['fiction']);
    recordListTagWalkHistory('fiction', 1);

    const lines = await render();
    expect(lines.some((l) => l.includes('have been walked'))).toBe(true);
  });

  it('honors minLists so tiny tags are not candidates', async () => {
    const db = getDb();
    db.exec('DELETE FROM list_tags; DELETE FROM list_tag_walk_history; DELETE FROM list_tag_walks');
    upsertListTags('L1', ['fiction']);
    upsertListTags('L2', ['romance']);
    upsertListTags('L3', ['romance']);

    const lines = await render({ minLists: 2 });
    expect(lines.some((l) => l.includes('Dry run — 1 unwalked tag found'))).toBe(true);
    expect(lines.some((l) => l.includes('romance'))).toBe(true);
    expect(lines.some((l) => l.includes('fiction'))).toBe(false);
  });
});