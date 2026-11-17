import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { iterateAuthors, streamRows } from './storage.ts';
import { getDb } from './db.ts';
import { selectAuthors, type SelectedAuthor } from './authorTopStats.ts';
import { computePublisherCatalog, loadPublisherRows, type RankedPublisher } from './publisherCatalog.ts';
import { getYear, stripTitleSuffix } from './utils.ts';
import { extractFirstWord } from './titleFirstWordHistogram.ts';
import { buildRatingBuckets, loadCoverageCounts, type CoverageCounts, type RatingBucket } from './summaryHistogram.ts';
import { loadBooksAddedBuckets, type BooksAddedSummary } from './booksAddedHistogram.ts';
import { loadAuthorArrivalBuckets, type AuthorArrivalSummary } from './authorArrivalHistogram.ts';
import { loadAuthorTopBookHistogram, type AuthorTopBookHistogramData } from './authorTopBookHistogram.ts';
import { loadTagFirstPagePicks, TAG_FIRST_PAGE_LIMIT, type TagFirstPagePickRow } from './tagFirstPagePicks.ts';

// Static HTML publishing: render DB reports to a local directory of plain
// files. See PLAN-static-publish.md for the full spec. Pages are built in
// memory first and then written one at a time via writeFileAtomic(), so a
// regeneration never takes the site down and never leaves a half-written file.

export type AuthorReportField =
  | 'numRatings'
  | 'numReviews'
  | 'numShelves'
  | 'catalogPages'
  | 'averageRating';

export interface AuthorReport {
  // Path id relative to the output root, e.g. 'author/top-authors-by-ratings'.
  id: string;
  title: string;
  sortBy: AuthorReportField;
  minRatings: number;
  // Defaults to 'desc'. Bottom reports sort ascending by the metric.
  direction?: 'asc' | 'desc';
}

export const AUTHOR_REPORTS: AuthorReport[] = [
  { id: 'author/top-authors-by-ratings', title: 'Top Authors by Ratings', sortBy: 'numRatings', minRatings: 0 },
  { id: 'author/top-authors-by-reviews', title: 'Top Authors by Reviews', sortBy: 'numReviews', minRatings: 0 },
  { id: 'author/top-authors-by-shelves', title: 'Top Authors by Shelves', sortBy: 'numShelves', minRatings: 0 },
  { id: 'author/top-authors-by-catalog-pages', title: 'Top Authors by Catalog Pages', sortBy: 'catalogPages', minRatings: 0 },
  { id: 'author/top-authors-by-avg-rating-min-100k', title: 'Top Authors by Avg Rating (min 100k ratings)', sortBy: 'averageRating', minRatings: 100000 },
  { id: 'author/top-authors-by-avg-rating-min-10k', title: 'Top Authors by Avg Rating (min 10k ratings)', sortBy: 'averageRating', minRatings: 10000 },
  { id: 'author/top-authors-by-avg-rating-min-1k', title: 'Top Authors by Avg Rating (min 1k ratings)', sortBy: 'averageRating', minRatings: 1000 },
  {
    id: 'author/bottom-authors-by-avg-rating-min-10k',
    title: 'Bottom Authors by Avg Rating (min 10k ratings)',
    sortBy: 'averageRating',
    minRatings: 10000,
    direction: 'asc',
  },
  {
    id: 'author/bottom-authors-by-avg-rating-min-1k',
    title: 'Bottom Authors by Avg Rating (min 1k ratings)',
    sortBy: 'averageRating',
    minRatings: 1000,
    direction: 'asc',
  },
];

export const AUTHOR_TOP_BOOK_HISTOGRAM_REPORT = {
  id: 'author/top-book-ratings-histogram',
  title: 'Author Top-Book Ratings Histogram',
  navLabel: 'Top-Book Ratings Histogram',
} as const;

export interface PublishOptions {
  out?: string;
  limit?: string;
}

export interface NavItem {
  id: string;
  label: string;
  href: string;
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

const AUTHOR_FIELDS: { field: AuthorReportField; label: string }[] = [
  { field: 'numRatings', label: 'Ratings' },
  { field: 'numReviews', label: 'Reviews' },
  { field: 'numShelves', label: 'Shelves' },
  { field: 'catalogPages', label: 'Catalog pages' },
  { field: 'averageRating', label: 'Avg rating' },
];

// ---------------------------------------------------------------------------
// Book sections: Book ID (all books), Work ID (books with a work_id), Works
// (one representative edition per work).
// ---------------------------------------------------------------------------

export type BookScopeId = 'book-id' | 'work-id' | 'works' | 'works-en';

export interface BookScope {
  id: BookScopeId;
  label: string;
}

export const BOOK_SCOPES: BookScope[] = [
  { id: 'book-id', label: 'Book ID' },
  { id: 'work-id', label: 'Work ID' },
  { id: 'works', label: 'Works' },
  { id: 'works-en', label: 'Works (English)' },
];

export type BookMetricId = 'ratings' | 'reviews' | 'currently-reading' | 'to-read' | 'edition-count';

export interface Bucket {
  label: string;
  min: number;
  max: number;
}

export interface BookMetric {
  id: BookMetricId;
  label: string;
  navLabel: string;
  source: 'books' | 'book_page';
  column: string;
  buckets: Bucket[];
}

const COUNT_BUCKETS: Bucket[] = [
  { label: '0', min: 0, max: 0 },
  { label: '1–9', min: 1, max: 9 },
  { label: '10–99', min: 10, max: 99 },
  { label: '100–999', min: 100, max: 999 },
  { label: '1,000–9,999', min: 1000, max: 9999 },
  { label: '10,000–99,999', min: 10000, max: 99999 },
  { label: '100,000–999,999', min: 100000, max: 999999 },
  { label: '1,000,000+', min: 1000000, max: Number.POSITIVE_INFINITY },
];

const EDITION_BUCKETS: Bucket[] = [
  { label: '0', min: 0, max: 0 },
  { label: '1', min: 1, max: 1 },
  { label: '2', min: 2, max: 2 },
  { label: '3–5', min: 3, max: 5 },
  { label: '6–10', min: 6, max: 10 },
  { label: '11–20', min: 11, max: 20 },
  { label: '21–50', min: 21, max: 50 },
  { label: '51+', min: 51, max: Number.POSITIVE_INFINITY },
];

export const BOOK_METRICS: BookMetric[] = [
  { id: 'ratings', label: 'Ratings', navLabel: 'Top by Ratings', source: 'books', column: 'ratings', buckets: COUNT_BUCKETS },
  { id: 'reviews', label: 'Reviews', navLabel: 'Top by Reviews', source: 'book_page', column: 'reviews_count', buckets: COUNT_BUCKETS },
  { id: 'currently-reading', label: 'Currently reading', navLabel: 'Top by Currently Reading', source: 'book_page', column: 'currently_reading', buckets: COUNT_BUCKETS },
  { id: 'to-read', label: 'To read', navLabel: 'Top by To Read', source: 'book_page', column: 'to_read', buckets: COUNT_BUCKETS },
  { id: 'edition-count', label: 'Editions', navLabel: 'Top by Edition Count', source: 'book_page', column: 'editions_count', buckets: EDITION_BUCKETS },
];

export type DerivedReportId =
  | 'highest-skewness-min-100k'
  | 'highest-skewness-min-10k'
  | 'highest-variance-min-100k'
  | 'highest-variance-min-10k'
  | 'lowest-kurtosis-min-100k'
  | 'lowest-kurtosis-min-10k'
  | 'highest-review-ratio-min-1k'
  | 'highest-avg-rating-min-100k'
  | 'highest-avg-rating-min-10k'
  | 'highest-avg-rating-min-1k'
  | 'lowest-avg-rating-min-10k'
  | 'lowest-avg-rating-min-1k';

export type DerivedReportKind = 'skewness' | 'variance' | 'kurtosis' | 'review-ratio' | 'avg-rating';

export interface DerivedReport {
  id: DerivedReportId;
  title: string;
  navLabel: string;
  kind: DerivedReportKind;
  dataLabel: string;
  valueLabel: string;
  minRatings: number;
  direction: 'asc' | 'desc';
}

// Top-N tables over the book_page.ratings_dist derived columns (plus the
// reviews/ratings ratio). These have no histogram: continuous stats do not fit
// the count-bucket scheme.
export const DERIVED_REPORTS: DerivedReport[] = [
  {
    id: 'highest-skewness-min-100k',
    title: 'Highest Skewness (min 100k ratings)',
    navLabel: 'Highest Skewness (min 100k)',
    kind: 'skewness',
    dataLabel: 'skewness',
    valueLabel: 'Skewness',
    minRatings: 100000,
    direction: 'desc',
  },
  {
    id: 'highest-skewness-min-10k',
    title: 'Highest Skewness (min 10k ratings)',
    navLabel: 'Highest Skewness (min 10k)',
    kind: 'skewness',
    dataLabel: 'skewness',
    valueLabel: 'Skewness',
    minRatings: 10000,
    direction: 'desc',
  },
  {
    id: 'highest-variance-min-100k',
    title: 'Highest Variance (min 100k ratings)',
    navLabel: 'Highest Variance (min 100k)',
    kind: 'variance',
    dataLabel: 'variance',
    valueLabel: 'Variance',
    minRatings: 100000,
    direction: 'desc',
  },
  {
    id: 'highest-variance-min-10k',
    title: 'Highest Variance (min 10k ratings)',
    navLabel: 'Highest Variance (min 10k)',
    kind: 'variance',
    dataLabel: 'variance',
    valueLabel: 'Variance',
    minRatings: 10000,
    direction: 'desc',
  },
  {
    id: 'lowest-kurtosis-min-100k',
    title: 'Lowest Kurtosis (min 100k ratings)',
    navLabel: 'Lowest Kurtosis (min 100k)',
    kind: 'kurtosis',
    dataLabel: 'kurtosis',
    valueLabel: 'Kurtosis',
    minRatings: 100000,
    direction: 'asc',
  },
  {
    id: 'lowest-kurtosis-min-10k',
    title: 'Lowest Kurtosis (min 10k ratings)',
    navLabel: 'Lowest Kurtosis (min 10k)',
    kind: 'kurtosis',
    dataLabel: 'kurtosis',
    valueLabel: 'Kurtosis',
    minRatings: 10000,
    direction: 'asc',
  },
  {
    id: 'highest-review-ratio-min-1k',
    title: 'Highest Review Ratio (min 1k ratings)',
    navLabel: 'Highest Review Ratio (min 1k)',
    kind: 'review-ratio',
    dataLabel: 'review ratio',
    valueLabel: 'Reviews / Ratings',
    minRatings: 1000,
    direction: 'desc',
  },
  {
    id: 'highest-avg-rating-min-100k',
    title: 'Highest Avg Rating (min 100k ratings)',
    navLabel: 'Highest Avg Rating (min 100k)',
    kind: 'avg-rating',
    dataLabel: 'average rating',
    valueLabel: 'Avg rating',
    minRatings: 100000,
    direction: 'desc',
  },
  {
    id: 'highest-avg-rating-min-10k',
    title: 'Highest Avg Rating (min 10k ratings)',
    navLabel: 'Highest Avg Rating (min 10k)',
    kind: 'avg-rating',
    dataLabel: 'average rating',
    valueLabel: 'Avg rating',
    minRatings: 10000,
    direction: 'desc',
  },
  {
    id: 'highest-avg-rating-min-1k',
    title: 'Highest Avg Rating (min 1k ratings)',
    navLabel: 'Highest Avg Rating (min 1k)',
    kind: 'avg-rating',
    dataLabel: 'average rating',
    valueLabel: 'Avg rating',
    minRatings: 1000,
    direction: 'desc',
  },
  {
    id: 'lowest-avg-rating-min-10k',
    title: 'Lowest Avg Rating (min 10k ratings)',
    navLabel: 'Lowest Avg Rating (min 10k)',
    kind: 'avg-rating',
    dataLabel: 'average rating',
    valueLabel: 'Avg rating',
    minRatings: 10000,
    direction: 'asc',
  },
  {
    id: 'lowest-avg-rating-min-1k',
    title: 'Lowest Avg Rating (min 1k ratings)',
    navLabel: 'Lowest Avg Rating (min 1k)',
    kind: 'avg-rating',
    dataLabel: 'average rating',
    valueLabel: 'Avg rating',
    minRatings: 1000,
    direction: 'asc',
  },
];

// HTML form of `avgHistogram.sh --hasDetails`: one page per ratings threshold,
// each showing the same distribution at three bucket widths.
export type AvgRatingHistogramStep = 0.5 | 0.2 | 0.1;

export const AVG_RATING_HISTOGRAM_STEPS: AvgRatingHistogramStep[] = [0.5, 0.2, 0.1];

export interface AvgRatingHistogramReport {
  id: string;
  title: string;
  navLabel: string;
  minRatings: number;
}

export const AVG_RATING_HISTOGRAM_REPORTS: AvgRatingHistogramReport[] = [
  {
    id: 'avg-ratings-histogram-min-100k',
    title: 'Avg Rating Histogram (min 100k ratings)',
    navLabel: 'Avg Rating Histogram (min 100k)',
    minRatings: 100000,
  },
  {
    id: 'avg-ratings-histogram-min-10k',
    title: 'Avg Rating Histogram (min 10k ratings)',
    navLabel: 'Avg Rating Histogram (min 10k)',
    minRatings: 10000,
  },
  {
    id: 'avg-ratings-histogram-min-1k',
    title: 'Avg Rating Histogram (min 1k ratings)',
    navLabel: 'Avg Rating Histogram (min 1k)',
    minRatings: 1000,
  },
];

export interface BookDetailReport {
  id: string;
  title: string;
  navLabel: string;
  kind: 'language' | 'format' | 'page-count';
}

export const BOOK_DETAIL_REPORTS: BookDetailReport[] = [
  { id: 'book-detail/by-language', title: 'Book Detail — Books by Language', navLabel: 'Books by Language', kind: 'language' },
  { id: 'book-detail/by-format', title: 'Book Detail — Books by Format', navLabel: 'Books by Format', kind: 'format' },
  { id: 'book-detail/by-page-count', title: 'Book Detail — Books by Page Count', navLabel: 'Books by Page Count', kind: 'page-count' },
];

// Publisher tables are fixed-size (not `--limit`) and reuse publisherCatalog's
// distinct-work semantics: editions collapse on the work key and each
// (publisher, work) is represented by its highest-rated edition.
export const PUBLISHER_REPORT_LIMIT = 1000;

export interface PublisherReport {
  id: string;
  title: string;
  navLabel: string;
  sortBy: 'books' | 'totalRatings';
}

export const PUBLISHER_REPORTS: PublisherReport[] = [
  {
    id: 'book-detail/publishers-most-books',
    title: 'Book Detail — Publishers with Most Books',
    navLabel: 'Publishers with Most Books',
    sortBy: 'books',
  },
  {
    id: 'book-detail/publishers-most-ratings',
    title: 'Book Detail — Publishers with Most Ratings',
    navLabel: 'Publishers with Most Ratings',
    sortBy: 'totalRatings',
  },
];

export interface FieldCoverageRow {
  table: string;
  field: string;
  populated: number;
  total: number;
  distinct?: number;
}

// ---------------------------------------------------------------------------
// Lists: top-N tables over list_meta (title from list_scrapes.list_name) plus
// a creator rollup.
// ---------------------------------------------------------------------------

export type ListSortField = 'numBooks' | 'numVoters' | 'numLikes' | 'createdAt';

export interface ListReport {
  // Path id relative to the output root, e.g. 'lists/most-books'.
  id: string;
  title: string;
  navLabel: string;
  sortBy: ListSortField;
  direction: 'asc' | 'desc';
}

export const LIST_REPORTS: ListReport[] = [
  { id: 'lists/most-books', title: 'Lists — Most Books', navLabel: 'Most Books', sortBy: 'numBooks', direction: 'desc' },
  { id: 'lists/most-voters', title: 'Lists — Most Voters', navLabel: 'Most Voters', sortBy: 'numVoters', direction: 'desc' },
  { id: 'lists/most-likes', title: 'Lists — Most Likes', navLabel: 'Most Likes', sortBy: 'numLikes', direction: 'desc' },
  { id: 'lists/earliest-created', title: 'Lists — Earliest Created', navLabel: 'Earliest Created', sortBy: 'createdAt', direction: 'asc' },
  { id: 'lists/latest-created', title: 'Lists — Latest Created', navLabel: 'Latest Created', sortBy: 'createdAt', direction: 'desc' },
];

export interface ListCreatorReport {
  id: string;
  title: string;
  navLabel: string;
}

export const LIST_CREATOR_REPORT: ListCreatorReport = {
  id: 'lists/creators-most-lists',
  title: 'Lists — Creators with Most Lists',
  navLabel: 'Creators with Most Lists',
};

export const STATIC_LISTS_REPORT = {
  id: 'lists/static-lists',
  title: 'Lists — Static Lists',
  navLabel: 'Static Lists',
} as const;

export interface ListRow {
  listId: string;
  title: string;
  numBooks: number;
  numVoters: number;
  numLikes: number | null;
  createdAt: string | null;
  creatorId: string | null;
  creatorName: string | null;
  isStatic: boolean;
}

export interface ListCreatorRow {
  creatorId: string;
  creatorName: string;
  numLists: number;
  numBooks: number;
  numVoters: number;
  numLikes: number;
  hasLikes: boolean;
}

// ---------------------------------------------------------------------------
// Highest Rated by Year: one fixed top-1000 report per publication year.
// ---------------------------------------------------------------------------

export interface YearReport {
  year: number;
  // Path id relative to the output root, e.g. 'year/2026'.
  id: string;
  title: string;
  navLabel: string;
}

export const YEAR_REPORT_START = 2000;
export const YEAR_REPORT_END = 2026;
export const YEAR_REPORT_LIMIT = 1000;
export const YEAR_MIN_RATINGS = 1000;

export const YEAR_REPORTS: YearReport[] = Array.from(
  { length: YEAR_REPORT_END - YEAR_REPORT_START + 1 },
  (_, index) => {
    const year = YEAR_REPORT_END - index;
    return {
      year,
      id: `year/${year}`,
      title: `Highest Rated by Year — ${year}`,
      navLabel: String(year),
    };
  },
);

export interface YearBook {
  id: string;
  title: string;
  author: string;
  authorId: string;
  avgRating: number;
  ratings: number;
  year: number;
}

// `books.published` is usually 'Unknown' or a 4-digit year, but some rows carry
// 'YYYY.MM.DD' (and BCE dates as negative years). Only the leading 4-digit year
// is used, and only years inside the report range survive.
export function parsePublishedYear(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{4})/.exec(value);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  return year >= YEAR_REPORT_START && year <= YEAR_REPORT_END ? year : null;
}

