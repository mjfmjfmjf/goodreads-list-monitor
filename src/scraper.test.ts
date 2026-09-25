import { describe, expect, it } from 'vitest';
import * as cheerio from 'cheerio';
import { extractAuthorId, acceptAuthorListMatch, findOnAuthorPage, extractShelfPageLinks, isPermanentAuthorPageFailure, parseTagListPage, parseAuthorStats } from './scraper.js';

describe('extractAuthorId', () => {
  it('returns the bare id as-is', () => {
    expect(extractAuthorId('630')).toBe('630');
  });

  it('extracts the id from a full slug', () => {
    expect(extractAuthorId('630.Dan_Brown')).toBe('630');
    expect(extractAuthorId('1265.Jane_Austen')).toBe('1265');
  });

  it('handles slugs whose name part itself contains dots', () => {
    expect(extractAuthorId('1406384.John_Green')).toBe('1406384');
  });

  it('trims surrounding whitespace', () => {
    expect(extractAuthorId('  630.Dan_Brown  ')).toBe('630');
  });
});

describe('acceptAuthorListMatch', () => {  it('accepts a confirmed hit even when published is Unknown (regression: check-book)', () => {
    // A combined-editions row on an author works page matched by id/title but
    // without a parseable publication year. This previously failed the
    // "published !== 'Unknown'" success gate and caused check-book to report a
    // spurious update failure for a correctly-found book.
    expect(acceptAuthorListMatch({ id: '170448', title: 'Animal Farm', published: 'Unknown' })).toBe(true);
  });

  it('accepts a normal hit with parsed stats', () => {
    expect(acceptAuthorListMatch({ id: '1', title: 'Foo', published: '2012' })).toBe(true);
  });

  it('rejects a miss (no title returned)', () => {
    expect(acceptAuthorListMatch({ id: '123' })).toBe(false);
    expect(acceptAuthorListMatch({})).toBe(false);
  });
});

describe('extractShelfPageLinks', () => {
  it('returns the true last page from a real logged-in shelf footer (algorithms, 21 pages)', () => {
    // Captured from /shelf/show/algorithms?page=1 with the app cookie.
    const html = `
      <div>
        <span class="previous_page disabled">« previous</span>
        <em class="current">1</em>
        <a rel="next" href="/shelf/show/algorithms?page=2">2</a>
        <a href="/shelf/show/algorithms?page=3">3</a>
        <a href="/shelf/show/algorithms?page=4">4</a>
        <a href="/shelf/show/algorithms?page=5">5</a>
        <a href="/shelf/show/algorithms?page=6">6</a>
        <a href="/shelf/show/algorithms?page=7">7</a>
        <a href="/shelf/show/algorithms?page=8">8</a>
        <a href="/shelf/show/algorithms?page=9">9</a>
        <a href="/shelf/show/algorithms?page=20">20</a>
        <a href="/shelf/show/algorithms?page=21">21</a>
        <a rel="next" href="/shelf/show/algorithms?page=2">next»</a>
      </div>`;
    const pages = extractShelfPageLinks(cheerio.load(html), 'algorithms');
    expect(pages[pages.length - 1]).toBe(21);
    expect(pages).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 20, 21]);
  });

  it('handles an interior page footer with prev/current/next (no first page anchor)', () => {
    // Captured from /shelf/show/algorithms?page=2 (current is an <em>, not a link).
    const html = `
      <div>
        <a href="/shelf/show/algorithms?page=1">« previous</a>
        <em class="current">2</em>
        <a href="/shelf/show/algorithms?page=3">3</a>
        <a href="/shelf/show/algorithms?page=20">20</a>
        <a href="/shelf/show/algorithms?page=21">21</a>
        <a rel="next" href="/shelf/show/algorithms?page=3">next»</a>
      </div>`;
    const pages = extractShelfPageLinks(cheerio.load(html), 'algorithms');
    expect(pages[pages.length - 1]).toBe(21);
  });

  it('returns an empty array when the footer is absent (logged-out/blocked page)', () => {
    const $ = cheerio.load('<html><body><div class="right"></div></body></html>');
    expect(extractShelfPageLinks($, 'algorithms')).toEqual([]);
  });

  it('only counts links for the requested tag', () => {
    const html = `
      <div>
        <a href="/shelf/show/othertag?page=99">99</a>
        <a href="/shelf/show/algorithms?page=7">7</a>
      </div>`;
    const pages = extractShelfPageLinks(cheerio.load(html), 'algorithms');
    expect(pages).toEqual([7]);
  });

