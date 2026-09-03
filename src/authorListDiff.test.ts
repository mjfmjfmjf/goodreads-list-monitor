import { describe, expect, it } from 'vitest';
import {
  dedupeAuthorsBySlug,
  diffVotesVsRanking,
  pickTopBook,
  pickSuggestionBook,
  assignSuggestedPositions,
  computeMoves,
  computeReplacements,
  stripSeriesSuffix,
  formatAuthorRef,
  formatBookRef,
  authorStatsPresent,
  planBuildProgress,
  SUGGESTION_MIN_RATINGS,
} from './authorListDiff.js';
import type { SelectedAuthor } from './authorTopStats.js';
import type { AuthorCacheEntry } from './storage.js';
import type { CachedBook } from './storage.js';
import type { UserVoteEntry } from './scraper.js';

function author(name: string, slug: string, averageRating: string, numRatings: string): SelectedAuthor {
  const entry: AuthorCacheEntry = {
    id: slug.split('.')[0],
    slug,
    lastSeen: '2026-08-22T00:00:00Z',
    averageRating,
    numRatings,
  };
  return { name, entry, value: parseFloat(averageRating) };
}

function vote(position: number, bookId: string, title: string, name: string, slug?: string): UserVoteEntry {
  return {
    position,
    bookId,
    title,
    author: name,
    authorSlug: slug,
    authorId: slug ? slug.split('.')[0] : undefined,
  };
}

describe('dedupeAuthorsBySlug', () => {
  it('collapses whitespace-mangled duplicates of the same author and renumbers ranks', () => {
    const ranked = dedupeAuthorsBySlug([
      author('Author A', '1.a', '4.70', '200000'),
      author('John   Williams', '6.John_Williams', '4.64', '451494'),
      author('John Williams', '6.John_Williams', '4.64', '451299'),
      author('Author B', '2.b', '4.50', '150000'),
    ]);
    expect(ranked.map(r => r.name)).toEqual(['Author A', 'John   Williams', 'Author B']);
    expect(ranked.map(r => r.rank)).toEqual([1, 2, 3]);
  });

  it('falls back to slug identity when id is missing', () => {
    const a = author('A', '1.a', '4.5', '100');
    delete (a.entry as any).id;
    const ranked = dedupeAuthorsBySlug([a, author('A again', '1.a', '4.5', '100')]);
    expect(ranked).toHaveLength(1);
  });
});

describe('diffVotesVsRanking', () => {
  const ranking = dedupeAuthorsBySlug([
    author('Staying', '10.staying', '4.80', '500000'),
    author('Newcomer', '20.newcomer', '4.75', '300000'),
    author('Falling', '30.falling', '4.60', '120000'),
    author('Unranked Author', '40.unranked', '4.50', '110000'),
  ]);

  it('flags voted authors who fell out of the top N, with their current rank', () => {
    const votes = [
      vote(1, 'b1', 'Book One', 'Staying', '10.staying'),
      vote(2, 'b2', 'Book Two', 'Falling', '30.falling'),
    ];
    const { dropped, additions } = diffVotesVsRanking(votes, ranking, 2);
    expect(dropped).toEqual([
      { position: 2, bookId: 'b2', title: 'Book Two', author: 'Falling', authorId: '30', currentRank: 3 },
    ]);
    expect(additions.map(a => a.name)).toEqual(['Newcomer']);
  });

  it('treats an unmatchable vote entry as dropped without a current rank', () => {
    const votes = [vote(7, 'b7', 'Mystery Book', 'Unknown Author')];
    const { dropped, additions } = diffVotesVsRanking(votes, ranking, 2);
    expect(dropped).toEqual([
      { position: 7, bookId: 'b7', title: 'Mystery Book', author: 'Unknown Author', authorId: undefined, currentRank: undefined },
    ]);
    expect(additions.map(a => a.name).sort()).toEqual(['Staying', 'Newcomer'].sort());
  });

  it('matches by numeric id even when slugs differ in casing', () => {
    const votes = [
      vote(1, 'b1', 'Book One', 'Staying', '10.Staying'),
      vote(2, 'b2', 'Book Two', 'Falling', '30.falling'),
      vote(3, 'b3', 'Book Three', 'Newcomer', '20.newcomer'),
      vote(4, 'b4', 'Book Four', 'Unranked Author', '40.unranked'),
    ];
    const { dropped, additions } = diffVotesVsRanking(votes, ranking, 4);
    expect(dropped).toHaveLength(0);
    expect(additions).toHaveLength(0);
  });

  it('reports nothing when list and ranking agree', () => {
    const votes = [
      vote(1, 'b1', 'Book One', 'Staying', '10.staying'),
      vote(2, 'b2', 'Book Two', 'Newcomer', '20.newcomer'),
    ];
    const { dropped, additions } = diffVotesVsRanking(votes, ranking, 2);
    expect(dropped).toHaveLength(0);
    expect(additions).toHaveLength(0);
  });
});

