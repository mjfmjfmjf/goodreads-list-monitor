# Goodreads Page Change Log

Record whenever Goodreads changes a page in a way that forces a code change.
Newest entry on top. Timestamp format: `YYYY/MM/DD HH:MM` (local time).

## 2026/10/18 21:10 — bookGenres serves COMPOUND legacy genre labels (~13% of books)

Not a page change — data-shape finding while adding `books --genre/--notGenre`.
The Apollo `bookGenres[].genre.name` values are usually discrete ("Comics",
"Graphic Novels", "X Men" — verified faithful vs a live page for
/book/show/44024187, stored correctly), but Goodreads itself ALSO serves
**combined legacy labels** — only 5 distinct ones exist DB-wide
(`Graphic Novels Comics` 7.8k, `Science Fiction Fantasy`, `Comics Manga`,
`Dc Comics`-style, `Comics Bd`) — hitting ~13% of scraped books, stable across
Sept/Oct scrape months (not a parser regression). Consequence: exact matching
would let compound-labelled books dodge an exclusion, so `books --notGenre`
uses **word-boundary matching** on the normalized (spaces≡hyphens, lowercase)
label (`comics` matches `Graphic Novels Comics`; `novel` does not match
`novels`). `--genre` stays exact. No scraper fix needed — the data is what
Goodreads serves.

## 2026/10/17 09:30 — Giveaways feed: AppSync `getGiveaways` book-id discovery walker

Not a page change — recording a new crawler. `./giveaways.sh` (`src/giveaways.ts`,
command `giveaways`) walks `https://www.goodreads.com/giveaway?sort=recently_listed`
purely to harvest **book ids**, then hands them to `browser-book-scrape` (book-id only;
nothing giveaway-specific is persisted).

- The listing paginates client-side (the "Show more giveaways" button); `?page=N` is
  **ignored** (page 2/3 returned the same 5 rows). The data comes from Goodreads' own
  AppSync `getGiveaways` query — the **same endpoint** as popular-by-date
  (`APPSYNC_URL`), with the api key at `__NEXT_DATA__.props.pageProps.apiKey`. The page
  is server-rendered, so the AppSync POST only fires after a click; the walker instead
  drives `getGiveaways` from inside the page with `fetch()`.
- Pagination chains a **base64** `nextPageToken`
  (`{"featured_ordering_seed":null,"sort_value":…,"id":…}`) until `hasNextPage=false`
  (getTopList uses hex — different). The server **caps a page at 15** (limit 30 → 15);
  `totalCount` was 1,788 on 2026/10/17 → ~120 fetches for a full walk.
- **Book id source**: `details.book.legacyId` is selectable on the Giveaway→Book edge
  (spike-verified: giveaway 454009 → book 213082829, matching
  `/book/show/213082829`); fallback is the cover `imageUrl` tail
  (`/books/<digest>i/<id>.jpg`). Verified live 2026/10/17 (headed browser; 3 pages →
  45 fetched / 45 distinct ids, http 200).

## 2026/10/16 19:40 — Derived `book_page` ratings statistics + `books.sh` sorts, backfill, streaming fixes

Not a page change — recording a feature that adds derived handling around the
already-stored `ratings_dist`.

- **New `book_page` columns** derived from the stored `ratings_dist` JSON:
  `ratings_mean`, `ratings_median`, `ratings_mode`, `ratings_variance`,
  `ratings_stddev`, `ratings_skewness` (3rd standardized moment), `ratings_kurtosis`
  (EXCESS; normal = 0) and `ratings_total` (= histogram sum, which legitimately
  differs from `books.ratings`). All NULL when `ratings_dist` is
  missing/empty/unparseable; skewness/kurtosis are also NULL when stddev = 0.
  Added the `CREATE TABLE` columns, a guarded `ALTER TABLE` migration
  (`src/db.ts`), and the export header (`exportData.test.ts`).
- **Pure module `src/ratingsStats.ts`** (`parseRatingsDist` / `computeRatingsStats`
  / `ratingsStatsColumns`) so the recompute is unit-tested offline.
- **Recomputed at every write path**: `browserBookScrape.saveBookPage` and
  `importData.importBookPagesFile` spread `ratingsStatsColumns(...)` into the
  upsert alongside `ratings_dist`, so the derived columns can't drift from it.
