import { describe, expect, it } from 'vitest';
import { shouldRescrapeUnknownTitle, UNKNOWN_TITLE_RESCAN_DAYS } from './browserBookScrape.js';
import type { CheckpointRow } from './browserBookScrape.js';

const DAY = 86400000;

function prior(status: 'ok' | 'error', scrapedAt: string): CheckpointRow {
  return {
    book_id: '1',
    status,
    scraped_at: scrapedAt,
  };
}

describe('shouldRescrapeUnknownTitle', () => {
  const now = Date.UTC(2026, 8, 25, 12, 0, 0);

  it('is false for real-titled books with fresh checkpoints', () => {
    expect(shouldRescrapeUnknownTitle(prior('ok', new Date(now - 2 * DAY).toISOString()), 'The Dinner Party', now)).toBe(false);
  });

  it('is false when the checkpoint is not ok', () => {
    expect(shouldRescrapeUnknownTitle(prior('error', new Date(now - 90 * DAY).toISOString()), 'Unknown Title', now)).toBe(false);
  });

  it('is false when unknown-title but the ok checkpoint is still fresh', () => {
    expect(shouldRescrapeUnknownTitle(prior('ok', new Date(now - 1 * DAY).toISOString()), 'Unknown Title', now)).toBe(false);
  });

  it('re-scrapes an unknown-title book once the ok checkpoint goes stale', () => {
    expect(shouldRescrapeUnknownTitle(prior('ok', new Date(now - (UNKNOWN_TITLE_RESCAN_DAYS + 1) * DAY).toISOString()), 'Unknown Title', now)).toBe(true);
  });

  it('treats the "Unknown" placeholder the same way', () => {
    expect(shouldRescrapeUnknownTitle(prior('ok', new Date(now - (UNKNOWN_TITLE_RESCAN_DAYS + 1) * DAY).toISOString()), 'Unknown', now)).toBe(true);
  });

  it('is false with no prior checkpoint (nothing to skip anyway)', () => {
    expect(shouldRescrapeUnknownTitle(undefined, 'Unknown Title', now)).toBe(false);
  });
});