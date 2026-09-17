import { describe, expect, it } from 'vitest';
import { formatDuration, formatBookLink, httpCallInfo, httpStatusWord, fmtBytes, isConnectivityError, isDbLockError } from './utils.js';

describe('isConnectivityError', () => {
  it('recognizes DNS / connection-level error codes', () => {
    expect(isConnectivityError({ code: 'ENOTFOUND' })).toBe(true);
    expect(isConnectivityError({ code: 'ECONNRESET' })).toBe(true);
    expect(isConnectivityError({ code: 'EAI_AGAIN' })).toBe(true);
    expect(isConnectivityError({ code: 'ETIMEDOUT' })).toBe(true);
  });

  it('rejects throttling / HTTP-level errors and empty values', () => {
    expect(isConnectivityError({ message: 'Request failed with status code 403' })).toBe(false);
    expect(isConnectivityError({ response: { status: 429 } })).toBe(false);
    expect(isConnectivityError(undefined)).toBe(false);
    expect(isConnectivityError(new Error('boom'))).toBe(false);
  });
});

describe('isDbLockError', () => {
  it('recognizes SQLITE_BUSY codes and messages', () => {
    expect(isDbLockError({ code: 'SQLITE_BUSY', message: 'database is locked' })).toBe(true);
    expect(isDbLockError({ code: 'SQLITE_BUSY_SNAPSHOT' })).toBe(true);
    expect(isDbLockError(new Error('database is locked'))).toBe(true);
    expect(isDbLockError({ message: 'database table is locked' })).toBe(true);
  });

  it('rejects non-lock errors and empty values', () => {
    expect(isDbLockError({ code: 'ENOTFOUND' })).toBe(false);
    expect(isDbLockError(new Error('Request failed with status code 403'))).toBe(false);
    expect(isDbLockError(undefined)).toBe(false);
  });
});

describe('formatDuration', () => {
  it('formats sub-minute runs', () => {
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(45000)).toBe('0m');
  });

  it('formats minutes', () => {
    expect(formatDuration(60000)).toBe('1m');
    expect(formatDuration(5 * 60000 + 30000)).toBe('5m');
  });

  it('formats hours and minutes', () => {
    expect(formatDuration(60 * 60000)).toBe('1h 0m');
    expect(formatDuration(2 * 3600000 + 18 * 60000)).toBe('2h 18m');
  });

  it('truncates seconds', () => {
    expect(formatDuration(3600000 + 60000 + 59000)).toBe('1h 1m');
  });
});

describe('formatBookLink', () => {
  it('builds a well-formed link for a plain title', () => {
    expect(formatBookLink('Dune', '1')).toBe('[book:Dune|1]');
  });

  it('strips nested brackets from the title', () => {
    expect(formatBookLink('約束のネバーランド 19 [Yakusoku no Neverland 19] (The Promised Neverland, #19)', '51925212')).toBe(
      '[book:約束のネバーランド 19 Yakusoku no Neverland 19 (The Promised Neverland, #19)|51925212]'
    );
  });

  it('strips pipe characters from the title', () => {
    expect(formatBookLink('Title | Part', '7')).toBe('[book:Title Part|7]');
  });

  it('strips leading/trailing brackets and collapses spaces', () => {
    expect(formatBookLink('[Hello] World', '3')).toBe('[book:Hello World|3]');
    expect(formatBookLink('A  [B]  C', '4')).toBe('[book:A B C|4]');
  });
});

describe('httpCallInfo', () => {
  it('logs status as both a string word and a numeric code', () => {
    expect(httpStatusWord(200)).toBe('ok');
    expect(httpStatusWord(202)).toBe('throttled');
    expect(httpStatusWord(403)).toBe('throttled');
    expect(httpStatusWord(429)).toBe('throttled');
    expect(httpStatusWord(404)).toBe('missing');
    expect(httpStatusWord(500)).toBe('500');
    expect(httpStatusWord(undefined)).toBe('-');
  });

  it('humanizes byte counts', () => {
    expect(fmtBytes(850)).toBe('850B');
    expect(fmtBytes(98914)).toBe('96.6KB');
    expect(fmtBytes(1171235)).toBe('1.1MB');
    expect(fmtBytes(undefined)).toBe('0B');
  });

  it('renders the keyed per-call line, seconds with 3 decimal places', () => {
    expect(httpCallInfo(200, 1171235, 3216)).toBe('[ok] http=200 dur=3.216s size=1.1MB');
    expect(httpCallInfo(200, 98914, 1130)).toBe('[ok] http=200 dur=1.130s size=96.6KB');
    expect(httpCallInfo(200, 1171235, 3216, ['bookId', 136943])).toBe(
      '[ok] bookId=136943 http=200 dur=3.216s size=1.1MB'
    );
    expect(httpCallInfo(202, 0, 501, ['listId', '163746'])).toBe(
      '[throttled] listId=163746 http=202 dur=0.501s size=0B'
    );
    expect(httpCallInfo(undefined, 0, undefined)).toBe('[-] http=- dur=- size=0B');
  });

  it('honors an explicit status-word override', () => {
    expect(httpCallInfo(500, 512, 900, ['bookId', 7], 'error')).toBe(
      '[error] bookId=7 http=500 dur=0.900s size=512B'
    );
  });
});