- **`backfill-ratings-stats` CLI** (+ npm script + `backfillRatingsStats.sh`) to
  populate existing rows. Keyset-chunked (`CHUNK=5000`) — NOT a whole-table
  `[...streamRows(...)]` snapshot (that is the `loadBookCache` anti-pattern;
  better-sqlite3 also forbids `.run()` while a read iterator is open). Live run:
  237,003 updated / 23,384 unchanged / 45 skipped, 7.6 s; re-run updated 0
  (idempotent), overwriting values left by an out-of-band session.
- **`books.sh` sorts**: the 8 stats are new `--sort` keys (`ratingsMean` …
  `ratingsTotal`), distinct from `avgRatings`/`numRatings`. Derived sorts now
  EXCLUDE books whose stat is missing (unknown ≠ 0) — previously `--asc` listed
  distribution-less books first via `?? 0`.
- **`backfillSeriesPos` fix**: was `for (snap of iterateBooks()) upsertBook(...)`,
  which throws "This database connection is busy executing a query" on the first
  changed row (read iterator + `.run()` on one connection). Rewritten to
  keyset-chunked `.all()` pages with a targeted `UPDATE books SET series_pos = ?
  WHERE id = ?`. Live run filled 1,293,353 rows.
- **`books.sh` perf**: `--minRatings` is now pushed into SQL
  (`iterateBooks({ minRatings })` seeks `idx_books_ratings`) instead of filtering
  after `rowToBook()` over all 13.26M books — 32.3 s → 12.1 s for
  `--sort editionCount --dedupe --minRatings 1000`.
- **AGENTS.md**: documented the single-connection read/write constraint +
  keyset-chunked pagination rule.

Verified: `./runUnitTests.sh` 85 files / 1060 tests + 2 CLI smoke green;
`./runIntegrationTests.sh` 2 files / 15 tests green; a live `browser-book-scrape`
wrote a new `book_page` row whose 8 columns matched an independent recompute.

## 2026/10/10 — Other-user review-list rating markup renamed `staticStars` → `readOnlyStars`

- Logged-in fetch of another user's review list (`/review/list/<id>?shelf=read`,
  verified against user 1147761, 200) shows the reviewer's rating now rendered as
  `<span class="readOnlyStars notranslate" title="really liked it">` with child
  spans `readOnlyStar full` / `readOnlyStar empty` — the old
  `staticStar p10` / `staticStar p0` classes no longer appear anywhere on the
  page. The `title` word label ("liked it" etc.) is untouched.
- `parseRowRating`'s other-user fallback now looks at both `.staticStars` (legacy,
  still matched so stale/cached pages parse) and `.readOnlyStars` for the title,
  and counts both `.staticStar.p10` and `.readOnlyStar.full` for the
  title-less fallback (src/reviewListSync.ts).
- Verified quarter-star data on other-user pages: the friend's rows in this fetch
  were all whole-star (titles `did not like it` … `it was amazing`, no fractional
  `readOnlyStar` class observed). The only `data-rating` on the page is on the
  viewer's own "my rating" shelf widget (`data-user-id="970632"`), which the
  parser already ignores. Fractional other-user rendering (e.g. a friend who rated
  3.75) is still UNOBSERVED — if/when one appears, re-check whether
  `readOnlyStar` gets a partial class or `readOnlyStars` gains a `data-rating`.

## 2026/10/03 19:30 — §4 MERGED the legacy `authors.fail_count` into the ledger (dropping it was the bug)

- **What was wrong:** §4 pointed the sweeps' candidate filter at
  `author_scrape_failures` alone while `authors.fail_count` still existed, and the
  planned migration DISCARDED the legacy counts. The two ledgers barely overlap —
  on the live DB **569 ids were legacy-only, 721 ledger-only** — because the
  legacy counter was written by years of past crawls. So every author the legacy
  counter had already retired at the threshold was silently re-admitted:
  **519 never-crawled authors at `fail_count >= 5`**, plus 154 at 1–4. Proof from
  the running log: `52038502` (`thornton-sarah`, the very id being re-scraped)
  carried `fail_count = 5` and was being fetched anyway. A `--sortBy topRatings`
  queue **grew** 235,645 -> 235,907 instead of shrinking.
- **Fixed, two parts:**
  1. `loadStrikeMap()` now UNIONES both sources with `MAX()`, so an author is
     skipped if EITHER ledger says it is exhausted. This protects every run
     between now and the migration, and is what stopped the immediate bleeding.
  2. `author-ledger-migrate` now MERGES the legacy strikes into the ledger
     (`MAX(authors.fail_count, ledger.fail_count)`) in the same transaction as the
     drop, instead of dropping the data. Applied to the live DB: **877 -> 1,403
     ledger rows (+526)**, 520 authors now at/over the threshold.
