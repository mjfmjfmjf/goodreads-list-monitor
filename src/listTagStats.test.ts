import { describe, expect, it, vi, afterAll } from 'vitest';
import chalk from 'chalk';

vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-listtagstats-test-${process.pid}-${Date.now()}.db`;
});

import { rankListTags, runListTagStats } from './listTagStats.ts';
import { closeDb, getDb } from './db.ts';
import { recordListTagMembership, recordListTagWalkHistory, upsertListTags } from './storage.ts';

afterAll(() => {
  closeDb();
  delete process.env.GOODREADS_DB_PATH;
});

const row = (tagName: string, lists: number, lastSeen = '2026-10-05T00:00:00.000Z') => ({ tagName, lists, lastSeen });

describe('rankListTags', () => {
  it('ranks by number of lists, descending', () => {
    const out = rankListTags([row('romance', 10), row('fiction', 49), row('fantasy', 32)]);
    expect(out.map(r => r.tagName)).toEqual(['fiction', 'fantasy', 'romance']);
    expect(out.map(r => r.lists)).toEqual([49, 32, 10]);
  });

  it('breaks ties by tag name, so repeated runs print the same order', () => {
    const out = rankListTags([row('zebra', 5), row('apple', 5), row('mango', 5)]);
    expect(out.map(r => r.tagName)).toEqual(['apple', 'mango', 'zebra']);
  });

  it('is stable across input order', () => {
    const rows = [row('b', 5), row('a', 5), row('c', 9)];
    expect(rankListTags(rows)).toEqual(rankListTags([...rows].reverse()));
  });

  it('applies minLists, dropping tags below the threshold', () => {
    const rows = [row('fiction', 49), row('rare', 2), row('mystery', 5)];
    expect(rankListTags(rows, { minLists: '5' }).map(r => r.tagName)).toEqual(['fiction', 'mystery']);
    // threshold of 1 keeps everything
    expect(rankListTags(rows, { minLists: '1' })).toHaveLength(3);
  });

  it('treats a missing or malformed minLists as 1 rather than dropping everything', () => {
    const rows = [row('fiction', 49), row('rare', 2)];
    expect(rankListTags(rows, {})).toHaveLength(2);
    expect(rankListTags(rows, { minLists: '' })).toHaveLength(2);
    expect(rankListTags(rows, { minLists: 'abc' })).toHaveLength(2);
    expect(rankListTags(rows, { minLists: '0' })).toHaveLength(2);
  });

  it('carries the newest last_seen through for display', () => {
    const out = rankListTags([row('fiction', 9, '2026-10-05T00:00:00.000Z')]);
    expect(out[0].lastSeen).toBe('2026-10-05T00:00:00.000Z');
  });

  it('handles an empty input', () => {
    expect(rankListTags([])).toEqual([]);
  });
});

describe('runListTagStats walk annotation', () => {
  const render = async (options: Parameters<typeof runListTagStats>[0] = {}) => {
    chalk.level = 0;
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runListTagStats({ limit: '10', ...options });
    const lines = out.mock.calls.map((c) => c.join(' '));
    out.mockRestore();
    return lines;
  };

  it('shows walk counts, unknown-membership walks, and never-walked', async () => {
    const db = getDb();
    db.exec('DELETE FROM list_tags; DELETE FROM list_tag_walk_history; DELETE FROM list_tag_walks');
    // Sidebar tags (list_tags): historical seen on 2 lists, classic/astronomy 1.
    upsertListTags('L1', ['historical']);
    upsertListTags('L2', ['historical']);
    upsertListTags('L3', ['classic']);
    upsertListTags('L4', ['astronomy']);
    // Directory walk: historical's tag index yielded L1, L2, AND L5 — a list
    // whose sidebar we never read. The unified xref counts all 3, so the
    // report's number is the directory's real size, not the sidebar subset.
    recordListTagMembership('historical', ['L1', 'L2', 'L5']);
    recordListTagWalkHistory('historical', 3);
    // classic walked with membership unknown (pre-unification placeholder),
    // astronomy never walked at all.
    recordListTagWalkHistory('classic', null);

    const lines = await render();

    expect(lines.find((l) => l.includes('historical'))).toContain('walked 3 lists');
    expect(lines.find((l) => l.includes('classic'))).toContain('membership unknown');
    expect(lines.find((l) => l.includes('astronomy'))).toContain('never walked');
  });

  it('suppresses the annotation under --exclude-walked, where nothing shown was walked', async () => {
    const lines = await render({ excludeWalked: true });
    const tagLines = lines.filter((l) => /^\s*\d+\.\s+\S/.test(l));
    expect(tagLines.length).toBeGreaterThan(0);
    for (const l of tagLines) {
      expect(l).not.toContain('never walked');
      expect(l).not.toContain('walked ');
    }
  });
});