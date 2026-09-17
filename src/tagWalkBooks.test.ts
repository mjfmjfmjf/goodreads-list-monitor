import { describe, expect, it } from 'vitest';
import { normalizeTag, nextShelfPageNumber, parseShelfPage } from './tagWalkBooks.js';

const ELEMENT = (id: number, title: string) => `
<div class="elementList">
  <div class="leftAlignedImage"><a href="/book/show/${id}"><img src="x"/></a></div>
  <div class="elementListRight">
    <a class="bookTitle" href="/book/show/${id}.Some_Title" itemprop="url"><span itemprop="name">${title}</span></a>
  </div>
</div>`;

describe('parseShelfPage', () => {
  it('extracts elementList book rows in order', () => {
    const html = `<title>Popular Books on sci-fi | Goodreads</title>${ELEMENT(1, 'Dune')}${ELEMENT(2, 'Neuromancer')}`;
    const page = parseShelfPage(html, 'sci-fi');
    expect(page.title).toBe('Popular Books on sci-fi');
    expect(page.books).toEqual([
      { position: 1, bookId: '1', title: 'Dune' },
      { position: 2, bookId: '2', title: 'Neuromancer' },
    ]);
  });

  it('reads the rel=next link and ignores unrelated shelf pagination', () => {
    const html = `<title>T</title>${ELEMENT(1, 'Dune')}
      <div class="pagination"><a rel="next" href="/shelf/show/sci-fi?page=2">next»</a>
      <a href="/shelf/show/othertag?page=99">99</a>
      <a href="/shelf/show/sci-fi?page=3">3</a>
      <a href="/shelf/show/sci-fi?page=5">5</a></div>`;
    const page = parseShelfPage(html, 'sci-fi');
    expect(page.hasNextPage).toBe(true);
    expect(page.nextPageHref).toBe('/shelf/show/sci-fi?page=2');
    expect(page.advertisedLastPage).toBe(5);
  });

  it('reports no next page at the end of the shelf', () => {
    const page = parseShelfPage(`<title>T</title>${ELEMENT(1, 'Dune')}`, 'sci-fi');
    expect(page.hasNextPage).toBe(false);
    expect(page.nextPageHref).toBeUndefined();
    expect(page.advertisedLastPage).toBeUndefined();
  });

  it('returns no books for an empty / challenged page', () => {
    const page = parseShelfPage('<html><title>Verify</title></html>', 'sci-fi');
    expect(page.books).toEqual([]);
    expect(page.hasNextPage).toBe(false);
  });

  it('strips markup from titles', () => {
    const html = `<title>T</title>
      <div class="elementList"><a class="bookTitle" href="/book/show/9.The_Book" itemprop="url"><span itemprop="name">The <b>Book</b> 2</span></a></div>`;
    expect(parseShelfPage(html, 'sci-fi').books[0].title).toBe('The Book 2');
  });
});

describe('nextShelfPageNumber', () => {
  it('parses ?page=N and falls back to current + 1', () => {
    expect(nextShelfPageNumber('/shelf/show/sci-fi?page=7', 6)).toBe(7);
    expect(nextShelfPageNumber(undefined, 6)).toBe(7);
    expect(nextShelfPageNumber('/shelf/show/sci-fi', 6)).toBe(7);
  });
});

describe('normalizeTag', () => {
  it('lowercases and converts separators to hyphens', () => {
    expect(normalizeTag('Science Fiction')).toBe('science-fiction');
    expect(normalizeTag('  science_fiction  ')).toBe('science-fiction');
    expect(normalizeTag('SCI-FI')).toBe('sci-fi');
  });
});