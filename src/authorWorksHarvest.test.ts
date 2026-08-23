import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { computeAuthorPageMerge, type AuthorPageBookRow } from './storage.js';
import type { CachedBook } from './storage.js';
import { parseAuthorListBooks } from './scraper.js';

const existingBook = (overrides: Partial<CachedBook> = {}): CachedBook => ({
  id: '15553789',
  title: '11/22/63',
  author: 'Stephen King',
  ratings: '999999',
  published: '2011',
  lastUpdated: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const incomingRow = (overrides: Partial<AuthorPageBookRow> = {}): AuthorPageBookRow => ({
  id: '15553789',
  title: "11/22/63: A Novel",
  author: 'Stephen King',
  authorId: '3389',
  ratings: '1,234,567',
  avgRating: '4.32',
  published: '2011',
  workId: '15553789',
  ...overrides,
});

describe('computeAuthorPageMerge', () => {
  it('inserts a full record when the book is unknown', () => {
    const outcome = computeAuthorPageMerge(undefined, incomingRow());
    expect(outcome.kind).toBe('insert');
    if (outcome.kind !== 'insert') return;
    expect(outcome.book.ratings).toBe('1234567');
    expect(outcome.book.workId).toBe('15553789');
    expect(outcome.book.authorId).toBe('3389');
  });

  it('fills only blank fields on an existing sparse row', () => {
    const existing = existingBook({ title: 'Unknown', author: 'Unknown Author', ratings: '0', published: 'Unknown' });
    const outcome = computeAuthorPageMerge(existing, incomingRow());
    expect(outcome.kind).toBe('update');
    if (outcome.kind !== 'update') return;
    expect(outcome.book.title).toBe("11/22/63: A Novel");
    expect(outcome.book.author).toBe('Stephen King');
    expect(outcome.book.authorId).toBe('3389');
    expect(outcome.book.ratings).toBe('1234567');
    expect(outcome.book.published).toBe('2011');
  });

  it('never overwrites richer existing data', () => {
    const existing = existingBook({
      avgRating: undefined,
      workId: undefined,
      genres: ['horror'],
    });
    const outcome = computeAuthorPageMerge(existing, incomingRow({ title: 'A DIFFERENT TITLE', workId: 'OTHER' }));
    expect(outcome.kind).toBe('update');
    if (outcome.kind !== 'update') return;
    expect(outcome.book.title).toBe('11/22/63');
    expect(outcome.book.workId).toBe('OTHER');
    expect(outcome.book.avgRating).toBe('4.32');
    expect(outcome.book.genres).toEqual(['horror']);
  });

  it('keeps an existing workId and never regresses it', () => {
    const existing = existingBook({ workId: 'KEEP' });
    const outcome = computeAuthorPageMerge(existing, incomingRow({ workId: 'NEW' }));
    if (outcome.kind !== 'update') throw new Error('expected update');
    expect(outcome.book.workId).toBe('KEEP');
  });

  it('skips when there is nothing to improve', () => {
    const existing = existingBook({ avgRating: '4.32', authorId: '3389', workId: '15553789' });
    const outcome = computeAuthorPageMerge(existing, incomingRow());
    expect(outcome.kind).toBe('skip');
  });
});

describe('parseAuthorListBooks', () => {
  it('extracts id, title, stats and workId from a works-table row', () => {
    const html = `
      <table class="tableList">
        <tr itemscope itemtype="http://schema.org/Book">
          <td>
            <a class="bookTitle" href="/book/show/15553789-11-22-63" itemprop="url">
              <span itemprop="name">11/22/63</span>
            </a>
            <a class="authorName" itemprop="author" href="/author/show/3389.Stephen_King">Stephen King</a>
            <span class="greyText smallText">
              <span>4.32 avg rating</span> —
              <span>1,234,567 ratings</span> —
              published 2011
            </span>
            <a class="greyText" rel="nofollow" href="/work/editions/15553789-11-22-63">218 editions</a>
          </td>
        </tr>
        <tr><td><a class="bookTitle" href="/author/list/3389.Stephen_King?page=2">not a book</a></td></tr>
      </table>`;
    const $ = cheerio.load(html);
    const books = parseAuthorListBooks($);
    expect(books.length).toBe(1);
    expect(books[0].id).toBe('15553789');
    expect(books[0].title).toBe('11/22/63');
    expect(books[0].authorId).toBe('3389');
    expect(books[0].ratings).toBe('1,234,567');
    expect(books[0].avgRating).toBe('4.32');
    expect(books[0].published).toBe('2011');
    expect(books[0].workId).toBe('15553789');
  });

  it('returns rows without workId when no editions link exists', () => {
    const html = `
      <table class="tableList">
        <tr>
          <td>
            <a class="bookTitle" href="/book/show/42">Some Book</a>
            <span class="greyText smallText">3.90 avg rating — 500 ratings — published 1999</span>
          </td>
        </tr>
      </table>`;
    const $ = cheerio.load(html);
    const books = parseAuthorListBooks($);
    expect(books.length).toBe(1);
    expect(books[0].id).toBe('42');
    expect(books[0].workId).toBeUndefined();
  });
});