describe('planBuildProgress', () => {
  const ranking = dedupeAuthorsBySlug([
    author('Top A', '10.a', '4.80', '500000'),
    author('Top B', '20.b', '4.70', '400000'),
    author('Top C', '30.c', '4.60', '120000'),
  ]);

  it('partitions covered, missing, and off-target votes', () => {
    const votes = [
      vote(1, 'b1', 'Book One', 'Top A', '10.a'),
      vote(2, 'b2', 'Book Two', 'Top B', '20.b'),
      vote(99, 'b9', 'Book Nine', 'Stray', '99.stray'),
    ];
    const { covered, missing, offTarget } = planBuildProgress(votes, ranking, 3);
    expect(covered.map(c => c.name)).toEqual(['Top A', 'Top B']);
    expect(missing.map(m => m.name)).toEqual(['Top C']);
    expect(offTarget.map(o => o.position)).toEqual([99]);
  });

  it('reports nothing off-target when votes match slugs with different casing', () => {
    const votes = [vote(1, 'b1', 'Book One', 'Top A', '10.A')];
    const { covered, missing, offTarget } = planBuildProgress(votes, ranking, 3);
    expect(covered.map(c => c.name)).toEqual(['Top A']);
    expect(offTarget).toHaveLength(0);
  });
});

describe('pickTopBook', () => {
  function book(id: string, title: string, ratings: number, avgRating?: string, isBad?: boolean): CachedBook {
    return {
      id,
      title,
      author: 'Someone',
      authorId: '42',
      ratings: String(ratings),
      avgRating,
      published: '2020',
      lastUpdated: '2026-08-22T00:00:00Z',
      isBad,
    };
  }

  it('picks the book with the most ratings', () => {
    const books = [book('a', 'Small', 1000), book('b', 'Big', 999999)];
    expect(pickTopBook(books, '42')?.id).toBe('b');
  });

  it('excludes books by other authors and bad books', () => {
    const books = [
      book('a', 'Mine', 10),
      { ...book('b', 'Others', 999999), authorId: '99' },
      { ...book('c', 'Bad', 999999), isBad: true },
    ];
    expect(pickTopBook(books, '42')?.id).toBe('a');
  });

  it('breaks rating ties on higher average rating, then title', () => {
    const books = [
      book('a', 'Zeta', 100, '4.2'),
      book('b', 'Alpha', 100, '4.5'),
    ];
    expect(pickTopBook(books, '42')?.id).toBe('b');

    const tied = [book('z', 'Zulu', 100, '4.5'), book('y', 'Yankee', 100, '4.5')];
    expect(pickTopBook(tied, '42')?.id).toBe('y');
  });

  it('prefers a book with a work id on a rating tie, over a higher-rated titleless one', () => {
    const withWork = { ...book('w', 'Zeta', 100, '3.9'), workId: '900' };
    const withoutWork = { ...book('n', 'Alpha', 100, '4.9') };
    expect(pickTopBook([withoutWork, withWork], '42')?.id).toBe('w');
  });

  it('returns undefined when the author has no books', () => {
    expect(pickTopBook([book('a', 'Mine', 10)], '43')).toBeUndefined();
  });
});

describe('assignSuggestedPositions', () => {
  it('fills freed slots in ascending order', () => {
    expect(assignSuggestedPositions(3, [57, 12, 33], 100)).toEqual([12, 33, 57]);
  });

  it('overflows past maxPosition when there are more additions than freed slots', () => {
    expect(assignSuggestedPositions(3, [90], 100)).toEqual([90, 101, 102]);
  });

  it('handles no freed slots', () => {
    expect(assignSuggestedPositions(2, [], 100)).toEqual([101, 102]);
  });
});

