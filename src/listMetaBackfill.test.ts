import fs from 'fs-extra';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Redirect to an isolated temp DB BEFORE db.ts is imported.
vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-listmetabackfill-${process.pid}-${Date.now()}.db`;
});

import { runListMetaBackfill, selectListsMissingMeta } from './listMetaBackfill.ts';
import { DB_PATH, closeDb, getDb } from './db.ts';

afterAll(() => {
  closeDb();
});

function reset(): void {
  const db = getDb();
  db.exec('DELETE FROM list_meta; DELETE FROM list_tags; DELETE FROM list_scrapes; DELETE FROM lists; DELETE FROM books;');
}

function scrapeRow(listId: string, firstScraped: string, lastScraped = firstScraped): void {
  getDb()
    .prepare('INSERT INTO list_scrapes (list_id, list_name, first_scraped, last_scraped) VALUES (?, ?, ?, ?)')
    .run(listId, `List ${listId}`, firstScraped, lastScraped);
}

function metaRow(listId: string, over: Partial<Record<string, unknown>> = {}): void {
  const row = {
    num_books: 100,
    num_voters: 10,
    num_likes: 5,
    created_at: '2010-01-01',
    creator_id: '1',
    creator_name: 'Creator',
    ...over,
  };
  getDb()
    .prepare(
      'INSERT INTO list_meta (list_id, num_books, num_voters, num_likes, created_at, creator_id, creator_name, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      listId,
      row.num_books,
      row.num_voters,
      row.num_likes,
      row.created_at,
      row.creator_id,
      row.creator_name,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
}

function listPageHtml(over: {
  books?: string;
  voters?: string;
  likes?: string | null;
  created?: string;
  creatorName?: string;
  creatorId?: string | null;
  tags?: string[];
} = {}): string {
  const {
    books = '1,234',
    voters = '56',
    likes = '78',
    created = 'May 1st, 2013',
    creatorName = 'Jane Doe',
    creatorId = '42',
    tags = ['romance', 'fiction'],
  } = over;
  const creator =
    creatorId === null ? creatorName : `<a href="/user/show/${creatorId}-jane">${creatorName}</a>`;
  const likeBlock =
    likes === null
      ? '<div class="likeItContainer"></div>'
      : `<div class="likeItContainer"><span class="likesCount">${likes} likes</span></div>`;
  const tagLinks = tags
    .map((tag) => `<a class="actionLinkLite" href="/list/show_tag/${tag}">${tag}</a>`)
    .join(' ');
  return `<!doctype html><html><body>
    <div class="stacked">
      <div>${books} books · ${voters} voters · list created ${created} by ${creator}.</div>
      <div>Tags: ${tagLinks}</div>
    </div>
    ${likeBlock}
  </body></html>`;
}

describe('test DB isolation', () => {
  it('never opens the production database', () => {
    expect(path.resolve(DB_PATH)).not.toBe(path.join(process.cwd(), 'goodreads.db'));
  });
});

describe('selectListsMissingMeta', () => {
  beforeEach(reset);

  it('keeps missing and partial rows, drops complete rows, earliest first', () => {
    scrapeRow('300', '2026-01-02T00:00:00.000Z');
    scrapeRow('100', '2026-01-01T00:00:00.000Z');
    scrapeRow('200', '2026-01-01T12:00:00.000Z');

    metaRow('200'); // complete → excluded
    metaRow('300', { num_likes: null }); // partial → included
    // '100' has no list_meta row → included

    expect(selectListsMissingMeta()).toEqual(['100', '300']);
  });

  it('includes list_tags/list-only ids after the crawled ones', () => {
    scrapeRow('100', '2026-01-01T00:00:00.000Z');
    getDb()
      .prepare('INSERT INTO list_tags (list_id, tag_name, first_seen, last_seen) VALUES (?, ?, ?, ?)')
      .run('400', 'romance', 't', 't');
    getDb()
      .prepare('INSERT INTO lists (list_id, title) VALUES (?, ?)')
      .run('500', 'List 500');

    expect(selectListsMissingMeta()).toEqual(['100', '400', '500']);
  });

  it('treats a deleted-user creator name as satisfying the creator requirement', () => {
    scrapeRow('100', '2026-01-01T00:00:00.000Z');
    metaRow('100', { creator_id: null, creator_name: 'deleted user' });
    expect(selectListsMissingMeta()).toEqual([]);
  });
});

describe('runListMetaBackfill', () => {
  beforeEach(reset);

  it('records header metadata and sidebar tags without touching list_scrapes', async () => {
    scrapeRow('9', '2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');

    const results = await runListMetaBackfill({
      fetchListPage: async () => listPageHtml(),
    });

    const row = getDb().prepare('SELECT * FROM list_meta WHERE list_id = ?').get('9') as any;
    expect(row.num_books).toBe(1234);
    expect(row.num_voters).toBe(56);
    expect(row.num_likes).toBe(78);
    expect(row.created_at).toBe('2013-05-01');
    expect(row.created_at_raw).toBe('May 1st, 2013');
    expect(row.creator_id).toBe('42');
    expect(row.creator_name).toBe('Jane Doe');

    const tags = getDb()
      .prepare('SELECT tag_name, from_sidebar FROM list_tags WHERE list_id = ? ORDER BY tag_name')
      .all('9') as { tag_name: string; from_sidebar: number }[];
    expect(tags).toEqual([
      { tag_name: 'fiction', from_sidebar: 1 },
      { tag_name: 'romance', from_sidebar: 1 },
    ]);

    const scrape = getDb().prepare('SELECT * FROM list_scrapes WHERE list_id = ?').get('9') as any;
    expect(scrape.first_scraped).toBe('2026-01-01T00:00:00.000Z');
    expect(scrape.last_scraped).toBe('2026-06-01T00:00:00.000Z');
    expect(scrape.num_scraped).toBeNull();
    expect(scrape.num_books_scraped).toBeNull();

    expect((getDb().prepare('SELECT COUNT(*) AS n FROM books').get() as any).n).toBe(0);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ listId: '9', existed: false, tagsRecorded: 2 });
  });

  it('fills the current year for a year-less header and keeps the raw text', async () => {
    scrapeRow('9', '2026-01-01T00:00:00.000Z');

    const results = await runListMetaBackfill({
      fetchListPage: async () => listPageHtml({ created: 'January 17th' }),
    });

    const row = getDb().prepare('SELECT * FROM list_meta WHERE list_id = ?').get('9') as any;
    expect(row.created_at).toBe(`${new Date().getFullYear()}-01-17`);
    expect(row.created_at_raw).toBe('January 17th');
    expect(results[0]).toMatchObject({
      listId: '9',
      createdAt: `${new Date().getFullYear()}-01-17`,
      createdAtRaw: 'January 17th',
    });
    expect(selectListsMissingMeta()).toEqual([]);
  });

  it('fills a partial row and marks it as existing', async () => {
    scrapeRow('9', '2026-01-01T00:00:00.000Z');
    metaRow('9', { num_likes: null });

    const results = await runListMetaBackfill({ fetchListPage: async () => listPageHtml() });

    expect(results[0]).toMatchObject({ listId: '9', existed: true });
    expect((getDb().prepare('SELECT num_likes FROM list_meta WHERE list_id = ?').get('9') as any).num_likes).toBe(78);
  });

  it('treats an empty like container as zero likes', async () => {
    scrapeRow('9', '2026-01-01T00:00:00.000Z');
    await runListMetaBackfill({ fetchListPage: async () => listPageHtml({ likes: null }) });
    expect((getDb().prepare('SELECT num_likes FROM list_meta WHERE list_id = ?').get('9') as any).num_likes).toBe(0);
  });

  it('does not fetch in a dry run', async () => {
    scrapeRow('9', '2026-01-01T00:00:00.000Z');
    const fetchListPage = vi.fn(async () => listPageHtml());

    const results = await runListMetaBackfill({ dryRun: true, fetchListPage });

    expect(results).toEqual([]);
    expect(fetchListPage).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT 1 FROM list_meta WHERE list_id = ?').get('9')).toBeUndefined();
  });

  it('marks a dead list terminal so the next run does not re-queue it', async () => {
    scrapeRow('9', '2026-01-01T00:00:00.000Z');

    const results = await runListMetaBackfill({
      fetchListPage: async () => {
        throw Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } });
      },
    });

    expect(results).toEqual([]);
    const row = getDb().prepare('SELECT meta_missing FROM list_meta WHERE list_id = ?').get('9') as any;
    expect(row.meta_missing).toBe(1);
    expect(selectListsMissingMeta()).toEqual([]);
  });

  it('waits between lists on success and on 404 failures', async () => {
    scrapeRow('9', '2026-01-01T00:00:00.000Z');
    scrapeRow('10', '2026-01-02T00:00:00.000Z');
    scrapeRow('11', '2026-01-03T00:00:00.000Z');
    const wait = vi.fn(async () => {});

    await runListMetaBackfill({
      wait,
      fetchListPage: async (listId) => {
        if (listId === '10') return listPageHtml();
        throw Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } });
      },
    });

    // Pace after list 9 (404) and list 10 (success), but not after the last id.
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('records a no-metadata page and does not requeue it', async () => {
    scrapeRow('9', '2026-01-01T00:00:00.000Z');

    const results = await runListMetaBackfill({
      fetchListPage: async () => '<div>nothing here</div>',
    });

    expect(results).toEqual([]);
    const row = getDb().prepare('SELECT meta_missing, is_static FROM list_meta WHERE list_id = ?').get('9') as any;
    expect(row.meta_missing).toBe(1);
    expect(row.is_static).toBe(0);
    expect(selectListsMissingMeta()).toEqual([]);
  });

  it('records a static list and marks it static', async () => {
    scrapeRow('9', '2026-01-01T00:00:00.000Z');

    await runListMetaBackfill({
      fetchListPage: async () => '<div>This is a static list.</div>',
    });

    const row = getDb().prepare('SELECT meta_missing, is_static FROM list_meta WHERE list_id = ?').get('9') as any;
    expect(row.meta_missing).toBe(1);
    expect(row.is_static).toBe(1);
    expect(selectListsMissingMeta()).toEqual([]);
  });

  it('stops the run on throttling', async () => {
    scrapeRow('9', '2026-01-01T00:00:00.000Z');

    await expect(
      runListMetaBackfill({
        fetchListPage: async () => {
          throw Object.assign(new Error('Goodreads throttled'), { response: { status: 429 } });
        },
      }),
    ).rejects.toThrow('Goodreads throttled');
  });
});
