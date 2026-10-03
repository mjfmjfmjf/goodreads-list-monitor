# Goodreads Page Change Log

Record whenever Goodreads changes a page in a way that forces a code change.
Newest entry on top. Timestamp format: `YYYY/MM/DD HH:MM` (local time).

## 2026/09/30 17:55 — Tag-shelf pagination footer advertises UNREACHABLE pages (last_page_seen = 100, only ~page 25 serves content)

- **Page / URL:** `https://www.goodreads.com/shelf/show/<tag>?page=<n>` (the pagination
  footer `extractShelfPageLinks` reads).
- **What happened:** For large tag shelves the rendered pagination footer advertises a last
  page of **100** (stored as `tag_stats.last_page_seen` by `persistShelfPageCount`), but
  requesting that page 404s: the first live run of the new tag-recent-monitor logged
  `❌ Error fetching shelf page 100: Request failed with status code 404` for "biology",
  "teen-reads", "police-procedural", "single-mom", "preschool" and more. Shelf content is
  only served up to about **page 25**. Note an anonymous `curl` of `?page=100` returns
  HTTP 200 — but with **no pagination block at all** and a soft/empty book grid, i.e. a
  soft-404; the crawler's 404 (cookie-authenticated axios) is the authoritative
  "not reachable" signal. This is the shelf-side analogue of the list-side cap already
  documented in `src/listPageParse.ts` (`MAX_LIST_PAGE_NUMBER = 100`).
- **Impact:** `getKnownShelfPages` is `COALESCE(last_page_seen, estimate_page)`, and the
  new monitor used it as a tail-read start page. Every tag whose measured length exceeds
  the reachable page burned a 404 plus a wasted page-1 re-probe and harvested nothing —
  and the footer's advertised number is also why a huge share of tags reported
  `known last page: 100` in the coverage dry run.
- **Also observed (2026/10/01):** the same shelf advertised 10 pages from its
  page-11 response and ~11 pages from its page-1 response minutes later, and a
  shelf page renders more `.elementList` rows than it has book links (quilting
  page 25: 52 rows → 50 books). Both make the footer untrustworthy as a length
  and made a tail read aimed at a since-shrunk shelf fall back to page 1. Fixed
  by `reanchorShelfPage` (re-anchor once to the last page the footer admits
  exists) and by reporting `N book(s) from M shelf row(s)`.
- **Fix:** the tail read no longer uses the footer's page count as its start page at all.
  `tag_books.position` is each book's GLOBAL 1-based shelf position
  (`bookPos = (startPage - 1) * 50` in `scrapeShelfBooks`, 50 books/page, indexed by
  `idx_tag_books_position(tag_name, position)`), so the last page actually harvested for a
  tag is `ceil(MAX(position) / 50)` — local, free, and always reachable. New
  `loadTagAnchors` in `src/storage.ts` reads `COUNT(*)`, `MAX(position)` and
  `last_page_seen` for the whole covered list in one chunked query (1.3s for all 4,084
  tags). `tailAnchorPage` turns that into a start page (dropping to page 1 when the
  harvest is sparser than its max position, i.e. there are un-read gaps below), and
  `tailReadWindow` still clamps the start and the outer wall to
  `MAX_REACHABLE_SHELF_PAGE = 25` as a safety net. Live: `tag_books` holds 4,565,515
  rows and virtually every tag's harvest reaches position 1,250 = page 25, so each
  covered tag now costs ~1 fetch instead of a 404 + probe. The re-probe path also keeps
  the probe page's books instead of discarding them. The backfilled `estimate_page`
  (`shelf_book_count / 50`; real "manga" estimates 125,293 pages) is ignored for tail
  starts entirely. Unit tests in `src/tagRecentMonitor.test.ts`; see
  `PLAN-tag-recent-monitor.md`.
- **Throttling note:** no extra requests were spent diagnosing this in bulk — the clamp is
  unit-tested and the live behavior was confirmed from the run log the user already had.

## 2026/09/29 20:22 — Author-page stats block served in MULTIPLE formats (A/B / in-flight rollout)

- **Page / URL:** `https://www.goodreads.com/author/show/<id>` (the header stats that
  `parseAuthorStats` reads).
