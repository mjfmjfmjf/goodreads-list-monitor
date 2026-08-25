import { describe, expect, it } from 'vitest';
import { buildYearEntry, extractYearLinks } from './bestOfYearConfig.js';

describe('extractYearLinks', () => {
  it('picks years from best_of_year hrefs and bare-year link text with correct URLs', () => {
    const html = `
      <div class="listDescription">
        By year:
        <a href="/list/best_of_year/2020">2020</a>,
        <a href="/list/show/34596.Best_Books_of_1899">1899</a>,
        <a href="https://www.goodreads.com/list/best_of_year/1975">1975</a>
      </div>`;
    const links = extractYearLinks(html);
    expect(links.map(l => l.year)).toEqual([1899, 1975, 2020]);
    expect(links.find(l => l.year === 1899)!.url).toBe('https://www.goodreads.com/list/show/34596');
    expect(links.find(l => l.year === 1975)!.url).toBe('https://www.goodreads.com/list/best_of_year/1975');
    expect(links.find(l => l.year === 2020)!.url).toBe('https://www.goodreads.com/list/best_of_year/2020');
  });

  it('uses text year for best_of_year URLs even when href year differs', () => {
    const html = `
      <a href="/list/best_of_year/2003">2013</a>
      <a href="/list/best_of_year/2006">2016</a>`;
    const links = extractYearLinks(html);
    expect(links.find(l => l.year === 2013)!.url).toBe('https://www.goodreads.com/list/best_of_year/2013');
    expect(links.find(l => l.year === 2016)!.url).toBe('https://www.goodreads.com/list/best_of_year/2016');
  });

  it('ignores pagination, decade labels, and non-list links', () => {
    const html = `
      <a href="/list/show/34595?page=2">2</a>
      <a href="/list/show/34595?page=42">42</a>
      <a href="/list/show/123.The_Best_of_the_1960s">1960s</a>
      <a href="/book/show/1.1984">1984</a>
      <a href="/list/show/34595">show all</a>`;
    expect(extractYearLinks(html)).toEqual([]);
  });

  it('deduplicates years across both link forms and sorts ascending', () => {
    const html = `
      <a href="/list/best_of_year/2001">2001</a>
      <a href="/list/show/34599.Best_Books_of_2001">2001</a>
      <a href="/list/show/34600.Best_Books_of_2000">2000</a>`;
    const links = extractYearLinks(html);
    expect(links.map(l => l.year)).toEqual([2000, 2001]);
    // first occurrence wins: best_of_year/2001 was seen first
    expect(links.find(l => l.year === 2001)!.url).toBe('https://www.goodreads.com/list/best_of_year/2001');
  });
});

describe('buildYearEntry', () => {
  it('uses show ID when url is a show link', () => {
    const entry = buildYearEntry(1967, 'https://www.goodreads.com/list/show/8588');
    expect(entry.id).toBe('8588');
    expect(entry.url).toBe('https://www.goodreads.com/list/show/8588');
    expect(entry.criteria.minYear).toBe(1967);
    expect(entry.criteria.maxYear).toBe(1967);
  });

  it('uses best_of_year path when url is a best_of_year link', () => {
    const entry = buildYearEntry(1997, 'https://www.goodreads.com/list/best_of_year/1997');
    expect(entry.id).toBe('best_of_year/1997');
    expect(entry.url).toBe('https://www.goodreads.com/list/best_of_year/1997');
  });
});
