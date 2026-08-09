import { describe, expect, it } from 'vitest';
import { authorExtractor, publisherExtractor, groupRatedRows, groupFavoriteAuthors, groupFavoritePublishers } from './favoriteAuthors.js';
import { LibraryEntry } from './libraryExport.js';

function entry(overrides: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    id: '1',
    title: 'Book',
    author: 'Author',
    shelf: 'read',
    dateRead: '2026/01/01',
    hasReview: true,
    review: 'Great',
    published: '2020',
    myRating: '4',
    pages: '200',
    publisher: 'Pub',
    bookshelves: '',
    ...overrides,
  };
}

describe('parseRating behavior via groupRatedRows', () => {
  it('counts a rated book and computes the average', () => {
    const result = groupRatedRows(
      [
        entry({ id: '1', myRating: '5' }),
        entry({ id: '2', myRating: '4' }),
        entry({ id: '3', myRating: '3' })
      ],
      authorExtractor
    );
    expect(result.reviewedBooks).toBe(3);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].books).toBe(3);
    expect(result.rows[0].avg).toBe(4);
    expect(Object.fromEntries(result.rows[0].stars)).toEqual({ 5: 1, 4: 1, 3: 1 });
  });

  it('skips unrated books (0 or empty My Rating)', () => {
    const result = groupRatedRows(
      [
        entry({ id: '1', myRating: '0' }),
        entry({ id: '2', myRating: '' }),
        entry({ id: '3', myRating: '5' })
      ],
      authorExtractor
    );
    expect(result.reviewedBooks).toBe(1);
    expect(result.skippedNotRated).toBe(2);
    expect(result.rows).toHaveLength(1);
  });

  it('treats each author as a separate group', () => {
    const result = groupRatedRows(
      [
        entry({ id: '1', author: 'Lois McMaster Bujold', myRating: '5' }),
        entry({ id: '2', author: 'Neil Gaiman', myRating: '4' })
      ],
      authorExtractor
    );
    expect(result.rows).toHaveLength(2);
    const names = result.rows.map(r => r.name);
    expect(names).toContain('Lois McMaster Bujold');
    expect(names).toContain('Neil Gaiman');
  });

  it('groups by the first author in multi-author entries', () => {
    const result = groupRatedRows(
      [
        entry({ id: '1', author: 'Barbara Kingsolver & Terry McMillan', myRating: '5' }),
        entry({ id: '2', author: 'Barbara Kingsolver', myRating: '4' })
      ],
      authorExtractor
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe('Barbara Kingsolver');
    expect(result.rows[0].books).toBe(2);
  });

  it('skips entries with no author', () => {
    const result = groupRatedRows([entry({ id: '1', author: 'Unknown', myRating: '5' })], authorExtractor);
    expect(result.skippedNoKey).toBe(1);
    expect(result.rows).toHaveLength(0);
  });
});

describe('publisherExtractor + groupFavoritePublishers', () => {
  it('groups by publisher and skips empty publishers', () => {
    const result = groupFavoritePublishers([
      entry({ id: '1', publisher: 'HarperCollins', myRating: '5' }),
      entry({ id: '2', publisher: 'HarperCollins', myRating: '4' }),
      entry({ id: '3', publisher: '', myRating: '4' }),
      entry({ id: '4', publisher: ' ', myRating: '4' })
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe('HarperCollins');
    expect(result.rows[0].books).toBe(2);
    expect(result.skippedNoKey).toBe(2);
  });

  it('collapses whitespace in publisher names', () => {
    const result = groupFavoritePublishers([
      entry({ id: '1', publisher: '   Tom Doherty   Associates  ', myRating: '5' })
    ]);
    expect(result.rows[0].name).toBe('Tom Doherty Associates');
  });
});

describe('groupFavoriteAuthors', () => {
  it('sorts nothing by default but reports distinct authors', () => {
    const result = groupFavoriteAuthors([
      entry({ id: '1', author: 'Zoe Author', myRating: '5' }),
      entry({ id: '2', author: 'Amy Author', myRating: '4' })
    ]);
    expect(result.rows).toHaveLength(2);
    const names = result.rows.map(r => r.name);
    expect(names).toContain('Zoe Author');
    expect(names).toContain('Amy Author');
  });
});
