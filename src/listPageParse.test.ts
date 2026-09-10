import { describe, expect, it } from 'vitest';
import {
  extractListId,
  parseListPage,
  parseChainLinks,
  parseListBooks,
  parseListPagination,
  parseListTitle,
  resolveNextChainLink,
  parseListStats,
} from './listPageParse.js';

const ROW = (pos: number, id: number, title: string) => `
<tr itemscope="" itemtype="http://schema.org/Book">
  <td valign="top" class="number">${pos}</td>
  <td><div id="${id}" class="u-anchorTarget"></div></td>
  <td>
    <a class="bookTitle" itemprop="url" href="/book/show/${id}.Some_Title">
      <span itemprop="name" role="heading" aria-level="4">${title}</span>
    </a>
  </td>
</tr>`;

const CHAIN_LINK = (id: number, label: string) =>
  `<a href="https://www.goodreads.com/list/show/${id}" rel="nofollow noopener">${label}</a>`;

function pageHtml(opts: {
  rows?: string;
  chain?: string;
  pagination?: string;
  listId?: number;
  title?: string;
}): string {
  const listId = opts.listId ?? 35177;
  return `
<html><head>
<title>${opts.title ?? 'Half a million ratings to a million ratings (348 books) | Goodreads'}</title>
<link rel="canonical" href="https://www.goodreads.com/list/show/${listId}.Some_Slug">
</head><body>
<div class="u-paddingBottomMedium mediumText">
  Lists for all books by Number of Ratings: ${opts.chain ?? ''}
</div>
<div id="all_votes"><table class="tableList"><tbody>
${opts.rows ?? ''}
</tbody></table>
${opts.pagination ?? ''}</div>
</body></html>`;
}

describe('parseListPage', () => {
  it('extracts the list id from the canonical link', () => {
    const html = pageHtml({});
    expect(extractListId(html)).toBe('35177');
  });

  it('parses title without the trailing count and site suffix', () => {
    expect(parseListTitle(pageHtml({ title: 'Half a million ratings to a million ratings (348 books) | Goodreads' })))
      .toBe('Half a million ratings to a million ratings');
  });

  it('parses book rows (position, id, title) scoped to #all_votes', () => {
    const rows = ROW(1, 21787, 'The Princess Bride') + ROW(2, 24280, 'Les Mis\u00e9rables');
    const html = pageHtml({ rows });
    expect(parseListBooks(html)).toEqual([
      { position: 1, bookId: '21787', title: 'The Princess Bride' },
      { position: 2, bookId: '24280', title: 'Les Mis\u00e9rables' },
    ]);
  });

  it('ignores non-book rows (no itemscope) outside the table', () => {
    const html = pageHtml({ rows: ROW(1, 21787, 'The Princess Bride') + '<tr><td>junk</td></tr>' });
    expect(parseListBooks(html)).toHaveLength(1);
  });

  it('detects pagination with a next page', () => {
    const pagination =
      '<div class="pagination"><span class="previous_page disabled">\u2190 Previous</span> <em class="current">1</em> ' +
      '<a rel="next" href="/list/show/35177.Some_Slug?page=2">2</a> ' +
      '<a class="next_page" rel="next" href="/list/show/35177.Some_Slug?page=2">Next \u2192</a></div>';
    expect(parseListPagination(pageHtml({ pagination }))).toEqual({
      hasNextPage: true,
      nextPageHref: '/list/show/35177.Some_Slug?page=2',
    });
  });

  it('detects the last page (no next_page link)', () => {
    const pagination =
      '<div class="pagination"><a class="previous_page" href="/list/show/35177.Some_Slug?page=1">\u2190 Previous</a> ' +
      '<em class="current">4</em></div>';
    expect(parseListPagination(pageHtml({ pagination })).hasNextPage).toBe(false);
  });
});

