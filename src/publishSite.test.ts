import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Redirect storage to an isolated temp database BEFORE db.ts is imported.
vi.hoisted(() => {
  const tmp = process.env.TMPDIR || process.env.TMP || '/tmp';
  process.env.GOODREADS_DB_PATH = `${tmp}/goodreads-publish-test-${process.pid}-${Date.now()}.db`;
});

import { closeDb, getDb } from './db.ts';
import { loadBooksAddedBuckets } from './booksAddedHistogram.ts';
import { loadAuthorArrivalBuckets } from './authorArrivalHistogram.ts';
import {
  AUTHOR_REPORTS,
  AVG_RATING_HISTOGRAM_REPORTS,
  AVG_RATING_HISTOGRAM_STEPS,
  BOOKS_ADDED_DAYS,
  BOOK_METRICS,
  BOOK_SCOPES,
  DERIVED_REPORTS,
  LIST_CREATOR_REPORT,
  LIST_REPORTS,
  LIST_SORT_ATTRIBUTES,
  LIST_SORT_SCRIPT,
  LIST_TAG_REPORT,
  PUBLISHER_REPORTS,
  STATIC_LISTS_REPORT,
  PUBLISHER_REPORT_LIMIT,
  TITLE_MIN_BOOKS,
  TITLE_REPORTS,
  YEAR_REPORTS,
  aggregateListCreators,
  buildNav,
  buildPublicationYearSummary,
  computeTitleStats,
  createAccumulators,
  dedupeEnglishWorks,
  scanBooks,
  escapeHtml,
  formatGeneratedAt,
  parsePublishedYear,
  renderAuthorTable,
  renderAvgRatingHistogramPage,
  renderDerivedTable,
  renderFieldCoveragePage,
  renderFirstWordTable,
  renderFrequencyPage,
  renderHistogram,
  renderListCreatorTable,
  renderListTable,
  renderListTagTable,
  renderNav,
  renderOverallRatingsHistogram,
  renderPage,
  renderPageCountPage,
  renderBooksAddedPage,
  renderAuthorsAddedPage,
  renderPublicationYearsPage,
  renderPublisherTable,
  renderScopeToggle,
  renderTopBooks,
  renderYearTable,
  runPublishSite,
  scanBookPages,
  scanEnglishWorks,
  sortListRows,
  writeFileAtomic,
} from './publishSite.ts';
import type { BookScopeId, DerivedBook, DerivedReportId, ListRow, YearBook } from './publishSite.ts';
import type { SelectedAuthor } from './authorTopStats.ts';
import type { AuthorCacheEntry } from './storage.ts';

const DB_FILE = process.env.GOODREADS_DB_PATH!;

afterAll(() => {
  closeDb();
  delete process.env.GOODREADS_DB_PATH;
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_FILE + suffix, { force: true });
});

function author(id: string, over: Partial<AuthorCacheEntry> = {}): SelectedAuthor {
  const entry: AuthorCacheEntry = {
    id,
    name: `Author ${id}`,
    slug: id,
    lastSeen: '2026-11-11T00:00:00.000Z',
    numRatings: '0',
    numReviews: '0',
    numShelves: '0',
    averageRating: '0',
    catalogPages: 0,
    ...over,
  };
  return { id, name: entry.name || id, entry, value: 0 };
}

function listRow(over: Partial<ListRow> = {}): ListRow {
  return {
    listId: '1',
    title: 'List 1',
    numBooks: 0,
    numVoters: 0,
    numLikes: 0,
    createdAt: '2020-01-01',
    creatorId: '9',
    creatorName: 'Creator',
    isStatic: false,
    ...over,
  };
}

function pageRow(over: Record<string, unknown> = {}) {
  return {
    id: '1',
    title: 'Title',
    author: 'Author',
    author_id: 'A',
    work_id: 'W1',
    is_work_rep: 0,
    reviews_count: '0',
    currently_reading: 0,
    to_read: 0,
    editions_count: 0,
    ratings: 0,
    avg_rating: null,
    ratings_skewness: null,
    ratings_variance: null,
    ratings_kurtosis: null,
    ...over,
  } as Parameters<typeof dedupeEnglishWorks>[0][number];
}