- **What happened:** The author stats block now appears in at least TWO coexisting formats,
  and which one a request gets seems to be an A/B / canary split, NOT a clean migration:
  - **New format:** counts keyed by `itemprop` inside `.hreview-aggregate` — average in
    `span.average[itemprop="ratingValue"]`, ratings in `span.votes .value-title[itemprop="ratingCount"]`,
    reviews in `span.count .value-title[itemprop="reviewCount"]`. **No "shelved N times" string at all.**
    The `a.authorName` link that used to sit next to the numbers is gone from this layout.
  - **Old format:** the classic text line next to the author's name link
    (`Average rating X · N ratings · M reviews · shelved K times`) in the
    `.leftContainer` block, which the old parser regex read.
  - Both were observed for the SAME author (32708716 Goswin of Bussut) minutes apart:
    the real browser (regular AND incognito) and the app's axios fetch (Chrome/120 UA,
    HTTP/1.1) got the **old** format ("shelved 6 times"); a raw curl got the **new** format
    every time, regardless of UA, login cookie, Accept headers, or HTTP/1.1 vs HTTP/2.
  - **Impact:** ~9,115 authors are "scraped but statless" (`catalog_pages >= 1` but all four
    counts 0/undefined, fresh `last_seen`) — consistent with requests that received the new
    format while the parser only knew the old one. `scrapeAuthorStats` bails with
    `no_stats_line` when every stat is absent, but `parseAuthorStats` old code returned an
    empty stats object and `catalog_pages` still got written, leaving a 0 baseline.
- **Fix:** `src/scraper.ts` `parseAuthorStats` now reads whichever layout is present:
  `.hreview-aggregate` itemprop first, legacy `.leftContainer a.authorName` regex as the
  fallback, and slug falls back to the canonical `<link rel="canonical">`. Unit tests cover
  both shapes. `GOODREADS_CHANGES.md` note: `num_shelves` only exists in the old format, so it
  (and the `hasStats` assessment of an author) will be inconsistent between format variants —
  and reporters should treat "new vs old" as a live experiment, not a settled migration.

## 2026/09/25 10:30 — `/book/show` throttled by HTTP 202 interstitial while other endpoints pass

- **Page / URL:** `https://www.goodreads.com/book/show/<id>` via the axios SSR engine.
- **What happened:** A full integration run (2026/09/25 10:11) got all 14 non-book/show
  live tests green (shelves, author stats/catalog, list pagination 1/2/3-page, review-list
  year read, add-book lookup) but the axios book-page scrape was served an HTTP 202 0-byte
  interstitial for `book/show/24548235` (Harry Potter and the Philosopher's Stone). Same
  URL 202'd again after ~90s cooldown while the identical axios transport succeeded on
  every other endpoint in the same run. This is the known anti-bot throttle pattern
  (browser gets full 200), not a markup change or parser regression.
- **Outcome:** No code change. The integration suite's `GOODREADS_STRICT_THROTTLE=1`
  behavior correctly failed fast; retry after a longer cooldown. Signals that `/book/show`
  is the first URL to be 202-throttled during cooldowns.

## 2026/09/02 08:45 — Review-list rows can carry a month-only Date Read

- **Page / URL:** `https://www.goodreads.com/review/list/<userId>?shelf=read&read_at=YYYY`
- **What changed:** Some rows show a month-only date (e.g. `"Feb 2026"`, `"Aug 2026"`)
  in `.date_read_value` instead of the usual `"Mon DD, YYYY"`, when a specific day isn't
  known. The old `parsePageDate` regex dropped these (returned `''`), so those books were
  silently missing from `year-in-books --userId` (e.g. "Quicksilver: No Surrender"; 12 of
  180 books for user 1147761 were dropped).
- **Fix:** `src/reviewListSync.ts` `parsePageDate` now also matches `Mon YYYY` and
  normalizes it to `YYYY/MM/01`, so the book still lands in the right year.

## 2026/09/01 20:05 — Anonymous review-list requests redirect to Sign-in

- **Page / URL:** `https://www.goodreads.com/review/list/<userId>` (any user's profile,
  including our own), with or without `shelf=read&read_at=YYYY`.
- **What changed:** Goodreads now serves a "Sign in" interstitial page (HTTP 200, ~13-15k
  bytes, no `tr.bookalike.review` rows) to unauthenticated requests for review lists.
  This affects both the existing review-list sync and the new
  `year-in-books --userId <id>` live source.
- **Fix:** `src/reviewListSync.ts` `fetchLiveYearReads` sends the stored config cookie
  (`loadConfig().cookie`); `year-in-books` passes it through. The cookie still works for
  viewing *other* users' public review lists.

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