describe('parseTagListPage', () => {
  it('extracts unique lists and the next page number', () => {
    const html = `
      <div>
        <a href="/list/show/196307.Best_Books_of_2024">Best Books of 2024</a>
        <a href="/list/show/196307.Best_Books_of_2024">Best Books of 2024 (dup)</a>
        <a href="/list/show/143500.Best_Books_of_the_Decade_2020_s">Decade</a>
        <a href="/list/show/181809.Can_t_Wait_Sci_Fi_Fantasy_of_2024">Expectations</a>
        <a href="/list/tag/2024?page=3">3</a>
        <a class="next_page" href="/list/tag/2024?page=2">next ›</a>
      </div>`;
    const { lists, nextPage } = parseTagListPage(cheerio.load(html), '2024');
    expect(lists.map(l => l.id)).toEqual(['196307', '143500', '181809']);
    expect(lists[0]).toMatchObject({ id: '196307', slug: 'Best_Books_of_2024' });
    expect(nextPage).toBe(2);
  });

  it('recognizes the real next_page label ("next »")', () => {
    const html = `
      <div>
        <a href="/list/show/196307.Best_Books_of_2024">Best Books</a>
        <a class="next_page" href="/list/tag/2024?page=2">next »</a>
      </div>`;
    expect(parseTagListPage(cheerio.load(html), '2024').nextPage).toBe(2);
  });

  it('returns no next page on the last page', () => {
    const html = `
      <div>
        <a href="/list/show/196307.Best_Books_of_2024">Best Books</a>
        <a class="next_page disabled" href="/list/tag/2024?page=4">next ›</a>
      </div>`;
    const { lists, nextPage } = parseTagListPage(cheerio.load(html), '2024');
    expect(lists).toHaveLength(1);
    expect(nextPage).toBeNull();
  });

  it('ignores non-list and non-tag anchors', () => {
    const html = `
      <div>
        <a href="/book/show/1234">a book</a>
        <a href="/shelf/show/2024">shelf</a>
      </div>`;
    const { lists, nextPage } = parseTagListPage(cheerio.load(html), '2024');
    expect(lists).toEqual([]);
    expect(nextPage).toBeNull();
  });
});
});

describe('isPermanentAuthorPageFailure', () => {
  it('counts client-side 4xx statuses as permanent (won\'t change on retry)', () => {
    expect(isPermanentAuthorPageFailure({ response: { status: 400 } })).toBe(true);
    expect(isPermanentAuthorPageFailure({ response: { status: 403 } })).toBe(true);
    expect(isPermanentAuthorPageFailure({ response: { status: 404 } })).toBe(true);
  });

  it('does not count throttle-class, transient, or amorphous errors', () => {
    expect(isPermanentAuthorPageFailure({ response: { status: 429 } })).toBe(false);
    expect(isPermanentAuthorPageFailure({ response: { status: 202 } })).toBe(false);
    expect(isPermanentAuthorPageFailure({ response: { status: 500 } })).toBe(false);
    expect(isPermanentAuthorPageFailure({ response: { status: 503 } })).toBe(false);
    // Redirect-loop and timeout errors carry no response status.
    expect(isPermanentAuthorPageFailure({ code: 'ERR_FR_TOO_MANY_REDIRECTS' })).toBe(false);
    expect(isPermanentAuthorPageFailure({ code: 'ECONNABORTED' })).toBe(false);
    expect(isPermanentAuthorPageFailure({})).toBe(false);
  });
});

describe('findOnAuthorPage', () => {
  const books = [
    { id: '100', title: 'The Works, Volume 2 (Hardcover)', author: 'Jonathan Swift', authorId: '1831', authorSlug: '1831.Jonathan_Swift', ratings: '1', avgRating: '4.00', published: '2000' },
    { id: '101', title: 'Gulliver\'s Travels', author: 'Jonathan Swift', authorId: '1831', ratings: '123', avgRating: '4.1', published: '1726' },
  ];

  it('matches by id', () => {
    const hit = findOnAuthorPage('100', null, books);
    expect(hit?.id).toBe('100');
  });

  it('matches by exact lowercased title', () => {
    const hit = findOnAuthorPage('zzz', "gulliver's travels", books);
    expect(hit?.id).toBe('101');
  });

  it('returns null when neither id nor title matches', () => {
    expect(findOnAuthorPage('999', null, books)).toBeNull();
    expect(findOnAuthorPage('999', 'no such book', books)).toBeNull();
  });

  it('prefers id over title when both are present', () => {
    const hit = findOnAuthorPage('100', null, books);
    expect(hit?.id).toBe('100');
  });
});

describe('parseAuthorStats', () => {
  // Mirrors the /author/list/<id> page header block (the page scrapeAuthorStats reads).
  const statsBlock = `
    <div class="leftContainer">
      <a class="leftAlignedImage" href="/author/show/15199838.Michael_Astour"><img alt="Michael Astour"/></a>
      <div class=""><a class="authorName" href="/author/show/15199838.Michael_Astour">Michael Astour</a><br/>
        Average rating 5.00 &middot;
        1 rating &middot;
        0 reviews &middot;
        shelved 15 times
      </div>
    </div>`;

  it('parses plural counts and the singular "1 rating"/"1 review" forms', () => {
    const stats = parseAuthorStats(cheerio.load(statsBlock));
    expect(stats.name).toBe('Michael Astour');
    expect(stats.slug).toBe('15199838.Michael_Astour');
    expect(stats.averageRating).toBe('5.00');
    expect(stats.numRatings).toBe('1');
    expect(stats.numReviews).toBe('0');
    expect(stats.numShelves).toBe('15');
  });

  it('also handles an "Average rating:" colon variant and large plural counts', () => {
    const html = `
      <div class="leftContainer">
        <div class=""><a class="authorName" href="/author/show/22498219.Tom_Turtle">Tom Turtle</a><br/>
          Average rating: 4.68 &middot; 228 ratings &middot; 0 reviews &middot; shelved 551 times
        </div>
      </div>`;
    const stats = parseAuthorStats(cheerio.load(html));
    expect(stats.averageRating).toBe('4.68');
    expect(stats.numRatings).toBe('228');
    expect(stats.numReviews).toBe('0');
    expect(stats.numShelves).toBe('551');
  });

  it('returns just name/slug when the stats line is absent', () => {
    const stats = parseAuthorStats(cheerio.load(`<div class="leftContainer"><a class="authorName" href="/author/show/1.A">A</a></div>`));
    expect(stats).toEqual({ name: 'A', slug: '1.A' });
  });
});
