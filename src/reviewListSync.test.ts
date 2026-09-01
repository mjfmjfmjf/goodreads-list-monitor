import { describe, it, expect } from 'vitest';
import {
  flipAuthorName,
  parsePageDate,
  parseReviewListPage,
  rowToEntry,
  newEntriesSinceExport,
  buildReviewListUrl
} from './reviewListSync.js';
import type { LibraryExport, LibraryEntry } from './libraryExport.js';

function rowHtml(
  opts: {
    reviewId?: string;
    bookId?: string;
    title?: string;
    author?: string;
    dateRead?: string;
    rating?: string;
    numPages?: string;
    datePub?: string;
    shelves?: string;
    review?: string;
  } = {}
): string {
  const reviewId = opts.reviewId ?? '8908464811';
  const bookId = opts.bookId ?? '820075';
  const title = opts.title ?? 'The Frog Prince, Continued';
  const author = opts.author ?? 'Scieszka, Jon';
  const dateRead = opts.dateRead ?? 'Aug 31, 2026';
  const rating = opts.rating ?? '4.0';
  const numPages = opts.numPages ?? '32';
  const datePub = opts.datePub ?? 'May 01, 1991';
  const shelves = opts.shelves ?? 'read, childrens, folktale';
  const review = opts.review ?? '';

  const shelfLinks = shelves.split(',').map(s => s.trim())
    .map(name => `<a class="shelfLink" href="/review/list/970632?${name === 'read' ? 'shelf' : 'tag'}=${name}">${name}</a>`)
    .join(', ');

  return `
<tr id="review_${reviewId}" class="bookalike review">
  <td class="field cover"><label>cover</label><div class="value">
    <div class="js-tooltipTrigger tooltipTrigger" data-resource-type="Book" data-resource-id="${bookId}">
      <a href="/book/show/${bookId}"><img alt="${title}" id="cover_review_${reviewId}" src="http://x.jpg" /></a>
    </div>
  </div></td>
  <td class="field title"><label>title</label><div class="value">
    <a title="${title}" href="/book/show/${bookId}.The">${title}</a>
  </div></td>
  <td class="field author"><label>author</label><div class="value">
    <a href="/author/show/27318.Jon_Scieszka">${author}</a>
  </div></td>
  <td class="field isbn13"><label>isbn13</label><div class="value">9780140542851</div></td>
  <td class="field num_pages"><label>num pages</label><div class="value"><nobr>${numPages}<span class="greyText"> pp</span></nobr></div></td>
  <td class="field avg_rating"><label>avg rating</label><div class="value">4.16</div></td>
  <td class="field num_ratings"><label>num ratings</label><div class="value">5,490</div></td>
  <td class="field date_pub"><label>date pub</label><div class="value">${datePub}</div></td>
  <td class="field rating"><label>my rating</label><div class="value">
    <div class="stars" data-resource-id="${bookId}" data-user-id="970632" data-rating="${rating}"><a class="star on" href="#">4 of 5 stars</a></div>
  </div></td>
  <td class="field shelves"><label>shelves</label><div class="value">${shelfLinks}</div></td>
  <td class="field review"><label>review</label><div class="value">
    <span id="freeTextContainer${reviewId}">${review ? review.slice(0, 40) : ''}</span>
    <span id="freeText${reviewId}" style="display:none">${review}</span>
  </div></td>
  <td class="field read_count"><label># times read</label><div class="value">1</div></td>
  <td class="field date_started"><label>date started</label><div class="value">${dateRead}</div></td>
  <td class="field date_read"><label>date read</label><div class="value">
    <div class="date_row"><div class="editable_date date_read_xxx">
      <span class="date_read_value">${dateRead}</span>
    </div></div>
  </div></td>
  <td class="field date_added"><label>date added</label><div class="value">Aug 31, 2026</div></td>
</tr>`;
}

const library = (entries: LibraryEntry[]): LibraryExport => ({
  sourcePath: 'test.csv',
  totalEntries: entries.length,
  reviewedEntries: entries.length,
  reviewedById: new Set(entries.map(e => e.id)),
  reviewedByTitleAuthor: new Set(),
  entries
});

describe('flipAuthorName', () => {
  it('flips "Last, First" to "First Last"', () => {
    expect(flipAuthorName('Scieszka, Jon')).toBe('Jon Scieszka');
  });
  it('leaves already-first-last names alone', () => {
    expect(flipAuthorName('Judi Barrett')).toBe('Judi Barrett');
  });
});

describe('parsePageDate', () => {
  it('parses "Aug 31, 2026" to CSV date format', () => {
    expect(parsePageDate('Aug 31, 2026')).toBe('2026/08/31');
  });
  it('parses "Jan 5, 2025" with padded day', () => {
    expect(parsePageDate('Jan 5, 2025')).toBe('2025/01/05');
  });
  it('returns empty for unparsable input', () => {
    expect(parsePageDate('')).toBe('');
    expect(parsePageDate('not a date')).toBe('');
  });
});