// ---------------------------------------------------------------------------
// Titles: first/last character and first word of every title. These run in a
// second, title-only pass so the main book scan stays narrow.
// ---------------------------------------------------------------------------

export interface TitleReport {
  id: string;
  title: string;
  navLabel: string;
}

export const TITLE_REPORTS: TitleReport[] = [
  { id: 'titles/first-char', title: 'Titles — Books by First Character', navLabel: 'First character' },
  { id: 'titles/last-char', title: 'Titles — Books by Last Character', navLabel: 'Last character' },
  { id: 'titles/first-word', title: 'Titles — Top First Words', navLabel: 'First word' },
];

// First/last character rows below this many books are omitted.
export const TITLE_MIN_BOOKS = 1000;

export interface TitleCharCount {
  char: string;
  count: number;
}

export interface TitleWordCount {
  word: string;
  count: number;
}

export interface TitleStats {
  total: number;
  firstChar: TitleCharCount[];
  lastChar: TitleCharCount[];
  firstWords: TitleWordCount[];
}

export const LIST_TAG_REPORT = {
  id: 'lists/top-list-tags',
  title: 'Top List Tags',
  navLabel: 'Top list tags',
} as const;

export const TAG_FIRST_PAGE_REPORT = {
  id: 'tags/first-page-books',
  title: 'Books on First Page of Tags',
  navLabel: 'Books on First Page of Tags',
} as const;

