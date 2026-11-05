import { describe, it, expect } from 'vitest';
import {
  sortToEnum,
  bookIdFromImageUrl,
  bookIdFromGiveawayNode,
  parseGiveawaysEdges,
  distinctBookIds,
  giveawaysQuery,
} from './giveaways.ts';

const SAMPLE_IMAGE_URL =
  'https://m.media-amazon.com/images/S/compressed.photo.goodreads.com/books/1715215178i/213082829.jpg';

function sampleNode(overrides: any = {}) {
  return {
    legacyId: 454009,
    details: {
      format: 'KINDLE',
      book: {
        legacyId: 213082829,
        title: 'The Wealth Elevator',
        imageUrl: SAMPLE_IMAGE_URL,
      },
    },
    ...overrides,
  };
}

describe('sortToEnum', () => {
  it('maps UX words to the AppSync enum', () => {
    expect(sortToEnum('recent')).toBe('RECENTLY_LISTED');
    expect(sortToEnum('ending')).toBe('ENDING_SOON');
    expect(sortToEnum('popular')).toBe('POPULAR');
    expect(sortToEnum('featured')).toBe('FEATURED');
  });

  it('accepts enum values case-insensitively', () => {
    expect(sortToEnum('RECENTLY_LISTED')).toBe('RECENTLY_LISTED');
    expect(sortToEnum('ending_soon')).toBe('ENDING_SOON');
  });

  it('falls back to RECENTLY_LISTED for unknown/empty input', () => {
    expect(sortToEnum()).toBe('RECENTLY_LISTED');
    expect(sortToEnum('')).toBe('RECENTLY_LISTED');
    expect(sortToEnum('nonsense')).toBe('RECENTLY_LISTED');
  });
});

describe('bookIdFromImageUrl', () => {
  it('extracts the numeric id from a cover URL', () => {
    expect(bookIdFromImageUrl(SAMPLE_IMAGE_URL)).toBe('213082829');
  });

  it('returns null for missing/unmatched URLs', () => {
    expect(bookIdFromImageUrl(null)).toBeNull();
    expect(bookIdFromImageUrl(undefined)).toBeNull();
    expect(bookIdFromImageUrl('')).toBeNull();
    expect(bookIdFromImageUrl('https://example.com/nocover.png')).toBeNull();
  });
});

describe('bookIdFromGiveawayNode', () => {
  it('prefers details.book.legacyId', () => {
    expect(bookIdFromGiveawayNode(sampleNode())).toBe('213082829');
  });

  it('falls back to the imageUrl when legacyId is absent', () => {
    const node = sampleNode();
    delete (node.details.book as any).legacyId;
    expect(bookIdFromGiveawayNode(node)).toBe('213082829');
  });

  it('returns null when neither source yields an id', () => {
    expect(bookIdFromGiveawayNode({ legacyId: 1, details: { book: {} } })).toBeNull();
    expect(bookIdFromGiveawayNode({})).toBeNull();
    expect(bookIdFromGiveawayNode(undefined)).toBeNull();
  });
});

describe('parseGiveawaysEdges', () => {
  it('flattens connections into giveaway rows', () => {
    const conns = [{ edges: [{ node: sampleNode() }] }];
    expect(parseGiveawaysEdges(conns)).toEqual([
      { giveawayId: '454009', bookId: '213082829', title: 'The Wealth Elevator', format: 'KINDLE' },
    ]);
  });

  it('keeps rows whose book has no usable id, with bookId null', () => {
    const node = sampleNode();
    delete (node.details.book as any).legacyId;
    delete (node.details.book as any).imageUrl;
    expect(parseGiveawaysEdges([{ edges: [{ node }] }])).toEqual([
      { giveawayId: '454009', bookId: null, title: 'The Wealth Elevator', format: 'KINDLE' },
    ]);
  });

  it('drops edges with no node / no giveaway id', () => {
    expect(parseGiveawaysEdges([{ edges: [null, {}, { node: {} }] }])).toEqual([]);
  });

  it('handles empty / nullish payloads', () => {
    expect(parseGiveawaysEdges([])).toEqual([]);
    expect(parseGiveawaysEdges(undefined as any)).toEqual([]);
    expect(parseGiveawaysEdges([null, { edges: null }, { edges: [] }])).toEqual([]);
  });
});

describe('distinctBookIds', () => {
  it('dedupes in first-seen order and drops rows without a book id', () => {
    const rows = [
      { giveawayId: '1', bookId: 'b', title: '' },
      { giveawayId: '2', bookId: 'a', title: '' },
      { giveawayId: '3', bookId: 'b', title: '' },
      { giveawayId: '4', bookId: null, title: '' },
      { giveawayId: '5', bookId: 'undefined', title: '' },
    ];
    expect(distinctBookIds(rows)).toEqual(['b', 'a']);
    expect(distinctBookIds([])).toEqual([]);
  });
});

describe('giveawaysQuery', () => {
  it('embeds the operation, the enum, and the paginated fields', () => {
    const q = giveawaysQuery('RECENTLY_LISTED');
    expect(q).toContain('query getGiveaways');
    expect(q).toContain('getGiveaways(');
    expect(q).toContain('sort: RECENTLY_LISTED');
    expect(q).toContain('pagination: { after: $nextPageToken, limit: $limit }');
    expect(q).toContain('book { legacyId title imageUrl }');
    expect(q).toContain('pageInfo { hasNextPage nextPageToken }');
  });
});
