import { describe, expect, it } from 'vitest';
import * as cheerio from 'cheerio';
import { extractAuthorId, acceptAuthorListMatch, findOnAuthorPage, extractShelfPageLinks, isPermanentAuthorPageFailure, parseTagListPage, parseAuthorStats, reanchorShelfPage, parseListTags, parseListMeta } from './scraper.ts';

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

// A dead author page (400/404/410) counts as a PERMANENT failure and burns a
// strike, exactly like any other 4xx. That is deliberate: after AUTHOR_FAIL_LIMIT
// (3) runs the author is filtered out of the crawl queue for good, so a dead id
// costs three requests total and then stops appearing. The reverted
// `authors.page_gone` retirement tried to skip that, but recorded NO strike — so
// nothing was ever filtered out and every dead author re-404'd on every run.
describe('isPermanentAuthorPageFailure', () => {
  it('counts client-side 4xx statuses as permanent (won\'t change on retry)', () => {
    expect(isPermanentAuthorPageFailure({ response: { status: 400 } })).toBe(true);
    expect(isPermanentAuthorPageFailure({ response: { status: 403 } })).toBe(true);
    expect(isPermanentAuthorPageFailure({ response: { status: 404 } })).toBe(true);
    expect(isPermanentAuthorPageFailure({ response: { status: 410 } })).toBe(true);
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

  it('still treats an unlisted client-side 4xx as permanent', () => {
    expect(isPermanentAuthorPageFailure({ response: { status: 401 } })).toBe(true);
    expect(isPermanentAuthorPageFailure({ response: { status: 451 } })).toBe(true);
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

  it('parses the new hreview-aggregate layout with itemprop counts', () => {
    const stats = parseAuthorStats(cheerio.load(`
      <link rel="canonical" href="https://www.goodreads.com/author/show/12603.Mollie_Hunter" />
      <div class="hreview-aggregate" itemprop="aggregateRating" itemscope itemtype="https://schema.org/AggregateRating">
        <span class="item fn" hidden>Mollie Hunter</span>
        <span class="rating">
          Average rating:
          <span class="average" itemprop="ratingValue">3.87</span>
        </span>
        <span class="votes"><span class="value-title" title="2390" itemprop="ratingCount" content="2390">2,390</span></span> ratings
        <span class="count"><span class="value-title" title="306" itemprop="reviewCount" content="306">306</span></span> reviews
      </div>`));
    expect(stats.name).toBe('Mollie Hunter');
    expect(stats.slug).toBe('12603.Mollie_Hunter');
    expect(stats.averageRating).toBe('3.87');
    expect(stats.numRatings).toBe('2390');
    expect(stats.numReviews).toBe('306');
  });

  it('returns just name/slug when the stats line is absent', () => {
    const stats = parseAuthorStats(cheerio.load(`<div class="leftContainer"><a class="authorName" href="/author/show/1.A">A</a></div>`));
    expect(stats).toEqual({ name: 'A', slug: '1.A' });
  });
});

describe('reanchorShelfPage', () => {
  it('re-anchors a tail read aimed past a shelf that has since shrunk', () => {
    // asked for page 11, the footer admits 10 exist (stale xref max position)
    expect(reanchorShelfPage(11, 10, false)).toBe(10);
  });

  it('does nothing when the requested page exists (normal tail read)', () => {
    expect(reanchorShelfPage(10, 10, false)).toBeNull();
    expect(reanchorShelfPage(10, 25, false)).toBeNull();
  });

  it('does nothing without a footer page count (nothing to trust yet)', () => {
    expect(reanchorShelfPage(11, null, false)).toBeNull();
  });

  it('re-anchors at most once — a second refusal means the footers disagree, so bail', () => {
    expect(reanchorShelfPage(11, 9, true)).toBeNull();
    expect(reanchorShelfPage(11, 0, false)).toBeNull(); // nonsense footer
  });
});

describe('parseListTags', () => {
  // Real markup from list/show/35080.One_Million_Ratings_ — the "Tags:" block in
  // the right-hand stacked sidebar, repeated on every page of the list.
  const tagsBlock = `
    <div class="stacked">
      <div>253 books &middot; 1,099 voters</div>
      <div>
        Tags:
        <a class="actionLinkLite" href="/list/show_tag/1000000">1000000</a>,
        <a class="actionLinkLite" href="/list/show_tag/goodreads-statistics">goodreads-statistics</a>,
        <a class="actionLinkLite" href="/list/show_tag/million">million</a>,
        <a class="actionLinkLite" href="/list/show_tag/million-ratings">million-ratings</a>,
        <a class="actionLinkLite" href="/list/show_tag/most-popular">most-popular</a>,
        <a class="actionLinkLite" href="/list/show_tag/most-rated">most-rated</a>,
        <a class="actionLinkLite" href="/list/show_tag/most-ratings">most-ratings</a>,
        <a class="actionLinkLite" href="/list/show_tag/popular">popular</a>,
        <a class="actionLinkLite" href="/list/show_tag/ratings">ratings</a>,
        <a class="actionLinkLite" href="/list/show_tag/top-ratings">top-ratings</a>,
        <a class="actionLinkLite" href="/list/show_tag/villaine">villaine</a>
      </div>
    </div>`;

  it('reads every tag in document order', () => {
    expect(parseListTags(cheerio.load(tagsBlock))).toEqual([
      '1000000', 'goodreads-statistics', 'million', 'million-ratings',
      'most-popular', 'most-rated', 'most-ratings', 'popular', 'ratings',
      'top-ratings', 'villaine',
    ]);
  });

  it('returns nothing for a list with no Tags block', () => {
    expect(parseListTags(cheerio.load('<div class="stacked"><div>10 books</div></div>'))).toEqual([]);
  });

  it('dedupes a tag repeated on the same page', () => {
    const html = `
      <a class="actionLinkLite" href="/list/show_tag/fiction">fiction</a>
      <a class="actionLinkLite" href="/list/show_tag/fiction">fiction</a>`;
    expect(parseListTags(cheerio.load(html))).toEqual(['fiction']);
  });

  it('uses the URL slug, not the anchor text, and normalizes case and spacing', () => {
    // The slug is canonical; the display string can differ in case or spacing.
    const html = `
      <a class="actionLinkLite" href="/list/show_tag/Science-Fiction">  Science Fiction </a>
      <a class="actionLinkLite" href="/list/show_tag/most  rated">most rated</a>`;
    expect(parseListTags(cheerio.load(html))).toEqual(['science-fiction', 'most-rated']);
  });

  it('leaves underscores alone — Goodreads slugs use hyphens, and folding _ to - would merge distinct tags', () => {
    const html = `<a class="actionLinkLite" href="/list/show_tag/Science_Fiction">x</a>`;
    expect(parseListTags(cheerio.load(html))).toEqual(['science_fiction']);
  });

  it('ignores actionLinkLite links that are not list tags', () => {
    // Same class, different href family (e.g. the "(votes)" style links).
    const html = `<a class="actionLinkLite" href="/list/show/35080">Other list</a>`;
    expect(parseListTags(cheerio.load(html))).toEqual([]);
  });

  it('handles percent-encoded slugs', () => {
    const html = `<a class="actionLinkLite" href="/list/show_tag/100%25%20off">100% off</a>`;
    expect(parseListTags(cheerio.load(html))).toEqual(['100%-off']);
  });
});

describe('parseListMeta', () => {
  // Real markup from list/show/36647 (the right-hand sidebar + like container).
  const page = `
    <div class="stacked">
      <div>
        1,137 books &middot;
        164 voters &middot;
        list created May 1st, 2013
        by <a href="/user/show/970632-mitchell-friedman">Mitchell Friedman</a>
        <a class="greyText smallText" href="/list/user_vote/2278198">(votes)</a> .
      </div>
      <div>
        Tags:
        <a class="actionLinkLite" href="/list/show_tag/mjf">mjf</a>
      </div>
    </div>
    <div>
      <span class="likeItContainer" id="like_container_list_36647">
        <a id="like_count_list_36647" href="/rating/voters/36647?resource_type=List">
          <span class="likesCount">80 likes</span>
        </a>
      </span>
    </div>`;

  it('reads books, voters, creation date, creator and likes', () => {
    expect(parseListMeta(cheerio.load(page))).toEqual({
      numBooks: 1137,
      numVoters: 164,
      createdAt: '2013-05-01',
      createdAtRaw: 'May 1st, 2013',
      creatorId: '970632',
      creatorName: 'Mitchell Friedman',
      numLikes: 80,
    });
  });

  it('assumes the current year when Goodreads omits it (current-year lists)', () => {
    // Real shape from list/show/380105: no year in the header at all.
    const html = `
      <div class="stacked">
        <div>232 books &middot; 37 voters &middot; list created January 17th by
          <a href="/user/show/970632-brittiny-harrand">Brittiny Harrand</a>
          <a class="greyText smallText" href="/list/user_vote/1">(votes)</a> .</div>
      </div>`;
    expect(parseListMeta(cheerio.load(html), new Date('2026-11-14T12:00:00Z'))).toEqual({
      numBooks: 232,
      numVoters: 37,
      createdAt: '2026-01-17',
      createdAtRaw: 'January 17th',
      creatorId: '970632',
      creatorName: 'Brittiny Harrand',
    });
  });

  it('handles an ordinal-less date and a creator whose id has no name slug', () => {
    const html = `
      <div class="stacked">
        <div>12 books &middot; 3 voters &middot; list created June 2, 2020 by
          <a href="/user/show/42">Somebody</a> .</div>
      </div>
      <span class="likeItContainer"><span class="likesCount">1 like</span></span>`;
    expect(parseListMeta(cheerio.load(html))).toEqual({
      numBooks: 12,
      numVoters: 3,
      createdAt: '2020-06-02',
      createdAtRaw: 'June 2, 2020',
      creatorId: '42',
      creatorName: 'Somebody',
      numLikes: 1,
    });
  });

  it('records 0 likes when the list has none (only the Like button renders)', () => {
    const html = `
      <div class="stacked"><div>5 books &middot; 2 voters</div></div>
      <span class="likeItContainer"><a class="jsLike like_it">Like</a></span>`;
    expect(parseListMeta(cheerio.load(html))).toEqual({ numBooks: 5, numVoters: 2, numLikes: 0 });
  });

  it('captures a deleted creator rendered as plain text (no user link)', () => {
    const html = `
      <div class="stacked">
        <div>746 books &middot; 339 voters &middot; list created September 12th, 2013 by deleted user.</div>
      </div>`;
    expect(parseListMeta(cheerio.load(html))).toEqual({
      numBooks: 746,
      numVoters: 339,
      createdAt: '2013-09-12',
      createdAtRaw: 'September 12th, 2013',
      creatorName: 'deleted user',
    });
  });

  it('omits pieces the page does not carry instead of fabricating them', () => {
    const html = `<div class="stacked"><div>10 books &middot; 2 voters</div></div>`;
    expect(parseListMeta(cheerio.load(html))).toEqual({ numBooks: 10, numVoters: 2 });
  });

  it('returns an empty object when there is no header at all', () => {
    expect(parseListMeta(cheerio.load('<div>nothing here</div>'))).toEqual({});
  });

  it('detects a static list marker', () => {
    expect(parseListMeta(cheerio.load('<div>This is a static list.</div>'))).toEqual({ isStatic: true });
  });
});
