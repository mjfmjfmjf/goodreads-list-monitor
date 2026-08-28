import { describe, expect, it } from 'vitest';
import { extractAuthorId, acceptAuthorListMatch } from './scraper.js';

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

describe('acceptAuthorListMatch', () => {
  it('accepts a confirmed hit even when published is Unknown (regression: check-book)', () => {
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
