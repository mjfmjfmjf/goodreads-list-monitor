export interface ChainLink {
  listId: string;
  label: string;
  url: string;
}

export interface ListBook {
  position: number;
  bookId: string;
  title: string;
}

export interface ParsedListPage {
  listId: string;
  title: string;
  books: ListBook[];
  hasNextPage: boolean;
  nextPageHref?: string;
  chainLinks: ChainLink[];
  totalBooks?: number;
  totalPages: number;
  walkablePages: number;
  walkableBooks: number;
}

// Rating-range labels look like "500,000 to 999,999" or "1,000,000 and more".
// Topic links ("Anthropology", "Fantasy", …) deliberately don't match.
const RANGE_LABEL_RE = /^\d{1,3}(?:,\d{3})*(?: to \d{1,3}(?:,\d{3})*)?(?: and more)?$/i;

export function extractListId(html: string): string | undefined {
  const canonical = html.match(/rel="canonical"\s+href="[^"]*?\/list\/show\/(\d+)/);
  if (canonical) return canonical[1];
  const first = html.match(/\/list\/show\/(\d+)/);
  return first?.[1];
}

// Pull book rows out of the #all_votes table (scope prevents picking up
// sidebar tables that also carry itemscope rows).
export function parseListBooks(html: string): ListBook[] {
  const votes = html.match(/<div id="all_votes">[\s\S]*?<div class="pagination">/) ??
    html.match(/<div id="all_votes">[\s\S]*/); // no pagination on last page
  if (!votes) return [];
  const rows = votes[0].match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? [];
  const books: ListBook[] = [];
  for (const row of rows) {
    if (!/itemscope/.test(row)) continue;
    const pos = row.match(/class="number">\s*(\d+)\s*<\/td>/);
    const id = row.match(/\/book\/show\/(\d+)/);
    const title = row.match(/itemprop="name"[^>]*>\s*([^<]+?)\s*<\/span>/);
    if (!id) continue;
    books.push({
      position: pos ? parseInt(pos[1], 10) : 0,
      bookId: id[1],
      title: title ? title[1].trim() : 'Unknown Title',
    });
  }
  return books;
}

export function parseListTitle(html: string): string {
  const title = html.match(/<title>([^<]*)<\/title>/);
  if (!title) return 'Unknown List';
  return title[1].replace(/\s*\| Goodreads\s*$/, '').replace(/\s*\(\d[\d,]* books\)\s*$/, '').trim();
}

export function parseListPagination(html: string): { hasNextPage: boolean; nextPageHref?: string } {
  const region = html.match(/<div class="pagination">[\s\S]*?<\/div>/);
  if (!region) return { hasNextPage: false };
  const block = region[0];
  if (/\bprevious_page disabled\b/.test(block) && !/next_page/.test(block)) return { hasNextPage: false };
  const next = block.match(/<a[^>]*class="[^"]*\bnext_page\b[^"]*"[^>]*href="([^"]+)"/);
  if (next) return { hasNextPage: true, nextPageHref: next[1] };
  return { hasNextPage: /<a[^>]*rel="next"/.test(block) };
}

// The description's "Lists for all books by Number of Ratings:" section is a
// chain of sibling-list links (absolute URLs), e.g. "500,000 to 999,999".
// Order returned = display order (ascending: 10,000 → 1,000,000+).
export function parseChainLinks(html: string): ChainLink[] {
  const links: ChainLink[] = [];
  for (const m of html.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const url = m[1];
    if (!/\/list\/show\/\d+/.test(url)) continue;
    const label = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!RANGE_LABEL_RE.test(label)) continue;
    const listId = url.match(/\/list\/show\/(\d+)/)?.[1];
    if (listId) links.push({ listId, label, url });
  }
  return links;
}

// Use the current list's own chain (which includes itself) to find the
// adjacent sibling in the requested direction. desc = next LOWER rating range
// (1,000,000+ → 500,000-999,999), asc = next HIGHER.
export function resolveNextChainLink(
  chainLinks: ChainLink[],
  currentListId: string,
  direction: 'desc' | 'asc'
): ChainLink | undefined {
  if (chainLinks.length === 0) return undefined;
  const idx = chainLinks.findIndex(l => l.listId === currentListId);
  if (idx === -1) {
    return direction === 'desc' ? chainLinks[chainLinks.length - 1] : chainLinks[0];
  }
  if (direction === 'desc') return idx > 0 ? chainLinks[idx - 1] : undefined;
  return idx + 1 < chainLinks.length ? chainLinks[idx + 1] : undefined;
}

export function parseListPage(html: string): ParsedListPage {
  return {
    listId: extractListId(html) ?? '',
    title: parseListTitle(html),
    books: parseListBooks(html),
    ...parseListPagination(html),
    chainLinks: parseChainLinks(html),
    ...parseListStats(html),
  };
}

// Goodreads only exposes the first 100 pages of ANY list, for every purpose:
// the remainder is hidden even though the list may have far more books than
// that (e.g. Best Books Ever has 79k books but only reads to page 100 = the
// first ~10k books). So a list's declared book count is NOT reachable; the
// walkable span is capped at 100 pages x 100 books/page = 10,000 books.
export const MAX_LIST_PAGE_NUMBER = 100;

export function parseListStats(html: string): {
  totalBooks?: number;
  totalPages: number;
  walkablePages: number;
  walkableBooks: number;
} {
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '';
  const books = title.match(/\(([\d,]+)\s*books\)/);
  const pagination = html.match(/<div class="pagination">[\s\S]*?<\/div>/);
  let totalPages = 1;
  if (pagination) {
    const nums = [...pagination[0].matchAll(/>(\d{1,3}(?:,\d{3})*)</g)].map(m => parseInt(m[1].replace(/,/g, ''), 10));
    const current = pagination[0].match(/class="current">\s*(\d+)\s*</);
    const max = Math.max(0, ...nums, current ? parseInt(current[1], 10) : 0);
    if (max > 0) totalPages = max;
  }
  const totalBooks = books ? parseInt(books[1].replace(/,/g, ''), 10) : undefined;
  const walkablePages = Math.min(totalPages, MAX_LIST_PAGE_NUMBER);
  return {
    totalBooks,
    totalPages,
    walkablePages,
    walkableBooks: totalBooks ? Math.min(totalBooks, walkablePages * 100) : walkablePages * 100,
  };
}