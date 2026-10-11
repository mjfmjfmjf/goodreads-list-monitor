import { describe, expect, it } from 'vitest';
import { rankListTags } from './listTagStats.ts';

const row = (tagName: string, lists: number, lastSeen = '2026-10-05T00:00:00.000Z') => ({ tagName, lists, lastSeen });

describe('rankListTags excludeWalked', () => {
  const rows = [row('fiction', 49), row('romance', 36), row('young-adult', 34), row('zebra-tag', 5)];
  const walked = ['fiction', 'romance'];

  it('drops walked tags when excludeWalked is set', () => {
    const out = rankListTags(rows, { excludeWalked: true }, walked);
    expect(out.map(r => r.tagName)).toEqual(['young-adult', 'zebra-tag']);
  });

  it('keeps everything when excludeWalked is off, even with walked tags supplied', () => {
    const out = rankListTags(rows, {}, walked);
    expect(out).toHaveLength(4);
  });

  it('ignores the walked list entirely unless the flag is set', () => {
    expect(rankListTags(rows, { excludeWalked: false }, walked)).toHaveLength(4);
    expect(rankListTags(rows, {}, walked)).toHaveLength(4);
  });

  it('applies excludeWalked before the limit, so the limit still fills', () => {
    // Ranking happens then slices — if the filter ran after the slice, the top
    // entries could all be walked tags and the report would come back short.
    const out = rankListTags(rows, { excludeWalked: true }, walked);
    expect(out).toHaveLength(2);
  });

  it('combines with minLists rather than replacing it', () => {
    const out = rankListTags(rows, { excludeWalked: true, minLists: '10' }, walked);
    expect(out.map(r => r.tagName)).toEqual(['young-adult']);
  });

  it('can exclude everything', () => {
    expect(rankListTags(rows, { excludeWalked: true }, rows.map(r => r.tagName))).toEqual([]);
  });

  it('matches walked tags exactly, not by prefix or substring', () => {
    // "fiction" walked must not also drop "science-fiction".
    const out = rankListTags([row('fiction', 9), row('science-fiction', 8)], { excludeWalked: true }, ['fiction']);
    expect(out.map(r => r.tagName)).toEqual(['science-fiction']);
  });

  it('treats an empty walked list as a no-op', () => {
    expect(rankListTags(rows, { excludeWalked: true }, [])).toHaveLength(4);
  });

  it('excludes a walked tag regardless of capitalization', () => {
    // Goodreads treats /show_tag/Dutch and /show_tag/dutch as the same tag, and
    // shell history preserves whatever case was typed. A walked 'Dutch' must
    // still drop the lowercased 'dutch' that list_tags actually stores.
    for (const walked of ['Dutch', 'DUTCH', 'dutch']) {
      const out = rankListTags([row('dutch', 4), row('fiction', 2)], { excludeWalked: true }, [walked]);
      expect(out.map(r => r.tagName)).toEqual(['fiction']);
    }
  });

  it('excludes regardless of the capitalization in list_tags', () => {
    const out = rankListTags([row('Dutch', 4), row('fiction', 2)], { excludeWalked: true }, ['dutch']);
    expect(out.map(r => r.tagName)).toEqual(['fiction']);
  });

  it('does not let mixed case defeat a near-miss (Castilian vs castillian)', () => {
    const out = rankListTags([row('castillian', 9)], { excludeWalked: true }, ['Castilian']);
    expect(out.map(r => r.tagName)).toEqual(['castillian']);
  });
});