# PLAN: `popular_by_date` walker + book-detail scrape

Status: **implemented — `src/popularByDate.ts` shipped 2026/09/25.**
Blockers/notes: the AppSync meta capture requires the headed browser page (endpoint
+ x-api-key captured from the site's own traffic each run). `GET_TOP_LIST_QUERY` is
a frozen const covering both `TopListBookEdge` (month) and `TopListWorkEdge` (year)
shapes — validated live against both `books-by-release-date-2026-9` (200 books, 14
fetches) and `works-by-release-date-2012` (200 books, 14 fetches).
Created 2026/09/25 after hand-inspecting 12+ `popular_by_date` pages (SSR HTML,
`__NEXT_DATA__`, chunk manifests, AppSync endpoint discovery).

## 1. Goal

Add a CLI command that walks Goodreads' "Popular This Month / By Year" pages
(`/book/popular_by_date`) — a release-date-ranked book feed — collects the book
IDs on each page, then feeds them through the existing book-detail scrape
(`browser-book-scrape` / `processBook`) to harvest full `book_page` rows
(publisher, ISBN, genres, series, etc.).

Two URL shapes, both SSG/Next.js:
- Monthly: `https://www.goodreads.com/book/popular_by_date/2026/9` (also `2026/09`)
- Yearly:  `https://www.goodreads.com/book/popular_by_date/2012`

## 2. Verified ground truth (2026/09/25, anonymous curl)

These were actually read — trust these over memory.

### URL availability
- Month paths work from at least `2023/1` up to future months (`2026/10`, `2026/11`
  all return real data). `2022/12` and earlier return a **client-side 404** (HTTP
  200 body, `<title>404: This page could not be found</title>`, zero books in
  Apollo state). So the month feed spans ~ the last 2 years plus a few months into
  the future AND back — the exact boundary must be probed at runtime, not hard-coded.
- Year paths work from at least `2011`/`2012` back (checked `2022`, `2012` → 200).
- Both leading-zero (`2026/09`) and bare (`2026/9`) month paths resolve to the
  same page. Use bare (`YYYY/M`) consistently.

### Render model — critical for the design
- Each URL is a Next.js page. `__NEXT_DATA__` (script tag `type="application/json"`)
  contains `props.pageProps.apolloState` with exactly **15 books** (GraphQL
  `pagination:{ after:null, limit:15 }`).
- `ROOT_QUERY` key shape (month): `getTopList({"getTopListInput":{"location":"ALL",
  "name":"books-by-release-date-2026-9","period":"A"},"pagination":{"after":null,"limit":15}})`
  and (year): `name:"works-by-release-date-2012"`. Returns `TopListConnection`
  with `pageInfo:{ hasNextPage, nextPageToken }`.
- `nextPageToken` is **NOT opaque** — it is hex-encoded JSON
  (`{"topListKey":"books-by-release-date-2026-9_A_ALL","rank":"15"}`) that the
  server echoes back with `rank + 15` on each page; pagination chains it until
  `hasNextPage=false`. The AppSync POST needs no AWS signing — just the
  `x-api-key` header — so the walker can drive the whole loop from inside the
  page with `page.evaluate(fetch)`.
- The page has a **"Show more"** button (confirmed present in the SSR HTML) that
  fires further Apollo/AppSync queries to load the rest (~200 books/user report).
- The Apollo HTTP link is **AWS AppSync**: `https://gychkpo36vhkzfbi6dge4i2isq.appsync-api.us-east-1.amazonaws.com/graphql`
  (endpoint found in `_app` chunk config, `x-api-key` from `pageProps.apiKey`).
  Replicating that by hand (API key + opaque cursor + AWS signing) is brittle —
  drive the real browser instead.

### Book data available at LIST level (no per-book fetch needed)
- Book entity fields: `id` (`kca://book/amzn1.gr.book.v3.*`), **`legacyId`** (the
  numeric `book/show/<id>` we key on), `title`, `titleComplete`, `imageUrl`,
  `description`, `webUrl`, `primaryContributorEdge`/`secondaryContributorEdges`
  (authors), `work`, `viewerShelving`.
- Work entity: `stats { ratingsCount, textReviewsCount, averageRating }`,
  `editions.webUrl` (`/work/editions/<workId>`).
- So the listing gives us the exact `book_id` + up-to-date ratings before any
  per-book scrape.

## 3. Design

Two-phase command (mirrors `listTagWalker`/`listPopularWalker` + `browserBookScrape`):

**Phase A — enumerate (browser engine required).** New walker
`scrapePopularByDate` (new `src/popularByDate.ts`), launched headless via
`launchBrowserProfile` (reuse `browserSession.ts`). For each page:
1. `page.goto('https://www.goodreads.com/book/popular_by_date/<YYYY/M>')`.
2. Parse the first 15 books straight from `__NEXT_DATA__` (no extra request).
3. Read the client-rendered DOM (or intercept AppSync responses via
   `page.on('response')` filtering the appsync URL) after clicking **"Show
   more"** until `hasNextPage` is false or a per-page cap (~200) / total limit
   is reached. Prefer response interception: structured JSON, immune to markup
   drift; DOM card classes are the fragile path. Also keeps one page load / one
   tab for the whole pagination sequence (gentle).
4. Upsert the listing into a **new `popular_by_date_book` table**:
   `page_key` (`YYYY` or `YYYY-M`), `book_id`, `rank`, `title`, `work_id`,
   `stats_ratings`, `stats_reviews`, `stats_avg`, `scraped_at`, PK
   `(page_key, book_id)`. This is the checkpoint — re-running a page skips it
   if newly scraped (mirrors `skipDays` semantics; keep the tolerance loose so
   refreshable rankings don't get locked forever).

**Phase B — book details.** Feed collected `book_id`s into the EXISTING
`browserBookScrape.processBook` / candidate loop (`src/browserBookScrape.ts`)
using the same skip/force/engine/cooldown/throttle machinery verbatim. Filter
with `--skip-has work-id,genres` so only books lacking details are fetched.
Phase B is effectively a no-new-code reuse of browser-book-scrape; only the
candidate source changes (a `popular_by_date_book`-driven candidate query).

### Range iteration
- Months: iterate from earliest available month (probe backward until client-side
  404, i.e. empty Apollo state) through current+foreseen months; skip 404 pages.
- Years: current year down to 2012 (or until 404s).
- `--year` / `--month` overrides, plus `--dry-run` (enumerate book list, crawl
  nothing) default-ish behavior like the other walkers.

## 4. CLI/wiring

- `src/popularByDate.ts` + `./popularByDate.sh` + npm script `popular-by-date`,
  command registered in `src/index.ts` with help. ✅ shipped.
- Options: `--year`, `--year-back`, `--month`, `--month-back`, `--limit`
  (Phase B budget), `--skip-has`, `--pages` (per-page fetch cap, default 30),
  `--skip-days` (listing freshness, default 7), `--engine axios|browser`
  (Phase B), `--dryRun`, `--no-details`, `--force`, `--cooldown-ms`,
  `--maxConsecutiveThrottles`. ✅
- Rank/default semantics: the anchor year page and the anchor month page are
  ALWAYS walked; `--year-back`/`--month-back` add earlier pages going back.
- Walk order is STRICTLY newest→oldest with months interleaved per year: a
  year's month pages (inner window, descending) come first, then that year's
  page, then the next year — e.g. 2026-9..2026-1, 2026, 2025-12..2025-1, 2025,
  2024-12..2024-10, 2024, 2023..2012 (year pages only after the ~2-year month
  window runs out). Not years-then-months (user 2026/09/25 — that looked
  non-chronological: it did 2026 then jumped to 2025, skipping that year's
  months).
- Throttle prose shared with the other walkers (cooldown + max-consecutive
  abort); `GOODREADS_STRICT_THROTTLE=1` aborts on the first 202/403.
- Phase A runs in the headed browser (`browserBookScrape.getBrowserContext`).
  Book detail-scraping is INTERLEAVED per page — walk a list, scrape its books,
  move to the next list (human-like browsing), NOT all-lists-then-all-books.
  Each page's scrape reuses `runBrowserBookScrape` with `candidateBookIds`
  (from `result.rows`, deduped, capped by `--limit`) and `closeContext: false`
  so one browser window stays open for the whole run; checkpoints keep already-
  scraped books skipped. `distinctIdsFromRows` (tested) does the per-page set. 
- Run reporting: each page logs `✓ page=K → N books (rank a–b) · http=200 ·
  F fetches · ~KB payload`; the final summary prints pages/skipped/not-found,
  `+N new listing rows`, and Phase B `+X books · +Y authors added` (DB-row
  deltas via `countBooks`/`countAuthors`, mirroring the list walkers). NOTE the
  `+N books` delta is a whole-`books`-table row-count delta over the page's
  scrape window, so OTHER concurrently-running crawlers (author-rescan,
  walk-new-tags…) inflate it — it is NOT a per-run attribution. (2026/09/25)
- Title recovery (2026/09/25): the Apollo `Book:` node used to be parsed without
  `title`, so brand-new books (not yet in `books`) were persisted as
  `'Unknown Title'`. Fixed forward: `BookPageDetails.title` is parsed from the
  `Book.title` node (DOM `h1[data-testid=bookTitle]` fallback) and
  `buildCachedBook` keeps `existing.title || parsed.title`. Backfill: UPDATE
  `books.title` from `popular_by_date_book.title` for `'Unknown Title'` rows
  (covers every popular-by-date placeholder; re-runnable, now 0 joinable). The
  residual `'Unknown'`/`'Unknown Title'` rows from older shelf walks are
  recovered by the re-scrape gate `shouldRescrapeUnknownTitle` in
  `browserBookScrape.ts` (skip an ok checkpoint only when the persisted title is
  real OR the checkpoint is newer than `UNKNOWN_TITLE_RESCAN_DAYS`=7d — bounded,
  no hammering of genuinely unparseable pages).
- Phase B author sync: `processBook` now extracts the primary author from
  `Book.primaryContributorEdge.node` → `Contributor:{name, legacyId, webUrl}`
  (verified live 2026/09) and upserts it into the `authors` table with the
  page's own `/author/show/<slug>` — so this command (and browser-book-scrape)
  grow the authors table and `books.author`/`authorId` columns for new books. 

## 5. What NOT to do (guardrails from AGENTS.md + this session)

- **Do NOT hand-craft AppSync requests** — the endpoint + `x-api-key` are
  captured from the site's OWN traffic every run (the automatic `getBasicGenres`
  request), with a frozen `APPSYNC_URL` fallback only if the capture misses. ✅
- **Do not hammer**: one tab, sequential page walks (1.5–3.5s pace between),
  in-page 250ms pause between pagination fetches; no unbounded retry on 202/403
  (back off and report). ✅
- **Do not load the whole books table** (`loadBookCache`) — `popular_by_date_book`
  is a small listing table; Phase B candidates come from that table via
  `distinctBookIdsFromPages`, bounded by `--limit`. ✅
- Month page range boundary is runtime-probed (client-side 404s skipped); never
  frozen — Goodreads moves it. ✅
- Connectivity errors rethrow/abort with progress saved (no failure strikes). ✅

## 6. Verification plan

- Unit: `src/popularByDate.test.ts` (15 tests) — page-key/name/URL builders,
  range iteration, 404 detection, both edge-shape parsers, skip logic. ✅ passed.
- Unit suite: `./runUnitTests.sh` all green (745 tests incl. CLI smoke). ✅
- Live (held off to respect the add-book rate limit / keep polite): ONE
  `popular_by_date/2026/9` walk in strict throttle mode, assert ~200 books
  enumerated and a fresh `book_id` set returned. The AppSync getTopList loop was
  validated directly against Goodreads during development (both month and year
  variants, 200 books in 14 fetches each).