describe('static publish', () => {
  it('builds the expected author reports', () => {
    expect(AUTHOR_REPORTS.map((report) => report.id)).toEqual([
      'author/top-authors-by-ratings',
      'author/top-authors-by-reviews',
      'author/top-authors-by-shelves',
      'author/top-authors-by-catalog-pages',
      'author/top-authors-by-avg-rating-min-100k',
      'author/top-authors-by-avg-rating-min-10k',
      'author/top-authors-by-avg-rating-min-1k',
      'author/bottom-authors-by-avg-rating-min-10k',
      'author/bottom-authors-by-avg-rating-min-1k',
    ]);
    expect(
      AUTHOR_REPORTS.find((report) => report.id === 'author/top-authors-by-avg-rating-min-100k')?.minRatings,
    ).toBe(100000);
    expect(
      AUTHOR_REPORTS.find((report) => report.id === 'author/top-authors-by-avg-rating-min-1k')?.minRatings,
    ).toBe(1000);
    const bottom = AUTHOR_REPORTS.find((report) => report.id === 'author/bottom-authors-by-avg-rating-min-10k');
    expect(bottom?.minRatings).toBe(10000);
    expect(bottom?.direction).toBe('asc');
    const bottom1k = AUTHOR_REPORTS.find((report) => report.id === 'author/bottom-authors-by-avg-rating-min-1k');
    expect(bottom1k?.minRatings).toBe(1000);
    expect(bottom1k?.direction).toBe('asc');
  });

  it('builds the expected publisher reports', () => {
    expect(PUBLISHER_REPORTS.map((report) => report.id)).toEqual([
      'book-detail/publishers-most-books',
      'book-detail/publishers-most-ratings',
    ]);
    expect(PUBLISHER_REPORTS.map((report) => report.sortBy)).toEqual(['books', 'totalRatings']);
    expect(PUBLISHER_REPORT_LIMIT).toBe(1000);
  });

  it('builds the expected book scopes and metrics', () => {
    expect(BOOK_SCOPES.map((scope) => scope.id)).toEqual(['book-id', 'work-id', 'works', 'works-en']);
    expect(BOOK_METRICS.map((metric) => metric.id)).toEqual([
      'ratings',
      'reviews',
      'currently-reading',
      'to-read',
      'edition-count',
    ]);
  });

  it('builds the expected derived book reports', () => {
    expect(DERIVED_REPORTS.map((report) => report.id)).toEqual([
      'highest-skewness-min-100k',
      'highest-skewness-min-10k',
      'highest-variance-min-100k',
      'highest-variance-min-10k',
      'lowest-kurtosis-min-100k',
      'lowest-kurtosis-min-10k',
      'highest-review-ratio-min-1k',
      'highest-avg-rating-min-100k',
      'highest-avg-rating-min-10k',
      'highest-avg-rating-min-1k',
      'lowest-avg-rating-min-10k',
      'lowest-avg-rating-min-1k',
    ]);
    expect(DERIVED_REPORTS.map((report) => report.minRatings)).toEqual([
      100000, 10000, 100000, 10000, 100000, 10000, 1000, 100000, 10000, 1000, 10000, 1000,
    ]);
    expect(DERIVED_REPORTS.find((report) => report.id === 'lowest-kurtosis-min-100k')?.direction).toBe('asc');
    expect(DERIVED_REPORTS.find((report) => report.id === 'lowest-kurtosis-min-10k')?.direction).toBe('asc');
    expect(DERIVED_REPORTS.find((report) => report.id === 'highest-review-ratio-min-1k')?.kind).toBe('review-ratio');
    expect(DERIVED_REPORTS.find((report) => report.id === 'lowest-avg-rating-min-10k')?.direction).toBe('asc');
    expect(DERIVED_REPORTS.find((report) => report.id === 'lowest-avg-rating-min-1k')?.direction).toBe('asc');
    expect(DERIVED_REPORTS.find((report) => report.id === 'highest-avg-rating-min-100k')?.kind).toBe('avg-rating');
    expect(DERIVED_REPORTS).toHaveLength(12);
  });

  it('builds avg-rating histogram reports at three thresholds and bucket widths', () => {
    expect(AVG_RATING_HISTOGRAM_REPORTS.map((report) => report.id)).toEqual([
      'avg-ratings-histogram-min-100k',
      'avg-ratings-histogram-min-10k',
      'avg-ratings-histogram-min-1k',
    ]);
    expect(AVG_RATING_HISTOGRAM_REPORTS.map((report) => report.minRatings)).toEqual([100000, 10000, 1000]);
    expect(AVG_RATING_HISTOGRAM_STEPS).toEqual([0.5, 0.2, 0.1]);
    const nav = renderNav(buildNav(), 'book-id/avg-ratings-histogram-min-100k', '../');
    for (const report of AVG_RATING_HISTOGRAM_REPORTS) {
      expect(nav).toContain(`href="../book-id/${report.id}.html"`);
      expect(nav).toContain(`href="../work-id/${report.id}.html"`);
      expect(nav).toContain(`href="../works/${report.id}.html"`);
      expect(nav).toContain(`href="../works-en/${report.id}.html"`);
    }
  });

  it('builds the expected list reports', () => {
    expect(LIST_REPORTS.map((report) => report.id)).toEqual([
      'lists/most-books',
      'lists/most-voters',
      'lists/most-likes',
      'lists/earliest-created',
      'lists/latest-created',
    ]);
    expect(LIST_CREATOR_REPORT.id).toBe('lists/creators-most-lists');
  });

  it('sorts lists by the report field with nulls last', () => {
    const rows = [
      listRow({ listId: '2', numLikes: null }),
      listRow({ listId: '1', numLikes: 5 }),
      listRow({ listId: '3', numLikes: 5 }),
    ];
    const report = LIST_REPORTS.find((candidate) => candidate.id === 'lists/most-likes')!;
    expect(sortListRows(rows, report).map((row) => row.listId)).toEqual(['1', '3', '2']);
  });

  it('renders list rows with Goodreads links and sortable columns', () => {
    const rows = [
      listRow({
        listId: '100',
        title: 'Big',
        numBooks: 500,
        numVoters: 100,
        numLikes: 20,
        createdAt: '2010-01-01',
        creatorId: '1',
        creatorName: 'Alice',
      }),
      listRow({
        listId: '200',
        title: 'Small',
        numBooks: 10,
        numVoters: 5,
        numLikes: null,
        createdAt: '2020-01-01',
        creatorId: null,
        creatorName: 'deleted user',
      }),
    ];
    const html = renderListTable(rows, 'numBooks');
    expect(html.indexOf('Big')).toBeLessThan(html.indexOf('Small'));
    expect(html).toContain('https://www.goodreads.com/list/show/100');
    expect(html).toContain('https://www.goodreads.com/list/created/1');
    expect(html).toContain('deleted user');
    expect(html).toContain('—');
    expect(html).toContain('<table id="lists-table" data-default-sort="numBooks">');
    expect(html).toContain('data-sort="numBooks"');
    expect(html).toContain('data-sort="numVoters"');
    expect(html).toContain('data-sort="numLikes"');
    expect(html).toContain('data-sort="createdAt"');
    expect(html).toContain('data-list-id="100" data-books="500" data-voters="100" data-likes="20" data-created="2010-01-01"');
  });

  it('sorts list rows by every column using the generated client script', () => {
    const rows = [
      listRow({ listId: '1', title: 'Alpha', numBooks: 10, numVoters: 200, numLikes: 5, createdAt: '2020-01-01' }),
      listRow({ listId: '2', title: 'Beta', numBooks: 30, numVoters: 100, numLikes: null, createdAt: '2010-01-01' }),
      listRow({ listId: '3', title: 'Gamma', numBooks: 20, numVoters: 300, numLikes: 9, createdAt: '2015-01-01' }),
    ];
    const html = renderListTable(rows, 'numBooks');

    // Build a minimal DOM from the rendered markup so the real script is exercised.
    interface FakeEl {
      attrs: Record<string, string>;
      getAttribute: (name: string) => string | null;
      addEventListener: (type: string, fn: () => void) => void;
      click: () => void;
      querySelector: (selector: string) => FakeEl | null;
      querySelectorAll: (selector: string) => FakeEl[];
      appendChild: (child: FakeEl) => void;
      rows: FakeEl[];
      textContent: string;
    }
    function el(attrs: Record<string, string> = {}, options: { buttons?: FakeEl[]; tbody?: FakeEl } = {}): FakeEl {
      const handlers: Array<() => void> = [];
      const arrow: FakeEl = elWithoutNesting();
      const node: FakeEl = {
        attrs,
        getAttribute: (name) => (name in attrs ? attrs[name] : null),
        addEventListener: (_type, fn) => handlers.push(fn),
        click: () => handlers.forEach((fn) => fn()),
        querySelector: (selector) => (selector === 'tbody' ? (options.tbody ?? null) : selector === '.sort-arrow' ? arrow : null),
        querySelectorAll: (selector) => (selector === '[data-sort]' ? (options.buttons ?? []) : []),
        appendChild: (child) => {
          const index = node.rows.indexOf(child);
          if (index !== -1) node.rows.splice(index, 1);
          node.rows.push(child);
        },
        rows: [],
        textContent: '',
      };
      return node;
    }
    function elWithoutNesting(): FakeEl {
      return {
        attrs: {},
        getAttribute: () => null,
        addEventListener: () => {},
        click: () => {},
        querySelector: () => null,
        querySelectorAll: () => [],
        appendChild: () => {},
        rows: [],
        textContent: '',
      };
    }

    const buttons = [...html.matchAll(/data-sort="([^"]+)"/g)].map((match) => el({ 'data-sort': match[1] }));
    const bodyRows = [...html.matchAll(/<tr data-list-id="([^"]+)"([^>]*)>/g)].map((match) => {
      const attrs: Record<string, string> = { 'data-list-id': match[1] };
      for (const attr of match[2].matchAll(/data-([a-z-]+)="([^"]*)"/g)) {
        attrs[`data-${attr[1]}`] = attr[2];
      }
      return el(attrs);
    });
    expect(bodyRows).toHaveLength(3);
    for (const field of Object.keys(LIST_SORT_ATTRIBUTES)) {
      expect(buttons.some((button) => button.attrs['data-sort'] === field)).toBe(true);
      expect(bodyRows[0].attrs[`data-${LIST_SORT_ATTRIBUTES[field as keyof typeof LIST_SORT_ATTRIBUTES]}`]).toBeDefined();
    }

    const tbody = el();
    tbody.rows = bodyRows;
    const defaultSort = /data-default-sort="([^"]+)"/.exec(html)![1];
    const table = el({ 'data-default-sort': defaultSort }, { buttons, tbody });
    const originalDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = {
      querySelector: (selector: string) => (selector === '#lists-table' ? table : null),
    };
    try {
      new Function(LIST_SORT_SCRIPT)();
      const order = () => tbody.rows.map((row) => row.attrs['data-list-id']);
      const click = (field: string) => buttons.find((button) => button.attrs['data-sort'] === field)!.click();

      click('numBooks');
      expect(order()).toEqual(['1', '3', '2']);
      click('numBooks');
      expect(order()).toEqual(['2', '3', '1']);
      click('numVoters');
      expect(order()).toEqual(['3', '1', '2']);
      click('numLikes');
      expect(order()).toEqual(['3', '1', '2']);
      click('createdAt');
      expect(order()).toEqual(['1', '3', '2']);
      click('createdAt');
      expect(order()).toEqual(['2', '3', '1']);
    } finally {
      (globalThis as { document?: unknown }).document = originalDocument;
    }
  });

  it('reports when no lists matched', () => {
    expect(renderListTable([], 'numBooks')).toContain('No lists');
    expect(renderListCreatorTable([])).toContain('No list creators');
  });

  it('aggregates list creators and sums their list attributes', () => {
    const rows = [
      listRow({ listId: '1', creatorId: '1', creatorName: 'Alice', numBooks: 100, numVoters: 10, numLikes: 5 }),
      listRow({ listId: '2', creatorId: '1', creatorName: 'Alice', numBooks: 50, numVoters: 5, numLikes: null }),
      listRow({ listId: '3', creatorId: null, creatorName: 'deleted', numBooks: 999, numVoters: 99, numLikes: 9 }),
    ];
    const creators = aggregateListCreators(rows);
    expect(creators).toHaveLength(1);
    expect(creators[0]).toMatchObject({
      creatorId: '1',
      creatorName: 'Alice',
      numLists: 2,
      numBooks: 150,
      numVoters: 15,
      numLikes: 5,
      hasLikes: true,
    });
    const html = renderListCreatorTable(creators);
    expect(html).toContain('https://www.goodreads.com/list/created/1');
    expect(html).toContain('Lists created');
    expect(html).toContain('<td class="num">2</td>');
    expect(html).toContain('<table id="list-creators">');
    expect(html).toContain('data-sort="lists"');
    expect(html).toContain('data-sort="likes"');
    expect(html).toContain('data-creator-id="1" data-lists="2" data-books="150" data-voters="15" data-likes="5"');
  });

  it('marks creators without likes data with an empty sort value', () => {
    const creators = aggregateListCreators([
      listRow({ listId: '1', creatorId: '2', creatorName: 'Bob', numBooks: 1, numVoters: 1, numLikes: null }),
    ]);
    const html = renderListCreatorTable(creators);
    expect(html).toContain('data-creator-id="2" data-lists="1" data-books="1" data-voters="1" data-likes=""');
  });

  it('builds 27 year reports from 2026 back to 2000', () => {
    expect(YEAR_REPORTS).toHaveLength(27);
    expect(YEAR_REPORTS[0]).toMatchObject({ year: 2026, id: 'year/2026' });
    expect(YEAR_REPORTS[26]).toMatchObject({ year: 2000, id: 'year/2000' });
  });

  it('parses published years and ignores out-of-range values', () => {
    expect(parsePublishedYear('2013')).toBe(2013);
    expect(parsePublishedYear('2013.05.01')).toBe(2013);
    expect(parsePublishedYear('Unknown')).toBeNull();
    expect(parsePublishedYear('1999')).toBeNull();
    expect(parsePublishedYear('2027')).toBeNull();
    expect(parsePublishedYear(null)).toBeNull();
  });

  it('renders year rows by avg rating then ratings', () => {
    const books: YearBook[] = [
      { id: '1', title: 'Lower', author: 'A', authorId: '101', avgRating: 4.5, ratings: 9000, year: 2024 },
      { id: '2', title: 'Tie Fewer', author: 'B', authorId: '', avgRating: 4.8, ratings: 2000, year: 2024 },
      { id: '3', title: 'Tie More', author: 'C', authorId: '103', avgRating: 4.8, ratings: 5000, year: 2024 },
    ];
    const html = renderYearTable(books, 2024);
    expect(html.indexOf('Tie More')).toBeLessThan(html.indexOf('Tie Fewer'));
    expect(html.indexOf('Tie Fewer')).toBeLessThan(html.indexOf('Lower'));
    expect(html).toContain('https://www.goodreads.com/book/show/3');
    expect(html).toContain('https://www.goodreads.com/author/show/103');
    expect(html).toContain('target="_blank" rel="noopener noreferrer">C</a>');
    // No author id: plain text, no link.
    expect(html).toContain('<td>B</td>');
    expect(html).toContain('4.80');
    expect(html).toContain('5,000');
    expect(html).toContain('at least 1,000 ratings');
  });

  it('reports an empty year', () => {
    expect(renderYearTable([], 2026)).toContain('No books matched');
  });

  it('defines three title reports and one list-tag report', () => {
    expect(TITLE_REPORTS.map((report) => report.id)).toEqual([
      'titles/first-char',
      'titles/last-char',
      'titles/first-word',
    ]);
    expect(LIST_TAG_REPORT.id).toBe('lists/top-list-tags');
  });

  it('computes title char and first-word stats with the 1000-book floor', () => {
    const titles = [
      ...Array.from({ length: TITLE_MIN_BOOKS }, () => 'Alpha'),
      ...Array.from({ length: 5 }, () => 'Beta'),
      'The Odyssey (The Odyssey, #1)',
    ];
    const stats = computeTitleStats(titles);
    expect(stats.total).toBe(TITLE_MIN_BOOKS + 6);
    expect(stats.firstChar).toEqual([{ char: 'A', count: TITLE_MIN_BOOKS }]);
    expect(stats.lastChar).toEqual([{ char: 'a', count: TITLE_MIN_BOOKS + 5 }]);
    expect(stats.firstWords.map((row) => row.word)).toEqual(['alpha', 'beta', 'the']);
    expect(stats.firstWords[0]).toEqual({ word: 'alpha', count: TITLE_MIN_BOOKS });
  });

  it('renders ranked first words', () => {
    const html = renderFirstWordTable([
      { word: 'the', count: 12 },
      { word: 'a', count: 5 },
    ]);
    expect(html).toContain('<td>the</td>');
    expect(html).toContain('<td>a</td>');
    expect(html.indexOf('<td>the</td>')).toBeLessThan(html.indexOf('<td>a</td>'));
    expect(html).toContain('12');
    expect(renderFirstWordTable([])).toContain('No titles matched');
  });

  it('links title labels to list tags only when the tag exists', () => {
    const tags = new Set(['a', 'the']);
    const chars = renderFrequencyPage(
      'intro',
      [
        { label: 'A', count: 10 },
        { label: 'B', count: 5 },
      ],
      15,
      'First character',
      tags,
    );
    expect(chars).toContain('<a href="https://www.goodreads.com/list/tag/a" target="_blank" rel="noopener noreferrer">A</a>');
    expect(chars).toContain('<td>B</td>');
    expect(chars).not.toContain('/list/tag/b');
    expect(renderFrequencyPage('intro', [{ label: 'A', count: 1 }], 1, 'Last character')).not.toContain('/list/tag/a');

    const words = renderFirstWordTable(
      [
        { word: 'the', count: 2 },
        { word: 'year', count: 1 },
      ],
      tags,
    );
    expect(words).toContain('/list/tag/the');
    expect(words).toContain('<td>year</td>');
  });

  it('links list tags to their directory pages', () => {
    const html = renderListTagTable([
      { tagName: 'horror', lists: 1018 },
      { tagName: 'romance', lists: 900 },
    ]);
    expect(html).toContain('https://www.goodreads.com/list/tag/horror');
    expect(html).toContain('https://www.goodreads.com/list/tag/romance');
    expect(html).toContain('1,018');
    expect(html.indexOf('horror')).toBeLessThan(html.indexOf('romance'));
    expect(renderListTagTable([])).toContain('No list tags matched');
  });

  it('escapes html', () => {
    expect(escapeHtml(`<a & "b" 'c'>`)).toBe('&lt;a &amp; &quot;b&quot; &#39;c&#39;&gt;');
  });

  it('renders nav sections, the active link, and soon badges', () => {
    const html = renderNav(buildNav(), 'author/top-authors-by-ratings', '../');
    expect(html).toContain('Overall');
    expect(html).toContain('Author');
    expect(html).toContain('Book ID');
    expect(html).toContain('Book Detail');
    expect(html).toContain('Titles');
    expect(html).toContain('Highest Rated by Year');
    expect(html).toContain('soon');
    expect(html).toContain('href="../author/top-authors-by-ratings.html"');
    expect(html).toContain('class="active"');
    expect(html).toContain('href="../book-id/ratings.html"');
    expect(html).toContain('href="../lists/most-books.html"');
    expect(html).toContain('href="../lists/static-lists.html"');
    expect(html).toContain('Static Lists');
    expect(html).toContain('Creators with Most Lists');
    expect(html).toContain('href="../year/2026.html"');
    expect(html).toContain('href="../year/2000.html"');
    expect(html).toContain('href="../titles/first-char.html"');
    expect(html).toContain('href="../titles/first-word.html"');
    expect(html).toContain('href="../lists/top-list-tags.html"');
    expect(html).toContain('href="../book-id/highest-skewness-min-100k.html"');
    expect(html).toContain('href="../book-id/highest-skewness-min-10k.html"');
    expect(html).toContain('href="../work-id/highest-variance-min-100k.html"');
    expect(html).toContain('href="../work-id/highest-variance-min-10k.html"');
    expect(html).toContain('href="../works/lowest-kurtosis-min-100k.html"');
    expect(html).toContain('href="../works/lowest-kurtosis-min-10k.html"');
    expect(html).toContain('href="../works-en/highest-avg-rating-min-1k.html"');
    expect(html).toContain('href="../book-id/lowest-avg-rating-min-1k.html"');
    expect(html).toContain('href="../works/highest-review-ratio-min-1k.html"');
    expect(html).toContain('href="../per-field.html"');
    expect(html).toContain('href="../ratings-histogram.html"');
    expect(html).toContain('href="../publication-years.html"');
    expect(html).toContain('href="../books-added.html"');
    expect(html).toContain('href="../authors-added.html"');
    expect(html).toContain('href="../author/top-authors-by-avg-rating-min-1k.html"');
    expect(html).toContain('href="../author/bottom-authors-by-avg-rating-min-1k.html"');
    expect(html).toContain('href="../book-detail/publishers-most-books.html"');
    expect(html).toContain('href="../book-detail/publishers-most-ratings.html"');
    // Expando: only the section holding the active report starts open.
    expect(html).toContain('<details class="nav-section" open>\n<summary class="nav-heading">Author</summary>');
    expect(html).toContain('<details class="nav-section">\n<summary class="nav-heading">Overall</summary>');
    // Empty sections keep the muted badge and no details element.
    expect(html).toContain('<div class="nav-heading">Genres <span class="soon">soon</span></div>');
    expect(html).toContain('href="../tags/first-page-books.html"');
    expect(html).toContain('<details class="nav-section">\n<summary class="nav-heading">Tags</summary>');
  });

  it('renders a page with title, generated stamp, nav and content', () => {
    const html = renderPage({
      title: 'Top <Authors>',
      nav: buildNav(),
      activeId: 'author/top-authors-by-ratings',
      rootPrefix: '../',
      content: '<p>hello</p>',
      generatedAt: '2026-11-11T12:34:56.789Z',
    });
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Top &lt;Authors&gt;');
    expect(html).toContain('Last generated: 2026-11-11 12:34:56 UTC');
    expect(html).toContain('<p>hello</p>');
    expect(html).toContain('.nav-section > summary');
    expect(html).toContain('.nav-section[open] > summary::before');
  });

  it('renders author rows with Goodreads links and the entry attribute first', () => {
    const authors = [
      author('1077326', {
        name: 'J.K. Rowling',
        numRatings: '1,234',
        numReviews: '56',
        numShelves: '7',
        catalogPages: 8,
        averageRating: '4.567',
      }),
    ];
    const html = renderAuthorTable(authors, 'numRatings');
    expect(html).toContain('href="https://www.goodreads.com/author/show/1077326"');
    expect(html).toContain('J.K. Rowling');
    expect(html).toContain('<th class="num">Ratings</th>');
    expect(html.indexOf('Ratings')).toBeLessThan(html.indexOf('Reviews'));
    expect(html).toContain('<td class="num">1,234</td>');
    expect(html).toContain('<td class="num">4.57</td>');
  });

  it('reports when no authors matched', () => {
    expect(renderAuthorTable([], 'numRatings')).toContain('No authors');
  });

  it('formats generated timestamps', () => {
    expect(formatGeneratedAt('2026-11-11T12:34:56.789Z')).toBe('2026-11-11 12:34:56 UTC');
    expect(formatGeneratedAt('not-a-date')).toBe('not-a-date');
  });

  it('renders histogram shares', () => {
    const acc = createAccumulators()['book-id'].metrics.ratings;
    acc.counts[0] = 1;
    acc.counts[1] = 2;
    acc.count = 3;
    const html = renderHistogram(acc, 3);
    expect(html).toContain('<td>0</td>');
    expect(html).toContain('33.3%');
    expect(html).toContain('66.7%');
  });

  it('renders top books best-first with work links', () => {
    const metric = BOOK_METRICS.find((candidate) => candidate.id === 'ratings')!;
    const html = renderTopBooks(
      [
        { id: '1', title: 'Low', author: 'A', authorId: '', workId: '', value: 10 },
        { id: '2', title: 'High', author: 'B', authorId: 'A2', workId: 'W2', value: 99 },
      ],
      metric,
      true,
    );
    expect(html.indexOf('High')).toBeLessThan(html.indexOf('Low'));
    expect(html).toContain('<th>Work ID</th>');
    expect(html).toContain('https://www.goodreads.com/work/editions/W2');
    expect(html).toContain('https://www.goodreads.com/book/show/2');
    expect(html).toContain('https://www.goodreads.com/author/show/A2');
  });

  it('renders derived tables best-first with ratio columns', () => {
    const skewness = DERIVED_REPORTS.find((report) => report.id === 'highest-skewness-min-100k')!;
    const html = renderDerivedTable(
      [
        { id: '1', title: 'Low', author: 'A', authorId: '', workId: '', value: 1, ratings: 200000, reviews: 0 },
        { id: '2', title: 'High', author: 'B', authorId: 'A2', workId: 'W2', value: 5, ratings: 100000, reviews: 0 },
      ],
      skewness,
      true,
    );
    expect(html.indexOf('High')).toBeLessThan(html.indexOf('Low'));
    expect(html).toContain('<th>Work ID</th>');
    expect(html).toContain('5.0000');
    expect(html).toContain('https://www.goodreads.com/book/show/2');
    expect(html).toContain('https://www.goodreads.com/work/editions/W2');
    expect(html).toContain('https://www.goodreads.com/author/show/A2');

    const kurtosis = DERIVED_REPORTS.find((report) => report.id === 'lowest-kurtosis-min-100k')!;
    const asc = renderDerivedTable(
      [
        { id: '1', title: 'Negative', author: 'A', authorId: '', workId: '', value: -2, ratings: 200000, reviews: 0 },
        { id: '2', title: 'Positive', author: 'B', authorId: '', workId: '', value: 3, ratings: 200000, reviews: 0 },
      ],
      kurtosis,
      false,
    );
    expect(asc.indexOf('Negative')).toBeLessThan(asc.indexOf('Positive'));
    expect(asc).toContain('-2.0000');

    const ratio = DERIVED_REPORTS.find((report) => report.id === 'highest-review-ratio-min-1k')!;
    const ratioHtml = renderDerivedTable(
      [{ id: '3', title: 'Ratio', author: 'C', authorId: '', workId: '', value: 1.6667, ratings: 150000, reviews: 250000 }],
      ratio,
      false,
    );
    expect(ratioHtml).toContain('<th class="num">Reviews</th>');
    expect(ratioHtml).toContain('1.667');
    expect(ratioHtml).toContain('250,000');
    expect(ratioHtml).toContain('150,000');

    expect(renderDerivedTable([], skewness, false)).toContain('No books matched');
  });

  it('scans derived stats per scope, filtering by ratings and dropping nulls', () => {
    const db = getDb();
    const insertBook = db.prepare(
      'INSERT INTO books (id, title, author, ratings, work_id, is_work_rep, last_updated) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    insertBook.run('40', 'High Skew', 'Author 40', 200000, 'W40', 1, '2026-11-11T00:00:00.000Z');
    insertBook.run('41', 'High Ratio', 'Author 41', 150000, 'W40', 0, '2026-11-11T00:00:00.000Z');
    insertBook.run('42', 'Loose', 'Author 42', 120000, null, 0, '2026-11-11T00:00:00.000Z');
    insertBook.run('43', 'Too Few', 'Author 43', 500, 'W43', 1, '2026-11-11T00:00:00.000Z');
    insertBook.run('44', 'No Stats', 'Author 44', 200000, 'W44', 1, '2026-11-11T00:00:00.000Z');

    const insertPage = db.prepare(
      'INSERT INTO book_page (book_id, reviews_count, ratings_skewness, ratings_variance, ratings_kurtosis, scraped_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insertPage.run('40', '100000', 5, 9, -2, '2026-11-11T00:00:00.000Z');
    insertPage.run('41', '300000', 1, 4, 2, '2026-11-11T00:00:00.000Z');
    insertPage.run('42', '1000', 9, 1, 1, '2026-11-11T00:00:00.000Z');
    insertPage.run('43', '10', 99, 99, 99, '2026-11-11T00:00:00.000Z');
    insertPage.run('44', '50000', null, null, null, '2026-11-11T00:00:00.000Z');

    try {
      const acc = createAccumulators();
      scanBookPages(acc, 10);
      const heapIds = (scope: BookScopeId, report: DerivedReportId): string[] =>
        acc[scope].derived[report].heap.map((book) => book.id).sort();

      expect(heapIds('book-id', 'highest-skewness-min-100k')).toEqual(['40', '41', '42']);
      expect(heapIds('work-id', 'highest-skewness-min-100k')).toEqual(['40', '41']);
      expect(heapIds('works', 'highest-skewness-min-100k')).toEqual(['40']);
      expect(heapIds('book-id', 'highest-variance-min-100k')).toEqual(['40', '41', '42']);
      expect(heapIds('work-id', 'highest-variance-min-100k')).toEqual(['40', '41']);
      expect(heapIds('works', 'highest-variance-min-100k')).toEqual(['40']);
      expect(heapIds('book-id', 'lowest-kurtosis-min-100k')).toEqual(['40', '41', '42']);
      expect(heapIds('works', 'lowest-kurtosis-min-100k')).toEqual(['40']);
      // Review ratio needs only >= 1k ratings, so the null-stat book qualifies.
      expect(heapIds('book-id', 'highest-review-ratio-min-1k')).toEqual(['40', '41', '42', '44']);
      expect(heapIds('work-id', 'highest-review-ratio-min-1k')).toEqual(['40', '41', '44']);
      expect(heapIds('works', 'highest-review-ratio-min-1k')).toEqual(['40', '44']);
      expect(acc['book-id'].derived['highest-review-ratio-min-1k'].count).toBe(4);

      const byId = new Map(acc['book-id'].derived['highest-review-ratio-min-1k'].heap.map((book) => [book.id, book]));
      expect(byId.get('41')?.value).toBeCloseTo(2);
      expect(byId.get('40')?.value).toBeCloseTo(0.5);
      expect(byId.get('40')?.reviews).toBe(100000);
      expect(byId.get('40')?.ratings).toBe(200000);
    } finally {
      db.prepare('DELETE FROM book_page WHERE book_id IN (?, ?, ?, ?, ?)').run('40', '41', '42', '43', '44');
      db.prepare('DELETE FROM books WHERE id IN (?, ?, ?, ?, ?)').run('40', '41', '42', '43', '44');
    }
  });

  it('dedupes English works by normalized title and author, keeping the best edition', () => {
    const deduped = dedupeEnglishWorks([
      pageRow({
        id: '1',
        title: 'Harry Potter and the Prisoner of Azkaban (Harry Potter, #3)',
        author_id: 'A',
        ratings: 100,
        work_id: 'W1',
      }),
      pageRow({
        id: '2',
        title: 'Harry Potter and the Prisoner of Azkaban',
        author_id: 'A',
        ratings: 200,
        work_id: 'W2',
      }),
      pageRow({ id: '3', title: 'Different', author_id: 'A', ratings: 300, work_id: 'W3' }),
      pageRow({ id: '4', title: '', author_id: 'A', ratings: 50, work_id: 'W4' }),
      pageRow({ id: '5', title: '', author_id: 'A', ratings: 40, work_id: 'W5' }),
    ]);
    expect(deduped.map((row) => row.id).sort()).toEqual(['2', '3', '4', '5']);
    expect(deduped.find((row) => row.id === '2')?.ratings).toBe(200);
  });

  it('renders the all-language/English works toggle on both works scopes', () => {
    const works = BOOK_SCOPES.find((scope) => scope.id === 'works')!;
    const english = BOOK_SCOPES.find((scope) => scope.id === 'works-en')!;
    const bookId = BOOK_SCOPES.find((scope) => scope.id === 'book-id')!;
    expect(renderScopeToggle(works, 'ratings')).toContain('href="../works-en/ratings.html"');
    expect(renderScopeToggle(works, 'ratings')).toContain('<strong>All languages</strong>');
    expect(renderScopeToggle(english, 'highest-avg-rating-min-100k')).toContain(
      'href="../works/highest-avg-rating-min-100k.html"',
    );
    expect(renderScopeToggle(english, 'highest-avg-rating-min-100k')).toContain('<strong>English only</strong>');
    expect(renderScopeToggle(bookId, 'ratings')).toBe('');
  });

  it('scans avg-rating reports with min-rating filters in both directions', () => {
    const db = getDb();
    const insertBook = db.prepare(
      'INSERT INTO books (id, title, author, ratings, avg_rating, work_id, is_work_rep, last_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insertBook.run('50', 'High Avg', 'Author 50', 200000, 4.9, 'W50', 1, '2026-11-11T00:00:00.000Z');
    insertBook.run('51', 'Low Avg', 'Author 51', 50000, 2.1, 'W51', 1, '2026-11-11T00:00:00.000Z');
    insertBook.run('52', 'Too Few', 'Author 52', 5000, 1.0, 'W52', 1, '2026-11-11T00:00:00.000Z');

    const insertPage = db.prepare(
      'INSERT INTO book_page (book_id, ratings_skewness, scraped_at) VALUES (?, ?, ?)',
    );
    insertPage.run('50', null, '2026-11-11T00:00:00.000Z');
    insertPage.run('51', null, '2026-11-11T00:00:00.000Z');
    insertPage.run('52', null, '2026-11-11T00:00:00.000Z');

    try {
      const acc = createAccumulators();
      scanBookPages(acc, 10);
      const ids = (report: DerivedReportId): string[] =>
        acc['book-id'].derived[report].heap.map((book) => book.id).sort();

      expect(ids('highest-avg-rating-min-100k')).toEqual(['50']);
      expect(ids('highest-avg-rating-min-10k')).toEqual(['50', '51']);
      expect(ids('lowest-avg-rating-min-10k')).toEqual(['50', '51']);
      expect(acc['book-id'].derived['highest-avg-rating-min-10k'].count).toBe(2);

      const highest = renderDerivedTable(
        acc['book-id'].derived['highest-avg-rating-min-10k'].heap,
        DERIVED_REPORTS.find((report) => report.id === 'highest-avg-rating-min-10k')!,
        false,
      );
      expect(highest.indexOf('High Avg')).toBeLessThan(highest.indexOf('Low Avg'));
      expect(highest).toContain('4.90');

      const lowest = renderDerivedTable(
        acc['book-id'].derived['lowest-avg-rating-min-10k'].heap,
        DERIVED_REPORTS.find((report) => report.id === 'lowest-avg-rating-min-10k')!,
        false,
      );
      expect(lowest.indexOf('Low Avg')).toBeLessThan(lowest.indexOf('High Avg'));
      expect(lowest).toContain('2.10');
    } finally {
      db.prepare('DELETE FROM book_page WHERE book_id IN (?, ?, ?)').run('50', '51', '52');
      db.prepare('DELETE FROM books WHERE id IN (?, ?, ?)').run('50', '51', '52');
    }
  });

  it('builds avg-rating histograms per threshold, step, and scope from details pages', () => {
    const db = getDb();
    const insertBook = db.prepare(
      'INSERT INTO books (id, title, author, ratings, avg_rating, work_id, is_work_rep, last_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const books: [string, number, number | null, string][] = [
      ['60', 200000, 4.9, 'W60'],
      ['61', 120000, 4.6, 'W61'],
      ['62', 50000, 3.2, 'W62'],
      ['63', 2000, 2.1, 'W63'],
      ['64', 500, 1.5, 'W64'],
      ['65', 200000, 5.0, 'W65'], // no details row: excluded by --hasDetails
      ['66', 200000, null, 'W66'], // details row but no avg rating: excluded
    ];
    for (const [id, ratings, avgRating, workId] of books) {
      insertBook.run(id, `Book ${id}`, `Author ${id}`, ratings, avgRating, workId, 1, '2026-11-11T00:00:00.000Z');
    }
    const insertPage = db.prepare('INSERT INTO book_page (book_id, language, scraped_at) VALUES (?, ?, ?)');
    for (const id of ['60', '61', '62', '63', '64', '66']) {
      insertPage.run(id, 'English', '2026-11-11T00:00:00.000Z');
    }

    try {
      const acc = createAccumulators();
      scanBookPages(acc, 10);
      const english = createAccumulators();
      scanEnglishWorks(english, 10);
      const histogram = (scope: BookScopeId, id: string) => acc[scope].avgRatingHistograms[id];
      const reportId = 'avg-ratings-histogram-min-100k';

      expect(histogram('book-id', reportId).count).toBe(2);
      expect(histogram('book-id', 'avg-ratings-histogram-min-10k').count).toBe(3);
      expect(histogram('book-id', 'avg-ratings-histogram-min-1k').count).toBe(4);
      expect(histogram('works', reportId).count).toBe(2);
      expect(english['works-en'].avgRatingHistograms[reportId].count).toBe(2);

      const buckets = histogram('book-id', reportId).buckets;
      expect(buckets[0.5][9]).toBe(2); // 4.50 to 4.99 holds both 4.6 and 4.9
      expect(buckets[0.2][24]).toBe(1); // 4.80 to 4.99
      expect(buckets[0.2][23]).toBe(1); // 4.60 to 4.79
      expect(buckets[0.1][49]).toBe(1); // 4.90
      expect(buckets[0.1][46]).toBe(1); // 4.60

      const html = renderAvgRatingHistogramPage(BOOK_SCOPES[0], AVG_RATING_HISTOGRAM_REPORTS[0], acc['book-id']);
      for (const step of AVG_RATING_HISTOGRAM_STEPS) {
        expect(html).toContain(`${step.toFixed(1)} star buckets`);
      }
      expect(html).toContain('4.50 to 4.99');
      expect(html).toContain('4.80 to 4.99');
      expect(html).toContain('4.90');
      expect(html).toContain('avgHistogram.sh --hasDetails');
    } finally {
      db.prepare('DELETE FROM book_page WHERE book_id IN (?, ?, ?, ?, ?, ?, ?)').run(
        '60', '61', '62', '63', '64', '65', '66',
      );
      db.prepare('DELETE FROM books WHERE id IN (?, ?, ?, ?, ?, ?, ?)').run('60', '61', '62', '63', '64', '65', '66');
    }
  });

  it('renders publisher tables with the sort metric first', () => {
    const publishers = [
      { publisher: 'Penguin', books: 2, totalRatings: 150000, avgRating: 4.1 },
      { publisher: 'Acme', books: 1, totalRatings: 9000, avgRating: 3.9 },
    ];
    const books = renderPublisherTable(publishers, 'books');
    expect(books).toContain('<th class="num">Books</th><th class="num">Total ratings</th>');
    expect(books.indexOf('Penguin')).toBeLessThan(books.indexOf('Acme'));
    expect(books).toContain('150,000');

    const ratings = renderPublisherTable(publishers, 'totalRatings');
    expect(ratings).toContain('<th class="num">Total ratings</th><th class="num">Books</th>');
    expect(renderPublisherTable([], 'books')).toContain('No publishers matched');
  });

  it('renders field coverage grouped by table', () => {
    const html = renderFieldCoveragePage([
      { table: 'books', field: 'author_id', populated: 3, total: 4, distinct: 2 },
      { table: 'books', field: 'pages', populated: 4, total: 4 },
      { table: 'authors', field: 'slug', populated: 1, total: 2, distinct: 1 },
    ]);
    expect(html).toContain('<h2>books</h2>');
    expect(html).toContain('<h2>authors</h2>');
    expect(html).toContain('<td>author_id</td><td class="num">3</td><td class="num">4</td><td class="num">75.0%</td>');
    expect(html).toContain('<td>pages</td><td class="num">4</td><td class="num">4</td><td class="num">100.0%</td>');
    expect(html).toContain('—');
    expect(renderFieldCoveragePage([])).toContain('No field coverage data');
  });

  it('renders the overall ratings histogram with compact grouped headers', () => {
    const buckets = [
      { label: 'A', min: 2, max: Infinity },
      { label: 'B', min: 1, max: 1 },
      { label: 'C', min: 0, max: 0 },
    ];
    const html = renderOverallRatingsHistogram({
      all: [2, 3, 5],
      work: [0, 0, 0],
      works: [0, 0, 0],
      field: [0, 0, 0],
      worksWithField: [0, 0, 0],
      totalAll: 10,
      totalWork: 0,
      totalWorks: 0,
      totalField: 0,
      totalWorksWithField: 0,
    }, buckets);
    expect(html).toContain('<th rowspan="2">Rating bracket</th>');
    expect(html).toContain('<th colspan="2" class="num" title="every cached book">ALL</th>');
    expect(html).toContain('>WORK+FIELD</th>');
    expect(html).toContain('↑ = rollup (this bracket and above)');
    expect(html).toContain('<tr><td>A</td><td class="num">2</td><td class="num">2</td><td class="num zero">0</td>');
    expect(html).toContain('<tr><td>B</td><td class="num">3</td><td class="num">5</td>');
    expect(html).toContain('<tr><td>C</td><td class="num">5</td><td class="num">10</td>');
    expect(html).toContain('<tr class="total"><td>Total</td><td class="num">10</td><td class="num">10</td>');
  });

  it('builds the publication-year summary like summary-year', () => {
    const summary = buildPublicationYearSummary([
      { published: '2024' },
      { published: 'January 1, 2008' },
      { published: '2008' },
      { published: '2024.05.01' },
      { published: 'circa 1999?' },
      { published: 'Unknown' },
      { published: '' },
      { published: null },
      { published: 'someday' },
      { published: 'zzz' },
    ]);

    expect(summary.years).toEqual([
      { year: 1999, count: 1 },
      { year: 2008, count: 2 },
      { year: 2024, count: 2 },
    ]);
    expect(summary.unknown).toBe(3);
    expect(summary.other).toEqual([
      { label: 'someday', count: 1 },
      { label: 'zzz', count: 1 },
    ]);
    expect(summary.total).toBe(10);
  });

  it('renders publication years with tallies, unparseable labels, and a total', () => {
    const summary = buildPublicationYearSummary([
      { published: '2008' },
      { published: '2008' },
      { published: '2024' },
      { published: 'Unknown' },
      { published: 'someday' },
    ]);
    const html = renderPublicationYearsPage(summary);
    expect(html).toContain('<td class="num">2008</td><td class="num">2</td>');
    expect(html).toContain('<td class="num">2024</td><td class="num">1</td>');
    expect(html).toContain('<td>Unknown</td><td class="num">1</td>');
    expect(html).toContain('<td>someday</td><td class="num">1</td>');
    expect(html).toContain('Total books in cache</td><td class="num">5</td>');
  });

  it('builds books-added buckets from books.first_seen like books-added-histogram', () => {
    const db = getDb();
    const ins = db.prepare(
      'INSERT INTO books (id, title, author, ratings, first_seen, last_updated) VALUES (?, ?, ?, ?, ?, ?)',
    );
    ins.run('ba0', 'Old', 'X', 10, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    ins.run('ba1', 'A', 'X', 100, '2026-09-05T01:00:00.000Z', '2026-09-05T01:00:00.000Z');
    ins.run('ba2', 'B', 'X', 300, '2026-09-05T23:00:00.000Z', '2026-09-05T23:00:00.000Z');
    ins.run('ba3', 'C', 'X', 50, '2026-09-06T12:00:00.000Z', '2026-09-06T12:00:00.000Z');
    ins.run('ba4', 'D', 'X', 900, '2026-09-07T12:00:00.000Z', '2026-09-07T12:00:00.000Z');

    try {
      const summary = loadBooksAddedBuckets({ days: 3, todayIso: '2026-09-07' });
      expect(summary.unit).toBe('day');
      expect(summary.buckets.map((b) => b.label)).toEqual(['2026-09-05', '2026-09-06', '2026-09-07']);
      expect(summary.buckets[0]).toMatchObject({ added: 2, avgRatings: 200, maxRatings: 300 });
      expect(summary.buckets[1]).toMatchObject({ added: 1, avgRatings: 50, maxRatings: 50 });
      expect(summary.buckets[2]).toMatchObject({ added: 1, avgRatings: 900, maxRatings: 900 });
      expect(summary.addedInWindow).toBe(4);
      expect(summary.totalBooks).toBe((db.prepare('SELECT COUNT(*) AS c FROM books').get() as any).c);
      expect(summary.buckets[summary.buckets.length - 1].total - summary.beforeWindow).toBe(4);
      expect(summary.missingFirstSeen).toBe(
        (db.prepare("SELECT COUNT(*) AS c FROM books WHERE first_seen IS NULL OR first_seen = ''").get() as any).c,
      );
      expect(BOOKS_ADDED_DAYS).toBe(1000);
    } finally {
      db.prepare("DELETE FROM books WHERE id IN ('ba0', 'ba1', 'ba2', 'ba3', 'ba4')").run();
    }
  });

  it('renders the books-added page with daily columns and footer notes', () => {
    const html = renderBooksAddedPage({
      unit: 'day',
      buckets: [
        { label: '2026-09-04', start: '2026-09-04', end: '2026-09-04', added: 0, total: 0, avgRatings: 0, maxRatings: 0 },
        { label: '2026-09-05', start: '2026-09-05', end: '2026-09-05', added: 2, total: 3, avgRatings: 200, maxRatings: 300 },
        { label: '2026-09-06', start: '2026-09-06', end: '2026-09-06', added: 0, total: 3, avgRatings: 0, maxRatings: 0 },
      ],
      totalBooks: 5,
      missingFirstSeen: 1,
      beforeWindow: 1,
      addedInWindow: 2,
      earliestFirstSeen: '2026-09-01T00:00:00.000Z',
    });
    expect(html).toContain('id="books-added"');
    expect(html).not.toContain('<td>2026-09-04</td>');
    expect(html).toContain(
      '<td>2026-09-05</td><td class="num">2</td><td class="num">3</td><td class="num">60.0%</td><td class="num">200</td><td class="num">300</td>',
    );
    expect(html).toContain(
      '<td>2026-09-06</td><td class="num">0</td><td class="num">3</td><td class="num">60.0%</td><td class="num">—</td><td class="num">—</td>',
    );
    expect(html).toContain('2 added in the window');
    expect(html).toContain('1 predate the window');
    expect(html).toContain('First-seen unknown for 1 books');
    expect(html).toContain('last_updated - 1 day');
  });

  it('builds authors-added buckets from authors.first_seen like authorHist --by day', () => {
    const db = getDb();
    const ins = db.prepare(
      'INSERT INTO authors (id, name, slug, last_seen, average_rating, num_ratings, first_seen) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    ins.run('aa0', 'Old', 'old', '2031-02-25T00:00:00.000Z', 4.0, 999, '2031-02-25T00:00:00.000Z');
    ins.run('aa1', 'A', 'a', '2031-03-01T01:00:00.000Z', 4.1, 100, '2031-03-01T01:00:00.000Z');
    ins.run('aa2', 'B', 'b', '2031-03-01T23:00:00.000Z', 4.2, 300, '2031-03-01T23:00:00.000Z');
    ins.run('aa3', 'C', 'c', '2031-03-02T12:00:00.000Z', 4.3, 50, '2031-03-02T12:00:00.000Z');
    ins.run('aa4', 'D', 'd', '2031-03-03T12:00:00.000Z', 4.4, 900, '2031-03-03T12:00:00.000Z');

    try {
      const summary = loadAuthorArrivalBuckets({ start: '2031-03-01', end: '2031-03-03' });
      expect(summary.buckets.map((b) => b.label)).toEqual(['2031-03-01', '2031-03-02', '2031-03-03']);
      expect(summary.buckets[0]).toMatchObject({ added: 2, total: 3, avgRatings: 200, maxRatings: 300 });
      expect(summary.buckets[1]).toMatchObject({ added: 1, total: 4, avgRatings: 50, maxRatings: 50 });
      expect(summary.buckets[2]).toMatchObject({ added: 1, total: 5, avgRatings: 900, maxRatings: 900 });
      expect(summary.addedInWindow).toBe(4);
      expect(summary.beforeWindow).toBe(1);
      expect(summary.totalAuthors).toBe((db.prepare('SELECT COUNT(*) AS c FROM authors').get() as any).c);
      expect(summary.missingFirstSeen).toBe(
        (db.prepare("SELECT COUNT(*) AS c FROM authors WHERE first_seen IS NULL OR first_seen = ''").get() as any).c,
      );
      expect(summary.earliestFirstSeen).toBe('2031-02-25T00:00:00.000Z');
    } finally {
      db.prepare("DELETE FROM authors WHERE id IN ('aa0', 'aa1', 'aa2', 'aa3', 'aa4')").run();
    }
  });

  it('renders the authors-added page with daily columns and footer notes', () => {
    const html = renderAuthorsAddedPage({
      buckets: [
        { label: '2031-03-01', added: 2, total: 3, avgRatings: 200, maxRatings: 300 },
        { label: '2031-03-02', added: 0, total: 3, avgRatings: 0, maxRatings: 0 },
      ],
      totalAuthors: 5,
      missingFirstSeen: 1,
      beforeWindow: 1,
      addedInWindow: 2,
      earliestFirstSeen: '2031-02-25T00:00:00.000Z',
    });
    expect(html).toContain('id="authors-added"');
    expect(html).toContain('<th class="num">Added</th>');
    expect(html).toContain(
      '<td>2031-03-01</td><td class="num">2</td><td class="num">3</td><td class="num">60.0%</td><td class="num">200</td><td class="num">300</td>',
    );
    expect(html).toContain(
      '<td>2031-03-02</td><td class="num">0</td><td class="num">3</td><td class="num">60.0%</td><td class="num">—</td><td class="num">—</td>',
    );
    expect(html).toContain('Total authors in DB: 5');
    expect(html).toContain('2 added in the window');
    expect(html).toContain('1 predate the window');
    expect(html).toContain('First-seen unknown for 1 authors');
    expect(html).toContain('2031-02-25T00:00:00.000Z');
    expect(html).toContain('last_seen - 1 day');
  });

  it('renders frequency rows with shares', () => {
    const html = renderFrequencyPage('Based on 2 books.', [{ label: 'English', count: 2 }], 2, 'Language');
    expect(html).toContain('English');
    expect(html).toContain('100.0%');
  });

  it('renders the page-count histogram with fixed buckets', () => {
    const html = renderPageCountPage(new Map([[320, 10], [100, 5]]));
    expect(html).toContain('Based on 15 books with a page count.');
    expect(html).toContain('<td>76-100</td><td class="num">5</td>');
    expect(html).toContain('<td>301-350</td><td class="num">10</td>');
    expect(html).toContain('66.7%');
    expect(html).not.toContain('data-sort');
  });

  it('writes files atomically without leaving temp files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-atomic-'));
    try {
      const file = path.join(dir, 'nested', 'page.html');
      writeFileAtomic(file, 'one');
      expect(fs.readFileSync(file, 'utf8')).toBe('one');
      writeFileAtomic(file, 'two');
      expect(fs.readFileSync(file, 'utf8')).toBe('two');
      const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp-'));
      expect(leftovers).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('publishes index, author, book, book-detail, and list pages end to end', async () => {
    const db = getDb();

    const insertAuthor = db.prepare(
      'INSERT INTO authors (id, name, slug, last_seen, average_rating, num_ratings, num_reviews, num_shelves, catalog_pages) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insertAuthor.run('1', 'Alice', '1.Alice', '2026-11-11T00:00:00.000Z', 4.5, 1000, 10, 20, 3);
    insertAuthor.run('2', 'Bob', '2.Bob', '2026-11-11T00:00:00.000Z', 4.9, 500000, 5, 30, 4);
    insertAuthor.run('3', 'Carol', '3.Carol', '2026-11-11T00:00:00.000Z', 3.0, 20000, 5, 15, 2);

    const insertBook = db.prepare(
      'INSERT INTO books (id, title, author, author_id, ratings, avg_rating, work_id, is_work_rep, pages, last_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insertBook.run('10', 'Alpha', 'Author A', '1', 150000, 4.5, 'W1', 1, 320, '2026-11-11T00:00:00.000Z');
    insertBook.run('11', 'Beta', 'Author B', '2', 2000, 4.2, 'W1', 0, 100, '2026-11-11T00:00:00.000Z');
    insertBook.run('12', 'Gamma', 'Author C', null, 100, 3.0, null, 0, 200, '2026-11-11T00:00:00.000Z');

    const insertYearBook = db.prepare(
      'INSERT INTO books (id, title, author, author_id, ratings, avg_rating, published, is_bad, last_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insertYearBook.run('20', 'Year C', 'Author YC', '1', 9000, 4.9, '2024', 0, '2026-11-11T00:00:00.000Z');
    insertYearBook.run('21', 'Year A', 'Author YA', null, 5000, 4.8, '2024', 0, '2026-11-11T00:00:00.000Z');
    insertYearBook.run('22', 'Year B', 'Author YB', null, 2000, 4.8, '2024', 0, '2026-11-11T00:00:00.000Z');
    insertYearBook.run('23', 'Year Bad', 'Author YBad', null, 5000, 4.99, '2024', 1, '2026-11-11T00:00:00.000Z');
    insertYearBook.run('24', 'Year Low Ratings', 'Author YLow', null, 500, 5.0, '2024', 0, '2026-11-11T00:00:00.000Z');
    insertYearBook.run('25', 'Year Old', 'Author YOld', null, 5000, 4.9, '1999', 0, '2026-11-11T00:00:00.000Z');

    const insertDetail = db.prepare(
      'INSERT INTO book_page (book_id, publisher, reviews_count, currently_reading, to_read, editions_count, language, format, ratings_skewness, ratings_variance, ratings_kurtosis, scraped_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insertDetail.run('10', 'Penguin', '250,000', 1234, 5678, 12, 'English', 'Hardcover', 3.5, 2.25, -0.5, '2026-11-11T00:00:00.000Z');
    insertDetail.run('12', 'Acme', '5', 0, 10, 1, 'French', 'Paperback', null, null, null, '2026-11-11T00:00:00.000Z');

    const insertListMeta = db.prepare(
      'INSERT INTO list_meta (list_id, num_books, num_voters, created_at, creator_id, creator_name, num_likes, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insertListMeta.run('100', 500, 100, '2010-01-01', '1', 'Alice', 20, '2026-11-11T00:00:00.000Z', '2026-11-11T00:00:00.000Z');
    insertListMeta.run('200', 10, 5, '2020-01-01', '1', 'Alice', null, '2026-11-11T00:00:00.000Z', '2026-11-11T00:00:00.000Z');
    insertListMeta.run('300', 50, 10, '2015-06-01', null, 'deleted user', 3, '2026-11-11T00:00:00.000Z', '2026-11-11T00:00:00.000Z');

    const insertListScrape = db.prepare(
      'INSERT INTO list_scrapes (list_id, list_name, first_scraped, last_scraped, num_scraped, num_books_scraped) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insertListScrape.run('100', 'Big List', '2026-11-11T00:00:00.000Z', '2026-11-11T00:00:00.000Z', 1, 500);
    insertListScrape.run('200', 'New List', '2026-11-11T00:00:00.000Z', '2026-11-11T00:00:00.000Z', 1, 10);
    insertListScrape.run('300', 'No Creator List', '2026-11-11T00:00:00.000Z', '2026-11-11T00:00:00.000Z', 1, 50);

    const insertListTag = db.prepare(
      'INSERT INTO list_tags (list_id, tag_name, first_seen, last_seen, from_sidebar, from_directory) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insertListTag.run('100', 'horror', '2026-11-11T00:00:00.000Z', '2026-11-11T00:00:00.000Z', 1, 0);
    insertListTag.run('200', 'horror', '2026-11-11T00:00:00.000Z', '2026-11-11T00:00:00.000Z', 1, 0);
    insertListTag.run('100', 'romance', '2026-11-11T00:00:00.000Z', '2026-11-11T00:00:00.000Z', 1, 0);
    insertListTag.run('100', 'alpha', '2026-11-11T00:00:00.000Z', '2026-11-11T00:00:00.000Z', 1, 0);

    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-e2e-'));
    const read = (relative: string): string => fs.readFileSync(path.join(out, relative), 'utf8');

    try {
      await runPublishSite({ out, limit: '10' });

      expect(fs.existsSync(path.join(out, 'index.html'))).toBe(true);

      const avgHistogram = read('book-id/avg-ratings-histogram-min-100k.html');
      for (const step of AVG_RATING_HISTOGRAM_STEPS) {
        expect(avgHistogram).toContain(`${step.toFixed(1)} star buckets`);
      }

      const ratings = read('author/top-authors-by-ratings.html');
      expect(ratings).toContain('https://www.goodreads.com/author/show/2');
      expect(ratings).toContain('Bob');
      expect(ratings.indexOf('Bob')).toBeLessThan(ratings.indexOf('Alice'));

      const avg100k = read('author/top-authors-by-avg-rating-min-100k.html');
      expect(avg100k).toContain('Bob');
      expect(avg100k).not.toContain('Alice');

      const bookRatings = read('book-id/ratings.html');
      expect(bookRatings).toContain('Alpha');
      expect(bookRatings.indexOf('Alpha')).toBeLessThan(bookRatings.indexOf('Beta'));
      expect(bookRatings.indexOf('Beta')).toBeLessThan(bookRatings.indexOf('Gamma'));
      expect(bookRatings).toContain('150,000');
      expect(bookRatings).toContain('https://www.goodreads.com/author/show/1');

      const workIdRatings = read('work-id/ratings.html');
      expect(workIdRatings).toContain('Alpha');
      expect(workIdRatings).toContain('Beta');
      expect(workIdRatings).not.toContain('Gamma');
      expect(workIdRatings).toContain('https://www.goodreads.com/work/editions/W1');

      const worksRatings = read('works/ratings.html');
      expect(worksRatings).toContain('Alpha');
      expect(worksRatings).not.toContain('Beta');
      expect(worksRatings).toContain('https://www.goodreads.com/author/show/1');
      expect(worksRatings).toContain('href="../works-en/ratings.html"');
      expect(worksRatings).toContain('<strong>All languages</strong>');

      const worksEnRatings = read('works-en/ratings.html');
      expect(worksEnRatings).toContain('Alpha');
      expect(worksEnRatings).not.toContain('Beta');
      expect(worksEnRatings).toContain('href="../works/ratings.html"');
      expect(worksEnRatings).toContain('<strong>English only</strong>');

      const bookAvg100k = read('book-id/highest-avg-rating-min-100k.html');
      expect(bookAvg100k).toContain('Alpha');
      expect(bookAvg100k).toContain('4.50');
      expect(bookAvg100k).not.toContain('Gamma');

      const avg10k = read('book-id/highest-avg-rating-min-10k.html');
      expect(avg10k).toContain('Alpha');
      expect(avg10k).not.toContain('Gamma');

      const lowAvg = read('book-id/lowest-avg-rating-min-10k.html');
      expect(lowAvg).toContain('Alpha');
      expect(lowAvg).not.toContain('Gamma');

      const worksEnAvg = read('works-en/highest-avg-rating-min-100k.html');
      expect(worksEnAvg).toContain('Alpha');
      expect(worksEnAvg).toContain('4.50');

      const topAvg1k = read('book-id/highest-avg-rating-min-1k.html');
      expect(topAvg1k).toContain('Alpha');
      expect(topAvg1k).toContain('4.50');
      expect(topAvg1k).not.toContain('Beta');

      const worksEnLowAvg1k = read('works-en/lowest-avg-rating-min-1k.html');
      expect(worksEnLowAvg1k).toContain('Alpha');
      expect(worksEnLowAvg1k).toContain('<strong>English only</strong>');

      const bottomAuthors = read('author/bottom-authors-by-avg-rating-min-10k.html');
      expect(bottomAuthors.indexOf('Carol')).toBeLessThan(bottomAuthors.indexOf('Bob'));
      expect(bottomAuthors).not.toContain('Alice');
      expect(bottomAuthors).toContain('3.00');
      expect(bottomAuthors).toContain('4.90');

      const topAuthors1k = read('author/top-authors-by-avg-rating-min-1k.html');
      expect(topAuthors1k).toContain('Bob');
      expect(topAuthors1k).toContain('Alice');
      expect(topAuthors1k).toContain('Carol');
      expect(topAuthors1k.indexOf('Bob')).toBeLessThan(topAuthors1k.indexOf('Alice'));

      const bottomAuthors1k = read('author/bottom-authors-by-avg-rating-min-1k.html');
      expect(bottomAuthors1k.indexOf('Carol')).toBeLessThan(bottomAuthors1k.indexOf('Alice'));
      expect(bottomAuthors1k.indexOf('Alice')).toBeLessThan(bottomAuthors1k.indexOf('Bob'));

      const reviews = read('book-id/reviews.html');
      expect(reviews).toContain('Based on 2 books with reviews data (of 9 Book IDs in scope).');
      expect(reviews).toContain('Alpha');
      expect(reviews).toContain('250,000');

      const skewness = read('book-id/highest-skewness-min-100k.html');
      expect(skewness).toContain('Alpha');
      expect(skewness).toContain('3.5000');
      expect(skewness).toContain('150,000');
      expect(skewness).not.toContain('Gamma');

      const variance = read('book-id/highest-variance-min-100k.html');
      expect(variance).toContain('Alpha');
      expect(variance).toContain('2.2500');

      const kurtosis = read('book-id/lowest-kurtosis-min-100k.html');
      expect(kurtosis).toContain('Alpha');
      expect(kurtosis).toContain('-0.5000');

      const skewness10k = read('book-id/highest-skewness-min-10k.html');
      expect(skewness10k).toContain('Alpha');
      expect(skewness10k).toContain('3.5000');

      const variance10k = read('work-id/highest-variance-min-10k.html');
      expect(variance10k).toContain('Alpha');
      expect(variance10k).toContain('https://www.goodreads.com/work/editions/W1');

      const kurtosis10k = read('works/lowest-kurtosis-min-10k.html');
      expect(kurtosis10k).toContain('Alpha');
      expect(kurtosis10k).toContain('-0.5000');

      const reviewRatio = read('book-id/highest-review-ratio-min-1k.html');
      expect(reviewRatio).toContain('Alpha');
      expect(reviewRatio).toContain('1.667');
      expect(reviewRatio).toContain('<th class="num">Reviews</th>');
      expect(reviewRatio).not.toContain('Gamma');

      const workSkewness = read('work-id/highest-skewness-min-100k.html');
      expect(workSkewness).toContain('Alpha');
      expect(workSkewness).toContain('https://www.goodreads.com/work/editions/W1');
      const worksSkewness = read('works/highest-skewness-min-100k.html');
      expect(worksSkewness).toContain('Alpha');

      const languages = read('book-detail/by-language.html');
      expect(languages).toContain('English');
      expect(languages).toContain('French');

      const pageCounts = read('book-detail/by-page-count.html');
      expect(pageCounts).toContain('books with a page count.');
      expect(pageCounts).toContain('<th>Pages</th><th class="num">Books</th><th class="num">Share</th>');
      expect(pageCounts).toContain('<td>301-350</td><td class="num">1</td>');
      expect(pageCounts).not.toContain('data-sort="page"');

      const publisherBooks = read('book-detail/publishers-most-books.html');
      expect(publisherBooks).toContain('<th class="num">Books</th><th class="num">Total ratings</th>');
      expect(publisherBooks).toContain('Penguin');
      expect(publisherBooks).toContain('Acme');
      expect(publisherBooks.indexOf('Penguin')).toBeLessThan(publisherBooks.indexOf('Acme'));
      expect(publisherBooks).toContain('150,000');

      const publisherRatings = read('book-detail/publishers-most-ratings.html');
      expect(publisherRatings).toContain('<th class="num">Total ratings</th><th class="num">Books</th>');
      expect(publisherRatings.indexOf('Penguin')).toBeLessThan(publisherRatings.indexOf('Acme'));

      const mostBooks = read('lists/most-books.html');
      expect(mostBooks).toContain('https://www.goodreads.com/list/show/100');
      expect(mostBooks).toContain('https://www.goodreads.com/list/created/1');
      expect(mostBooks.indexOf('Big List')).toBeLessThan(mostBooks.indexOf('No Creator List'));
      expect(mostBooks.indexOf('No Creator List')).toBeLessThan(mostBooks.indexOf('New List'));

      const mostLikes = read('lists/most-likes.html');
      expect(mostLikes).toContain('Based on 2 lists with likes data (of 3 lists).');
      expect(mostLikes).toContain('Big List');

      const earliest = read('lists/earliest-created.html');
      expect(earliest.indexOf('Big List')).toBeLessThan(earliest.indexOf('No Creator List'));

      const latest = read('lists/latest-created.html');
      expect(latest.indexOf('New List')).toBeLessThan(latest.indexOf('Big List'));

      const creators = read('lists/creators-most-lists.html');
      expect(creators).toContain('Alice');
      expect(creators).toContain('https://www.goodreads.com/list/created/1');
      expect(creators).toContain('<td class="num">2</td>');
      expect(creators).not.toContain('deleted user');
      expect(creators).toContain('data-sort="lists"');
      expect(creators).toContain('data-sort="books"');
      expect(creators).toContain('data-sort="voters"');
      expect(creators).toContain('data-sort="likes"');
      expect(creators).toContain("querySelector('#list-creators')");

      const year2024 = read('year/2024.html');
      expect(year2024).toContain('https://www.goodreads.com/book/show/20');
      expect(year2024).toContain('https://www.goodreads.com/author/show/1');
      expect(year2024).toContain('rel="noopener noreferrer">Author YC</a>');
      expect(year2024).toContain('<td>Author YA</td>');
      expect(year2024.indexOf('Year C')).toBeLessThan(year2024.indexOf('Year A'));
      expect(year2024.indexOf('Year A')).toBeLessThan(year2024.indexOf('Year B'));
      expect(year2024).not.toContain('Year Bad');
      expect(year2024).not.toContain('Year Low Ratings');
      expect(year2024).not.toContain('Year Old');
      expect(year2024).toContain('4.90');
      expect(year2024).toContain('9,000');

      const year2026 = read('year/2026.html');
      expect(year2026).toContain('No books matched');

      const firstChar = read('titles/first-char.html');
      expect(firstChar).toContain('characters with at least 1,000 books');
      expect(firstChar).not.toContain('<td>A</td>');

      const firstWord = read('titles/first-word.html');
      expect(firstWord).toContain('Top 4 first words across 9 books.');
      expect(firstWord.indexOf('year') < firstWord.indexOf('alpha')).toBe(true);
      expect(firstWord).toContain('<a href="https://www.goodreads.com/list/tag/alpha" target="_blank" rel="noopener noreferrer">alpha</a>');
      expect(firstWord).toContain('<td>year</td>');

      const listTags = read('lists/top-list-tags.html');
      expect(listTags).toContain('https://www.goodreads.com/list/tag/horror');
      expect(listTags).toContain('https://www.goodreads.com/list/tag/romance');
      expect(listTags.indexOf('horror')).toBeLessThan(listTags.indexOf('romance'));
      expect(listTags).toContain('>horror</a></td><td class="num">2</td>');

      const perField = read('per-field.html');
      expect(perField).toContain('<h2>books</h2>');
      expect(perField).toContain('<h2>book_page</h2>');
      expect(perField).toContain('<td>author_id</td>');
      expect(perField).toContain('<td>publisher</td>');
      expect(perField).toContain('100.0%');

      const ratingsHistogram = read('ratings-histogram.html');
      expect(ratingsHistogram).toContain('id="ratings-histogram"');
      expect(ratingsHistogram).toContain('<th rowspan="2">Rating bracket</th>');
      expect(ratingsHistogram).toContain('>WORK+FIELD</th>');
      expect(ratingsHistogram).toContain(
        '<tr class="total"><td>Total</td><td class="num">9</td><td class="num">9</td><td class="num">2</td><td class="num">2</td><td class="num">1</td><td class="num">1</td><td class="num">2</td><td class="num">2</td><td class="num">1</td><td class="num">1</td></tr>',
      );

      const booksAdded = read('books-added.html');
      expect(booksAdded).toContain('id="books-added"');
      expect(booksAdded).toContain('Total books in DB:');

      const authorsAdded = read('authors-added.html');
      expect(authorsAdded).toContain('id="authors-added"');
      expect(authorsAdded).toContain('Total authors in DB:');
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
      db.prepare('DELETE FROM book_page WHERE book_id IN (?, ?)').run('10', '12');
      db.prepare('DELETE FROM books WHERE id IN (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        '10',
        '11',
        '12',
        '20',
        '21',
        '22',
        '23',
        '24',
        '25',
      );
      db.prepare('DELETE FROM authors WHERE id IN (?, ?, ?)').run('1', '2', '3');
      db.prepare('DELETE FROM list_meta WHERE list_id IN (?, ?, ?)').run('100', '200', '300');
      db.prepare('DELETE FROM list_scrapes WHERE list_id IN (?, ?, ?)').run('100', '200', '300');
      db.prepare('DELETE FROM list_tags WHERE list_id IN (?, ?, ?)').run('100', '200', '300');
    }
  });

  it('dedupes Highest Rated by Year to one edition per work', () => {
    const db = getDb();
    const insert = db.prepare(
      'INSERT INTO books (id, title, author, author_id, ratings, avg_rating, published, is_bad, work_id, last_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const stamp = '2026-11-11T00:00:00.000Z';
    // Same work_id: the higher-ratings edition survives.
    insert.run('30', 'Shared Work', 'Author S', '7', 5000, 4.9, '2023', 0, 'W9', stamp);
    insert.run('31', 'Shared Work', 'Author S', '7', 9000, 4.8, '2023', 0, 'W9', stamp);
    // Same work_id and ratings: lower numeric id wins.
    insert.run('32', 'Tie Work', 'Author T', '8', 6000, 4.7, '2023', 0, 'W8', stamp);
    insert.run('33', 'Tie Work', 'Author T', '8', 6000, 4.7, '2023', 0, 'W8', stamp);
    // No work_id: normalized title + author collapses editions.
    insert.run('40', 'No Work Edition', 'Author N', '9', 4000, 4.6, '2023', 0, null, stamp);
    insert.run('41', 'No Work Edition', 'Author N', '9', 7000, 4.5, '2023', 0, null, stamp);
    // Same title but a different author is a different work.
    insert.run('42', 'No Work Edition', 'Author O', '10', 3000, 4.4, '2023', 0, null, stamp);

    try {
      const yearHeaps = new Map<number, YearBook[]>();
      scanBooks(createAccumulators(), new Map(), 10, yearHeaps);
      const ids = (yearHeaps.get(2023) ?? []).map((book) => book.id).sort();
      expect(ids).toEqual(['31', '32', '41', '42']);
      expect((yearHeaps.get(2023) ?? []).find((book) => book.id === '31')?.authorId).toBe('7');
    } finally {
      db.prepare('DELETE FROM books WHERE id IN (?, ?, ?, ?, ?, ?, ?)').run(
        '30',
        '31',
        '32',
        '33',
        '40',
        '41',
        '42',
      );
    }
  });
});
