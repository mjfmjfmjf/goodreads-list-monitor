# PLAN: Playwright browser transport for per-book scrapes

Status: **Phase 1 SHIPPED 2026/09/05** (`browser-book-scrape` command + `bookPageParse.ts` + unit tests + live integration tests; unit gate green; one live axios harvest verified → `books.genres` + `book_page` row). Phase 0 conclusions below; Phase 2 (work-page / tag-pass / editions) open.
Created 2026/09/05. Feature request: the axios transport keeps getting
throttled (HTTP 202 interstitials, redirect loops, 403s) while a real
browser gets the full 200 page. Replace it with Playwright.

## Phase 0 findings (2026/09/05 — decided the architecture)

- Headless (both `headless:true` headless-shell and `channel:'chromium'`
  headless full Chromium) → **403/202 immediately (WAF fingerprint block)**.
  HEADED full Chromium → 200, 415 KB. So the browser engine is HEADED — one
  persistent window, one page at a time (user OK'd a single headed window).
- Browser is transport-ONLY: `page.content()` HTML string → same parsers.
  2–4s uniform-ms pacing, never bounded retries, cooldown on throttling.
- axios+cookie baseline still works today (5/5 → 200); `--engine axios` is the
  default, `--engine browser` for WAF-bypass + editions capture.

## Problem

The current single-book scrape is `axios → HTML string → cheerio` in
`src/scraper.ts` (`scrapeBookDetails`, `fetchWithRetry`). Goodreads serves
this app's axios requests 0-byte 202 interstitials / redirect loops while a
browser with a logged-in session gets 200 (most recently 2026/08/09 on
`/search`). A real browser should materially reduce (not eliminate) that:
full TLS fingerprint, complete header set, real JS execution, and the session
cookie placed in a real cookie jar instead of a bare `Cookie:` header.

The browser is TRANSPORT-ONLY. Parsing stays in cheerio; the browser hands
back the rendered HTML. Zero selector re-work, zero integration-test churn.

## Decisions (user, 2026/09/05)

- Framework: **Playwright** (TS-native, `launchPersistentContext` for sessions,
  exact pacing control). Not Selenium.
- Session: **one-time interactive login** into a persistent profile —
  `npm run browser-login` (command + `browserLogin.sh`, `src/browserSession.ts`,
  durable profile at `~/.goodreads/browser-profile`, NOT `/tmp`, which macOS
  wipes). Seeding `config.json.cookie` via `context.addCookies` was implemented
  and PROVEN NOT to work 2026/09/05: the cookie IS valid (axios+`Cookie:`
  header logs in), but the browser enforces Secure/HttpOnly/Domain/Prefix flag
  rules that a pasted name/value string strips, so the headed window stayed
  logged-out (checked on both `www.goodreads.com` and parent-domain seeding).
  The real-browser session is created by the user typing credentials ONE time;
  later `--engine browser` runs auto-verify the profile on the hub page
  (`/user/show/<id>-…` marker present on every page) and report
  `✓ Session verified` or `⚠️ logged OUT`.
- Queue: **initially, books with the most ratings that still lack genres**
  (ratings-descending across the missing-genres set). The sort order is a
  data-driven decision that will change over time (see Queue section), so any
  sort mode is swappable at runtime — never hardcoded. Eventually extend to
  the work page and the book tag page; also start capturing fields we never
  scraped (below).
- Pacing: **uniform random delay of 2000–4000 ms at millisecond precision**
  between books (avg ~3s, user decision 2026/09/05) — implemented with
  `2000 + Math.floor(Math.random()*2001)` rather than the `utils.delay()`
  helper, which inflates its range by 1.5x+100ms. Cooldown 5–15 min on
  202/403; never unbounded retry (AGENTS.md rules apply).

## Target pace / throughput

2–4s uniform-random ms pacing (avg ~3s) ≈ **~1,000 books/hr**, a large step
up from the throttle-crippled axios rate. Must be the ONLY `/book/show`
hitter while running (don't stack with axios crawlers on that endpoint). The
add-book live lookup 1/min rule is preserved.

## Architecture

### 1. Transport — `src/browserScrape.ts`
- `launchPersistentContext(profileDir)` → Chromium, `headless: true` first;
  if headless stays detectable (202-rate not improved), switch to headed /
  offscreen before tuning anything else.
- Seed cookies from `config.json.cookie`; verify session (visit `/account`
  or a known-book page and check for logged-in marker) before queue starts.
- (SUPERSEDED 2026/09/05) cookie-seeding does NOT authenticate the browser;
  see Decisions → Session. Browser login is now `npm run browser-login`
  (interactive, persisted profile), with auto-verify on context open.
- `fetchBookPageHtml(bookId, { minDelayMs, jitterMs })`:
  `page.goto('/book/show/<id>')` → detect 202/403/redirect-loop/404 → return
  the 200 `page.content()` as a plain HTML string.
- Pacing enforced in the page loop (sleep AFTER each book), not just before.

### 2. Parser reuse — refactor `src/scraper.ts`
- Export `parseBookPage(bookId, html): Partial<BookMetadata>` combining
  today's `extractBookFromCheerio` + `extractWorkId` (lines 677/77).
- `scrapeBookDetails` becomes a thin wrapper: transport(axios) → parse →
  author-list fallback (unchanged behavior). Browser path:
  transport(playwright) → parse → same writer.
- Integration tests keep testing `scrapeBookDetails`; add a unit test that
  `parseBookPage` on a cached fixture equals the old extractor output.

### 3. Field capture — VERIFIED key mapping (live 2026/09/05, book 3 + 2657)
All fields below confirmed against live `__NEXT_DATA__ → apolloState` SSR
(so they are scrapable via plain axios too) — see `bookPageParse.ts`:

| Target field        | Verified source (apolloState)           | Notes |
|---------------------|-----------------------------------------|-------|
| publisher           | `Book.details.publisher`                | ✓ inline |
| isbn13              | `Book.details.isbn13`                   | ✓ |
| isbn10              | `Book.details.isbn`                     | ✓ |
| asin                | `Book.details.asin` (elsewhere)         | currently mirrors isbn |
| format              | `Book.details.format`                   | ✓ |
| language            | `Book.details.language.name`            | ✓ object, use `.name` |
| description         | `description({"stripped":true})` first  | plain `description` has tags |
| series              | `Book.bookSeries[].series.__ref→title`  | NOT `bd.series` |
| # reviews           | `stats.textReviewsCount`                | key NOT `reviewsCount` |
| ratings by star     | `stats.ratingsCountDist`                | ORDERED ARRAY [1★..5★], normalized to `{1..5}` (NOT `ratingDetails`) |
| publicationsDate    | work→details / book details `.publicationTime` | epoch-millis NUMBER, format YYYY.MM.DD |
| currently reading   | ROOT_QUERY `getSocialSignals` array     | `{name:CURRENTLY_READING,count,userPhrase}` — SSR! verified 2657 = 101,346 |
| to-read             | same array, `TO_READ`                   | SSR! 2657 = 2,959,423 |
| # editions          | **NOT in apollo/SSR**                   | only **logged-in rendered DOM** ("Show all 886 editions", nbsp-tolerant regex) → browser engine only, best-effort |
| workId              | `/work/editions/<id>` href              | ✓ |

Schema decision (differs from draft): new columns went to a NEW `book_page`
table (one row per book, publisher/isbn13/isbn10/asin/format/language/
description/series/reviews_count/ratings_dist/currently_reading/to_read/
editions_count, upsert-on-conflict) instead of migrating `books` — avoids
touching `BOOK_UPSERT_SQL`/`rowToBook` under the 5-writer regime. `books`
gets only the fields it already has columns for (genres, work_id, ratings…).

### 4. Queue / prioritization — SHIPPED
- CLI `browser-book-scrape --limit N --minRatings N --skip-has genres|work-id|tags --sort ratingsDesc|ratingsAsc|random --engine axios|browser [--dryRun] [--force] [--cooldown-ms N]` — sort select + skip-criteria builder are pure fns (unit-tested). Always-on filter: `is_bad=0 AND requires_auth=0`. Default select = **books missing genres**, default sort = **`ratingsDesc`**; both swappable at runtime.
- Future sort modes (grown into `SORT_ORDERS` in bookPageParse.ts):
  `missingFields`, `genreGap`, `editionDensity`.
- Checkpoint table (actual, diff from draft: `source` dropped, `http/bytes/elapsed_ms` added for the timing/status log):
  ```
  browser_scrape (book_id PK, status ok|throttled|missing|error, http, bytes, elapsed_ms, scraped_at, error)
  ```
- Note: ratings-desc backlog surfaces MANY editions of the same work (first live run: 5× Harry Potter #1). Expected; distinct books, distinct detail rows.

### 5. Writes + observability — SHIPPED
- Writes via existing `storage.ts` (upsertBook + new book_page/browser_scrape)
  wrapped in `withDbLockRetry` (sync backoff under the shared-WAL regime).
- Per-book log line carries id, classified status, HTTP code, elapsed ms,
  bytes, ratings, genre count, title — the timing/status format the user asked
  for. `--dryRun` is side-effect-free (no tables, no network).
- Strict-throttle env semantics preserved (abort run on 202/403).

## Phases

- **0. Transport spike + field inventory**: ✅ DONE — headed-only result (above); field map verified live and locked in §3; axexios baseline 5/5→200.
- **1. End-to-end skeleton**: ✅ DONE — `bookPageParse.ts` (pure, unit-tested, incl. inline-`bookGenres` fix that also repaired `bookSweep.extractBookDetailsFromHtml`), `browserBookScrape.ts` runner, `browser-book-scrape` command + `browserBookScrape.sh`, `--dryRun`, checkpoint + `book_page` tables, PERFECT live axios harvest (book 3: 9 genres, publisher, ISBNs, currently-reading 289,322, ratings-dist). Unit gate (tsc + coverage + CLI smoke) green. Live integration tests added to `goodreads.integration.ts` (guarded by 2s spacing + STRICT throttle; write 1 real row).
- **2. Extend sources + fields**: open — work-page pass; `/work/shelves` tag pass (with slug fix); editions-count real capture requires a **logged-in** browser window (keep `--engine browser` manual validation; un-logged-in probe window shows "Book details & editions" button but no count).
- **3. Optional pacing**: 2-tab parallelism only if 202-rate stays flat.

## Risk status updates

- Headless Chromium detectability → CONFIRMED BLOCKED (403/202) → headed is the browser transport. ✅ resolved by design.
- Editions count / "currently reading" — currently-reading/to-read solved via SSR `getSocialSignals` (no browser needed). Editions: logged-in-DOM-only, browser-engine best-effort.
- BUG FOUND + FIXED en route: `bookSweep.extractBookDetailsFromHtml` was silently returning `genres: []` on current markup because `bookGenres[].genre` is now inline (`{name}`) instead of `__ref`. New parser handles both shapes; bookSweep patched with the same fallback (+ test).