import { describe, expect, it, vi, afterAll } from 'vitest';
import chalk from 'chalk';

vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-listtags-test-${process.pid}-${Date.now()}.db`;
});

import { resolveLimit, sortTagCounts, formatTagCountLine, runListTags, DEFAULT_LIST_TAGS_LIMIT } from './listTags.ts';
import { closeDb, getDb } from './db.ts';
import { upsertListTags, recordListTagMembership } from './storage.ts';

afterAll(() => {
  closeDb();
  delete process.env.GOODREADS_DB_PATH;
});

describe('resolveLimit', () => {
  it('defaults to 30 when nothing is passed', () => {
    expect(resolveLimit(undefined)).toBe(DEFAULT_LIST_TAGS_LIMIT);
    expect(resolveLimit('')).toBe(30);
  });

  it('passes a positive number through', () => {
    expect(resolveLimit('100')).toBe(100);
    expect(resolveLimit(5)).toBe(5);
  });

  it('falls back to the default for junk rather than printing nothing', () => {
    expect(resolveLimit('abc')).toBe(30);
    expect(resolveLimit('0')).toBe(30);
    expect(resolveLimit('-7')).toBe(30);
  });
});

describe('sortTagCounts', () => {
  it('sorts by list count descending', () => {
    const out = sortTagCounts([
      { tagName: 'romance', lists: 10 },
      { tagName: 'fiction', lists: 49 },
      { tagName: 'fantasy', lists: 32 },
    ]);
    expect(out.map(r => r.tagName)).toEqual(['fiction', 'fantasy', 'romance']);
  });

  it('breaks ties alphabetically so two runs diff clean', () => {
    const out = sortTagCounts([
      { tagName: 'zebra', lists: 5 },
      { tagName: 'apple', lists: 5 },
      { tagName: 'mango', lists: 5 },
    ]);
    expect(out.map(r => r.tagName)).toEqual(['apple', 'mango', 'zebra']);
  });

  it('does not mutate its input', () => {
    const rows = [{ tagName: 'b', lists: 1 }, { tagName: 'a', lists: 9 }];
    sortTagCounts(rows);
    expect(rows.map(r => r.tagName)).toEqual(['b', 'a']);
  });
});

describe('formatTagCountLine', () => {
  it('formats rank, tag, and count', () => {
    const line = formatTagCountLine(1, { tagName: 'romance', lists: 3159 });
    expect(line).toContain('1. romance');
    expect(line).toMatch(/romance\s+3,159$/);
    // column layout stays stable across ranks ≥ 10
    expect(formatTagCountLine(42, { tagName: 'x', lists: 7 })).toMatch(/^\s+42\. x\s+7$/);
  });
});

describe('runListTags', () => {
  const render = async (options: Parameters<typeof runListTags>[0] = {}) => {
    chalk.level = 0;
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runListTags(options);
    const lines = out.mock.calls.map((c) => c.join(' '));
    out.mockRestore();
    return lines;
  };

  it('prints a bare ranked list capped at the limit, counts included', async () => {
    const db = getDb();
    db.exec('DELETE FROM list_tags');
    // 35 tags, 1 list each → default limit shows 30, --limit 5 shows 5.
    for (let i = 0; i < 35; i++) {
      upsertListTags(`LT${i}`, [`tag${String(i).padStart(2, '0')}`]);
    }

    const lines = await render();
    const ranked = lines.filter((l) => /^\s*\d+\.\s+tag\d\d\s+\d+$/.test(l));
    expect(ranked).toHaveLength(30);
    expect(ranked[0]).toContain('tag00');
    expect(ranked.some((l) => l.includes('tag34'))).toBe(false);

    const few = await render({ limit: '5' });
    expect(few.filter((l) => /^\s*\d+\.\s+tag\d\d\s+\d+$/.test(l))).toHaveLength(5);
  });

  it('counts lists learned only through a directory walk — the actual directory size', async () => {
    const db = getDb();
    db.exec('DELETE FROM list_tags');
    upsertListTags('L1', ['walked-tag']);
    upsertListTags('L2', ['walked-tag']);
    // L3..L5 were never read for their sidebar; the walk of walked-tag found them.
    recordListTagMembership('walked-tag', ['L3', 'L4', 'L5']);

    const lines = await render();
    const line = lines.find((l) => l.includes('walked-tag'));
    expect(line).toBeTruthy();
    expect(line).toMatch(/walked-tag\s+5$/);
  });

  it('says how little data there is rather than printing an empty table', async () => {
    const db = getDb();
    db.exec('DELETE FROM list_tags');
    const lines = await render();
    expect(lines.join('\n')).toContain('No list_tags rows yet');
  });
});
