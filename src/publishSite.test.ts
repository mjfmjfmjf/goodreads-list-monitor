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
import {
  AUTHOR_REPORTS,
  BOOK_METRICS,
  BOOK_SCOPES,
  buildNav,
  createAccumulators,
  escapeHtml,
  formatGeneratedAt,
  renderAuthorTable,
  renderFrequencyPage,
  renderHistogram,
  renderNav,
  renderPage,
  renderPageCountPage,
  renderTopBooks,
  runPublishSite,
  writeFileAtomic,
} from './publishSite.ts';
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

describe('static publish', () => {
  it('builds the expected author reports', () => {
    expect(AUTHOR_REPORTS.map((report) => report.id)).toEqual([
      'author/top-authors-by-ratings',
      'author/top-authors-by-reviews',
      'author/top-authors-by-shelves',
      'author/top-authors-by-catalog-pages',
      'author/top-authors-by-avg-rating-min-100k',
      'author/top-authors-by-avg-rating-min-10k',
    ]);
    expect(
      AUTHOR_REPORTS.find((report) => report.id === 'author/top-authors-by-avg-rating-min-100k')?.minRatings,
    ).toBe(100000);
  });

  it('builds the expected book scopes and metrics', () => {
    expect(BOOK_SCOPES.map((scope) => scope.id)).toEqual(['book-id', 'work-id', 'works']);
    expect(BOOK_METRICS.map((metric) => metric.id)).toEqual([
      'ratings',
      'reviews',
      'currently-reading',
      'to-read',
      'edition-count',
    ]);
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
        { id: '1', title: 'Low', author: 'A', workId: '', value: 10 },
        { id: '2', title: 'High', author: 'B', workId: 'W2', value: 99 },
      ],
      metric,
      true,
    );
    expect(html.indexOf('High')).toBeLessThan(html.indexOf('Low'));
    expect(html).toContain('<th>Work ID</th>');
    expect(html).toContain('https://www.goodreads.com/work/editions/W2');
    expect(html).toContain('https://www.goodreads.com/book/show/2');
  });

  it('renders frequency rows with shares', () => {
    const html = renderFrequencyPage('Based on 2 books.', [{ label: 'English', count: 2 }], 2, 'Language');
    expect(html).toContain('English');
    expect(html).toContain('100.0%');
  });

  it('renders the page-count table with sort controls', () => {
    const html = renderPageCountPage(new Map([[320, 10], [100, 5]]));
    expect(html).toContain('data-page="320"');
    expect(html).toContain('data-sort="page"');
    expect(html).toContain('data-sort="count"');
    expect(html).toContain('66.7%');
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

  it('publishes index, author, book, and book-detail pages end to end', async () => {
    const db = getDb();

    const insertAuthor = db.prepare(
      'INSERT INTO authors (id, name, slug, last_seen, average_rating, num_ratings, num_reviews, num_shelves, catalog_pages) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insertAuthor.run('1', 'Alice', '1.Alice', '2026-11-11T00:00:00.000Z', 4.5, 1000, 10, 20, 3);
    insertAuthor.run('2', 'Bob', '2.Bob', '2026-11-11T00:00:00.000Z', 4.9, 500000, 5, 30, 4);

    const insertBook = db.prepare(
      'INSERT INTO books (id, title, author, ratings, work_id, is_work_rep, pages, last_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insertBook.run('10', 'Alpha', 'Author A', 5000, 'W1', 1, 320, '2026-11-11T00:00:00.000Z');
    insertBook.run('11', 'Beta', 'Author B', 2000, 'W1', 0, 100, '2026-11-11T00:00:00.000Z');
    insertBook.run('12', 'Gamma', 'Author C', 100, null, 0, 200, '2026-11-11T00:00:00.000Z');

    const insertDetail = db.prepare(
      'INSERT INTO book_page (book_id, reviews_count, currently_reading, to_read, editions_count, language, format, scraped_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insertDetail.run('10', '250,000', 1234, 5678, 12, 'English', 'Hardcover', '2026-11-11T00:00:00.000Z');
    insertDetail.run('12', '5', 0, 10, 1, 'French', 'Paperback', '2026-11-11T00:00:00.000Z');

    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-e2e-'));
    const read = (relative: string): string => fs.readFileSync(path.join(out, relative), 'utf8');

    try {
      await runPublishSite({ out, limit: '10' });

      expect(fs.existsSync(path.join(out, 'index.html'))).toBe(true);

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
      expect(bookRatings).toContain('5,000');

      const workIdRatings = read('work-id/ratings.html');
      expect(workIdRatings).toContain('Alpha');
      expect(workIdRatings).toContain('Beta');
      expect(workIdRatings).not.toContain('Gamma');
      expect(workIdRatings).toContain('https://www.goodreads.com/work/editions/W1');

      const worksRatings = read('works/ratings.html');
      expect(worksRatings).toContain('Alpha');
      expect(worksRatings).not.toContain('Beta');

      const reviews = read('book-id/reviews.html');
      expect(reviews).toContain('Based on 2 books with reviews data (of 3 books in scope).');
      expect(reviews).toContain('Alpha');
      expect(reviews).toContain('250,000');

      const languages = read('book-detail/by-language.html');
      expect(languages).toContain('English');
      expect(languages).toContain('French');

      const pageCounts = read('book-detail/by-page-count.html');
      expect(pageCounts).toContain('data-page="320"');
      expect(pageCounts).toContain('data-sort="page"');
      expect(pageCounts).toContain('<script>');
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
      db.prepare('DELETE FROM book_page WHERE book_id IN (?, ?)').run('10', '12');
      db.prepare('DELETE FROM books WHERE id IN (?, ?, ?)').run('10', '11', '12');
      db.prepare('DELETE FROM authors WHERE id IN (?, ?)').run('1', '2');
    }
  });
});
