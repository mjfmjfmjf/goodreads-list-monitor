import { describe, expect, it } from 'vitest';
import cheerio from 'cheerio';
import { parseGenreListPage, type GenreListEntry } from './scraper.js';

function pageHtml(rows: Array<[string, string]>, next: boolean): string {
  const body = rows.map(([name, count]) => `
    <div class="shelfStat">
      <div style="float: left; width: 100px;">
        <a class="mediumText actionLinkLite" href="/genres/${name}">${name.replace(/-/g, ' ')}</a>
      </div>
      <div class="smallText greyText" style="text-align: right; width: 80px; float: left;">
        ${count}
      </div>
      <div class="clear"></div>
    </div>`).join('');
  const pager = next
    ? `<a class="next_page" rel="next" href="/genres/list?page=2">next »</a>`
    : `<span class="previous_page disabled">« previous</span> <em class="current">1</em>`;
  return `<html><body>${body}${pager}</body></html>`;
}

describe('parseGenreListPage', () => {
  it('parses name and member-count from shelfStat rows', () => {
    const $ = cheerio.load(pageHtml([
      ['science-fiction', '1,234,567 books'],
      ['fantasy', '890,000 books'],
      ['0-audio-storytel', '1,182 books'],
    ], true));
    const { genres, hasNext } = parseGenreListPage($, '');
    expect(genres).toEqual([
      { name: 'science-fiction', memberCount: 1234567 },
      { name: 'fantasy', memberCount: 890000 },
      { name: '0-audio-storytel', memberCount: 1182 },
    ] as GenreListEntry[]);
    expect(hasNext).toBe(true);
  });

  it('drops rows with no genre link and reports hasNext=false on the last page', () => {
    const html = `
      <div class="shelfStat">
        <div style="float: left; width: 100px;">
          <a class="mediumText actionLinkLite" href="/genres/history">History</a>
        </div>
        <div class="smallText greyText" style="float: left;">5,253 books</div>
        <div class="clear"></div>
      </div>
      <div class="shelfStat">
        <div style="float: left; width: 100px;">
          <a class="mediumText actionLinkLite" href="/somewhere/else">unrelated</a>
        </div>
        <div class="smallText greyText" style="float: left;">999 books</div>
        <div class="clear"></div>
      </div>
      <span class="previous_page disabled">« previous</span> <em class="current">1</em>`;
    const $ = cheerio.load(html);
    const { genres, hasNext } = parseGenreListPage($, '');
    expect(genres).toEqual([{ name: 'history', memberCount: 5253 }]);
    expect(hasNext).toBe(false);
  });

  it('decodes percent-encoded genre names', () => {
    const $ = cheerio.load(pageHtml([
      ['%E6%BC%AB%E7%94%BB', '19,287 books'], // 漫画 (manga)
      ['%E1%9B%8B%E1%9B%8B-books', '2 books'],
    ], false));
    const { genres } = parseGenreListPage($, '');
    expect(genres.map(g => g.name)).toEqual(['\u6F2B\u753B', '\u16CB\u16CB-books']);
  });

  it('handles missing/odd counts as zero', () => {
    const $ = cheerio.load(pageHtml([['mystery', 'no count here']], false));
    const { genres } = parseGenreListPage($, '');
    expect(genres).toEqual([{ name: 'mystery', memberCount: 0 }]);
  });
});
