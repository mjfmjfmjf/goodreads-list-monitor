import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { iterateAuthors, streamRows } from './storage.ts';
import { getDb } from './db.ts';
import { selectAuthors, type SelectedAuthor } from './authorTopStats.ts';

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
}

export const AUTHOR_REPORTS: AuthorReport[] = [
  { id: 'author/top-authors-by-ratings', title: 'Top Authors by Ratings', sortBy: 'numRatings', minRatings: 0 },
  { id: 'author/top-authors-by-reviews', title: 'Top Authors by Reviews', sortBy: 'numReviews', minRatings: 0 },
  { id: 'author/top-authors-by-shelves', title: 'Top Authors by Shelves', sortBy: 'numShelves', minRatings: 0 },
  { id: 'author/top-authors-by-catalog-pages', title: 'Top Authors by Catalog Pages', sortBy: 'catalogPages', minRatings: 0 },
  { id: 'author/top-authors-by-avg-rating-min-100k', title: 'Top Authors by Avg Rating (min 100k ratings)', sortBy: 'averageRating', minRatings: 100000 },
  { id: 'author/top-authors-by-avg-rating-min-10k', title: 'Top Authors by Avg Rating (min 10k ratings)', sortBy: 'averageRating', minRatings: 10000 },
];

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

export type BookScopeId = 'book-id' | 'work-id' | 'works';

export interface BookScope {
  id: BookScopeId;
  label: string;
}

