import { describe, it, expect } from 'vitest';
import { buildTagShelvesIndex, tagShelvedCount, findBelowTagShelves, resolveMissingWorkIds } from './auditor.js';

const row = (bookId: string | number, shelved?: number | null) => ({ book_id: bookId, shelved });
const workRow = (bookId: string | number, workId: string | number, shelved: number) => ({ book_id: bookId, work_id: workId, shelved });

describe('buildTagShelvesIndex', () => {
  it('keeps the best (max) shelved count per book id', () => {
    const index = buildTagShelvesIndex([row('1', 5), row('1', 12), row('2', 3)], []);
    expect(index.byBook.get('1')).toBe(12);
    expect(index.byBook.get('2')).toBe(3);
  });

  it('ignores null/undefined shelved rows and keeps max per work id', () => {
    const index = buildTagShelvesIndex([row('1', null), row('2', 4)], [workRow('3', 'w9', 7), workRow('3', 'w9', 9)]);
    expect(index.byBook.has('1')).toBe(false);
    expect(index.byBook.get('2')).toBe(4);
    expect(index.byWork.get('w9')).toBe(9);
  });
});

describe('tagShelvedCount', () => {
  const index = buildTagShelvesIndex(
    [row('1', 10), row('2', 0)],
    [workRow('9', 'w1', 15), workRow('8', 'w2', 3)]
  );

  it('prefers the book id count over the work id', () => {
    expect(tagShelvedCount(index, '1', 'w1')).toBe(10);
  });

  it('falls back to the work id when the book id has no row', () => {
    expect(tagShelvedCount(index, '9', 'w1')).toBe(15);
  });

  it('returns 0 for a book explicitly shelved 0 times (a real row)', () => {
    expect(tagShelvedCount(index, '2', undefined)).toBe(0);
  });

  it('returns undefined when the book is absent from the table', () => {
    expect(tagShelvedCount(index, '42', undefined)).toBeUndefined();
  });
});

describe('findBelowTagShelves', () => {
  const index = buildTagShelvesIndex(
    [row('1', 10), row('2', 4)],
    []
  );
  const books = [{ id: '1' }, { id: '2' }, { id: '3' }];

  it('flags books below the minimum and books with no row', () => {
    const out = findBelowTagShelves(books, index, new Map(), 10);
    expect(out.map(o => o.bookId)).toEqual(['2', '3']);
    expect(out.find(o => o.bookId === '2')?.count).toBe(4);
    expect(out.find(o => o.bookId === '3')?.count).toBeUndefined();
  });

  it('keeps books at or above the minimum', () => {
    const out = findBelowTagShelves(books, index, new Map(), 4);
    expect(out.map(o => o.bookId)).toEqual(['3']);
  });

  it('resolves edition mismatches through the work id map', () => {
    const workIdx = buildTagShelvesIndex([], [workRow('900', 'w7', 20)]);
    const out = findBelowTagShelves([{ id: '901' }], workIdx, new Map([['901', 'w7']]), 10);
    expect(out).toEqual([]);
  });
});

describe('resolveMissingWorkIds', () => {
  it('resolves a list book lacking a work id via a same-title same-author row', () => {
    const known = [{ title: "Old Man's War (Old Man's War, #1)", author: 'John Scalzi', work_id: '50700' }];
    const out = resolveMissingWorkIds([{ id: '51964', title: "Old Man's War (Old Man's War, #1)", author: 'John Scalzi' }], known);
    expect(out.get('51964')).toBe('50700');
  });

  it('normalizes titles/authors before matching (parentheticals, #N, case)', () => {
    const known = [{ title: 'Cibola Burn (The Expanse, #4)', author: 'James S.A. Corey', work_id: '12345' }];
    const out = resolveMissingWorkIds([{ id: 'x', title: 'cibola burn (expanse, 4)', author: 'james s.a. corey' }], known);
    expect(out.get('x')).toBe('12345');
  });

  it('ignores empty work ids and leaves unresolvable books unmapped', () => {
    const known = [
      { title: 'Foo', author: 'A', work_id: '' },
      { title: 'Foo', author: 'A', work_id: null as any }
    ];
    const out = resolveMissingWorkIds([{ id: '1', title: 'Foo', author: 'A' }], known);
    expect(out.has('1')).toBe(false);
  });

  it('bridges a shelf-edition work id to the list book end-to-end', () => {
    const index = buildTagShelvesIndex(
      [],
      [{ book_id: '36510196', work_id: '50700', shelved: 742 }]
    );
    const workIdByBook = resolveMissingWorkIds(
      [{ id: '51964', title: "Old Man's War (Old Man's War, #1)", author: 'John Scalzi' }],
      [{ title: "Old Man's War (Old Man's War, #1)", author: 'John Scalzi', work_id: '50700' }]
    );
    expect(tagShelvedCount(index, '51964', workIdByBook.get('51964'))).toBe(742);
    expect(findBelowTagShelves([{ id: '51964' }], index, workIdByBook, 10)).toEqual([]);
  });
});