describe('parseListStats', () => {
  it('parses total books from the title and total pages from pagination', () => {
    const html = pageHtml({
      title: 'Half a million ratings to a million ratings (348 books) | Goodreads',
      pagination:
        '<div class="pagination"><a class="previous_page" href="?page=3">\u2190 Previous</a> ' +
        '<em class="current">4</em></div>',
    });
    expect(parseListStats(html)).toEqual({ totalBooks: 348, totalPages: 4, walkablePages: 4, walkableBooks: 348 });
  });

  it('parses the max page number from pagination links', () => {
    const html = pageHtml({
      pagination:
        '<div class="pagination"><em class="current">1</em> <a href="?page=2">2</a> ' +
        '<a href="?page=3">3</a> <a class="next_page" href="?page=2">Next \u2192</a></div>',
    });
    expect(parseListStats(html).totalPages).toBe(3);
  });

  it('defaults to 1 page with no book count when absent', () => {
    const html = pageHtml({ title: 'A list with no count | Goodreads' });
    expect(parseListStats(html)).toEqual({ totalBooks: undefined, totalPages: 1, walkablePages: 1, walkableBooks: 100 });
  });

  it('caps the walkable span at 100 pages (lists can declare far more books than are reachable)', () => {
    // Pagination lists up to page 101, but the walker must stop at page 100.
    const html = pageHtml({
      title: 'Best Books Ever (79000 books) | Goodreads',
      pagination:
        '<div class="pagination"><a class="previous_page" href="?page=99">\u2190 Previous</a> ' +
        '<em class="current">100</em> <a rel="next" href="?page=101">101</a></div>',
    });
    const stats = parseListStats(html);
    expect(stats.totalPages).toBe(101); // the pager advertises page 101
    expect(stats.walkablePages).toBe(100); // but only 100 pages are reachable
    expect(stats.walkableBooks).toBe(10_000); // not 79,000 — only page 100 is exposed
  });
});

describe('parseChainLinks', () => {
  const chain = [
    CHAIN_LINK(35708, '100,000 to 149,999'),
    CHAIN_LINK(36647, '200,000 to 499,999'),
    CHAIN_LINK(35177, '500,000 to 999,999'),
    CHAIN_LINK(35080, '1,000,000 and more'),
  ].join(', ');

  it('extracts rating-range chain links in display order, skipping topic links', () => {
    const html = pageHtml({
      chain:
        chain +
        ', <a href="https://www.goodreads.com/list/show/92581" rel="nofollow noopener">Anthropology</a>, ' +
        '<a href="https://www.goodreads.com/list/show/107268" rel="nofollow noopener">Poetry</a>',
    });
    expect(parseChainLinks(html)).toEqual([
      { listId: '35708', label: '100,000 to 149,999', url: 'https://www.goodreads.com/list/show/35708' },
      { listId: '36647', label: '200,000 to 499,999', url: 'https://www.goodreads.com/list/show/36647' },
      { listId: '35177', label: '500,000 to 999,999', url: 'https://www.goodreads.com/list/show/35177' },
      { listId: '35080', label: '1,000,000 and more', url: 'https://www.goodreads.com/list/show/35080' },
    ]);
  });
});

describe('resolveNextChainLink', () => {
  const chain = [
    { listId: '35708', label: '100,000 to 149,999', url: 'u1' },
    { listId: '36647', label: '200,000 to 499,999', url: 'u2' },
    { listId: '35177', label: '500,000 to 999,999', url: 'u3' },
    { listId: '35080', label: '1,000,000 and more', url: 'u4' },
  ];

  it('walks desc: 1,000,000+ → 500,000 to 999,999', () => {
    expect(resolveNextChainLink(chain, '35080', 'desc')).toEqual(chain[2]);
  });

  it('walks desc down to the bottom and stops', () => {
    expect(resolveNextChainLink(chain, '35708', 'desc')).toBeUndefined();
  });

  it('walks asc: 500,000 to 999,999 → 1,000,000+', () => {
    expect(resolveNextChainLink(chain, '35177', 'asc')).toEqual(chain[3]);
  });

  it('falls back to the top when the current id is not in its own chain (desc)', () => {
    expect(resolveNextChainLink(chain, '99999', 'desc')).toEqual(chain[3]);
  });

  it('returns undefined for an empty chain', () => {
    expect(resolveNextChainLink([], '35080', 'desc')).toBeUndefined();
  });
});

describe('parseListPage integration', () => {
  it('assembles a full page record', () => {
    const html = pageHtml({
      rows: ROW(1, 21787, 'The Princess Bride') + ROW(2, 24280, 'Les Mis\u00e9rables'),
      chain: [CHAIN_LINK(35177, '500,000 to 999,999'), CHAIN_LINK(35080, '1,000,000 and more')].join(', '),
      pagination: '<div class="pagination"><em class="current">1</em> <a rel="next" href="?page=2">2</a></div>',
    });
    const parsed = parseListPage(html);
    expect(parsed.listId).toBe('35177');
    expect(parsed.books).toHaveLength(2);
    expect(parsed.hasNextPage).toBe(true);
    expect(parsed.chainLinks.map(l => l.listId)).toEqual(['35177', '35080']);
    expect(parsed.totalPages).toBe(2);
    expect(parsed.totalBooks).toBe(348);
    expect(parsed.walkablePages).toBe(2);
  });
});