describe('pickSuggestionBook', () => {
  function book(id: string, title: string, ratings: number, avgRating?: string, isBad?: boolean): CachedBook {
    return {
      id,
      title,
      author: 'Someone',
      authorId: '42',
      ratings: String(ratings),
      avgRating,
      published: '2020',
      lastUpdated: '2026-08-22T00:00:00Z',
      isBad,
    };
  }

  it('picks the most-rated book with at least the ratings threshold', () => {
    const books = [book('a', 'Popular But Mid', 50000, '3.9'), book('b', 'Best Loved', 2000, '4.6'), book('c', 'Tiny Gem', 900, '4.9')];
    expect(pickSuggestionBook(books, '42')).toEqual({ book: books[0], qualified: true });
  });

  it('breaks rating-count ties on higher average rating, then title', () => {
    const tied = [book('z', 'Zulu', 5000, '4.5'), book('y', 'Yankee', 8000, '4.5')];
    expect(pickSuggestionBook(tied, '42').book?.id).toBe('y');

    const same = [book('b', 'Beta', 5000, '4.0'), book('a', 'Alpha', 5000, '4.5')];
    expect(pickSuggestionBook(same, '42').book?.id).toBe('a');
  });

  it('falls back to most-rated and flags unqualified when nothing clears the bar', () => {
    const books = [book('a', 'Small', 500, '4.8'), book('b', 'Smaller', 300, '4.9')];
    expect(pickSuggestionBook(books, '42')).toEqual({ book: books[0], qualified: false });
  });

  it('honors a custom threshold', () => {
    const books = [book('a', 'Mid', 1500, '4.1'), book('b', 'Star', 1200, '4.7')];
    expect(pickSuggestionBook(books, '42', SUGGESTION_MIN_RATINGS).book?.id).toBe('a');
    expect(pickSuggestionBook(books, '42', 2000)).toEqual({ book: books[0], qualified: false });
  });

  it('excludes bad books from both pools', () => {
    const books = [
      { ...book('a', 'Bad Star', 99999, '4.9'), isBad: true },
      book('b', 'Real Pick', 1000, '4.0'),
    ];
    expect(pickSuggestionBook(books, '42')).toEqual({ book: books[1], qualified: true });
  });

  it('prefers a book with a work id on a rating tie, even against a higher-rated one without', () => {
    const withWork = { ...book('w', 'Second Edition', 5000, '3.9'), workId: '900' };
    const withoutWork = { ...book('n', 'First Edition', 5000, '4.9') };
    const pick = pickSuggestionBook([withoutWork, withWork], '42');
    expect(pick.book?.id).toBe('w');
    expect(pick.qualified).toBe(true);
  });
});

describe('computeMoves', () => {
  const ranking = dedupeAuthorsBySlug([
    author('Staying A', '10.a_staying', '4.80', '500000'),
    author('Staying B', '20.b_staying', '4.70', '400000'),
    author('Outside', '30.outside', '4.60', '120000'),
  ]);

  it('flags votes whose slot no longer matches the live rank', () => {
    const votes = [
      vote(4, 'b4', 'Book Four', 'Staying B', '20.b_staying'),
      vote(1, 'b1', 'Book One', 'Staying A', '10.a_staying'),
      vote(5, 'b5', 'Book Five', 'Outside', '30.outside'),
    ];
    const moves = computeMoves(votes, ranking, 2);
    expect(moves).toEqual([
      { position: 4, targetRank: 2, bookId: 'b4', title: 'Book Four', author: 'Staying B', authorId: '20' },
    ]);
  });

  it('reports nothing when every staying vote sits at its live rank', () => {
    const votes = [vote(1, 'b1', 'One', 'Staying A', '10.a_staying'), vote(2, 'b2', 'Two', 'Staying B', '20.b_staying')];
    expect(computeMoves(votes, ranking, 2)).toEqual([]);
  });

  it('sorts moves by target rank', () => {
    const votes = [
      vote(9, 'b2', 'Two', 'Staying B', '20.b_staying'),
      vote(8, 'b1', 'One', 'Staying A', '10.a_staying'),
    ];
    expect(computeMoves(votes, ranking, 2).map(m => m.targetRank)).toEqual([1, 2]);
  });
});