// Sections with no items render a muted "soon" badge instead of dead links.
export function buildNav(): NavSection[] {
  const bookSections: NavSection[] = BOOK_SCOPES.map((scope) => ({
    label: scope.label,
    items: [
      ...BOOK_METRICS.map((metric) => ({
        id: `${scope.id}/${metric.id}`,
        label: metric.navLabel,
        href: `${scope.id}/${metric.id}.html`,
      })),
      ...DERIVED_REPORTS.map((report) => ({
        id: `${scope.id}/${report.id}`,
        label: report.navLabel,
        href: `${scope.id}/${report.id}.html`,
      })),
      ...AVG_RATING_HISTOGRAM_REPORTS.map((report) => ({
        id: `${scope.id}/${report.id}`,
        label: report.navLabel,
        href: `${scope.id}/${report.id}.html`,
      })),
    ],
  }));

  return [
    {
      label: 'Overall',
      items: [
        { id: 'overall', label: 'Overview', href: 'index.html' },
        { id: 'overall/per-field', label: 'Per Field', href: 'per-field.html' },
        { id: 'overall/ratings-histogram', label: 'Ratings histogram', href: 'ratings-histogram.html' },
        { id: 'overall/publication-years', label: 'Publication years', href: 'publication-years.html' },
        { id: 'overall/books-added', label: 'Books added', href: 'books-added.html' },
        { id: 'overall/authors-added', label: 'Authors added', href: 'authors-added.html' },
      ],
    },
    {
      label: 'Author',
      items: [
        ...AUTHOR_REPORTS.map((report) => ({
          id: report.id,
          label: report.title,
          href: `${report.id}.html`,
        })),
        {
          id: AUTHOR_TOP_BOOK_HISTOGRAM_REPORT.id,
          label: AUTHOR_TOP_BOOK_HISTOGRAM_REPORT.navLabel,
          href: `${AUTHOR_TOP_BOOK_HISTOGRAM_REPORT.id}.html`,
        },
      ],
    },
    ...bookSections,
    {
      label: 'Book Detail',
      items: [
        ...BOOK_DETAIL_REPORTS.map((report) => ({
          id: report.id,
          label: report.navLabel,
          href: `${report.id}.html`,
        })),
        ...PUBLISHER_REPORTS.map((report) => ({
          id: report.id,
          label: report.navLabel,
          href: `${report.id}.html`,
        })),
      ],
    },
    {
      label: 'Titles',
      items: TITLE_REPORTS.map((report) => ({
        id: report.id,
        label: report.navLabel,
        href: `${report.id}.html`,
      })),
    },
    {
      label: 'Highest Rated by Year',
      items: YEAR_REPORTS.map((report) => ({
        id: report.id,
        label: report.navLabel,
        href: `${report.id}.html`,
      })),
    },
    {
      label: 'Lists',
      items: [
        ...LIST_REPORTS.map((report) => ({
          id: report.id,
          label: report.navLabel,
          href: `${report.id}.html`,
        })),
        {
          id: STATIC_LISTS_REPORT.id,
          label: STATIC_LISTS_REPORT.navLabel,
          href: `${STATIC_LISTS_REPORT.id}.html`,
        },
        {
          id: LIST_CREATOR_REPORT.id,
          label: LIST_CREATOR_REPORT.navLabel,
          href: `${LIST_CREATOR_REPORT.id}.html`,
        },
        {
          id: LIST_TAG_REPORT.id,
          label: LIST_TAG_REPORT.navLabel,
          href: `${LIST_TAG_REPORT.id}.html`,
        },
      ],
    },
    { label: 'Genres', items: [] },
    {
      label: 'Tags',
      items: [
        {
          id: TAG_FIRST_PAGE_REPORT.id,
          label: TAG_FIRST_PAGE_REPORT.navLabel,
          href: `${TAG_FIRST_PAGE_REPORT.id}.html`,
        },
      ],
    },
  ];
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatCount(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString('en-US') : '0';
}

function renderAuthorLink(author: string, authorId: string): string {
  if (!authorId) return escapeHtml(author || '—');
  const href = `https://www.goodreads.com/author/show/${encodeURIComponent(authorId)}`;
  return `<a href="${href}" target="_blank" rel="noopener noreferrer">${escapeHtml(author || authorId)}</a>`;
}

export function formatGeneratedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function parseCount(value: string | undefined): number {
  return parseInt((value || '0').replace(/,/g, ''), 10) || 0;
}

function parseAvg(value: string | undefined): number {
  return parseFloat(value || '0') || 0;
}

export function authorFieldValue(author: SelectedAuthor, field: AuthorReportField): number {
  switch (field) {
    case 'numRatings':
      return parseCount(author.entry.numRatings);
    case 'numReviews':
      return parseCount(author.entry.numReviews);
    case 'numShelves':
      return parseCount(author.entry.numShelves);
    case 'catalogPages':
      return author.entry.catalogPages ?? 0;
    case 'averageRating':
      return parseAvg(author.entry.averageRating);
  }
}

export function renderNav(nav: NavSection[], activeId: string | null, rootPrefix = ''): string {
  const parts = ['<nav class="sidebar">', '<div class="brand">Goodreads data</div>'];
  for (const section of nav) {
    // Empty sections have nothing to expand, so they stay a plain heading.
    if (section.items.length === 0) {
      parts.push('<div class="nav-section">');
      parts.push(`<div class="nav-heading">${escapeHtml(section.label)} <span class="soon">soon</span></div>`);
      parts.push('</div>');
      continue;
    }

    // No-JS expando: the section holding the active report starts open, every
    // other section starts collapsed so the sidebar stays short.
    const hasActive = activeId !== null && section.items.some((item) => item.id === activeId);
    parts.push(`<details class="nav-section"${hasActive ? ' open' : ''}>`);
    parts.push(`<summary class="nav-heading">${escapeHtml(section.label)}</summary>`);
    parts.push('<ul>');
    for (const item of section.items) {
      const active = item.id === activeId ? ' class="active"' : '';
      parts.push(`<li><a${active} href="${rootPrefix}${item.href}">${escapeHtml(item.label)}</a></li>`);
    }
    parts.push('</ul>');
    parts.push('</details>');
  }
  parts.push('</nav>');
  return parts.join('\n');
}

export function renderAuthorTable(authors: SelectedAuthor[], sortBy: AuthorReportField): string {
  if (authors.length === 0) return '<p>No authors matched this report.</p>';

  const ordered: AuthorReportField[] = [
    sortBy,
    ...AUTHOR_FIELDS.map((field) => field.field).filter((field) => field !== sortBy),
  ];
  const labelOf = (field: AuthorReportField): string =>
    AUTHOR_FIELDS.find((candidate) => candidate.field === field)!.label;

  const rows = authors.map((author, index) => {
    const cells = ordered
      .map((field) => {
        const value = authorFieldValue(author, field);
        const text = field === 'averageRating' ? value.toFixed(2) : formatCount(value);
        return `<td class="num">${text}</td>`;
      })
      .join('');
    const name = escapeHtml(author.name || author.id);
    const href = `https://www.goodreads.com/author/show/${encodeURIComponent(author.id)}`;
    return `<tr><td class="num">${index + 1}</td><td><a href="${href}" target="_blank" rel="noopener noreferrer">${name}</a></td>${cells}</tr>`;
  });

  const head = ordered.map((field) => `<th class="num">${escapeHtml(labelOf(field))}</th>`).join('');
  return [
    '<table>',
    `<thead><tr><th class="num">#</th><th>Author</th>${head}</tr></thead>`,
    '<tbody>',
    rows.join('\n'),
    '</tbody>',
    '</table>',
  ].join('\n');
}

export function renderOverview(nav: NavSection[], limit: number): string {
  const parts = [
    `<p>Static reports generated from the local Goodreads database. Up to ${formatCount(limit)} rows per report.</p>`,
  ];
  for (const section of nav) {
    if (section.label === 'Overall' || section.items.length === 0) continue;
    parts.push(`<h2>${escapeHtml(section.label)}</h2>`, '<ul>');
    for (const item of section.items) {
      parts.push(`<li><a href="${item.href}">${escapeHtml(item.label)}</a></li>`);
    }
    parts.push('</ul>');
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Book aggregation
// ---------------------------------------------------------------------------

export interface TopBook {
  id: string;
  title: string;
  author: string;
  authorId: string;
  workId: string;
  value: number;
}

export interface MetricAccumulator {
  buckets: Bucket[];
  counts: number[];
  heap: TopBook[];
  // Number of rows that actually carried a value (the histogram denominator).
  count: number;
}

export interface DerivedBook {
  id: string;
  title: string;
  author: string;
  authorId: string;
  workId: string;
  value: number;
  ratings: number;
  reviews: number;
}

export interface DerivedAccumulator {
  heap: DerivedBook[];
  // Rows that passed the min-ratings filter and carried a non-null stat.
  count: number;
}

export interface AvgRatingHistogramAccumulator {
  minRatings: number;
  // Books counted at this threshold (the denominator for each table's share).
  count: number;
  buckets: Record<AvgRatingHistogramStep, number[]>;
}

export interface ScopeAccumulator {
  // Total books in the scope (from `books`), used as the ratings denominator.
  total: number;
  metrics: Record<BookMetricId, MetricAccumulator>;
  derived: Record<DerivedReportId, DerivedAccumulator>;
  avgRatingHistograms: Record<string, AvgRatingHistogramAccumulator>;
}

export type Accumulators = Record<BookScopeId, ScopeAccumulator>;

interface BooksRow {
  id: string;
  title: string | null;
  author: string | null;
  author_id: string | null;
  ratings: number | null;
  avg_rating: number | null;
  published: string | null;
  is_bad: number | null;
  work_id: string | null;
  is_work_rep: number | null;
  pages: number | null;
}

interface BookPageRow {
  id: string;
  title: string | null;
  author: string | null;
  author_id: string | null;
  work_id: string | null;
  is_work_rep: number | null;
  reviews_count: string | null;
  currently_reading: number | null;
  to_read: number | null;
  editions_count: number | null;
  ratings: string | number | null;
  avg_rating: number | null;
  ratings_skewness: number | null;
  ratings_variance: number | null;
  ratings_kurtosis: number | null;
}

function toInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : parseInt(String(value).replace(/,/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function bucketIndex(value: number, buckets: Bucket[]): number {
  for (let index = 0; index < buckets.length; index++) {
    if (value <= buckets[index].max) return index;
  }
  return buckets.length - 1;
}

// Min-heap ordered worst-first (lower value, then larger id), so the root is
// always the entry most worth evicting. At render time the heap is copied and
// sorted best-first.
function compareWorstFirst(a: TopBook, b: TopBook): number {
  if (a.value !== b.value) return a.value - b.value;
  if (a.id === b.id) return 0;
  return a.id > b.id ? -1 : 1;
}

// Year reports rank by average rating, then by number of ratings, then id.
function compareYearWorstFirst(a: YearBook, b: YearBook): number {
  if (a.avgRating !== b.avgRating) return a.avgRating - b.avgRating;
  if (a.ratings !== b.ratings) return a.ratings - b.ratings;
  if (a.id === b.id) return 0;
  return a.id > b.id ? -1 : 1;
}

// One edition per year/work: keep the highest-ratings edition, lowest id on tie
// (the same rule as recomputeWorkReps).
function isBetterYearEdition(candidate: YearBook, current: YearBook): boolean {
  if (candidate.ratings !== current.ratings) return candidate.ratings > current.ratings;
  return Number(candidate.id) < Number(current.id);
}

// Derived reports rank by the stat in the report's direction, then by number
// of ratings (more is better), then id (smaller is better).
function compareDerivedWorstFirst(a: DerivedBook, b: DerivedBook, direction: 'asc' | 'desc'): number {
  if (a.value !== b.value) return direction === 'desc' ? a.value - b.value : b.value - a.value;
  if (a.ratings !== b.ratings) return a.ratings - b.ratings;
  if (a.id === b.id) return 0;
  return a.id > b.id ? -1 : 1;
}

function formatDerivedValue(kind: DerivedReportKind, value: number): string {
  if (kind === 'review-ratio') return value.toFixed(3);
  if (kind === 'avg-rating') return value.toFixed(2);
  return value.toFixed(4);
}

function siftUp<T>(heap: T[], index: number, compare: (a: T, b: T) => number): void {
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (compare(heap[index], heap[parent]) >= 0) break;
    [heap[index], heap[parent]] = [heap[parent], heap[index]];
    index = parent;
  }
}

function siftDown<T>(heap: T[], index: number, compare: (a: T, b: T) => number): void {
  const length = heap.length;
  for (;;) {
    const left = index * 2 + 1;
    const right = left + 1;
    let smallest = index;
    if (left < length && compare(heap[left], heap[smallest]) < 0) smallest = left;
    if (right < length && compare(heap[right], heap[smallest]) < 0) smallest = right;
    if (smallest === index) break;
    [heap[index], heap[smallest]] = [heap[smallest], heap[index]];
    index = smallest;
  }
}

function pushTop<T>(heap: T[], item: T, limit: number, compare: (a: T, b: T) => number): void {
  if (heap.length < limit) {
    heap.push(item);
    siftUp(heap, heap.length - 1, compare);
    return;
  }
  if (compare(item, heap[0]) > 0) {
    heap[0] = item;
    siftDown(heap, 0, compare);
  }
}

function addValue(acc: MetricAccumulator, value: number, book: TopBook, limit: number): void {
  acc.count++;
  acc.counts[bucketIndex(value, acc.buckets)]++;
  pushTop(acc.heap, book, limit, compareWorstFirst);
}

function derivedValue(row: BookPageRow, report: DerivedReport, ratings: number): number | null {
  switch (report.kind) {
    case 'skewness':
      return row.ratings_skewness;
    case 'variance':
      return row.ratings_variance;
    case 'kurtosis':
      return row.ratings_kurtosis;
    case 'review-ratio':
      return ratings > 0 ? (toInt(row.reviews_count) ?? 0) / ratings : null;
    case 'avg-rating': {
      const avg = row.avg_rating === null || row.avg_rating === undefined ? null : Number(row.avg_rating);
      return avg !== null && Number.isFinite(avg) && avg > 0 ? avg : null;
    }
  }
}

// Average ratings are hundredths of a star; values outside 0.01–5.00 (and
// non-numeric sentinels such as "Unknown") are excluded just as in the CLI.
function avgRatingHundredths(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const hundredths = Math.round(parsed * 100);
  return hundredths <= 500 ? hundredths : null;
}

function addAvgRatingHistograms(acc: ScopeAccumulator, row: BookPageRow): void {
  const ratings = toInt(row.ratings) ?? 0;
  const hundredths = avgRatingHundredths(row.avg_rating);
  if (hundredths === null) return;
  for (const report of AVG_RATING_HISTOGRAM_REPORTS) {
    if (ratings < report.minRatings) continue;
    const histogram = acc.avgRatingHistograms[report.id];
    histogram.count++;
    for (const step of AVG_RATING_HISTOGRAM_STEPS) {
      const index = Math.floor(hundredths / Math.round(step * 100));
      if (index >= 0 && index < histogram.buckets[step].length) histogram.buckets[step][index]++;
    }
  }
}

function addDerivedReports(acc: ScopeAccumulator, row: BookPageRow, limit: number): void {
  const ratings = toInt(row.ratings) ?? 0;
  for (const report of DERIVED_REPORTS) {
    if (ratings < report.minRatings) continue;
    const value = derivedValue(row, report, ratings);
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    const accumulator = acc.derived[report.id];
    accumulator.count++;
    pushTop(
      accumulator.heap,
      {
        id: String(row.id),
        title: row.title ?? '',
        author: row.author ?? '',
        authorId: row.author_id ?? '',
        workId: row.work_id ?? '',
        value,
        ratings,
        reviews: toInt(row.reviews_count) ?? 0,
      },
      limit,
      (a, b) => compareDerivedWorstFirst(a, b, report.direction),
    );
  }
}

export function createAccumulators(): Accumulators {
  const makeMetrics = (): Record<BookMetricId, MetricAccumulator> => {
    const metrics = {} as Record<BookMetricId, MetricAccumulator>;
    for (const metric of BOOK_METRICS) {
      metrics[metric.id] = {
        buckets: metric.buckets,
        counts: metric.buckets.map(() => 0),
        heap: [],
        count: 0,
      };
    }
    return metrics;
  };
  const makeDerived = (): Record<DerivedReportId, DerivedAccumulator> => {
    const derived = {} as Record<DerivedReportId, DerivedAccumulator>;
    for (const report of DERIVED_REPORTS) derived[report.id] = { heap: [], count: 0 };
    return derived;
  };
  const makeAvgRatingHistograms = (): Record<string, AvgRatingHistogramAccumulator> => {
    const histograms: Record<string, AvgRatingHistogramAccumulator> = {};
    for (const report of AVG_RATING_HISTOGRAM_REPORTS) {
      const buckets = {} as Record<AvgRatingHistogramStep, number[]>;
      for (const step of AVG_RATING_HISTOGRAM_STEPS) {
        buckets[step] = new Array(Math.floor(500 / Math.round(step * 100)) + 1).fill(0);
      }
      histograms[report.id] = { minRatings: report.minRatings, count: 0, buckets };
    }
    return histograms;
  };
  return {
    'book-id': {
      total: 0,
      metrics: makeMetrics(),
      derived: makeDerived(),
      avgRatingHistograms: makeAvgRatingHistograms(),
    },
    'work-id': {
      total: 0,
      metrics: makeMetrics(),
      derived: makeDerived(),
      avgRatingHistograms: makeAvgRatingHistograms(),
    },
    works: {
      total: 0,
      metrics: makeMetrics(),
      derived: makeDerived(),
      avgRatingHistograms: makeAvgRatingHistograms(),
    },
    'works-en': {
      total: 0,
      metrics: makeMetrics(),
      derived: makeDerived(),
      avgRatingHistograms: makeAvgRatingHistograms(),
    },
  };
}

function bookPageValue(row: BookPageRow, metric: BookMetric): number | null {
  switch (metric.id) {
    case 'reviews':
      return toInt(row.reviews_count);
    case 'currently-reading':
      return toInt(row.currently_reading);
    case 'to-read':
      return toInt(row.to_read);
    case 'edition-count':
      return toInt(row.editions_count);
    default:
      return null;
  }
}

function addBookPageMetrics(acc: ScopeAccumulator, row: BookPageRow, metrics: BookMetric[], limit: number): void {
  for (const metric of metrics) {
    const value = bookPageValue(row, metric);
    if (value === null) continue;
    addValue(
      acc.metrics[metric.id],
      value,
      {
        id: String(row.id),
        title: row.title ?? '',
        author: row.author ?? '',
        authorId: row.author_id ?? '',
        workId: row.work_id ?? '',
        value,
      },
      limit,
    );
  }
}

// `books` is huge (~18.6M rows), so the scan selects only the columns needed to
// build the histograms and pick the top-N ids. Titles/authors are resolved for
// just the surviving ids afterwards (see resolveBookTitles).
export function scanBooks(
  accumulators: Accumulators,
  pageFrequency: Map<number, number>,
  limit: number,
  yearHeaps: Map<number, YearBook[]> = new Map(),
): void {
  const sql =
    'SELECT id, title, author, author_id, ratings, avg_rating, published, is_bad, work_id, is_work_rep, pages FROM books';
  const yearCandidates = new Map<number, Map<string, YearBook>>();
  for (const row of streamRows<BooksRow>(sql)) {
    const value = toInt(row.ratings) ?? 0;
    const book: TopBook = {
      id: String(row.id),
      title: '',
      author: '',
      authorId: '',
      workId: row.work_id ?? '',
      value,
    };

    accumulators['book-id'].total++;
    addValue(accumulators['book-id'].metrics.ratings, value, book, limit);

    const hasWorkId = row.work_id !== null && row.work_id !== '';
    if (hasWorkId) {
      accumulators['work-id'].total++;
      addValue(accumulators['work-id'].metrics.ratings, value, book, limit);
    }
    if (Number(row.is_work_rep) === 1) {
      accumulators.works.total++;
      addValue(accumulators.works.metrics.ratings, value, book, limit);
    }

    // Highest Rated by Year: drop flagged books, require >= 1,000 ratings, and
    // collapse editions of one work before filling the top-N heap.
    const year = parsePublishedYear(row.published);
    if (year !== null && Number(row.is_bad) !== 1 && value >= YEAR_MIN_RATINGS) {
      const avgRating = row.avg_rating === null || row.avg_rating === undefined ? null : Number(row.avg_rating);
      if (avgRating !== null && Number.isFinite(avgRating) && avgRating > 0) {
        const id = String(row.id);
        const title = row.title ?? '';
        const author = row.author ?? '';
        const authorId = row.author_id ?? '';
        const authorKey =
          row.author_id !== null && row.author_id !== '' ? row.author_id : author.trim().toLowerCase();
        const normalizedTitle = normalizeWorkTitle(title);
        const groupKey = hasWorkId
          ? `w:${row.work_id}`
          : normalizedTitle === '' || authorKey === ''
            ? `id:${id}`
            : `t:${normalizedTitle}|a:${authorKey}`;

        let candidates = yearCandidates.get(year);
        if (!candidates) {
          candidates = new Map();
          yearCandidates.set(year, candidates);
        }
        const candidate: YearBook = { id, title, author, authorId, avgRating, ratings: value, year };
        const current = candidates.get(groupKey);
        if (!current || isBetterYearEdition(candidate, current)) candidates.set(groupKey, candidate);
      }
    }

    const pages = toInt(row.pages);
    if (pages !== null && pages > 0) pageFrequency.set(pages, (pageFrequency.get(pages) ?? 0) + 1);
  }

  for (const [year, candidates] of yearCandidates) {
    const heap: YearBook[] = [];
    for (const candidate of candidates.values()) {
      pushTop(heap, candidate, YEAR_REPORT_LIMIT, compareYearWorstFirst);
    }
    yearHeaps.set(year, heap);
  }
}

// Fill in title/author for the ratings and year top-N ids collected by scanBooks.
export function resolveBookTitles(
  accumulators: Accumulators,
  yearHeaps: Map<number, YearBook[]> = new Map(),
): void {
  const ids = new Set<string>();
  for (const scope of BOOK_SCOPES) {
    for (const book of accumulators[scope.id].metrics.ratings.heap) ids.add(book.id);
  }
  for (const heap of yearHeaps.values()) {
    for (const book of heap) ids.add(book.id);
  }
  if (ids.size === 0) return;

  const idList = [...ids];
  const metadata = new Map<string, { title: string; author: string; authorId: string }>();
  const db = getDb();
  for (let offset = 0; offset < idList.length; offset += 500) {
    const chunk = idList.slice(offset, offset + 500);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id, title, author, author_id FROM books WHERE id IN (${placeholders})`)
      .all(...chunk) as { id: string; title: string | null; author: string | null; author_id: string | null }[];
    for (const row of rows) {
      metadata.set(String(row.id), {
        title: row.title ?? '',
        author: row.author ?? '',
        authorId: row.author_id ?? '',
      });
    }
  }

  for (const scope of BOOK_SCOPES) {
    for (const book of accumulators[scope.id].metrics.ratings.heap) {
      const found = metadata.get(book.id);
      if (found) {
        book.title = found.title;
        book.author = found.author;
        book.authorId = found.authorId;
      }
    }
  }
  for (const heap of yearHeaps.values()) {
    for (const book of heap) {
      const found = metadata.get(book.id);
      if (found) {
        book.title = found.title;
        book.author = found.author;
        book.authorId = found.authorId;
      }
    }
  }
}

export function scanBookPages(accumulators: Accumulators, limit: number): void {
  const sql = `
    SELECT bp.book_id AS id, bp.reviews_count, bp.currently_reading, bp.to_read, bp.editions_count,
           bp.ratings_skewness, bp.ratings_variance, bp.ratings_kurtosis,
           b.title, b.author, b.author_id, b.work_id, b.is_work_rep, b.ratings, b.avg_rating
    FROM book_page bp
    JOIN books b ON b.id = bp.book_id
  `;
  const bookPageMetrics = BOOK_METRICS.filter((metric) => metric.source === 'book_page');
  for (const row of streamRows<BookPageRow>(sql)) {
    addBookPageMetrics(accumulators['book-id'], row, bookPageMetrics, limit);
    addDerivedReports(accumulators['book-id'], row, limit);
    addAvgRatingHistograms(accumulators['book-id'], row);
    const hasWorkId = row.work_id !== null && row.work_id !== '';
    if (hasWorkId) {
      addBookPageMetrics(accumulators['work-id'], row, bookPageMetrics, limit);
      addDerivedReports(accumulators['work-id'], row, limit);
      addAvgRatingHistograms(accumulators['work-id'], row);
    }
    if (Number(row.is_work_rep) === 1) {
      addBookPageMetrics(accumulators.works, row, bookPageMetrics, limit);
      addDerivedReports(accumulators.works, row, limit);
      addAvgRatingHistograms(accumulators.works, row);
    }
  }
}

// Works (English): one row per work_id, choosing the highest-ratings edition
// whose book_page.language is exactly 'English'. Works with no known English
// edition are excluded (language coverage is partial; the top of the report is
// reliable, the long tail is not). The window function picks the edition; the
// title+author dedupe then collapses Goodreads' occasional duplicate work_ids
// (e.g. Harry Potter #3).
const ENGLISH_WORKS_SQL = `
  WITH english AS (
    SELECT b.id, b.title, b.author, b.author_id, b.work_id, b.ratings, b.avg_rating,
           0 AS is_work_rep,
           bp.reviews_count, bp.currently_reading, bp.to_read, bp.editions_count,
           bp.ratings_skewness, bp.ratings_variance, bp.ratings_kurtosis,
           ROW_NUMBER() OVER (
             PARTITION BY b.work_id
             ORDER BY b.ratings DESC, CAST(b.id AS INTEGER) ASC
           ) AS rn
    FROM book_page bp
    JOIN books b ON b.id = bp.book_id
    WHERE bp.language = 'English'
      AND b.work_id IS NOT NULL AND b.work_id != ''
  )
  SELECT id, title, author, author_id, work_id, ratings, avg_rating, is_work_rep,
         reviews_count, currently_reading, to_read, editions_count,
         ratings_skewness, ratings_variance, ratings_kurtosis
  FROM english
  WHERE rn = 1
`;

export function normalizeWorkTitle(title: string): string {
  return stripTitleSuffix(title)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isBetterWorkRow(candidate: BookPageRow, current: BookPageRow): boolean {
  const candidateRatings = toInt(candidate.ratings) ?? 0;
  const currentRatings = toInt(current.ratings) ?? 0;
  if (candidateRatings !== currentRatings) return candidateRatings > currentRatings;
  return Number(candidate.id) < Number(current.id);
}

// Collapse duplicate work_ids that share a normalized title and author. The
// best (most ratings, then lowest id) edition survives. Rows without a usable
// title keep their own work_id key so unrelated untitled rows never collapse.
export function dedupeEnglishWorks(rows: BookPageRow[]): BookPageRow[] {
  const best = new Map<string, BookPageRow>();
  for (const row of rows) {
    const title = normalizeWorkTitle(row.title ?? '');
    const authorKey = row.author_id || (row.author ?? '').trim().toLowerCase();
    const key = title ? `${title}|${authorKey}` : `work:${row.work_id ?? row.id}`;
    const current = best.get(key);
    if (!current || isBetterWorkRow(row, current)) best.set(key, row);
  }
  return [...best.values()];
}

export function scanEnglishWorks(accumulators: Accumulators, limit: number): void {
  const acc = accumulators['works-en'];
  const bookPageMetrics = BOOK_METRICS.filter((metric) => metric.source === 'book_page');
  for (const row of dedupeEnglishWorks([...streamRows<BookPageRow>(ENGLISH_WORKS_SQL)])) {
    const value = toInt(row.ratings) ?? 0;
    acc.total++;
    addValue(
      acc.metrics.ratings,
      value,
      {
        id: String(row.id),
        title: row.title ?? '',
        author: row.author ?? '',
        authorId: row.author_id ?? '',
        workId: row.work_id ?? '',
        value,
      },
      limit,
    );
    addBookPageMetrics(acc, row, bookPageMetrics, limit);
    addDerivedReports(acc, row, limit);
    addAvgRatingHistograms(acc, row);
  }
}

// ---------------------------------------------------------------------------
// Book rendering
// ---------------------------------------------------------------------------

function scopeUnitLabel(scopeId: BookScopeId): string {
  if (scopeId === 'book-id') return 'Book IDs';
  if (scopeId === 'work-id') return 'Work IDs';
  return 'works';
}

export function renderHistogram(acc: MetricAccumulator, total: number): string {
  const rows = acc.buckets.map((bucket, index) => {
    const count = acc.counts[index];
    const share = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
    return `<tr><td>${escapeHtml(bucket.label)}</td><td class="num">${formatCount(count)}</td><td class="num">${share}%</td></tr>`;
  });
  return [
    '<table>',
    '<thead><tr><th>Range</th><th class="num">Books</th><th class="num">Share</th></tr></thead>',
    '<tbody>',
    rows.join('\n'),
    '</tbody>',
    '</table>',
  ].join('\n');
}

export function renderTopBooks(heap: TopBook[], metric: BookMetric, showWorkId: boolean): string {
  if (heap.length === 0) return '<p>No books with this metric.</p>';

  const books = [...heap].sort((a, b) => compareWorstFirst(b, a));
  const rows = books.map((book, index) => {
    const title = escapeHtml(book.title || book.id);
    const href = `https://www.goodreads.com/book/show/${encodeURIComponent(book.id)}`;
    const author = renderAuthorLink(book.author, book.authorId);
    const workCell = showWorkId
      ? `<td>${
          book.workId
            ? `<a href="https://www.goodreads.com/work/editions/${encodeURIComponent(book.workId)}" target="_blank" rel="noopener noreferrer">${escapeHtml(book.workId)}</a>`
            : '—'
        }</td>`
      : '';
    return `<tr><td class="num">${index + 1}</td><td><a href="${href}" target="_blank" rel="noopener noreferrer">${title}</a></td><td>${author}</td>${workCell}<td class="num">${formatCount(book.value)}</td></tr>`;
  });
  const workHead = showWorkId ? '<th>Work ID</th>' : '';
  return [
    '<table>',
    `<thead><tr><th class="num">#</th><th>Title</th><th>Author</th>${workHead}<th class="num">${escapeHtml(metric.label)}</th></tr></thead>`,
    '<tbody>',
    rows.join('\n'),
    '</tbody>',
    '</table>',
  ].join('\n');
}

export function renderBookMetricPage(scope: BookScope, metric: BookMetric, acc: ScopeAccumulator, limit: number): string {
  const metricAcc = acc.metrics[metric.id];
  const showWorkId = scope.id !== 'book-id';
  const denominator = metric.source === 'books' ? acc.total : metricAcc.count;
  const parts: string[] = [];

  const unit = scopeUnitLabel(scope.id);
  if (metric.source === 'books') {
    parts.push(`<p>${formatCount(acc.total)} ${unit} in scope.</p>`);
  } else {
    parts.push(
      `<p>Based on ${formatCount(metricAcc.count)} books with ${escapeHtml(metric.label.toLowerCase())} data (of ${formatCount(acc.total)} ${unit} in scope).</p>`,
    );
  }

  parts.push('<h2>Distribution</h2>');
  parts.push(renderHistogram(metricAcc, denominator));
  parts.push(`<h2>Top ${formatCount(Math.min(limit, metricAcc.heap.length))}</h2>`);
  parts.push(renderTopBooks(metricAcc.heap, metric, showWorkId));
  return parts.join('\n');
}

export function renderDerivedTable(heap: DerivedBook[], report: DerivedReport, showWorkId: boolean): string {
  if (heap.length === 0) return '<p>No books matched this report.</p>';

  const books = [...heap].sort((a, b) => compareDerivedWorstFirst(b, a, report.direction));
  const rows = books.map((book, index) => {
    const title = escapeHtml(book.title || book.id);
    const href = `https://www.goodreads.com/book/show/${encodeURIComponent(book.id)}`;
    const author = renderAuthorLink(book.author, book.authorId);
    const workCell = showWorkId
      ? `<td>${
          book.workId
            ? `<a href="https://www.goodreads.com/work/editions/${encodeURIComponent(book.workId)}" target="_blank" rel="noopener noreferrer">${escapeHtml(book.workId)}</a>`
            : '—'
        }</td>`
      : '';
    const valueCell = `<td class="num">${formatDerivedValue(report.kind, book.value)}</td>`;
    const reviewsCell =
      report.kind === 'review-ratio' ? `<td class="num">${formatCount(book.reviews)}</td>` : '';
    return `<tr><td class="num">${index + 1}</td><td><a href="${href}" target="_blank" rel="noopener noreferrer">${title}</a></td><td>${author}</td>${workCell}${valueCell}${reviewsCell}<td class="num">${formatCount(book.ratings)}</td></tr>`;
  });
  const workHead = showWorkId ? '<th>Work ID</th>' : '';
  const reviewsHead = report.kind === 'review-ratio' ? '<th class="num">Reviews</th>' : '';
  return [
    '<table>',
    `<thead><tr><th class="num">#</th><th>Title</th><th>Author</th>${workHead}<th class="num">${escapeHtml(report.valueLabel)}</th>${reviewsHead}<th class="num"># ratings</th></tr></thead>`,
    '<tbody>',
    rows.join('\n'),
    '</tbody>',
    '</table>',
  ].join('\n');
}

export function renderDerivedPage(scope: BookScope, report: DerivedReport, acc: ScopeAccumulator, limit: number): string {
  const derived = acc.derived[report.id];
  const intro = `Based on ${formatCount(derived.count)} books with ${report.dataLabel} data and at least ${formatCount(report.minRatings)} ratings (of ${formatCount(acc.total)} ${scopeUnitLabel(scope.id)} in scope).`;
  return [
    `<p>${escapeHtml(intro)}</p>`,
    `<h2>Top ${formatCount(Math.min(limit, derived.heap.length))}</h2>`,
    renderDerivedTable(derived.heap, report, scope.id !== 'book-id'),
  ].join('\n');
}

// Static "toggle" between the all-language and English-only works views. Both
// scopes live one directory under the output root, so the sibling path is
// always `../<other-scope>/<same-report>.html`.
export function renderScopeToggle(scope: BookScope, reportId: string): string {
  if (scope.id !== 'works' && scope.id !== 'works-en') return '';
  const allLanguages =
    scope.id === 'works'
      ? '<strong>All languages</strong>'
      : `<a href="../works/${reportId}.html">All languages</a>`;
  const english =
    scope.id === 'works-en'
      ? '<strong>English only</strong>'
      : `<a href="../works-en/${reportId}.html">English only</a>`;
  return `<p class="scope-toggle">View: ${allLanguages} · ${english}</p>`;
}

// Title labels (first character, first word) and publisher names link to their
// Listopia tag page only when the normalized label is a known list_tags.tag_name.
// Tag names/slugs are lowercased with spaces collapsed to dashes.
function renderTagLabel(label: string, tagNames?: ReadonlySet<string>): string {
  const text = escapeHtml(label);
  if (!tagNames) return text;
  const tag = label.toLowerCase().trim().replace(/\s+/g, '-');
  if (!tagNames.has(tag)) return text;
  const href = `https://www.goodreads.com/list/tag/${encodeURIComponent(tag)}`;
  return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
}

export function renderFrequencyPage(
  intro: string,
  values: { label: string; count: number }[],
  total: number,
  heading: string,
  tagNames?: ReadonlySet<string>,
): string {
  const rows = values.map((value) => {
    const share = total > 0 ? ((value.count / total) * 100).toFixed(1) : '0.0';
    return `<tr><td>${renderTagLabel(value.label, tagNames)}</td><td class="num">${formatCount(value.count)}</td><td class="num">${share}%</td></tr>`;
  });
  return [
    `<p>${escapeHtml(intro)}</p>`,
    '<table>',
    `<thead><tr><th>${escapeHtml(heading)}</th><th class="num">Books</th><th class="num">Share</th></tr></thead>`,
    '<tbody>',
    rows.join('\n'),
    '</tbody>',
    '</table>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Lists aggregation / rendering
// ---------------------------------------------------------------------------

interface ListMetaDbRow {
  list_id: string;
  title: string | null;
  num_books: number | null;
  num_voters: number | null;
  num_likes: number | null;
  created_at: string | null;
  creator_id: string | null;
  creator_name: string | null;
  is_static: number | null;
}

// `list_meta` holds the sidebar header of every list read (~26k rows), while
// `list_scrapes.list_name` is the only reliable title source (`lists` only has
// a few hundred rows). Both are small enough to load whole.
export function loadListRows(): ListRow[] {
  const rows = getDb()
    .prepare(
      `SELECT m.list_id, s.list_name AS title, m.num_books, m.num_voters, m.num_likes,
              m.created_at, m.creator_id, m.creator_name, m.is_static
       FROM list_meta m
       LEFT JOIN list_scrapes s ON s.list_id = m.list_id`,
    )
    .all() as ListMetaDbRow[];
  return rows.map((row) => ({
    listId: String(row.list_id),
    title: row.title || String(row.list_id),
    numBooks: toInt(row.num_books) ?? 0,
    numVoters: toInt(row.num_voters) ?? 0,
    numLikes: toInt(row.num_likes),
    createdAt: row.created_at || null,
    creatorId: row.creator_id || null,
    creatorName: row.creator_name || null,
    isStatic: Number(row.is_static) === 1,
  }));
}

function listSortValue(row: ListRow, field: ListSortField): number | string | null {
  switch (field) {
    case 'numBooks':
      return row.numBooks;
    case 'numVoters':
      return row.numVoters;
    case 'numLikes':
      return row.numLikes;
    case 'createdAt':
      return row.createdAt;
  }
}

function compareListIds(a: ListRow, b: ListRow): number {
  if (a.listId === b.listId) return 0;
  return a.listId < b.listId ? -1 : 1;
}

export function sortListRows(rows: ListRow[], report: ListReport): ListRow[] {
  const direction = report.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = listSortValue(a, report.sortBy);
    const bv = listSortValue(b, report.sortBy);
    // Unknown values (NULL likes / creation dates) always sort last.
    if (av === null && bv === null) return compareListIds(a, b);
    if (av === null) return 1;
    if (bv === null) return -1;
    if (av !== bv) return (av < bv ? -1 : 1) * direction;
    return compareListIds(a, b);
  });
}

export function aggregateListCreators(rows: ListRow[]): ListCreatorRow[] {
  const creators = new Map<string, ListCreatorRow>();
  for (const row of rows) {
    if (!row.creatorId) continue;
    let creator = creators.get(row.creatorId);
    if (!creator) {
      creator = {
        creatorId: row.creatorId,
        creatorName: row.creatorName || '',
        numLists: 0,
        numBooks: 0,
        numVoters: 0,
        numLikes: 0,
        hasLikes: false,
      };
      creators.set(row.creatorId, creator);
    }
    creator.numLists++;
    creator.numBooks += row.numBooks;
    creator.numVoters += row.numVoters;
    if (row.numLikes !== null) {
      creator.numLikes += row.numLikes;
      creator.hasLikes = true;
    }
    if (!creator.creatorName && row.creatorName) creator.creatorName = row.creatorName;
  }
  return [...creators.values()];
}

export function sortListCreators(creators: ListCreatorRow[]): ListCreatorRow[] {
  return [...creators].sort((a, b) => {
    if (a.numLists !== b.numLists) return b.numLists - a.numLists;
    if (a.creatorId === b.creatorId) return 0;
    return a.creatorId < b.creatorId ? -1 : 1;
  });
}

const LIST_FIELDS: { field: ListSortField; label: string }[] = [
  { field: 'numBooks', label: 'Books' },
  { field: 'numVoters', label: 'Voters' },
  { field: 'numLikes', label: 'Likes' },
  { field: 'createdAt', label: 'Created' },
];

// Sort buttons use the ListSortField names; rows use shorter data-* attributes.
// The mapping is inlined into the client script so the two cannot drift apart.
export const LIST_SORT_ATTRIBUTES: Record<ListSortField, string> = {
  numBooks: 'books',
  numVoters: 'voters',
  numLikes: 'likes',
  createdAt: 'created',
};

export function renderAvgRatingHistogram(
  histogram: AvgRatingHistogramAccumulator,
  step: AvgRatingHistogramStep,
): string {
  const stepH = Math.round(step * 100);
  const rows = histogram.buckets[step].flatMap((count, index) => {
    if (count === 0) return [];
    const startH = index * stepH;
    const endH = Math.min((index + 1) * stepH, 501) - 1;
    const label =
      startH === endH
        ? (startH / 100).toFixed(2)
        : `${(startH / 100).toFixed(2)} to ${(endH / 100).toFixed(2)}`;
    const share = histogram.count > 0 ? ((count / histogram.count) * 100).toFixed(1) : '0.0';
    return [`<tr><td>${label}</td><td class="num">${formatCount(count)}</td><td class="num">${share}%</td></tr>`];
  });
  return [
    `<h2>${step.toFixed(1)} star buckets</h2>`,
    '<table>',
    '<thead><tr><th>Range</th><th class="num">Books</th><th class="num">Share</th></tr></thead>',
    '<tbody>',
    rows.length > 0 ? rows.join('\n') : '<tr><td colspan="3">No books matched this report.</td></tr>',
    '</tbody>',
    '</table>',
  ].join('\n');
}

export function renderAvgRatingHistogramPage(
  scope: BookScope,
  report: AvgRatingHistogramReport,
  acc: ScopeAccumulator,
): string {
  const histogram = acc.avgRatingHistograms[report.id];
  const intro = `Based on ${formatCount(histogram.count)} books with an average rating and at least ${formatCount(report.minRatings)} ratings (of ${formatCount(acc.total)} ${scopeUnitLabel(scope.id)} in scope). Only books with a scraped details page (book_page row) are included, matching <code>avgHistogram.sh --hasDetails</code>.`;
  return [`<p>${intro}</p>`, ...AVG_RATING_HISTOGRAM_STEPS.map((step) => renderAvgRatingHistogram(histogram, step))].join(
    '\n',
  );
}

export function renderListTable(rows: ListRow[], sortBy: ListSortField): string {
  if (rows.length === 0) return '<p>No lists matched this report.</p>';

  const labelOf = (field: ListSortField): string =>
    LIST_FIELDS.find((candidate) => candidate.field === field)!.label;
  const sortableHead = (field: ListSortField): string => {
    const cls = field === 'createdAt' ? '' : ' class="num"';
    return `<th${cls}><button type="button" class="sort-btn" data-sort="${field}">${escapeHtml(labelOf(field))} <span class="sort-arrow" aria-hidden="true"></span></button></th>`;
  };

  const body = rows
    .map((row, index) => {
      const title = escapeHtml(row.title || row.listId);
      const href = `https://www.goodreads.com/list/show/${encodeURIComponent(row.listId)}`;
      const creator = row.creatorId
        ? `<a href="https://www.goodreads.com/list/created/${encodeURIComponent(row.creatorId)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.creatorName || row.creatorId)}</a>`
        : escapeHtml(row.creatorName || '—');
      const likes = row.numLikes === null ? '—' : formatCount(row.numLikes);
      const likesValue = row.numLikes === null ? '' : String(row.numLikes);
      const created = row.createdAt ? escapeHtml(row.createdAt) : '—';
      const createdValue = row.createdAt ? escapeHtml(row.createdAt) : '';
      return `<tr data-list-id="${escapeHtml(row.listId)}" data-books="${row.numBooks}" data-voters="${row.numVoters}" data-likes="${likesValue}" data-created="${createdValue}"><td class="num">${index + 1}</td><td><a href="${href}" target="_blank" rel="noopener noreferrer">${title}</a></td><td class="num">${formatCount(row.numBooks)}</td><td class="num">${formatCount(row.numVoters)}</td><td class="num">${likes}</td><td>${created}</td><td>${creator}</td></tr>`;
    })
    .join('\n');

  const head = LIST_FIELDS.map((field) => sortableHead(field.field)).join('');
  return [
    `<table id="lists-table" data-default-sort="${sortBy}">`,
    `<thead><tr><th class="num">#</th><th>List</th>${head}<th>Creator</th></tr></thead>`,
    '<tbody>',
    body,
    '</tbody>',
    '</table>',
  ].join('\n');
}

export const LIST_SORT_SCRIPT = `
(function () {
  var table = document.querySelector('#lists-table');
  if (!table) return;
  var tbody = table.querySelector('tbody');
  if (!tbody) return;
  var rows = Array.prototype.slice.call(tbody.rows);
  var key = table.getAttribute('data-default-sort') || 'numBooks';
  var dir = (key === 'createdAt') ? 'asc' : 'desc';
  var dataAttrs = ${JSON.stringify(LIST_SORT_ATTRIBUTES)};
  function value(row, field) {
    var raw = row.getAttribute('data-' + (dataAttrs[field] || field));
    if (raw === null || raw === '') return null;
    return field === 'createdAt' ? raw : Number(raw);
  }
  function listId(row) {
    return row.getAttribute('data-list-id') || '';
  }
  function refresh() {
    Array.prototype.forEach.call(table.querySelectorAll('[data-sort]'), function (button) {
      var field = button.getAttribute('data-sort');
      var arrow = button.querySelector('.sort-arrow');
      if (arrow) arrow.textContent = field === key ? (dir === 'asc' ? '\\u2191' : '\\u2193') : '';
    });
  }
  function apply(field, direction) {
    key = field;
    dir = direction;
    rows.sort(function (a, b) {
      var av = value(a, field);
      var bv = value(b, field);
      if (av === null && bv === null) return listId(a) < listId(b) ? -1 : listId(a) > listId(b) ? 1 : 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (av !== bv) return (av < bv ? -1 : 1) * (direction === 'asc' ? 1 : -1);
      return listId(a) < listId(b) ? -1 : listId(a) > listId(b) ? 1 : 0;
    });
    rows.forEach(function (row) { tbody.appendChild(row); });
    refresh();
  }
  Array.prototype.forEach.call(table.querySelectorAll('[data-sort]'), function (button) {
    button.addEventListener('click', function () {
      var field = button.getAttribute('data-sort');
      apply(field, field === key && dir === 'desc' ? 'asc' : 'desc');
    });
  });
  refresh();
})();
`.trim();

const LIST_CREATOR_SORT_SCRIPT = `
(function () {
  var table = document.querySelector('#list-creators');
  if (!table) return;
  var tbody = table.querySelector('tbody');
  if (!tbody) return;
  var rows = Array.prototype.slice.call(tbody.rows);
  var key = 'lists';
  var dir = 'desc';
  function value(row, field) {
    var raw = row.getAttribute('data-' + field);
    return raw === null || raw === '' ? null : Number(raw);
  }
  function creatorId(row) {
    return row.getAttribute('data-creator-id') || '';
  }
  function refresh() {
    Array.prototype.forEach.call(table.querySelectorAll('[data-sort]'), function (button) {
      var field = button.getAttribute('data-sort');
      var arrow = button.querySelector('.sort-arrow');
      if (arrow) arrow.textContent = field === key ? (dir === 'asc' ? '\\u2191' : '\\u2193') : '';
    });
  }
  function apply(field, direction) {
    key = field;
    dir = direction;
    rows.sort(function (a, b) {
      var av = value(a, field);
      var bv = value(b, field);
      if (av === null && bv === null) return creatorId(a) < creatorId(b) ? -1 : creatorId(a) > creatorId(b) ? 1 : 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (av !== bv) return (av < bv ? -1 : 1) * (direction === 'asc' ? 1 : -1);
      return creatorId(a) < creatorId(b) ? -1 : creatorId(a) > creatorId(b) ? 1 : 0;
    });
    rows.forEach(function (row) { tbody.appendChild(row); });
    refresh();
  }
  Array.prototype.forEach.call(table.querySelectorAll('[data-sort]'), function (button) {
    button.addEventListener('click', function () {
      var field = button.getAttribute('data-sort');
      apply(field, field === key && dir === 'desc' ? 'asc' : 'desc');
    });
  });
  refresh();
})();
`.trim();

export function renderListCreatorTable(creators: ListCreatorRow[]): string {
  if (creators.length === 0) return '<p>No list creators matched this report.</p>';

  const sortableHead = (field: string, label: string): string =>
    `<th class="num"><button type="button" class="sort-btn" data-sort="${field}">${escapeHtml(label)} <span class="sort-arrow" aria-hidden="true"></span></button></th>`;

  const body = creators
    .map((creator, index) => {
      const name = escapeHtml(creator.creatorName || creator.creatorId);
      const href = `https://www.goodreads.com/list/created/${encodeURIComponent(creator.creatorId)}`;
      const likes = creator.hasLikes ? formatCount(creator.numLikes) : '—';
      const likesValue = creator.hasLikes ? String(creator.numLikes) : '';
      return `<tr data-creator-id="${escapeHtml(creator.creatorId)}" data-lists="${creator.numLists}" data-books="${creator.numBooks}" data-voters="${creator.numVoters}" data-likes="${likesValue}"><td class="num">${index + 1}</td><td><a href="${href}" target="_blank" rel="noopener noreferrer">${name}</a></td><td class="num">${formatCount(creator.numLists)}</td><td class="num">${formatCount(creator.numBooks)}</td><td class="num">${formatCount(creator.numVoters)}</td><td class="num">${likes}</td></tr>`;
    })
    .join('\n');

  return [
    '<table id="list-creators">',
    `<thead><tr><th class="num">#</th><th>Creator</th>${sortableHead('lists', 'Lists created')}${sortableHead('books', 'Books')}${sortableHead('voters', 'Voters')}${sortableHead('likes', 'Likes')}</tr></thead>`,
    '<tbody>',
    body,
    '</tbody>',
    '</table>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// List tags (unified list_tags xref)
// ---------------------------------------------------------------------------

export interface ListTagCount {
  tagName: string;
  lists: number;
}

export function loadListTagRows(limit: number): ListTagCount[] {
  return getDb()
    .prepare(
      `SELECT tag_name AS tagName, COUNT(*) AS lists
       FROM list_tags
       GROUP BY tag_name
       ORDER BY lists DESC, tag_name ASC
       LIMIT @limit`,
    )
    .all({ limit }) as ListTagCount[];
}

export function loadListTagNameSet(): Set<string> {
  const rows = getDb().prepare('SELECT DISTINCT tag_name FROM list_tags').all() as { tag_name: string }[];
  return new Set(rows.map((row) => row.tag_name.toLowerCase()));
}

export function renderListTagTable(rows: ListTagCount[]): string {
  if (rows.length === 0) return '<p>No list tags matched this report.</p>';

  const body = rows
    .map((row, index) => {
      const tag = escapeHtml(row.tagName);
      const href = `https://www.goodreads.com/list/tag/${encodeURIComponent(row.tagName)}`;
      return `<tr><td class="num">${index + 1}</td><td><a href="${href}" target="_blank" rel="noopener noreferrer">${tag}</a></td><td class="num">${formatCount(row.lists)}</td></tr>`;
    })
    .join('\n');

  return [
    '<table>',
    '<thead><tr><th class="num">#</th><th>Tag</th><th class="num">Lists</th></tr></thead>',
    '<tbody>',
    body,
    '</tbody>',
    '</table>',
  ].join('\n');
}

export function renderTagFirstPagePicksTable(rows: TagFirstPagePickRow[]): string {
  if (rows.length === 0) return '<p>No books matched this report.</p>';

  const body = rows
    .map((row, index) => {
      const title = escapeHtml(row.title || row.bookId);
      const href = `https://www.goodreads.com/book/show/${encodeURIComponent(row.bookId)}`;
      const author = renderAuthorLink(row.author, row.authorId || '');
      const avg = row.avgRating == null ? '—' : row.avgRating.toFixed(2);
      return `<tr><td class="num">${index + 1}</td><td><a href="${href}" target="_blank" rel="noopener noreferrer">${title}</a></td><td>${author}</td><td class="num">${formatCount(row.tagCount)}</td><td class="num">${formatCount(row.ratings)}</td><td class="num">${avg}</td></tr>`;
    })
    .join('\n');

  return [
    '<table>',
    '<thead><tr><th class="num">#</th><th>Title</th><th>Author</th><th class="num">First-page tags</th><th class="num">Ratings</th><th class="num">Avg</th></tr></thead>',
    '<tbody>',
    body,
    '</tbody>',
    '</table>',
  ].join('\n');
}

export function renderAuthorTopBookHistogram(data: AuthorTopBookHistogramData): string {
  const intro = `<p>For each author, take their highest-rated book (by rating count) and bin it. Authors: ${formatCount(data.totalAuthors)} — ${formatCount(data.inAuthorCache)} in author cache, ${formatCount(data.notInAuthorCache)} not.</p>`;
  const body = data.buckets.map((bucket, i) => {
    const count = data.counts[i] || 0;
    const pct = data.totalAuthors > 0 ? ((count / data.totalAuthors) * 100).toFixed(1) : '0.0';
    return `<tr><td>${escapeHtml(bucket.label)}</td><td class="num">${formatCount(count)}</td><td class="num">${pct}%</td><td class="num">${formatCount(data.cumGE[i] || 0)}</td><td class="num">${formatCount(data.cumLE[i] || 0)}</td></tr>`;
  }).join('\n');

  return [
    intro,
    '<table>',
    '<thead><tr><th>Rating bracket</th><th class="num">Count</th><th class="num">%</th><th class="num">CUM &gt;=</th><th class="num">CUM &lt;=</th></tr></thead>',
    '<tbody>',
    body,
    '</tbody>',
    '</table>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Highest Rated by Year rendering
// ---------------------------------------------------------------------------

export function renderYearTable(books: YearBook[], year: number): string {
  const intro = `<p>Books published in ${year} with at least ${formatCount(YEAR_MIN_RATINGS)} ratings, excluding flagged books. One edition per work (highest-ratings edition kept).</p>`;
  if (books.length === 0) return `${intro}\n<p>No books matched this report.</p>`;

  const ordered = [...books].sort((a, b) => compareYearWorstFirst(b, a));
  const rows = ordered.map((book, index) => {
    const title = escapeHtml(book.title || book.id);
    const href = `https://www.goodreads.com/book/show/${encodeURIComponent(book.id)}`;
    const author = renderAuthorLink(book.author, book.authorId);
    return `<tr><td class="num">${index + 1}</td><td><a href="${href}" target="_blank" rel="noopener noreferrer">${title}</a></td><td>${author}</td><td class="num">${book.avgRating.toFixed(2)}</td><td class="num">${formatCount(book.ratings)}</td><td class="num">${book.year}</td></tr>`;
  });
  return [
    intro,
    '<table>',
    '<thead><tr><th class="num">#</th><th>Title</th><th>Author</th><th class="num">Avg rating</th><th class="num"># ratings</th><th class="num">Published</th></tr></thead>',
    '<tbody>',
    rows.join('\n'),
    '</tbody>',
    '</table>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Titles rendering / second pass
// ---------------------------------------------------------------------------

// Pure over its input so the report rules are unit-testable without a DB.
export function computeTitleStats(titles: Iterable<string>): TitleStats {
  const firstCounts = new Map<string, number>();
  const lastCounts = new Map<string, number>();
  const wordCounts = new Map<string, number>();
  let total = 0;

  for (const raw of titles) {
    total++;
    const title = stripTitleSuffix(raw ?? '');
    if (!title) continue;

    const first = title.charAt(0);
    const last = title.charAt(title.length - 1);
    if (first) firstCounts.set(first, (firstCounts.get(first) ?? 0) + 1);
    if (last) lastCounts.set(last, (lastCounts.get(last) ?? 0) + 1);

    const word = extractFirstWord(raw ?? '');
    if (word) wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
  }

  const toCharRows = (counts: Map<string, number>): TitleCharCount[] =>
    [...counts.entries()]
      .map(([char, count]) => ({ char, count }))
      .filter((row) => row.count >= TITLE_MIN_BOOKS)
      .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.char.charCodeAt(0) - b.char.charCodeAt(0)));

  const firstWords = [...wordCounts.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.word.localeCompare(b.word)));

  return { total, firstChar: toCharRows(firstCounts), lastChar: toCharRows(lastCounts), firstWords };
}

// Second pass: stream only the title column (O(1) memory beyond the distinct
// characters/words) so the main book scan can stay narrow.
export function scanTitles(): TitleStats {
  return computeTitleStats(
    (function* () {
      for (const row of streamRows<{ title: string | null }>('SELECT title FROM books')) {
        yield row.title ?? '';
      }
    })(),
  );
}

export function renderFirstWordTable(words: TitleWordCount[], tagNames?: ReadonlySet<string>): string {
  if (words.length === 0) return '<p>No titles matched this report.</p>';

  const body = words
    .map(
      (row, index) =>
        `<tr><td class="num">${index + 1}</td><td>${renderTagLabel(row.word, tagNames)}</td><td class="num">${formatCount(row.count)}</td></tr>`,
    )
    .join('\n');

  return [
    '<table>',
    '<thead><tr><th class="num">#</th><th>First word</th><th class="num">Books</th></tr></thead>',
    '<tbody>',
    body,
    '</tbody>',
    '</table>',
  ].join('\n');
}

interface PageCountBucket {
  label: string;
  min: number;
  max: number; // inclusive; Infinity for open-ended
}

function buildPageCountBuckets(maxPages: number): PageCountBucket[] {
  const buckets: PageCountBucket[] = [{ label: '0', min: 0, max: 0 }];
  // 1-25, 26-50, ... up to 300
  for (let start = 1; start <= 276; start += 25) {
    const end = start + 24;
    buckets.push({ label: `${start}-${end}`, min: start, max: end });
  }
  // 301-350, ... up to 600
  for (let start = 301; start <= 551; start += 50) {
    const end = start + 49;
    buckets.push({ label: `${start}-${end}`, min: start, max: end });
  }
  // 601-700 and 100-wide buckets upward, covering maxPages
  if (maxPages >= 601) {
    let start = 601;
    while (start <= maxPages) {
      const end = start + 99;
      buckets.push({ label: `${start}-${end}`, min: start, max: end });
      start = end + 1;
    }
  }
  return buckets;
}

function pageCountBucketIndex(pages: number, buckets: PageCountBucket[]): number {
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    if (pages >= b.min && pages <= b.max) return i;
  }
  // Fallback: clamp into last bucket (should not happen if buckets cover max)
  return buckets.length - 1;
}

export function renderPageCountPage(frequency: Map<number, number>): string {
  let total = 0;
  let maxPages = 0;
  for (const [pages, count] of frequency) {
    total += count;
    if (pages > maxPages) maxPages = pages;
  }

  const buckets = buildPageCountBuckets(maxPages);
  const counts = buckets.map(() => 0);
  for (const [pages, count] of frequency) {
    if (pages < 0) continue;
    counts[pageCountBucketIndex(pages, buckets)] += count;
  }

  const rows = buckets.flatMap((bucket, index) => {
    const count = counts[index];
    if (count === 0) return [];
    const share = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
    return [`<tr><td>${escapeHtml(bucket.label)}</td><td class="num">${formatCount(count)}</td><td class="num">${share}%</td></tr>`];
  });

  return [
    `<p>Based on ${formatCount(total)} books with a page count.</p>`,
    '<table>',
    '<thead><tr><th>Pages</th><th class="num">Books</th><th class="num">Share</th></tr></thead>',
    '<tbody>',
    rows.join('\n'),
    '</tbody>',
    '</table>',
  ].join('\n');
}

export function renderPublisherTable(publishers: RankedPublisher[], sortBy: 'books' | 'totalRatings', tagNames?: ReadonlySet<string>): string {
  if (publishers.length === 0) return '<p>No publishers matched this report.</p>';

  const booksHead = '<th class="num">Books</th>';
  const ratingsHead = '<th class="num">Total ratings</th>';
  const head = sortBy === 'books' ? `${booksHead}${ratingsHead}` : `${ratingsHead}${booksHead}`;
  const rows = publishers.map((publisher, index) => {
    const books = `<td class="num">${formatCount(publisher.books)}</td>`;
    const ratings = `<td class="num">${formatCount(publisher.totalRatings)}</td>`;
    const cells = sortBy === 'books' ? `${books}${ratings}` : `${ratings}${books}`;
    return `<tr><td class="num">${index + 1}</td><td>${renderTagLabel(publisher.publisher, tagNames)}</td>${cells}</tr>`;
  });
  return [
    '<table>',
    `<thead><tr><th class="num">#</th><th>Publisher</th>${head}</tr></thead>`,
    '<tbody>',
    rows.join('\n'),
    '</tbody>',
    '</table>',
  ].join('\n');
}

function coverageRows(
  table: string,
  total: number,
  fields: Record<string, number>,
  distinct: Record<string, number> = {},
): FieldCoverageRow[] {
  return Object.entries(fields).map(([field, populated]) => ({
    table,
    field,
    populated: Number(populated) || 0,
    total,
    distinct: distinct[field] != null ? Number(distinct[field]) : undefined,
  }));
}

// A compact fieldCoverage.sh: per-table column population for the main tables.
export function loadFieldCoverageRows(): FieldCoverageRow[] {
  const db = getDb();
  const rows: FieldCoverageRow[] = [];

  const books = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN author_id IS NOT NULL THEN 1 ELSE 0 END) AS 'author_id',
      SUM(CASE WHEN ratings IS NOT NULL THEN 1 ELSE 0 END) AS 'ratings',
      SUM(CASE WHEN avg_rating IS NOT NULL THEN 1 ELSE 0 END) AS 'avg_rating',
      SUM(CASE WHEN published IS NOT NULL AND published NOT IN ('Unknown', 'null', '') THEN 1 ELSE 0 END) AS 'published',
      SUM(CASE WHEN pages IS NOT NULL THEN 1 ELSE 0 END) AS 'pages',
      SUM(CASE WHEN series_pos IS NOT NULL THEN 1 ELSE 0 END) AS 'series_pos',
      SUM(CASE WHEN genres IS NOT NULL AND genres != '' AND genres != '[]' THEN 1 ELSE 0 END) AS 'genres',
      SUM(CASE WHEN tags IS NOT NULL AND tags != '' AND tags != '{}' THEN 1 ELSE 0 END) AS 'tags',
      SUM(CASE WHEN work_id IS NOT NULL AND work_id != '' THEN 1 ELSE 0 END) AS 'work_id'
    FROM books
  `).get() as Record<string, number>;
  const booksDistinct = db.prepare(`
    SELECT
      COUNT(DISTINCT author_id) AS 'author_id',
      COUNT(DISTINCT avg_rating) AS 'avg_rating',
      COUNT(DISTINCT pages) AS 'pages',
      COUNT(DISTINCT series_pos) AS 'series_pos',
      COUNT(DISTINCT work_id) AS 'work_id'
    FROM books
  `).get() as Record<string, number>;
  rows.push(...coverageRows('books', Number(books.total), books, booksDistinct));

  const authors = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN average_rating IS NOT NULL THEN 1 ELSE 0 END) AS 'average_rating',
      SUM(CASE WHEN num_ratings IS NOT NULL AND num_ratings > 0 THEN 1 ELSE 0 END) AS 'num_ratings',
      SUM(CASE WHEN num_reviews IS NOT NULL AND num_reviews > 0 THEN 1 ELSE 0 END) AS 'num_reviews',
      SUM(CASE WHEN num_shelves IS NOT NULL AND num_shelves > 0 THEN 1 ELSE 0 END) AS 'num_shelves',
      SUM(CASE WHEN slug IS NOT NULL AND slug != '' THEN 1 ELSE 0 END) AS 'slug',
      SUM(CASE WHEN catalog_pages IS NOT NULL AND catalog_pages > 0 THEN 1 ELSE 0 END) AS 'catalog_pages',
      SUM(CASE WHEN source IS NOT NULL AND source != '' THEN 1 ELSE 0 END) AS 'source'
    FROM authors
  `).get() as Record<string, number>;
  const authorDistinct = db.prepare(`
    SELECT COUNT(DISTINCT slug) AS 'slug', COUNT(DISTINCT source) AS 'source' FROM authors
  `).get() as Record<string, number>;
  rows.push(...coverageRows('authors', Number(authors.total), authors, authorDistinct));

  const bookPage = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN publisher IS NOT NULL THEN 1 ELSE 0 END) AS 'publisher',
      SUM(CASE WHEN isbn13 IS NOT NULL THEN 1 ELSE 0 END) AS 'isbn13',
      SUM(CASE WHEN isbn10 IS NOT NULL THEN 1 ELSE 0 END) AS 'isbn10',
      SUM(CASE WHEN asin IS NOT NULL THEN 1 ELSE 0 END) AS 'asin',
      SUM(CASE WHEN format IS NOT NULL THEN 1 ELSE 0 END) AS 'format',
      SUM(CASE WHEN language IS NOT NULL THEN 1 ELSE 0 END) AS 'language',
      SUM(CASE WHEN description IS NOT NULL THEN 1 ELSE 0 END) AS 'description',
      SUM(CASE WHEN series IS NOT NULL THEN 1 ELSE 0 END) AS 'series',
      SUM(CASE WHEN reviews_count IS NOT NULL THEN 1 ELSE 0 END) AS 'reviews_count',
      SUM(CASE WHEN ratings_dist IS NOT NULL THEN 1 ELSE 0 END) AS 'ratings_dist',
      SUM(CASE WHEN currently_reading IS NOT NULL THEN 1 ELSE 0 END) AS 'currently_reading',
      SUM(CASE WHEN to_read IS NOT NULL THEN 1 ELSE 0 END) AS 'to_read',
      SUM(CASE WHEN editions_count IS NOT NULL THEN 1 ELSE 0 END) AS 'editions_count'
    FROM book_page
  `).get() as Record<string, number>;
  const bookPageDistinct = db.prepare(`
    SELECT
      COUNT(DISTINCT publisher) AS 'publisher',
      COUNT(DISTINCT format) AS 'format',
      COUNT(DISTINCT language) AS 'language'
    FROM book_page
  `).get() as Record<string, number>;
  rows.push(...coverageRows('book_page', Number(bookPage.total), bookPage, bookPageDistinct));

  const tagBooks = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN position IS NOT NULL THEN 1 ELSE 0 END) AS 'position',
      SUM(CASE WHEN shelved IS NOT NULL THEN 1 ELSE 0 END) AS 'shelved'
    FROM tag_books
  `).get() as Record<string, number>;
  const tagBooksDistinct = db.prepare(`
    SELECT COUNT(DISTINCT tag_name) AS 'tag_name', COUNT(DISTINCT book_id) AS 'book_id' FROM tag_books
  `).get() as Record<string, number>;
  rows.push(...coverageRows('tag_books', Number(tagBooks.total), tagBooks, tagBooksDistinct));

  const lists = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN title IS NOT NULL AND title != '' THEN 1 ELSE 0 END) AS 'title',
      SUM(CASE WHEN last_count IS NOT NULL THEN 1 ELSE 0 END) AS 'last_count',
      SUM(CASE WHEN seen_book_ids IS NOT NULL THEN 1 ELSE 0 END) AS 'seen_book_ids',
      SUM(CASE WHEN ingested IS NOT NULL THEN 1 ELSE 0 END) AS 'ingested',
      SUM(CASE WHEN discovery_page IS NOT NULL THEN 1 ELSE 0 END) AS 'discovery_page',
      SUM(CASE WHEN url IS NOT NULL AND url != '' THEN 1 ELSE 0 END) AS 'url'
    FROM lists
  `).get() as Record<string, number>;
  rows.push(...coverageRows('lists', Number(lists.total), lists));

  const listMeta = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN num_books IS NOT NULL THEN 1 ELSE 0 END) AS 'num_books',
      SUM(CASE WHEN num_voters IS NOT NULL THEN 1 ELSE 0 END) AS 'num_voters',
      SUM(CASE WHEN created_at IS NOT NULL THEN 1 ELSE 0 END) AS 'created_at',
      SUM(CASE WHEN created_at_raw IS NOT NULL THEN 1 ELSE 0 END) AS 'created_at_raw',
      SUM(CASE WHEN creator_id IS NOT NULL THEN 1 ELSE 0 END) AS 'creator_id',
      SUM(CASE WHEN creator_name IS NOT NULL THEN 1 ELSE 0 END) AS 'creator_name',
      SUM(CASE WHEN num_likes IS NOT NULL THEN 1 ELSE 0 END) AS 'num_likes'
    FROM list_meta
  `).get() as Record<string, number>;
  rows.push(...coverageRows('list_meta', Number(listMeta.total), listMeta));

  const listTags = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN first_seen IS NOT NULL THEN 1 ELSE 0 END) AS 'first_seen',
      SUM(CASE WHEN last_seen IS NOT NULL THEN 1 ELSE 0 END) AS 'last_seen',
      SUM(CASE WHEN from_sidebar = 1 THEN 1 ELSE 0 END) AS 'from_sidebar',
      SUM(CASE WHEN from_directory = 1 THEN 1 ELSE 0 END) AS 'from_directory'
    FROM list_tags
  `).get() as Record<string, number>;
  const listTagsDistinct = db.prepare(`
    SELECT COUNT(DISTINCT tag_name) AS 'tag_name', COUNT(DISTINCT list_id) AS 'list_id' FROM list_tags
  `).get() as Record<string, number>;
  rows.push(...coverageRows('list_tags', Number(listTags.total), listTags, listTagsDistinct));

  return rows;
}

export function renderFieldCoveragePage(rows: FieldCoverageRow[]): string {
  if (rows.length === 0) return '<p>No field coverage data.</p>';

  const tables: string[] = [];
  const byTable = new Map<string, FieldCoverageRow[]>();
  for (const row of rows) {
    let tableRows = byTable.get(row.table);
    if (!tableRows) {
      tableRows = [];
      byTable.set(row.table, tableRows);
      tables.push(row.table);
    }
    tableRows.push(row);
  }

  const parts = [
    '<p>Column population across the local database. Coverage is the share of rows with a non-NULL (and, for a few fields, non-empty/non-default) value.</p>',
  ];
  for (const table of tables) {
    const body = byTable.get(table)!.map((row) => {
      const pct = row.total > 0 ? ((row.populated / row.total) * 100).toFixed(1) : '0.0';
      const missing = row.total - row.populated;
      const distinct = row.distinct === undefined ? '—' : formatCount(row.distinct);
      return `<tr><td>${escapeHtml(row.field)}</td><td class="num">${formatCount(row.populated)}</td><td class="num">${formatCount(row.total)}</td><td class="num">${pct}%</td><td class="num">${formatCount(missing)}</td><td class="num">${distinct}</td></tr>`;
    });
    parts.push(`<h2>${escapeHtml(table)}</h2>`);
    parts.push('<table>');
    parts.push(
      '<thead><tr><th>Field</th><th class="num">Populated</th><th class="num">Total</th><th class="num">Coverage</th><th class="num">Missing</th><th class="num">Distinct</th></tr></thead>',
    );
    parts.push('<tbody>');
    parts.push(body.join('\n'));
    parts.push('</tbody>');
    parts.push('</table>');
  }
  return parts.join('\n');
}

type CoverageSubsetKey = 'all' | 'work' | 'works' | 'field' | 'worksWithField';
type CoverageTotalKey = 'totalAll' | 'totalWork' | 'totalWorks' | 'totalField' | 'totalWorksWithField';

const RATINGS_HISTOGRAM_SUBSETS: {
  key: CoverageSubsetKey;
  totalKey: CoverageTotalKey;
  label: string;
  description: string;
}[] = [
  { key: 'all', totalKey: 'totalAll', label: 'ALL', description: 'every cached book' },
  { key: 'work', totalKey: 'totalWork', label: 'WORK-ID', description: 'cached books with a non-empty work id' },
  { key: 'works', totalKey: 'totalWorks', label: 'WORKS', description: 'distinct works (one representative edition each)' },
  { key: 'field', totalKey: 'totalField', label: 'FIELD', description: 'cached books with a book_page field-coverage row' },
  {
    key: 'worksWithField',
    totalKey: 'totalWorksWithField',
    label: 'WORK+FIELD',
    description: 'a distinct work whose representative edition also has a book_page field-coverage row',
  },
];

function inclusivePrefix(counts: number[]): number[] {
  let acc = 0;
  return counts.map((count) => (acc += count));
}

export function renderOverallRatingsHistogram(
  counts: CoverageCounts,
  buckets: RatingBucket[] = buildRatingBuckets(),
): string {
  const rollups = new Map<CoverageSubsetKey, number[]>();
  for (const subset of RATINGS_HISTOGRAM_SUBSETS) {
    rollups.set(subset.key, inclusivePrefix(counts[subset.key]));
  }

  const groupHead = RATINGS_HISTOGRAM_SUBSETS.map(
    (subset) =>
      `<th colspan="2" class="num" title="${escapeHtml(subset.description)}">${escapeHtml(subset.label)}</th>`,
  ).join('');
  const subHead = RATINGS_HISTOGRAM_SUBSETS.map(
    () => '<th class="num">#</th><th class="num" title="This bracket and every higher one">↑</th>',
  ).join('');

  const body = buckets.map((bucket, index) => {
    const cells = RATINGS_HISTOGRAM_SUBSETS.map((subset) => {
      const count = counts[subset.key][index] ?? 0;
      const rollup = rollups.get(subset.key)![index] ?? 0;
      return `<td class="num${count === 0 ? ' zero' : ''}">${formatCount(count)}</td><td class="num${rollup === 0 ? ' zero' : ''}">${formatCount(rollup)}</td>`;
    }).join('');
    return `<tr><td>${escapeHtml(bucket.label)}</td>${cells}</tr>`;
  });

  const totalCells = RATINGS_HISTOGRAM_SUBSETS.map((subset) => {
    const total = counts[subset.totalKey];
    return `<td class="num">${formatCount(total)}</td><td class="num">${formatCount(total)}</td>`;
  }).join('');

  return [
    '<p class="legend">ALL = cached books · WORK-ID = has a work id · WORKS = distinct works (de-duplicated) · FIELD = has a book_page field-coverage row · WORK+FIELD = a distinct work whose representative edition also has a field-coverage row · ↑ = rollup (this bracket and above)</p>',
    '<table id="ratings-histogram">',
    `<thead><tr><th rowspan="2">Rating bracket</th>${groupHead}</tr><tr>${subHead}</tr></thead>`,
    '<tbody>',
    body.join('\n'),
    `<tr class="total"><td>Total</td>${totalCells}</tr>`,
    '</tbody>',
    '</table>',
  ].join('\n');
}

export interface PublicationYearSummary {
  years: { year: number; count: number }[];
  unknown: number;
  other: { label: string; count: number }[];
  total: number;
}

// HTML form of `summary-year`: every cached book grouped by the year parsed
// from `published`, plus the command's Unknown/unparseable buckets. Streams a
// narrow projection so the full books table is never materialized.
export function buildPublicationYearSummary(
  rows: Iterable<{ published: string | null }>,
): PublicationYearSummary {
  const yearCounts = new Map<number, number>();
  const otherCounts = new Map<string, number>();
  let unknown = 0;
  let total = 0;

  for (const row of rows) {
    total++;
    const year = getYear(row.published ?? '');
    if (year !== null) {
      yearCounts.set(year, (yearCounts.get(year) ?? 0) + 1);
    } else if (!row.published || row.published === 'Unknown') {
      unknown++;
    } else {
      otherCounts.set(row.published, (otherCounts.get(row.published) ?? 0) + 1);
    }
  }

  return {
    years: [...yearCounts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([year, count]) => ({ year, count })),
    unknown,
    other: [...otherCounts.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([label, count]) => ({ label, count })),
    total,
  };
}

export function loadPublicationYearSummary(): PublicationYearSummary {
  return buildPublicationYearSummary(streamRows<{ published: string | null }>('SELECT published FROM books'));
}

export function renderPublicationYearsPage(summary: PublicationYearSummary): string {
  const rows = summary.years.map(
    (row) => `<tr><td class="num">${row.year}</td><td class="num">${formatCount(row.count)}</td></tr>`,
  );
  if (summary.unknown > 0) {
    rows.push(`<tr class="muted"><td>Unknown</td><td class="num">${formatCount(summary.unknown)}</td></tr>`);
  }
  for (const row of summary.other) {
    rows.push(`<tr class="muted"><td>${escapeHtml(row.label)}</td><td class="num">${formatCount(row.count)}</td></tr>`);
  }

  return [
    '<p>Every cached book grouped by the year parsed from its <code>published</code> string — the HTML form of <code>summary-year</code>. Unparseable values are listed individually after the years.</p>',
    '<table id="publication-years">',
    '<thead><tr><th class="num">Year</th><th class="num">Books</th></tr></thead>',
    '<tbody>',
    rows.join('\n'),
    `<tr class="total"><td>Total books in cache</td><td class="num">${formatCount(summary.total)}</td></tr>`,
    '</tbody>',
    '</table>',
  ].join('\n');
}

export const BOOKS_ADDED_DAYS = 1000;

// HTML form of `books-added-histogram --days 1000`: one row per UTC day of
// `books.first_seen`, plus the command's footer totals. Avg/max ratings are for
// the books added that day (not cumulative), matching the CLI.
export function renderBooksAddedPage(summary: BooksAddedSummary): string {
  const pctOf = (n: number): string =>
    summary.totalBooks > 0 ? `${((n / summary.totalBooks) * 100).toFixed(1)}%` : '0.0%';

  const firstNonZero = summary.buckets.findIndex((bucket) => bucket.total > 0 || bucket.added > 0);
  const buckets = firstNonZero === -1 ? [] : summary.buckets.slice(firstNonZero);

  const rows = buckets.map((bucket) => {
    const avg = bucket.added > 0 ? formatCount(bucket.avgRatings) : '—';
    const max = bucket.added > 0 && bucket.maxRatings > 0 ? formatCount(bucket.maxRatings) : '—';
    return [
      '<tr>',
      `<td>${escapeHtml(bucket.start)}</td>`,
      `<td class="num">${formatCount(bucket.added)}</td>`,
      `<td class="num">${formatCount(bucket.total)}</td>`,
      `<td class="num">${escapeHtml(pctOf(bucket.total))}</td>`,
      `<td class="num">${avg}</td>`,
      `<td class="num">${max}</td>`,
      '</tr>',
    ].join('');
  });

  return [
    `<p>Books first seen per UTC day over the last ${formatCount(summary.buckets.length)} days (oldest first), driven by <code>books.first_seen</code> — the HTML form of <code>books-added-histogram --days ${formatCount(summary.buckets.length)}</code>.</p>`,
    '<table id="books-added">',
    '<thead><tr><th>Period</th><th class="num">Added</th><th class="num">Total</th><th class="num">Of DB</th><th class="num">Avg rating</th><th class="num">Max rating</th></tr></thead>',
    '<tbody>',
    rows.join('\n'),
    '</tbody>',
    '</table>',
    '<ul class="notes">',
    `<li>Total books in DB: ${formatCount(summary.totalBooks)}</li>`,
    `<li>${formatCount(summary.addedInWindow)} added in the window · ${formatCount(summary.beforeWindow)} predate the window (cumulative baseline, not in-window counts).</li>`,
    `<li>First-seen unknown for ${formatCount(summary.missingFirstSeen)} books (${escapeHtml(pctOf(summary.missingFirstSeen))} of DB) — excluded from the totals above.</li>`,
    '<li>Avg rating / max rating are among the books added that day, not cumulative.</li>',
    '</ul>',
    '<p class="note">Caveat: <code>first_seen</code> did not exist from the start. Older books were backfilled with <code>last_updated - 1 day</code>, so buckets before live stamping began are synthetic proxies, not real arrival times.</p>',
  ].join('\n');
}

// HTML form of `./authorHist.sh --by day`: every contiguous UTC day between the
// buffer-authors' earliest and latest first_seen, driven by authors.first_seen.
// Avg/max are `authors.num_ratings` among that day's additions (not cumulative).
export function renderAuthorsAddedPage(summary: AuthorArrivalSummary): string {
  const pctOf = (n: number): string =>
    summary.totalAuthors > 0 ? `${((n / summary.totalAuthors) * 100).toFixed(1)}%` : '0.0%';

  const rows = summary.buckets.map((bucket) => {
    const avg = bucket.added > 0 ? formatCount(bucket.avgRatings) : '—';
    const max = bucket.added > 0 && bucket.maxRatings > 0 ? formatCount(bucket.maxRatings) : '—';
    return [
      '<tr>',
      `<td>${escapeHtml(bucket.label)}</td>`,
      `<td class="num">${formatCount(bucket.added)}</td>`,
      `<td class="num">${formatCount(bucket.total)}</td>`,
      `<td class="num">${escapeHtml(pctOf(bucket.total))}</td>`,
      `<td class="num">${avg}</td>`,
      `<td class="num">${max}</td>`,
      '</tr>',
    ].join('');
  });

  const earliest = summary.earliestFirstSeen
    ? `<li>Earliest first_seen: ${escapeHtml(summary.earliestFirstSeen)}</li>`
    : '';

  return [
    `<p>Authors first seen per UTC day, spanning the earliest to latest <code>authors.first_seen</code> (oldest first) — the HTML form of <code>authorHist.sh --by day</code>.</p>`,
    '<table id="authors-added">',
    '<thead><tr><th>Period</th><th class="num">Added</th><th class="num">Total</th><th class="num">Of DB</th><th class="num">Avg rating</th><th class="num">Max rating</th></tr></thead>',
    '<tbody>',
    rows.join('\n'),
    '</tbody>',
    '</table>',
    '<ul class="notes">',
    `<li>Total authors in DB: ${formatCount(summary.totalAuthors)}</li>`,
    `<li>${formatCount(summary.addedInWindow)} added in the window · ${formatCount(summary.beforeWindow)} predate the window (cumulative baseline, not in-window counts).</li>`,
    `<li>First-seen unknown for ${formatCount(summary.missingFirstSeen)} authors (${escapeHtml(pctOf(summary.missingFirstSeen))} of DB) — excluded from the totals above.</li>`,
    '<li>Avg rating / max rating are among the authors added that day, not cumulative.</li>',
    earliest,
    '</ul>',
    '<p class="note">Caveat: <code>first_seen</code> did not exist from the start. Older authors were backfilled with <code>last_seen - 1 day</code>, so buckets before live stamping began are synthetic proxies, not real arrival times.</p>',
  ].join('\n');
}

const PAGE_CSS = `
:root { --bg:#fff; --fg:#222; --muted:#666; --border:#e3e3e3; --accent:#0b6bcb; --sidebar:#f7f7f8; }
* { box-sizing: border-box; }
body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; color:var(--fg); background:var(--bg); }
.layout { display:flex; min-height:100vh; }
.sidebar { width:260px; flex:0 0 260px; background:var(--sidebar); border-right:1px solid var(--border); padding:16px; position:sticky; top:0; height:100vh; overflow:auto; }
.sidebar .brand { font-weight:700; margin-bottom:16px; }
.nav-section { margin-bottom:16px; }
.nav-heading { font-size:0.72rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--muted); margin-bottom:6px; }
.nav-heading .soon { text-transform:none; letter-spacing:0; font-size:0.68rem; color:#aaa; }
.nav-section > summary { list-style:none; cursor:pointer; user-select:none; }
.nav-section > summary::-webkit-details-marker { display:none; }
.nav-section > summary::before { content:'▸ '; color:var(--muted); }
.nav-section[open] > summary::before { content:'▾ '; }
.nav-section > summary:hover { color:var(--fg); }
.sidebar ul { list-style:none; margin:0; padding:0; }
.sidebar li a { display:block; padding:4px 6px; border-radius:4px; color:var(--fg); text-decoration:none; font-size:0.88rem; }
.sidebar li a:hover { background:#e9e9ec; }
.sidebar li a.active { background:var(--accent); color:#fff; }
main { flex:1; padding:24px 32px; max-width:1200px; }
h1 { margin-top:0; }
h2 { margin-top:28px; }
.generated { font-size:0.8rem; color:var(--muted); margin-top:-8px; margin-bottom:24px; }
.scope-toggle { margin:0 0 16px; font-size:0.88rem; color:var(--muted); }
.scope-toggle strong { color:var(--fg); }
table { border-collapse:collapse; width:100%; font-size:0.88rem; }
th, td { border-bottom:1px solid var(--border); padding:6px 8px; text-align:left; }
th { position:sticky; top:0; background:#fff; }
td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
tbody tr:hover { background:#fafafa; }
a { color:var(--accent); }
button { font:inherit; padding:4px 10px; border:1px solid var(--border); background:#fff; border-radius:4px; cursor:pointer; }
button:hover { background:#e9e9ec; }
.sort-btn { padding:0; border:0; background:transparent; color:inherit; font:inherit; cursor:pointer; white-space:nowrap; }
.sort-btn:hover { background:transparent; text-decoration:underline; }
.sort-arrow { display:inline-block; min-width:0.8em; }
.zero { color:var(--muted); }
.sort-controls { margin:12px 0; }
@media (max-width:720px) { .layout { display:block; } .sidebar { width:auto; height:auto; position:static; } main { padding:16px; } }
`.trim();

export interface RenderPageOptions {
  title: string;
  nav: NavSection[];
  activeId: string | null;
  rootPrefix: string;
  content: string;
  generatedAt: string;
  script?: string;
}

export function renderPage(options: RenderPageOptions): string {
  const { title, nav, activeId, rootPrefix, content, generatedAt, script } = options;
  const scriptTag = script ? `\n<script>${script}</script>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Goodreads data</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<div class="layout">
${renderNav(nav, activeId, rootPrefix)}
<main>
<h1>${escapeHtml(title)}</h1>
<p class="generated">Last generated: ${escapeHtml(formatGeneratedAt(generatedAt))}</p>
${content}
</main>
</div>${scriptTag}
</body>
</html>
`;
}

let tempSeq = 0;

// Write to a sibling temp file, then rename over the target. rename(2) is
// atomic on the same filesystem, so a reader sees the old or the new file,
// never a partial one. The target's directory is created if needed.
export function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${tempSeq++}`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, filePath);
}

export async function runPublishSite(options: PublishOptions = {}): Promise<void> {
  const outDir = path.resolve(options.out || 'publish');
  const parsedLimit = parseInt(options.limit || '1000', 10);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 1000;
  const nav = buildNav();

  let written = 0;
  // Write each page as soon as it is generated. The `Last generated` stamp is
  // taken at write time, so files that appear earlier carry earlier stamps.
  const writePage = (file: string, page: Omit<RenderPageOptions, 'generatedAt'>): void => {
    writeFileAtomic(file, renderPage({ ...page, generatedAt: new Date().toISOString() }));
    written++;
  };

  for (const report of AUTHOR_REPORTS) {
    const { authors } = selectAuthors(iterateAuthors(), {
      sortBy: report.sortBy,
      minRatings: String(report.minRatings),
      limit: String(limit),
      direction: report.direction,
    });
    writePage(path.join(outDir, `${report.id}.html`), {
      title: report.title,
      nav,
      activeId: report.id,
      rootPrefix: '../',
      content: renderAuthorTable(authors, report.sortBy),
    });
    console.log(chalk.gray(`   ${report.title}: ${authors.length} author(s)`));
  }

  console.log(chalk.gray('   Scanning books and book_page for book reports...'));
  const accumulators = createAccumulators();
  const pageFrequency = new Map<number, number>();
  const yearHeaps = new Map<number, YearBook[]>();
  scanBooks(accumulators, pageFrequency, limit, yearHeaps);
  scanEnglishWorks(accumulators, limit);
  resolveBookTitles(accumulators, yearHeaps);
  scanBookPages(accumulators, limit);

  for (const scope of BOOK_SCOPES) {
    const acc = accumulators[scope.id];
    for (const metric of BOOK_METRICS) {
      writePage(path.join(outDir, scope.id, `${metric.id}.html`), {
        title: `${scope.label} — ${metric.navLabel}`,
        nav,
        activeId: `${scope.id}/${metric.id}`,
        rootPrefix: '../',
        content: renderScopeToggle(scope, metric.id) + renderBookMetricPage(scope, metric, acc, limit),
      });
    }
    for (const report of DERIVED_REPORTS) {
      writePage(path.join(outDir, scope.id, `${report.id}.html`), {
        title: `${scope.label} — ${report.title}`,
        nav,
        activeId: `${scope.id}/${report.id}`,
        rootPrefix: '../',
        content: renderScopeToggle(scope, report.id) + renderDerivedPage(scope, report, acc, limit),
      });
    }
    for (const report of AVG_RATING_HISTOGRAM_REPORTS) {
      writePage(path.join(outDir, scope.id, `${report.id}.html`), {
        title: `${scope.label} — ${report.title}`,
        nav,
        activeId: `${scope.id}/${report.id}`,
        rootPrefix: '../',
        content: renderScopeToggle(scope, report.id) + renderAvgRatingHistogramPage(scope, report, acc),
      });
    }
    console.log(chalk.gray(`   ${scope.label}: ${formatCount(acc.total)} books`));
  }

  console.log(chalk.gray('   Writing highest-rated-by-year pages...'));
  for (const report of YEAR_REPORTS) {
    writePage(path.join(outDir, `${report.id}.html`), {
      title: report.title,
      nav,
      activeId: report.id,
      rootPrefix: '../',
      content: renderYearTable(yearHeaps.get(report.year) ?? [], report.year),
    });
  }
  console.log(chalk.gray(`   Highest Rated by Year: ${YEAR_REPORTS.length} year(s)`));

  console.log(chalk.gray('   Scanning titles for title reports...'));
  const titleStats = scanTitles();
  const listTagNames = loadListTagNameSet();
  const [firstCharReport, lastCharReport, firstWordReport] = TITLE_REPORTS;
  writePage(path.join(outDir, `${firstCharReport.id}.html`), {
    title: firstCharReport.title,
    nav,
    activeId: firstCharReport.id,
    rootPrefix: '../',
    content: renderFrequencyPage(
      `Books per first character of the title (characters with at least ${formatCount(TITLE_MIN_BOOKS)} books).`,
      titleStats.firstChar.map((row) => ({ label: row.char, count: row.count })),
      titleStats.total,
      'First character',
      listTagNames,
    ),
  });
  writePage(path.join(outDir, `${lastCharReport.id}.html`), {
    title: lastCharReport.title,
    nav,
    activeId: lastCharReport.id,
    rootPrefix: '../',
    content: renderFrequencyPage(
      `Books per last character of the title (characters with at least ${formatCount(TITLE_MIN_BOOKS)} books).`,
      titleStats.lastChar.map((row) => ({ label: row.char, count: row.count })),
      titleStats.total,
      'Last character',
    ),
  });
  const topWords = titleStats.firstWords.slice(0, limit);
  writePage(path.join(outDir, `${firstWordReport.id}.html`), {
    title: firstWordReport.title,
    nav,
    activeId: firstWordReport.id,
    rootPrefix: '../',
    content: `<p>Top ${formatCount(topWords.length)} first words across ${formatCount(titleStats.total)} books.</p>\n${renderFirstWordTable(topWords, listTagNames)}`,
  });
  console.log(
    chalk.gray(
      `   Titles: ${formatCount(titleStats.total)} books · ${titleStats.firstChar.length}/${titleStats.lastChar.length} chars · ${topWords.length} first word(s)`,
    ),
  );

  const db = getDb();
  const loadFrequency = (column: 'language' | 'format'): { label: string; count: number }[] =>
    db
      .prepare(
        `SELECT COALESCE(NULLIF(${column}, ''), '(none)') AS label, COUNT(*) AS count FROM book_page GROUP BY label ORDER BY count DESC`,
      )
      .all() as { label: string; count: number }[];

  const languageRows = loadFrequency('language');
  const languageTotal = languageRows.reduce((sum, row) => sum + row.count, 0);
  writePage(path.join(outDir, 'book-detail', 'by-language.html'), {
    title: 'Book Detail — Books by Language',
    nav,
    activeId: 'book-detail/by-language',
    rootPrefix: '../',
    content: renderFrequencyPage(
      `Based on ${formatCount(languageTotal)} books with detail data.`,
      languageRows,
      languageTotal,
      'Language',
    ),
  });

  const formatRows = loadFrequency('format');
  const formatTotal = formatRows.reduce((sum, row) => sum + row.count, 0);
  writePage(path.join(outDir, 'book-detail', 'by-format.html'), {
    title: 'Book Detail — Books by Format',
    nav,
    activeId: 'book-detail/by-format',
    rootPrefix: '../',
    content: renderFrequencyPage(
      `Based on ${formatCount(formatTotal)} books with detail data.`,
      formatRows,
      formatTotal,
      'Format',
    ),
  });

  writePage(path.join(outDir, 'book-detail', 'by-page-count.html'), {
    title: 'Book Detail — Books by Page Count',
    nav,
    activeId: 'book-detail/by-page-count',
    rootPrefix: '../',
    content: renderPageCountPage(pageFrequency),
  });

  console.log(chalk.gray('   Loading publishers...'));
  const publisherRows = loadPublisherRows();
  for (const report of PUBLISHER_REPORTS) {
    const publishers = computePublisherCatalog(publisherRows, {
      sortBy: report.sortBy,
      limit: String(PUBLISHER_REPORT_LIMIT),
    });
    const metric = report.sortBy === 'books' ? 'number of books' : 'total ratings';
    writePage(path.join(outDir, `${report.id}.html`), {
      title: report.title,
      nav,
      activeId: report.id,
      rootPrefix: '../',
      content: `<p>Top ${formatCount(PUBLISHER_REPORT_LIMIT)} publishers by ${metric} (distinct works; each (publisher, work) is counted once using its highest-rated edition).</p>\n${renderPublisherTable(publishers, report.sortBy, listTagNames)}`,
    });
    console.log(chalk.gray(`   ${report.title}: ${publishers.length} publisher(s)`));
  }

  console.log(chalk.gray('   Loading lists...'));
  const listRows = loadListRows();
  const listsWithLikes = listRows.filter((row) => row.numLikes !== null).length;
  for (const report of LIST_REPORTS) {
    const sorted = sortListRows(listRows, report).slice(0, limit);
    const intro =
      report.sortBy === 'numLikes'
        ? `Based on ${formatCount(listsWithLikes)} lists with likes data (of ${formatCount(listRows.length)} lists).`
        : `${formatCount(listRows.length)} lists.`;
    writePage(path.join(outDir, `${report.id}.html`), {
      title: report.title,
      nav,
      activeId: report.id,
      rootPrefix: '../',
      content: `<p>${intro} Click a column heading to sort.</p>\n${renderListTable(sorted, report.sortBy)}`,
      script: LIST_SORT_SCRIPT,
    });
    console.log(chalk.gray(`   ${report.title}: ${sorted.length} list(s)`));
  }

  const staticLists = listRows
    .filter((row) => row.isStatic)
    .sort((a, b) => (Number(a.listId) || 0) - (Number(b.listId) || 0));
  writePage(path.join(outDir, `${STATIC_LISTS_REPORT.id}.html`), {
    title: STATIC_LISTS_REPORT.title,
    nav,
    activeId: STATIC_LISTS_REPORT.id,
    rootPrefix: '../',
    content: `<p>${formatCount(staticLists.length)} static lists (is_static=1), ordered by list ID. Click a column heading to sort.</p>\n${renderListTable(staticLists, 'createdAt')}`,
    script: LIST_SORT_SCRIPT,
  });
  console.log(chalk.gray(`   ${STATIC_LISTS_REPORT.title}: ${staticLists.length} list(s)`));

  const allCreators = aggregateListCreators(listRows);
  const topCreators = sortListCreators(allCreators).slice(0, limit);
  writePage(path.join(outDir, `${LIST_CREATOR_REPORT.id}.html`), {
    title: LIST_CREATOR_REPORT.title,
    nav,
    activeId: LIST_CREATOR_REPORT.id,
    rootPrefix: '../',
    content: `<p>Based on ${formatCount(allCreators.length)} list creators across ${formatCount(listRows.length)} lists. Click a column heading to sort.</p>\n${renderListCreatorTable(topCreators)}`,
    script: LIST_CREATOR_SORT_SCRIPT,
  });
  console.log(chalk.gray(`   ${LIST_CREATOR_REPORT.title}: ${topCreators.length} creator(s)`));

  console.log(chalk.gray('   Loading list tags...'));
  const listTagRows = loadListTagRows(limit);
  writePage(path.join(outDir, `${LIST_TAG_REPORT.id}.html`), {
    title: LIST_TAG_REPORT.title,
    nav,
    activeId: LIST_TAG_REPORT.id,
    rootPrefix: '../',
    content: `<p>Top ${formatCount(listTagRows.length)} list tags by number of lists (from the unified list_tags xref).</p>\n${renderListTagTable(listTagRows)}`,
  });
  console.log(chalk.gray(`   ${LIST_TAG_REPORT.title}: ${listTagRows.length} tag(s)`));

  console.log(chalk.gray('   Loading books on first page of tags...'));
  const firstPagePicks = loadTagFirstPagePicks({ limit: TAG_FIRST_PAGE_LIMIT });
  writePage(path.join(outDir, `${TAG_FIRST_PAGE_REPORT.id}.html`), {
    title: TAG_FIRST_PAGE_REPORT.title,
    nav,
    activeId: TAG_FIRST_PAGE_REPORT.id,
    rootPrefix: '../',
    content: `<p>Books appearing on the most tag first pages (positions 1–50), based on ${formatCount(firstPagePicks.totalTags)} tags and ${formatCount(firstPagePicks.totalDistinctBooks)} distinct first-page books (${formatCount(firstPagePicks.uncached)} not in cache). Top ${formatCount(firstPagePicks.picks.length)} shown.</p>\n${renderTagFirstPagePicksTable(firstPagePicks.picks)}`,
  });
  console.log(chalk.gray(`   ${TAG_FIRST_PAGE_REPORT.title}: ${firstPagePicks.picks.length} book(s)`));

  console.log(chalk.gray('   Loading author top-book ratings histogram...'));
  const authorTopBookHistogram = loadAuthorTopBookHistogram();
  writePage(path.join(outDir, `${AUTHOR_TOP_BOOK_HISTOGRAM_REPORT.id}.html`), {
    title: AUTHOR_TOP_BOOK_HISTOGRAM_REPORT.title,
    nav,
    activeId: AUTHOR_TOP_BOOK_HISTOGRAM_REPORT.id,
    rootPrefix: '../',
    content: renderAuthorTopBookHistogram(authorTopBookHistogram),
  });
  console.log(chalk.gray(`   ${AUTHOR_TOP_BOOK_HISTOGRAM_REPORT.title}: ${authorTopBookHistogram.totalAuthors} author(s)`));

  console.log(chalk.gray('   Loading field coverage...'));
  const fieldCoverageRows = loadFieldCoverageRows();
  writePage(path.join(outDir, 'per-field.html'), {
    title: 'Per Field',
    nav,
    activeId: 'overall/per-field',
    rootPrefix: '',
    content: renderFieldCoveragePage(fieldCoverageRows),
  });
  console.log(chalk.gray(`   Per Field: ${fieldCoverageRows.length} field(s)`));

  console.log(chalk.gray('   Loading ratings coverage...'));
  const ratingsCoverage = loadCoverageCounts();
  writePage(path.join(outDir, 'ratings-histogram.html'), {
    title: 'Ratings Histogram',
    nav,
    activeId: 'overall/ratings-histogram',
    rootPrefix: '',
    content: renderOverallRatingsHistogram(ratingsCoverage),
  });
  console.log(chalk.gray(`   Ratings Histogram: ${formatCount(ratingsCoverage.totalAll)} book(s)`));

  console.log(chalk.gray('   Loading publication years...'));
  const publicationYears = loadPublicationYearSummary();
  writePage(path.join(outDir, 'publication-years.html'), {
    title: 'Publication Years',
    nav,
    activeId: 'overall/publication-years',
    rootPrefix: '',
    content: renderPublicationYearsPage(publicationYears),
  });
  console.log(chalk.gray(`   Publication Years: ${formatCount(publicationYears.total)} book(s)`));

  console.log(chalk.gray('   Loading books added by day...'));
  const booksAdded = loadBooksAddedBuckets({ days: BOOKS_ADDED_DAYS });
  writePage(path.join(outDir, 'books-added.html'), {
    title: 'Books Added',
    nav,
    activeId: 'overall/books-added',
    rootPrefix: '',
    content: renderBooksAddedPage(booksAdded),
  });
  console.log(chalk.gray(`   Books Added: ${formatCount(booksAdded.addedInWindow)} in the last ${BOOKS_ADDED_DAYS} days`));

  console.log(chalk.gray('   Loading authors added by day...'));
  const authorsAdded = loadAuthorArrivalBuckets();
  writePage(path.join(outDir, 'authors-added.html'), {
    title: 'Authors Added',
    nav,
    activeId: 'overall/authors-added',
    rootPrefix: '',
    content: renderAuthorsAddedPage(authorsAdded),
  });
  console.log(chalk.gray(`   Authors Added: ${formatCount(authorsAdded.addedInWindow)} across ${formatCount(authorsAdded.buckets.length)} day(s)`));

  writePage(path.join(outDir, 'index.html'), {
    title: 'Overview',
    nav,
    activeId: 'overall',
    rootPrefix: '',
    content: renderOverview(nav, limit),
  });

  console.log(chalk.green.bold(`\n📄 Published ${written} pages to ${outDir}`));
}
