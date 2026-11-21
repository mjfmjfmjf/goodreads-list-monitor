import { describe, expect, it } from 'vitest';
import { parseShelfDirectoryPage } from './shelfTagDirectory.ts';

const stat = (href: string, label: string, count: string) => `
  <div class="shelfStat">
    <div style="float: left; width: 100px;">
      <a class="mediumText actionLinkLite" href="${href}">${label}</a>
    </div>
    <div class="smallText greyText" style="text-align: right; width: 80px; float: left;">
      ${count} books
    </div>
    <div class="clear"></div>
  </div>`;

const PAGE_HTML = `
<h1>Top Shelves</h1>
<p class="mediumText">Most popular shelves on Goodreads <span class="smallText">Showing 1-100 of 15,000</span>.</p>
<div class="left">${stat('/shelf/show/to-read', 'to-read', '3,186,489,228')}${stat('/shelf/show/currently-reading', 'currently-reading', '353,423,893')}</div>
<div class="left">${stat('/shelf/show/fantasy', 'fantasy', '20,293,142')}</div>
<div class="left">${stat('/shelf/show/Science-Fiction', 'Science-Fiction', '3,921,924')}</div>
<div><a class="next_page" rel="next" href="/shelf?page=2">next »</a></div>`;

describe('parseShelfDirectoryPage', () => {
  it('uses directory DOM order (down each column) as rank and parses #books', () => {
    const { entries, hasNext } = parseShelfDirectoryPage(PAGE_HTML, 1);
    expect(hasNext).toBe(true);
    expect(entries).toEqual([
      { tagName: 'to-read', bookCount: 3186489228, rank: 1, scrapedAt: '' },
      { tagName: 'currently-reading', bookCount: 353423893, rank: 2, scrapedAt: '' },
      { tagName: 'fantasy', bookCount: 20293142, rank: 3, scrapedAt: '' },
      { tagName: 'science-fiction', bookCount: 3921924, rank: 4, scrapedAt: '' },
    ]);
  });

  it('continues global rank on later pages', () => {
    const { entries } = parseShelfDirectoryPage(PAGE_HTML, 2);
    expect(entries.map((entry) => entry.rank)).toEqual([101, 102, 103, 104]);
  });

  it('reports no next page at the end and ignores challenged pages', () => {
    const last = parseShelfDirectoryPage(PAGE_HTML.replace('class="next_page"', 'class="next_page disabled"'), 100);
    expect(last.hasNext).toBe(false);
    const empty = parseShelfDirectoryPage('<html><title>Sign Up</title></html>', 1);
    expect(empty.entries).toEqual([]);
    expect(empty.hasNext).toBe(false);
  });
});
