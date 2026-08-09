import { describe, expect, it } from 'vitest';
import {
  parseYear,
  firstCharBucket,
  charBucket,
  readInYear,
  readAll,
  reviewedInYear,
  reviewedAll,
  charCounts,
  publishedCounts,
  missingLetters,
  mostRecentReviewYear,
  pubYearUpper,
  missingPubYears,
  renderCharCountLines,
  renderPublishedYearLines,
  renderMissingLines
} from './library.js';
import { LibraryExport, LibraryEntry } from './libraryExport.js';

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

function library(entries: LibraryEntry[]): LibraryExport {
  return {
    sourcePath: 'test.csv',
    totalEntries: entries.length,
    reviewedEntries: entries.length,
    reviewedById: new Set(entries.map(e => e.id)),
    reviewedByTitleAuthor: new Set(),
    entries,
  };
}

describe('parseYear', () => {
  it('extracts a leading 4-digit year', () => {
    expect(parseYear('2024')).toBe('2024');
    expect(parseYear('2024/05/06')).toBe('2024');
    expect(parseYear(' 2010 ')).toBe('2010');
  });
  it('returns null when no year is present', () => {
    expect(parseYear('')).toBeNull();
    expect(parseYear('Unknown')).toBeNull();
    expect(parseYear('Paperback')).toBeNull();
  });
});

describe('firstCharBucket / charBucket', () => {
  it('buckets the first letter, uppercase', () => {
    expect(firstCharBucket('The Great Gatsby')).toBe('T');
    expect(firstCharBucket('  anna ')).toBe('A');
  });
  it('falls back to # for non-letters', () => {
    expect(firstCharBucket('12345')).toBe('#');
    expect(firstCharBucket('')).toBe('#');
  });
  it('buckets by title by default', () => {
    expect(charBucket(entry({ title: 'dune' }), 'title')).toBe('D');
    expect(charBucket(entry({ title: '9 stories' }), 'title')).toBe('#');
  });
});

describe('reviewedInYear / reviewedAll', () => {
  const lib = library([
    entry({ id: '1', dateRead: '2026/03/15' }),
    entry({ id: '2', dateRead: '2025/12/01' }),
    entry({ id: '3', dateRead: '2026/01/01', hasReview: false, review: '' }),
    entry({ id: '4', dateRead: '2026/02/01', shelf: 'to-read' })
  ]);

  it('filters read + reviewed books in a specific year', () => {
    const ids = reviewedInYear(lib, '2026').map(e => e.id);
    expect(ids).toEqual(['1']);
  });

  it('filters read + reviewed books across all years', () => {
    const ids = reviewedAll(lib).map(e => e.id);
    expect(ids).toEqual(['1', '2']);
  });
});

describe('readInYear / readAll (review text optional)', () => {
  const lib = library([
    entry({ id: '1', dateRead: '2026/03/15', hasReview: true, review: 'Great' }),
    entry({ id: '2', dateRead: '2025/12/01', hasReview: true, review: 'Nice' }),
    entry({ id: '3', dateRead: '2026/01/01', hasReview: false, review: '' }),
    entry({ id: '4', dateRead: '2026/02/01', shelf: 'to-read' }),
    entry({ id: '5', dateRead: '', hasReview: false, review: '' })
  ]);

  it('includes un-reviewed books by default (just read in the year)', () => {
    const ids = readInYear(lib, '2026').map(e => e.id);
    expect(ids).toEqual(['1', '3']);
  });

  it('requires review text when requested', () => {
    const ids = readInYear(lib, '2026', true).map(e => e.id);
    expect(ids).toEqual(['1']);
  });

  it('readAll includes read books without reviews by default', () => {
    const ids = readAll(lib).map(e => e.id);
    expect(ids).toEqual(['1', '2', '3', '5']);
  });

  it('readAll requires review text when requested', () => {
    const ids = readAll(lib, true).map(e => e.id);
    expect(ids).toEqual(['1', '2']);
  });

  it('readAll ignores Date Read (all read-shelf books)', () => {
    const ids = readAll(lib, false).map(e => e.id);
    expect(ids).toContain('5');
  });

  it('matches the strict helpers: reviewedInYear === readInYear(requireReviews=true)', () => {
    expect(readInYear(lib, '2026', true).map(e => e.id)).toEqual(reviewedInYear(lib, '2026').map(e => e.id));
    expect(readAll(lib, true).map(e => e.id)).toEqual(reviewedAll(lib).map(e => e.id));
  });
});

describe('charCounts / publishedCounts', () => {
  it('counts books per first-letter bucket', () => {
    const counts = charCounts(
      [
        entry({ title: 'Dune' }),
        entry({ title: 'Dune Messiah' }),
        entry({ title: 'Children of Dune' })
      ],
      'title'
    );
    expect(counts.get('D')).toBe(2);
    expect(counts.get('C')).toBe(1);
  });

  it('groups missing publication years into Unknown', () => {
    const counts = publishedCounts([
      entry({ published: '2020' }),
      entry({ published: '2020' }),
      entry({ published: '' }),
      entry({ published: '2024/01/05' })
    ]);
    expect(counts.get('2020')).toBe(2);
    expect(counts.get('2024')).toBe(1);
    expect(counts.get('Unknown')).toBe(1);
  });
});

describe('missingLetters', () => {
  it('returns only letters absent from the counts', () => {
    const counts = new Map([['A', 3], ['M', 1]]);
    const missing = missingLetters(counts);
    expect(missing).toHaveLength(24);
    expect(missing).toContain('B');
    expect(missing).toContain('Z');
    expect(missing).not.toContain('A');
    expect(missing).not.toContain('M');
  });
});

describe('mostRecentReviewYear', () => {
  it('returns the max year in Date Read', () => {
    const lib = library([
      entry({ id: '1', dateRead: '2010/05/24' }),
      entry({ id: '2', dateRead: '2026/08/06' }),
      entry({ id: '3', dateRead: '2015/01/01' })
    ]);
    expect(mostRecentReviewYear(lib)).toBe('2026');
  });
});

describe('pubYearUpper / missingPubYears', () => {
  it('upper bound is at least the review year', () => {
    const counts = new Map([['1999', 1]]);
    expect(pubYearUpper(counts, 2026)).toBe(2026);
  });
  it('raises the upper bound to the latest published year', () => {
    const counts = new Map([['1999', 1], ['2027', 1]]);
    expect(pubYearUpper(counts, 2026)).toBe(2027);
  });
  it('lists every year in 1961..upper with no books', () => {
    const counts = new Map([['1961', 1], ['1963', 1]]);
    const missing = missingPubYears(counts, 1962);
    expect(missing).toEqual(['1962']);
  });
});

describe('renderers', () => {
  it('renderCharCountLines lists letters with counts', () => {
    const lines = renderCharCountLines([entry({ title: 'Dune' })], 'title');
    const text = lines.join('\n');
    expect(text).toContain('D: 1');
  });

  it('renderPublishedYearLines lists publication years ascending', () => {
    const lines = renderPublishedYearLines([
      entry({ published: '2010' }),
      entry({ published: '2000' }),
      entry({ published: '' })
    ]);
    const text = lines.join('\n');
    expect(text.indexOf('2000:')).toBeLessThan(text.indexOf('2010:'));
    expect(text).toContain('Unknown: 1');
  });

  it('renderMissingLines reports missing letters and years', () => {
    const lines = renderMissingLines([entry({ title: 'Zoo', published: '1961' })], '2026');
    const text = lines.join('\n');
    expect(text).toContain('missing');
    expect(text).toContain('Publication years 1961-2026');
  });
});
