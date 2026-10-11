import { describe, expect, it, vi, afterAll } from 'vitest';
import chalk from 'chalk';

vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-listtagwalker-test-${process.pid}-${Date.now()}.db`;
});

vi.mock('./scraper.ts', () => ({
  scrapeListsByTag: vi.fn(async () => [
    { id: '100', slug: 'recently_scraped_list', url: 'https://www.goodreads.com/list/show/100' },
  ]),
  scrapeListBooks: vi.fn(async () => []),
}));

import { runListTagWalker, shouldSkipList } from './listTagWalker.ts';
import { closeDb, getDb } from './db.ts';
import { upsertListScrape } from './storage.ts';

afterAll(() => {
  closeDb();
  delete process.env.GOODREADS_DB_PATH;
});

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

describe('runListTagWalker walk-membership recording', () => {
  it('records directory membership for a list it SKIPPED, not only for crawled ones', async () => {
    const db = getDb();
    // Scraped an hour ago → the skipDays=7 default takes the skip path, so the
    // crawl (scrapeListBooks) is never called for this list. Regression: the
    // membership write used to sit after that `continue`, so skipped lists
    // never got a row (christian walk: 27 of 828 recorded).
    upsertListScrape('100', 'Recently Scraped');

    chalk.level = 0;
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runListTagWalker({ tag: 'christian', skipDays: 7 });
    out.mockRestore();
    err.mockRestore();

    // Unified xref: the row lives in list_tags, flagged from_directory (the
    // list was reached THROUGH the tag), not in a side table.
    const row = db.prepare(
      `SELECT list_id, tag_name, from_directory, from_sidebar
       FROM list_tags WHERE tag_name='christian' AND list_id='100'`
    ).get() as any;
    expect(row).toBeTruthy();
    expect(row.list_id).toBe('100');
    expect(row.from_directory).toBe(1);
    expect(row.from_sidebar).toBe(0);

    // …and the walk itself is counted in the tag-level history.
    const hist = db.prepare(
      `SELECT num_walks, num_lists FROM list_tag_walk_history WHERE tag_name='christian'`
    ).get() as any;
    expect(hist).toBeTruthy();
    expect(hist.num_lists).toBe(1);
    expect(hist.num_walks).toBeGreaterThanOrEqual(1);
  });

  it('does not write walk rows on a dry run', async () => {
    const db = getDb();
    chalk.level = 0;
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runListTagWalker({ tag: 'dryrun-tag', dryRun: true });
    out.mockRestore();

    const row = db.prepare(
      `SELECT list_id FROM list_tags WHERE tag_name='dryrun-tag' AND from_directory=1`
    ).get();
    expect(row).toBeFalsy();
    expect(
      db.prepare(`SELECT 1 FROM list_tag_walk_history WHERE tag_name='dryrun-tag'`).get(),
    ).toBeFalsy();
  });
});