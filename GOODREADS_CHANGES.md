# Goodreads Page Change Log

Record whenever Goodreads changes a page in a way that forces a code change.
Newest entry on top. Timestamp format: `YYYY/MM/DD HH:MM` (local time).

## 2026/08/30 23:20 — Author-catalog crawl halted + per-run author page-1 cache

- **Page / URL:** `https://www.goodreads.com/author/list/<authorId>`
- **What changed:** During "Unknown" publication-year backfills, `scrapeBookByAuthorPage`
  crawled the author's catalog (100+ pages) searching for a single usually-obscure volume,
  and re-crawled the same author from scratch for every one of their volumes in the batch
  (e.g. Swift Vol 2, 3, 10 each re-read his full 166-page catalog). Combined with the 3–6s
  `delay()` between pages and Goodreads throttling, one book lookup burned 5–19 minutes of
  back-to-back `(Waiting ...)` lines with no indication of what it was doing.
- **Fix:** `src/scraper.ts` — a single-book lookup now reads the author's **catalog page 1
  only** (no page-2+ crawling; page-1 books are all we need). The parsed page-1 books are
  cached per authorId in a module-level `authorPage1Cache` for the run, so a later book by
  the same author is matched against that cached list with **no network call at all**. New
  pure `findOnAuthorPage(id, titleHint, books)` helper, unit-tested in `scraper.test.ts`.
  The separate `scrapeAuthorStats(crawlAllPages=true)` path keeps its full-crawl behavior.
- **Detected by:** manual run during an `audio_wanted` shelf backfill (Swift volume took
  ~19 min / 1164s; ~30s after the intermediate 5-page cap).

## 2026/08/22 15:24 — Anti-bot throttling: redirect-loop deflection on `/search`

- **Page / URL:** `https://www.goodreads.com/search?q=...`
- **What changed:** A new throttling vector alongside the known HTTP 202 interstitial:
  search requests get bounced in an infinite redirect loop (no HTTP status at all).
  axios fails with `ERR_FR_TOO_MANY_REDIRECTS`; node's undici `fetch` fails the same way.
  Reproduced with a single hand-crafted request ~30 min after the failing test run, so it
  is persistent, not transient.
- **Impact:** Invisible to every existing guardrail — `fetchWithRetry` only classifies
  202/403/429 as throttling, and `scrapeBookBySearch` swallowed all exceptions and returned
  bare `{ id }`, so the integration test failed with a parser-regression-looking
  `title: undefined`.
- **Fix:** (a) `src/utils.ts` `fetchWithRetry` now recognizes `ERR_FR_TOO_MANY_REDIRECTS`,
  logs it loudly, never retries it, and treats it as throttling in strict mode
  (`GOODREADS_STRICT_THROTTLE=1` → immediate fail with clear message). (b) `src/scraper.ts` —
  the five silent live-fetch catches (`scrapeBookBySearch`, `scrapeBookByAuthorPage`,
  `scrapeAuthorStats`, `scrapeTagCount`, `scrapeListDescription`) now log the error code /
  message before returning their fallback value, so future throttles can't masquerade as
  markup changes.
- **Detected by:** integration test `book search round-trips the shelf book`
  (failed 2 runs in a row, 2026/08/22); confirmed via instrumented single-request probes.

## 2026/08/09 10:20 — Search results page: results table markup changed

- **Page / URL:** `https://www.goodreads.com/search?q=...`
- **What changed:** Book results no longer render in a `table.bookTable`. They now live in
  `table.tableList` as rows `tr[itemtype="http://schema.org/Book"]`; the book id also appears in
  `div.u-anchorTarget`; the publication year moved inside the `.minirating` text
  (e.g. `4.29 avg rating — 1,695,328 ratings — published 1965 — 539 editions`).
- **Impact:** `scrapeBookBySearch` (src/scraper.ts) matched `$('.bookTable tr')`, found zero rows,
  and fell back to returning `{ id }` — so every add-book/search lookup lost title/author/ratings/year.
- **Fix:** `src/scraper.ts` — select `$('.tableList tr')`; read the title from
  `span[itemprop="name"]` and author from `.authorName span[itemprop="name"]`; the
  rating/avg/year regexes were unchanged (they already target the meta text that now includes the year).
- **Detected by:** integration test `book search round-trips the shelf book`
  (`./runIntegrationTests.sh`).

### Throttling notes (observed same day)

- Goodreads intermittently serves **HTTP 202 with a 0-byte body** (anti-bot interstitial).
  During debugging, the app's HTTP stack (**axios** via `fetchWithRetry`) received 202 while the
  same request via node's built-in `fetch` (undici) returned 200 with the full page — same UA and
  cookie. The block is intermittent and per-request-stack dependent.
- **Never hammer.** Respect the `delay()` sleeps already in src/utils.ts and the existing
  per-endpoint spacing (e.g. add-book lookups at most once per minute). Re-check after a cooldown
  before concluding a parser is broken.
