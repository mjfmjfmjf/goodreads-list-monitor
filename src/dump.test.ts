import { test } from 'vitest';
import { buildAuthorBucketBuckets, computeAuthorTopBookHistogram } from '/Users/mitchellfriedman/codebase/goodreads/src/authorTopBookHistogram.js';
import { CachedBook } from '/Users/mitchellfriedman/codebase/goodreads/src/storage.js';
test('dump', () => {
  const b = buildAuthorBucketBuckets();
  const C = (c: CachedBook) => computeAuthorTopBookHistogram([c]);
  const c = computeAuthorTopBookHistogram([]);
  const book: CachedBook = { id:'x', title:'T', author:'A', ratings:'5,000,000', published:'', lastUpdated:'' };
  const bc = computeAuthorTopBookHistogram([book]);
  console.log('buckets', b.length, 'first', JSON.stringify(b[0]), 'last', JSON.stringify(b[b.length-1]));
});