- **Why MAX is correct:** a legacy `5` means "exhausted" and must keep excluding
  the author — 503 legacy rows sit at exactly 5, the old cap, which is a retired
  author and not a suspicious number. MAX also never lowers an existing ledger
  count.
- **Migration bug found and fixed on first apply:** `ALTER TABLE ... DROP COLUMN`
  already removes the column's indexes, so the trailing `DROP INDEX` failed with
  `no such column: page_gone` and rolled the transaction back. The index is now
  dropped BEFORE the column.
- **Live DB after apply:** `authors` = `id, name, slug, last_seen, average_rating,
  num_ratings, num_reviews, num_shelves, first_seen, catalog_pages, ratings_rate`.
  `fail_count`, `last_error`, `page_gone` gone; `integrity_check: ok`; fresh
  backup in `backups/goodreads.db.2026-10-04` (5.81 GB, 60.7s).
- **Tests:** 76 files / 903 tests + CLI smoke. `authorLedgerMigrate.test.ts`
  covers the merge, MAX-both-directions, and no-double-count on re-run;
  `storage.test.ts` pins the union filter.

## 2026/10/03 19:20 — REVERTED: permanent `authors.page_gone` retirement of dead author pages

- **What was wrong:** a 404/410/400 author page was classified as a durable FACT
  (`scrapeAuthorStats` reported the sentinel `author_page_gone`) and each sweep
  retired the id via a new `authors.page_gone` column while explicitly recording
  **no strike**. That removed the only mechanism that was actually making
  progress: a strike-based skip drops an author from the crawl queue after
  `AUTHOR_FAIL_LIMIT` runs, whereas retirement-without-a-strike drops nothing.
  Live effect on 2026/10/03: `author-rescan --sortBy topRatings` queued 235,645
  authors, the first ~80 were all one-book misattributed ids (404), and the queue
  did not shrink between runs (235,645 → 235,820) — every dead author re-404'd
  forever, each with three lines of noise instead of one.
- **Fixed:** reverted entirely. `isPermanentAuthorPageFailure` is back to
  `4xx && !== 429`, so 400/404/410 count a strike like any other permanent
  failure and the author is filtered out of the queue after `AUTHOR_FAIL_LIMIT`.
  Removed `isDeadAuthorPage`, `isThrottleResponse`, `THROTTLE_STATUSES`,
  `AUTHOR_PAGE_GONE`, `markAuthorPageGone`, `clearAuthorPageGone`,
  `countAuthorsPageGone`, the `pageGone` field/SQL, the `page_gone` DDL and
  startup migration, the two `entry.pageGone` candidate filters, the
  `retired_gone` report line, and the export/import round-trip of the column.
- **Lesson (the point of the workaround):** a permanent failure must consume a
  strike. "This id is bad forever" is only actionable if it removes the author
  from the queue; a flag that is written but never filters anything just makes
  the run louder and the queue permanent.
- **Live DB:** `authors.page_gone` is still present but inert (nothing reads or
  writes it). `authorLedgerMigrate` now drops it alongside `fail_count` /
  `last_error`.
- **Tests:** `src/scraper.test.ts` asserts dead pages ARE permanent failures
  (with a comment recording why), and `src/storage.test.ts`'s retirement suite is
  deleted. Full gate: 76 files / 900 tests + CLI smoke.

## 2026/10/03 19:05 — §4 unified the author strike ledger; dropped `authors.fail_count` / `authors.last_error`

- **What changed:** failure state for author pages now lives in exactly ONE
  place, `author_scrape_failures`, read through `loadStrikeMap()` /
  `loadAuthorScrapeFailure()` and gated by ONE threshold,
  `storage.ts:AUTHOR_FAIL_LIMIT = 5`.
- **Was:** two parallel counters that could disagree — `authors.fail_count`
  (limit 5) and `author_scrape_failures.fail_count` (limit 3), plus
  `authors.last_error`. A single failure could burn a strike in both.
- **Fixed:** removed `recordAuthorFailureById` and every `authors.fail_count` /
  `authors.last_error` read and write (`authorRescan`, `authorOrphans`,
  `authorRecent`, `authorTopBooks`, `authorOne`, `scraper`, `importData`,
  `authorRekey`, `fieldCoverage`). `authors` no longer creates or migrates the
  two columns; `authorRekey`'s rebuild DDL drops them. `field-coverage` reports
  `failed_ever` / `chronic_failures` from the ledger with the shared constant
  instead of two hardcoded limits.
