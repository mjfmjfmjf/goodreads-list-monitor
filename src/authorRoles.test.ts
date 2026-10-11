import { describe, expect, it, vi, afterAll } from 'vitest';
import chalk from 'chalk';

vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-authorroles-test-${process.pid}-${Date.now()}.db`;
});

import {
  extractCandidates,
  normalizeRole,
  selectRoles,
  rankRoleCounts,
  summarizeRoles,
  collectRoleDetail,
  runAuthorRoles,
} from './authorRoles.ts';
import { closeDb, getDb } from './db.ts';

afterAll(() => {
  closeDb();
  delete process.env.GOODREADS_DB_PATH;
});

describe('normalizeRole', () => {
  it('lowercases and collapses whitespace and slashes', () => {
    expect(normalizeRole('Editor / Contributor')).toBe('editor/contributor');
    expect(normalizeRole('  House   Name ')).toBe('house name');
    expect(normalizeRole('EDITOR')).toBe('editor');
  });
});

describe('extractCandidates', () => {
  it('finds a trailing role', () => {
    expect(extractCandidates('Vincenzo Bellini(Composer)')).toEqual(['composer']);
    expect(extractCandidates('John Joseph Adams(Editor)')).toEqual(['editor']);
  });

  it('finds a mid-string role left by a run-on concatenation', () => {
    expect(extractCandidates('Heinrich Harrer (Author)Dalai Lama XIV')).toEqual(['author']);
  });

  it('finds both when a run-on also ends in a role', () => {
    expect(extractCandidates('A(Editor)B(Illustrator)')).toEqual(['editor', 'illustrator']);
  });

  it('returns org-name parens as candidates too — the vocabulary decides', () => {
    expect(extractCandidates('British Museum (Natural History)')).toEqual(['natural history']);
    expect(extractCandidates('Presbyterian Church (USA)')).toEqual(['usa']);
  });

  it('returns nothing for an author without parens', () => {
    expect(extractCandidates('George Orwell')).toEqual([]);
  });

  it('dedupes case-variant duplicates within one string', () => {
    expect(extractCandidates('A(Editor)B(Editor)')).toEqual(['editor']);
  });
});

describe('selectRoles (vocabulary filter)', () => {
  it('keeps known roles and drops org-name parens', () => {
    expect(selectRoles('Vincenzo Bellini(Composer)')).toEqual(['composer']);
    expect(selectRoles('British Museum (Natural History)')).toEqual([]);
    expect(selectRoles('Presbyterian Church (USA)')).toEqual([]);
  });

  it('matches case-insensitively via normalization', () => {
    expect(selectRoles('neil clarke(editor)')).toEqual(['editor']);
    expect(selectRoles('Kenneth Robeson(House Name)')).toEqual(['house name']);
  });

  it('--all bypasses the vocabulary', () => {
    expect(selectRoles('British Museum (Natural History)', true)).toEqual(['natural history']);
  });
});

describe('rankRoleCounts', () => {
  it('ranks by book count descending, ties alphabetical', () => {
    const out = rankRoleCounts([['editor', 40], ['composer', 406], ['artist', 40]]);
    expect(out.map(r => r.role)).toEqual(['composer', 'artist', 'editor']);
    expect(out.map(r => r.books)).toEqual([406, 40, 40]);
  });

  it('applies minBooks and limit', () => {
    const counts: Array<[string, number]> = [['a', 10], ['b', 5], ['c', 1]];
    expect(rankRoleCounts(counts, { minBooks: 5 }).map(r => r.role)).toEqual(['a', 'b']);
    expect(rankRoleCounts(counts, { limit: 2 }).map(r => r.role)).toEqual(['a', 'b']);
    expect(rankRoleCounts(counts, { limit: 0 })).toHaveLength(3); // 0 = no cap
  });

  it('handles empty input', () => {
    expect(rankRoleCounts([])).toEqual([]);
  });
});

describe('summarizeRoles / collectRoleDetail (fixture DB)', () => {
  const db = getDb();
  db.exec('DELETE FROM books');
  const insert = db.prepare(
    `INSERT INTO books (id, title, author, author_id, ratings, avg_rating, published, last_updated)
     VALUES (?, ?, ?, ?, ?, 4.0, '2020', '2026-10-07')`,
  );
  insert.run('1', 'Norma: Libretto', 'Vincenzo Bellini(Composer)', '140903', 100);
  insert.run('2', 'Editor Picks', 'John Joseph Adams(Editor)', '77', 50);
  insert.run('3', 'Org Book', 'British Museum (Natural History)', '88', 10);
  insert.run('4', 'Run-On', 'Heinrich Harrer (Author)Dalai Lama XIV', '99', 5);
  insert.run('5', 'No Role', 'George Orwell', '3706', 1000);
  insert.run('6', 'Lower Editor', 'neil clarke(editor)', '55', 7);

  it('summarizeRoles counts books per role, org parens excluded', () => {
    const { withRole, counts } = summarizeRoles();
    expect(withRole).toBe(4); // rows 1, 2, 4, 6 — not the org book, not no-parens
    expect(counts.get('composer')).toBe(1);
    expect(counts.get('editor')).toBe(2); // Editor + editor collapse to one role
    expect(counts.get('author')).toBe(1);
    expect(counts.has('natural history')).toBe(false);
  });

  it('summarizeRoles(--all) surfaces unfiltered candidates', () => {
    const { counts } = summarizeRoles(true);
    expect(counts.get('natural history')).toBe(1);
    expect(counts.has('composer')).toBe(true);
  });

  it('collectRoleDetail lists matching books up to the limit while counting all', () => {
    const out = collectRoleDetail('Editor', { limit: 1 });
    expect(out.total).toBe(2);
    expect(out.books).toHaveLength(1);

    const all = collectRoleDetail('editor', { limit: 40 }); // case-insensitive lookup
    expect(all.total).toBe(2);
    expect(all.books.map(b => b.id).sort()).toEqual(['2', '6']);
    expect(all.books[0]).toMatchObject({ authorId: expect.any(String), ratings: expect.any(Number) });
  });

  it('collectRoleDetail --authors aggregates per author_id, ranked by book count', () => {
    const out = collectRoleDetail('Editor', { limit: 40, authors: true });
    expect(out.total).toBe(2);
    expect(out.authorTotal).toBe(2);
    expect(out.authors.map(a => a.name).sort()).toEqual(['John Joseph Adams(Editor)', 'neil clarke(editor)']);

    // Same author id twice counts as one author with two books.
    getDb().prepare(
      `INSERT INTO books (id, title, author, author_id, ratings, avg_rating, published, last_updated)
       VALUES ('7', 'More Picks', 'John Joseph Adams(Editor)', '77', 3, 4.0, '2021', '2026-10-07')`,
    ).run();
    const agg = collectRoleDetail('Editor', { limit: 40, authors: true });
    expect(agg.authors[0]).toEqual({ name: 'John Joseph Adams(Editor)', books: 2 });
    expect(agg.authorTotal).toBe(2); // two books, same id → still two authors
    getDb().prepare(`DELETE FROM books WHERE id = '7'`).run();
  });

  it('returns nothing for an unknown role', () => {
    const out = collectRoleDetail('astronaut', { limit: 5 });
    expect(out.total).toBe(0);
    expect(out.books).toEqual([]);
  });
});

describe('runAuthorRoles output', () => {
  const render = async (options: Parameters<typeof runAuthorRoles>[0] = {}) => {
    chalk.level = 0;
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runAuthorRoles(options);
    const lines = out.mock.calls.map((c) => c.join(' '));
    out.mockRestore();
    return lines;
  };

  it('prints the ranked summary with counts', async () => {
    const lines = await render({ limit: '10' });
    const editorLine = lines.find(l => /^\s*\d+\.\s+editor\s/.test(l));
    expect(editorLine).toBeTruthy();
    expect(editorLine).toContain('2');
    expect(lines.join('\n')).toContain('books scanned');
  });

  it('prints detail for one role', async () => {
    const lines = await render({ role: 'composer', limit: '10' });
    expect(lines.join('\n')).toContain('Norma: Libretto');
  });

  it('says so when a role matches nothing', async () => {
    const lines = await render({ role: 'astronaut' });
    expect(lines.join('\n')).toContain('No books carry the role');
  });
});