describe('buildReviewListUrl', () => {
  it('builds a readable, sorted, paginated URL', () => {
    expect(buildReviewListUrl('970632', 2)).toBe(
      'https://www.goodreads.com/review/list/970632?shelf=read&per_page=100&sort=date_read&order=d&page=2'
    );
  });
});

describe('parseReviewListPage', () => {
  it('parses a bookalike row into structured data', () => {
    const html = `<table><tbody>${rowHtml({ review: 'Not a huge fan of the twist ending.' })}</tbody></table>`;
    const rows = parseReviewListPage(html);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      reviewId: '8908464811',
      bookId: '820075',
      title: 'The Frog Prince, Continued',
      author: 'Jon Scieszka',
      dateRead: '2026/08/31',
      hasReview: true,
      review: 'Not a huge fan of the twist ending.',
      myRating: '4.0',
      pages: '32',
      published: '1991',
      bookshelves: 'childrens, folktale'
    });
  });
  it('reads the full review from the hidden span even when the visible one is truncated', () => {
    const full = 'A long review ' + 'x'.repeat(300);
    const html = `<table><tbody>${rowHtml({ review: full })}</tbody></table>`;
    expect(parseReviewListPage(html)[0].review).toBe(full);
  });
  it('marks no-review rows as not reviewed', () => {
    const html = `<table><tbody>${rowHtml({ review: '' })}</tbody></table>`;
    const row = parseReviewListPage(html)[0];
    expect(row.hasReview).toBe(false);
    expect(row.review).toBe('');
  });
  it('skips the exclusive read shelf when listing bookshelves', () => {
    const html = `<table><tbody>${rowHtml({ shelves: 'read' })}</tbody></table>`;
    expect(parseReviewListPage(html)[0].bookshelves).toBe('');
  });
});

describe('rowToEntry', () => {
  it('maps a row to a LibraryEntry on the read shelf', () => {
    const rows = parseReviewListPage(`<table><tbody>${rowHtml({ review: 'fine' })}</tbody></table>`);
    const entry = rowToEntry(rows[0]);
    expect(entry).toMatchObject({
      id: '820075',
      shelf: 'read',
      dateRead: '2026/08/31',
      hasReview: true,
      myRating: '4.0',
      pages: '32',
      published: '1991'
    });
    expect(entry.publisher).toBe('');
  });
});

describe('newEntriesSinceExport', () => {
  it('returns reads after the last export and ignores already-known ones', () => {
    const lib = library([
      { id: '820075', title: 'Frog Prince', author: 'Jon Scieszka', shelf: 'read', dateRead: '2026/03/01', hasReview: false, review: '', published: '', myRating: '', pages: '', publisher: '', bookshelves: '' },
      { id: '900000', title: 'Old Book', author: 'A', shelf: 'to-read', dateRead: '', hasReview: false, review: '', published: '', myRating: '', pages: '', publisher: '', bookshelves: '' }
    ]);
    const html = `<table><tbody>${rowHtml({ review: 'yo' })}${rowHtml({
      reviewId: '2', bookId: '700001', title: 'New Read', dateRead: 'Aug 28, 2026', datePub: 'Jun 10, 2020'
    })}</tbody></table>`;
    const rows = parseReviewListPage(html);
    const seen = new Set<string>();
    const fresh = newEntriesSinceExport(rows, lib, '2026', seen);

    // 820075 already read → skipped. 700001 is new → returned. 900000 (to-read) isn't on the page.
    expect(fresh.map(e => e.id)).toEqual(['700001']);
    expect(seen.has('700001')).toBe(true);
    expect(seen.has('820075')).toBe(true);
  });
  it('counts a to-read book that has now been finished as new', () => {
    const lib = library([
      { id: '700001', title: 'New Read', author: 'B', shelf: 'to-read', dateRead: '', hasReview: false, review: '', published: '', myRating: '', pages: '', publisher: '', bookshelves: '' }
    ]);
    const rows = parseReviewListPage(`<table><tbody>${rowHtml({
      reviewId: '2', bookId: '700001', title: 'New Read', dateRead: 'Aug 28, 2026'
    })}</tbody></table>`);
    expect(newEntriesSinceExport(rows, lib, '2026', new Set()).map(e => e.id)).toEqual(['700001']);
  });
  it('keeps only entries dated in the requested year', () => {
    const lib = library([]);
    const rows = parseReviewListPage(`<table><tbody>${rowHtml({
      reviewId: '2', bookId: '700001', title: 'Last Year', dateRead: 'Dec 1, 2025'
    })}</tbody></table>`);
    expect(newEntriesSinceExport(rows, lib, '2026', new Set())).toHaveLength(0);
  });
  it('dedupes ids seen earlier in the same walk', () => {
    const lib = library([]);
    const rows = parseReviewListPage(`<table><tbody>${rowHtml()}</tbody></table>`);
    // re-parse the same row twice → second pass must be skipped via seenIds
    const seen = new Set<string>();
    const first = newEntriesSinceExport(rows, lib, '2026', seen);
    const second = newEntriesSinceExport(rows, lib, '2026', seen);
    expect(first.length).toBe(1);
    expect(second).toHaveLength(0);
  });
});