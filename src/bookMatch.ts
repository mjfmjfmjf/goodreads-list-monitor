import { CachedBook } from './storage.js';

export type MatchField = 'title' | 'authorLast' | 'authorFirst';

export interface RegexCriterion {
  titleRegex?: string;
  authorLastRegex?: string;
  authorFirstRegex?: string;
}

export function compileRegex(pattern: string): RegExp {
  return new RegExp(pattern, 'i');
}

export function splitAuthorNames(author: string): string[] {
  if (!author || author === 'Unknown') return [];
  return author
    .split(/\s*(?:,|&|\s+and\s+)\s*/i)
    .map(s => s.trim())
    .filter(Boolean);
}

export function authorFirstAndLast(name: string): { first: string; last: string } {
  const clean = (token: string): string => token.replace(/[^a-zA-Z'-]/g, '');
  const tokens = name
    .replace(/\([^)]*\)/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(clean)
    .filter(Boolean);

  return {
    first: tokens.length ? tokens[0] : '',
    last: tokens.length ? tokens[tokens.length - 1] : ''
  };
}

export function matchesRegex(book: Pick<CachedBook, 'title' | 'author'>, criterion: RegexCriterion): boolean {
  if (criterion.titleRegex) {
    if (!compileRegex(criterion.titleRegex).test(book.title || '')) return false;
  }

  if (criterion.authorLastRegex || criterion.authorFirstRegex) {
    const names = splitAuthorNames(book.author || '');
    if (names.length === 0) return false;
    const { first, last } = authorFirstAndLast(names[0]);

    if (criterion.authorLastRegex && !compileRegex(criterion.authorLastRegex).test(last)) return false;
    if (criterion.authorFirstRegex && !compileRegex(criterion.authorFirstRegex).test(first)) return false;
  }

  return true;
}