describe('computeReplacements', () => {
  function book(id: string, title: string, ratings: number, avgRating: string): CachedBook {
    return {
      id,
      title,
      author: 'Someone',
      authorId: '10',
      ratings: String(ratings),
      avgRating,
      published: '2020',
      lastUpdated: '2026-08-22T00:00:00Z',
    };
  }

  const ranking = dedupeAuthorsBySlug([author('Staying', '10.staying', '4.80', '500000')]);

  it('suggests a swap when the voted book is not the best qualified one', () => {
    const booksByAuthor = new Map([['10', [book('old', 'Voted Book', 5000, '3.8'), book('new', 'Better Book', 6000, '4.6')]]]);
    const votes = [vote(1, 'old', 'Voted Book', 'Staying', '10.staying')]; // slot matches live rank
    expect(computeReplacements(votes, ranking, 1, booksByAuthor)).toEqual([
      {
        position: 1,
        votedBook: { id: 'old', title: 'Voted Book', ratings: '5000' },
        suggestedBook: book('new', 'Better Book', 6000, '4.6'),
        author: 'Staying',
        authorId: '10',
      },
    ]);
  });

  it('stays quiet when the voted book already is the best qualified pick', () => {
    const booksByAuthor = new Map([['10', [book('best', 'The One', 5000, '4.6'), book('meh', 'Meh', 4000, '3.9')]]]);
    const votes = [vote(3, 'best', 'The One', 'Staying', '10.staying')];
    expect(computeReplacements(votes, ranking, 1, booksByAuthor)).toEqual([]);
  });

  it('never suggests an unqualified fallback as a replacement', () => {
    const booksByAuthor = new Map([['10', [book('thin', 'Thin Book', 40, '4.9'), book('other', 'Other', 30, '4.0')]]]);
    const votes = [vote(3, 'thin', 'Thin Book', 'Staying', '10.staying')];
    expect(computeReplacements(votes, ranking, 1, booksByAuthor)).toEqual([]);
  });

  it('skips votes that already have a pending move', () => {
    const booksByAuthor = new Map([['10', [book('old', 'Voted', 5000, '3.8'), book('new', 'Better', 6000, '4.6')]]]);
    const votes = [vote(5, 'old', 'Voted', 'Staying', '10.staying')]; // sits at #5, live rank #1
    expect(computeMoves(votes, ranking, 1)).toHaveLength(1);
    expect(computeReplacements(votes, ranking, 1, booksByAuthor)).toEqual([]);
  });
});

describe('authorStatsPresent', () => {
  const base = { slug: '1.x', lastSeen: '2026-08-22T00:00:00Z' } as any;

  it('is false for missing or statless entries', () => {
    expect(authorStatsPresent(undefined)).toBe(false);
    expect(authorStatsPresent({ ...base })).toBe(false);
    expect(authorStatsPresent({ ...base, averageRating: '4.4' })).toBe(false);
    expect(authorStatsPresent({ ...base, numRatings: '1000' })).toBe(false);
  });

  it('is true once both stats exist', () => {
    expect(authorStatsPresent({ ...base, averageRating: '4.4', numRatings: '143371' } as any)).toBe(true);
  });
});

describe('reference formatting', () => {
  it('strips trailing series parentheticals for book link text', () => {
    expect(stripSeriesSuffix('March: The Trilogy (March, #1-3)')).toBe('March: The Trilogy');
    expect(stripSeriesSuffix('The Wise Man\u2019s Fear (The Kingkiller Chronicle, #2)')).toBe('The Wise Man\u2019s Fear');
    expect(stripSeriesSuffix('Plain Title')).toBe('Plain Title');
    expect(stripSeriesSuffix('(Standalone, #1)')).toBe('(Standalone, #1)');
  });

  it('formats author and book references with ids', () => {
    expect(formatAuthorRef({ name: 'John Lewis', id: '6429079' })).toBe('[author:John Lewis|6429079]');
    expect(formatAuthorRef({ name: 'Unknown' })).toBe('Unknown');
    expect(formatBookRef({ title: 'March: The Trilogy (March, #1-3)', id: '29844341' })).toBe('[book:March: The Trilogy|29844341]');
    expect(formatBookRef({ title: 'No Id Book' })).toBe('No Id Book');
  });

  it('never nests brackets inside a reference', () => {
    expect(formatBookRef({ title: '鬼滅の刃 8 [Kimetsu no Yaiba 8]', id: '40376342' })).toBe(
      '[book:鬼滅の刃 8 (Kimetsu no Yaiba 8)|40376342]'
    );
    expect(formatAuthorRef({ name: 'Weird [Name]', id: '1' })).toBe('[author:Weird (Name)|1]');
  });
});
