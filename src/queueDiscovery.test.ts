import { describe, expect, it } from 'vitest';
import { pruneCandidates, isAlreadyOnList, resolveListWorkIds } from './queueDiscovery.js';
import type { CachedBook } from './storage.js';

const book = (over: Partial<CachedBook> = {}): CachedBook => ({
  id: 'x',
  title: 'T',
  author: 'A',
  ratings: '100',
  published: '',
  lastUpdated: '',
  ...over,
});

describe('pruneCandidates', () => {
  it('drops run-together multi-author concatenations', () => {
    const out = pruneCandidates([
      book({ id: '1', title: 'Tom Sawyer', author: 'Mark Twain', ratings: '1000000' }),
      book({ id: '2', title: 'Tom Sawyer', author: 'Mark TwainGeorge Eliot', ratings: '1000000' }),
    ]);
    expect(out.map(b => b.id)).toEqual(['1']);
  });

  it('collapses editions sharing a workId, keeping the highest-rated', () => {
    const out = pruneCandidates([
      book({ id: 'a', title: 'The Adventures of Tom Sawyer', author: 'Mark Twain', ratings: '5000', workId: '41326609' }),
      book({ id: 'b', title: 'The Adventures of Tom Sawyer', author: 'Mark Twain', ratings: '9000', workId: '41326609' }),
      book({ id: 'c', title: 'The Adventures of Tom Sawyer', author: 'Mark Twain', ratings: '7000', workId: '41326609' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('b');
  });

  it('falls back to normalized title+author when workId is absent', () => {
    const out = pruneCandidates([
      book({ id: '3', title: 'Harry Potter and the Sorcerer\'s Stone (Harry Potter, #1)', author: 'J.K. Rowling', ratings: '1000' }),
      book({ id: '77523', title: 'Harry Potter and the Sorcerer\'s Stone (Harry Potter, #1)', author: 'J.K. Rowling', ratings: '9000' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('77523');
  });

  it('keeps distinct works separate', () => {
    const out = pruneCandidates([
      book({ id: 'a', title: 'Hamlet', author: 'William Shakespeare', ratings: '9000', workId: '1' }),
      book({ id: 'b', title: 'Macbeth', author: 'William Shakespeare', ratings: '8000', workId: '2' }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('merges a workId edition with a "(Narrator)" no-workId edition', () => {
    const out = pruneCandidates([
      book({ id: '16141924', title: 'Dad Is Fat', author: 'Jim Gaffigan', ratings: '81098', workId: '21973739' }),
      book({ id: '17212302', title: 'Dad Is Fat', author: 'Jim Gaffigan(Narrator)', ratings: '81097' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('16141924');
  });

  it('merges differently-titled editions that share a workId', () => {
    const out = pruneCandidates([
      book({ id: 'en', title: 'The Adventures of Tom Sawyer', author: 'Mark Twain', ratings: '2000', workId: '41326609' }),
      book({ id: 'es', title: 'Las aventuras de Tom Sawyer', author: 'Mark Twain', ratings: '1500', workId: '41326609' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('en');
  });
});

describe('isAlreadyOnList', () => {
  const cand = { id: 'c', title: 'Vindens skugga', author: 'Carlos Ruiz Zafón' };

  it('recognizes an exact same-title+same-author list match', () => {
    expect(isAlreadyOnList(cand, [{ id: 'l1', title: 'Vindens skugga', author: 'Carlos Ruiz Zafón' }], new Set(), '999')).toBe(true);
  });

  it('recognizes a different-title edition via a shared workId', () => {
    const listBooks = [{ id: 'l1', title: 'The Shadow of the Wind', author: 'Carlos Ruiz Zafón' }];
    expect(isAlreadyOnList(cand, listBooks, new Set(['111']), '111')).toBe(true);
  });

  it('does NOT match when no list workId is known for the candidate', () => {
    const listBooks = [{ id: 'l1', title: 'The Shadow of the Wind', author: 'Carlos Ruiz Zafón' }];
    expect(isAlreadyOnList(cand, listBooks, new Set(['111']), undefined)).toBe(false);
    expect(isAlreadyOnList(cand, listBooks, new Set(), '111')).toBe(false);
  });
});

describe('resolveListWorkIds', () => {
  const cached = (o: Partial<CachedBook>): CachedBook => ({
    id: 'x', title: 'T', author: 'A', ratings: '0', published: '', lastUpdated: '', ...o,
  });
  const cache: Record<string, CachedBook> = {
    '1': cached({ id: '1', title: 'The Shadow of the Wind', author: 'Carlos Ruiz Zafón', authorId: '123', workId: '111' }),
  };

  it('recovers a workId by exact list-book id match', () => {
    const workIds = resolveListWorkIds([{ id: '1', authorId: '123', title: 'The Shadow of the Wind' }], cache);
    expect(workIds.has('111')).toBe(true);
  });

  it('recovers a workId by authorId + normalized title when the list edition id differs', () => {
    const listBooks = [{ id: '999', authorId: '123', title: 'The Shadow of the Wind' }];
    const workIds = resolveListWorkIds(listBooks, cache);
    expect(workIds.has('111')).toBe(true);
  });

  it('cannot resolve translations with different titles when only an id-less list edition exists', () => {
    const listBooks = [{ id: '999', authorId: '123', title: 'Vindens skugga' }];
    const workIds = resolveListWorkIds(listBooks, cache);
    expect(workIds.size).toBe(0);
  });

  it('skips list books with no authorId', () => {
    const workIds = resolveListWorkIds([{ id: '0', title: 'No Author Id' }], cache);
    expect(workIds.size).toBe(0);
  });
});