- **Migration NOT yet applied to the live DB:** the dropped columns are still
  present there. They are inert (nothing reads or writes them). Deliberately does
  NOT import the legacy counts: on the live DB 331 of the 354 never-crawled
  authors it would block have `last_error=ERR_BAD_REQUEST`, i.e. exactly the
  dead-page class that is now a normal strike — importing it would exclude them
  from the crawl for a reason that no longer applies. Drop the columns only with
  the crawlers stopped.
- **Tests:** `src/exportData.test.ts` (authors header without strike columns),
  `src/authorRekey.test.ts` (6).

## 2026/10/03 19:05 — New `./bookLanguages.sh` and `./bookFormats.sh` facet catalogs

- **What changed:** added `book-languages` / `book-formats` commands, modelled on
  `publisher-catalog`, sharing one module (`src/facetCatalog.ts`) because
  `language` and `format` are both plain `book_page` columns.
- **Ranking** reuses the publisher work-dedup rule: editions of one work
  collapse, each `(facet, work)` represented by its highest-rated edition.
  Sorts `--sortBy books|avgRating|totalRatings`, filters `--minBooks`
  / `--minRatings`, `--limit`.
- **Data note:** `book_page.format` is the raw page string and its tail is
  messy — 227 distinct values, with case/whitespace variants splitting real
  formats (`Paperback` 72,961 vs `paperback` 31 vs `Paperback ` 9). Values are
  trimmed, inner whitespace collapsed, and case-folded by default; the folded
  spellings are listed as `also:` so nothing is hidden, and `--raw` keeps them
  apart. Placeholders (`Unknown Binding`, which alone is 2,244 rows) are
  excluded. `language` needs no folding (71 values, no trim or case dupes).
- **Not a Goodreads page change** — recorded here only because the log is the
  place the two §4-adjacent changes above are tracked.
- **Tests:** `src/facetCatalog.test.ts` (13).

## 2026/10/03 17:55 — `/author/list/<id>` returns **HTTP 400 (ERR_BAD_REQUEST)** for some valid author ids

- **Page / URL:** `https://www.goodreads.com/author/list/<authorId>` — the URL
  `buildAuthorListUrl` builds for every author crawl (`author-rescan`,
  `author-orphans`, `author-recent`, `author-top-books`).
- **What happened:** the `author-orphans --scrape` run logged
  `⚠️ Author stats fetch failed for 53189166: ERR_BAD_REQUEST` and the same for
  `36868517` on ids that are otherwise normal (a real book with 63,567 ratings
  sits on `53189166`). This is a **400**, not the 404 we treat as a dead id, and
  it is not the 202/403/429 anti-bot shape — so it is neither a dead-end signal
  nor throttling. Observed only on the id-only `/author/list/` form; the same
  authors were not re-tested against `/author/show/`.
- **Impact:** each occurrence costs a strike in **both** failure ledgers
  (`authors.fail_count` limit 5 *and* `author_scrape_failures.fail_count`
  limit 3 — `authorOrphans.ts` records both for one event), so a 400 currently
  burns two of an author's three-strike budget per attempt. Whether a 400 is
  permanent for a given id is not yet established; treat it as retryable until
  proven otherwise, and do **not** shrink the pacing in response (this is not
  throttle-shaped).
- **Also recorded (data, not a page change):** `books.published` is the literal
  string **`'Unknown'`** for **8,780,422 of 11,578,563 books (75.8%)** in the
  live DB. This is our own stored value, not a Goodreads response, but it is the
  durable fact behind a serious selection bug: `loadAuthorBookStats` gated its
  *entire* aggregation on a parseable 4-digit year, so any author whose books
  were all `'Unknown'` produced no stats row, and `selectMultiPageAuthors` drops
  book-based-sort authors with no stats row. That made
  `author-rescan --multiPage --onlyUntouched --sortBy topRatings` able to see
  only **~393 of 236,804** never-crawled authors (99.84% invisible) — the grind
  reported "Done" after ~600 authors. Fixed by scoping the year range to
  `newest` only (`top`/`books` now use `ratings` alone unless `--minBookYear` is
  set, which is that flag's documented job); reachable authors went
  **597 → 234,573**. Regression tests in `src/authorBookStats.test.ts`.
  **Lesson:** a filter added to tame one sort key must not silently gate the
  others — `ratings` is ~100% dense, `published` is 24% dense.
- **Fix:** the strike double-write is removed in the ledger unification
  (`PLAN-author-completion.md` §4). A follow-up should decide whether a 400 gets
  its own `onError` reason so it can be distinguished from `404`/`no_stats_line`
  in `author_scrape_failures.last_error`.

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