export const BOOK_SCOPES: BookScope[] = [
  { id: 'book-id', label: 'Book ID' },
  { id: 'work-id', label: 'Work ID' },
  { id: 'works', label: 'Works' },
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

// Sections with no items render a muted "soon" badge instead of dead links.
export function buildNav(): NavSection[] {
  const bookSections: NavSection[] = BOOK_SCOPES.map((scope) => ({
    label: scope.label,
    items: BOOK_METRICS.map((metric) => ({
      id: `${scope.id}/${metric.id}`,
      label: metric.navLabel,
      href: `${scope.id}/${metric.id}.html`,
    })),
  }));

  return [
    { label: 'Overall', items: [{ id: 'overall', label: 'Overview', href: 'index.html' }] },
    {
      label: 'Author',
      items: AUTHOR_REPORTS.map((report) => ({
        id: report.id,
        label: report.title,
        href: `${report.id}.html`,
      })),
    },
    ...bookSections,
    {
      label: 'Book Detail',
      items: BOOK_DETAIL_REPORTS.map((report) => ({
        id: report.id,
        label: report.navLabel,
        href: `${report.id}.html`,
      })),
    },
    { label: 'Titles', items: [] },
    { label: 'Highest Rated by Year', items: [] },
    { label: 'Lists', items: [] },
    { label: 'Genres', items: [] },
    { label: 'Tags', items: [] },
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
    const soon = section.items.length === 0 ? ' <span class="soon">soon</span>' : '';
    parts.push('<div class="nav-section">');
    parts.push(`<div class="nav-heading">${escapeHtml(section.label)}${soon}</div>`);
    if (section.items.length > 0) {
      parts.push('<ul>');
      for (const item of section.items) {
        const active = item.id === activeId ? ' class="active"' : '';
        parts.push(`<li><a${active} href="${rootPrefix}${item.href}">${escapeHtml(item.label)}</a></li>`);
      }
      parts.push('</ul>');
    }
    parts.push('</div>');
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

export interface ScopeAccumulator {
  // Total books in the scope (from `books`), used as the ratings denominator.
  total: number;
  metrics: Record<BookMetricId, MetricAccumulator>;
}

export type Accumulators = Record<BookScopeId, ScopeAccumulator>;

interface BooksRow {
  id: string;
  ratings: number | null;
  work_id: string | null;
  is_work_rep: number | null;
  pages: number | null;
}

interface BookPageRow {
  id: string;
  title: string | null;
  author: string | null;
  work_id: string | null;
  is_work_rep: number | null;
  reviews_count: string | null;
  currently_reading: number | null;
  to_read: number | null;
  editions_count: number | null;
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

function siftUp(heap: TopBook[], index: number): void {
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (compareWorstFirst(heap[index], heap[parent]) >= 0) break;
    [heap[index], heap[parent]] = [heap[parent], heap[index]];
    index = parent;
  }
}

function siftDown(heap: TopBook[], index: number): void {
  const length = heap.length;
  for (;;) {
    const left = index * 2 + 1;
    const right = left + 1;
    let smallest = index;
    if (left < length && compareWorstFirst(heap[left], heap[smallest]) < 0) smallest = left;
    if (right < length && compareWorstFirst(heap[right], heap[smallest]) < 0) smallest = right;
    if (smallest === index) break;
    [heap[index], heap[smallest]] = [heap[smallest], heap[index]];
    index = smallest;
  }
}

function pushTop(heap: TopBook[], book: TopBook, limit: number): void {
  if (heap.length < limit) {
    heap.push(book);
    siftUp(heap, heap.length - 1);
    return;
  }
  if (compareWorstFirst(book, heap[0]) > 0) {
    heap[0] = book;
    siftDown(heap, 0);
  }
}

function addValue(acc: MetricAccumulator, value: number, book: TopBook, limit: number): void {
  acc.count++;
  acc.counts[bucketIndex(value, acc.buckets)]++;
  pushTop(acc.heap, book, limit);
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
  return {
    'book-id': { total: 0, metrics: makeMetrics() },
    'work-id': { total: 0, metrics: makeMetrics() },
    works: { total: 0, metrics: makeMetrics() },
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
export function scanBooks(accumulators: Accumulators, pageFrequency: Map<number, number>, limit: number): void {
  const sql = 'SELECT id, ratings, work_id, is_work_rep, pages FROM books';
  for (const row of streamRows<BooksRow>(sql)) {
    const value = toInt(row.ratings) ?? 0;
    const book: TopBook = {
      id: String(row.id),
      title: '',
      author: '',
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

    const pages = toInt(row.pages);
    if (pages !== null && pages > 0) pageFrequency.set(pages, (pageFrequency.get(pages) ?? 0) + 1);
  }
}

// Fill in title/author for the ratings top-N ids collected by scanBooks.
export function resolveBookTitles(accumulators: Accumulators): void {
  const ids = new Set<string>();
  for (const scope of BOOK_SCOPES) {
    for (const book of accumulators[scope.id].metrics.ratings.heap) ids.add(book.id);
  }
  if (ids.size === 0) return;

  const idList = [...ids];
  const metadata = new Map<string, { title: string; author: string }>();
  const db = getDb();
  for (let offset = 0; offset < idList.length; offset += 500) {
    const chunk = idList.slice(offset, offset + 500);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id, title, author FROM books WHERE id IN (${placeholders})`)
      .all(...chunk) as { id: string; title: string | null; author: string | null }[];
    for (const row of rows) {
      metadata.set(String(row.id), { title: row.title ?? '', author: row.author ?? '' });
    }
  }

  for (const scope of BOOK_SCOPES) {
    for (const book of accumulators[scope.id].metrics.ratings.heap) {
      const found = metadata.get(book.id);
      if (found) {
        book.title = found.title;
        book.author = found.author;
      }
    }
  }
}

export function scanBookPages(accumulators: Accumulators, limit: number): void {
  const sql = `
    SELECT bp.book_id AS id, bp.reviews_count, bp.currently_reading, bp.to_read, bp.editions_count,
           b.title, b.author, b.work_id, b.is_work_rep
    FROM book_page bp
    JOIN books b ON b.id = bp.book_id
  `;
  const bookPageMetrics = BOOK_METRICS.filter((metric) => metric.source === 'book_page');
  for (const row of streamRows<BookPageRow>(sql)) {
    addBookPageMetrics(accumulators['book-id'], row, bookPageMetrics, limit);
    const hasWorkId = row.work_id !== null && row.work_id !== '';
    if (hasWorkId) addBookPageMetrics(accumulators['work-id'], row, bookPageMetrics, limit);
    if (Number(row.is_work_rep) === 1) addBookPageMetrics(accumulators.works, row, bookPageMetrics, limit);
  }
}

// ---------------------------------------------------------------------------
// Book rendering
// ---------------------------------------------------------------------------

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
    const author = escapeHtml(book.author || '—');
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

  if (metric.source === 'books') {
    parts.push(`<p>${formatCount(acc.total)} books in scope.</p>`);
  } else {
    parts.push(
      `<p>Based on ${formatCount(metricAcc.count)} books with ${escapeHtml(metric.label.toLowerCase())} data (of ${formatCount(acc.total)} books in scope).</p>`,
    );
  }

  parts.push('<h2>Distribution</h2>');
  parts.push(renderHistogram(metricAcc, denominator));
  parts.push(`<h2>Top ${formatCount(Math.min(limit, metricAcc.heap.length))}</h2>`);
  parts.push(renderTopBooks(metricAcc.heap, metric, showWorkId));
  return parts.join('\n');
}

export function renderFrequencyPage(
  intro: string,
  values: { label: string; count: number }[],
  total: number,
  heading: string,
): string {
  const rows = values.map((value) => {
    const share = total > 0 ? ((value.count / total) * 100).toFixed(1) : '0.0';
    return `<tr><td>${escapeHtml(value.label)}</td><td class="num">${formatCount(value.count)}</td><td class="num">${share}%</td></tr>`;
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

const PAGE_COUNT_SORT_SCRIPT = `
(function () {
  var tbody = document.querySelector('#page-counts tbody');
  if (!tbody) return;
  var rows = Array.prototype.slice.call(tbody.rows);
  function sortBy(key) {
    rows.sort(function (a, b) {
      var av = Number(a.getAttribute('data-' + key));
      var bv = Number(b.getAttribute('data-' + key));
      if (key === 'count') return bv - av;
      return av - bv;
    });
    rows.forEach(function (row) { tbody.appendChild(row); });
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-sort]'), function (button) {
    button.addEventListener('click', function () { sortBy(button.getAttribute('data-sort')); });
  });
  sortBy('page');
})();
`.trim();

export function renderPageCountPage(frequency: Map<number, number>): string {
  const entries = [...frequency.entries()].sort((a, b) => a[0] - b[0]);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  const rows = entries.map(([pages, count]) => {
    const share = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
    return `<tr data-page="${pages}" data-count="${count}"><td class="num">${formatCount(pages)}</td><td class="num">${formatCount(count)}</td><td class="num">${share}%</td></tr>`;
  });
  return [
    `<p>Based on ${formatCount(total)} books with a page count.</p>`,
    '<p class="sort-controls">Sort by: <button type="button" data-sort="page">Page count</button> <button type="button" data-sort="count">Number of books</button></p>',
    '<table id="page-counts">',
    '<thead><tr><th class="num">Pages</th><th class="num">Books</th><th class="num">Share</th></tr></thead>',
    '<tbody>',
    rows.join('\n'),
    '</tbody>',
    '</table>',
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
.sidebar ul { list-style:none; margin:0; padding:0; }
.sidebar li a { display:block; padding:4px 6px; border-radius:4px; color:var(--fg); text-decoration:none; font-size:0.88rem; }
.sidebar li a:hover { background:#e9e9ec; }
.sidebar li a.active { background:var(--accent); color:#fff; }
main { flex:1; padding:24px 32px; max-width:1200px; }
h1 { margin-top:0; }
h2 { margin-top:28px; }
.generated { font-size:0.8rem; color:var(--muted); margin-top:-8px; margin-bottom:24px; }
table { border-collapse:collapse; width:100%; font-size:0.88rem; }
th, td { border-bottom:1px solid var(--border); padding:6px 8px; text-align:left; }
th { position:sticky; top:0; background:#fff; }
td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
tbody tr:hover { background:#fafafa; }
a { color:var(--accent); }
button { font:inherit; padding:4px 10px; border:1px solid var(--border); background:#fff; border-radius:4px; cursor:pointer; }
button:hover { background:#e9e9ec; }
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
  scanBooks(accumulators, pageFrequency, limit);
  resolveBookTitles(accumulators);
  scanBookPages(accumulators, limit);

  for (const scope of BOOK_SCOPES) {
    const acc = accumulators[scope.id];
    for (const metric of BOOK_METRICS) {
      writePage(path.join(outDir, scope.id, `${metric.id}.html`), {
        title: `${scope.label} — ${metric.navLabel}`,
        nav,
        activeId: `${scope.id}/${metric.id}`,
        rootPrefix: '../',
        content: renderBookMetricPage(scope, metric, acc, limit),
      });
    }
    console.log(chalk.gray(`   ${scope.label}: ${formatCount(acc.total)} books`));
  }

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
    script: PAGE_COUNT_SORT_SCRIPT,
  });

  writePage(path.join(outDir, 'index.html'), {
    title: 'Overview',
    nav,
    activeId: 'overall',
    rootPrefix: '',
    content: renderOverview(nav, limit),
  });

  console.log(chalk.green.bold(`\n📄 Published ${written} pages to ${outDir}`));
}
