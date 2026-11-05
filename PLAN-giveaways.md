# PLAN: `giveaways` book-id discovery walker

Status: **implemented — `src/giveaways.ts` + `./giveaways.sh` + command `giveaways`
shipped 2026/10/17.** Task 0 spike done (all questions answered; see §2.5). Unit suite
green (86 files / 1074 tests incl. 14 giveaways tests). Live one-shot verification +
integration test still TODO.
Created 2026/10/17 after hand-inspecting
`https://www.goodreads.com/giveaway?sort=recently_listed` (anonymous curl + parsing
`__NEXT_DATA__`), then a headed-browser spike via the production `getBrowserContext()`.
Trust the "verified ground truth" below over memory.

## 1. Goal

Add a CLI command (wrapper `./giveaways.sh`) modeled on `popular-by-date` that walks
Goodreads' **Giveaways** listing, collects the **book ids** on offer, and feeds them
through the existing book-detail scrape (`browser-book-scrape` / `runBrowserBookScrape`)
to harvest full `book_page` + `books` rows.

**Scope decision (locked 2026/10/17): bookId-only — DO NOT persist giveaway-level data.**
The book detail page (`/book/show/<id>`) is the canonical source for everything
book-level (title, author, description, genres, series, ISBN, ratings…), so the
listing only needs to yield a `book_id`; title/author are carried **in-memory** only,
for readable run output. There is **no `giveaway` table** and therefore **no schema,
export/import, or registry-test change**. The only thing given up is the giveaway
*mechanics* (copies, entries, start/end dates, region) — deliberately dropped.

## 2. Verified ground truth (2026/10/17, anonymous curl)

### URL + render model
- Listing: `https://www.goodreads.com/giveaway?sort=recently_listed`
  (UI sort labels: Featured / Ending / Recent / Popular).
- `?page=N` is **ignored** — `?sort=recently_listed`, `&page=2`, `&page=3` returned the
  identical 5 giveaways. Pagination is the client-side **"Show more giveaways"** button
  (a React `<button class="Button">`, no href), i.e. Apollo/AppSync, not URL params.
- SSR payload grew 5 giveaways anonymous (the user, logged in, sees 30). The initial
  request is `pagination:{after:null, limit:5}`; the browser loads more on demand.

### The AppSync/Apollo query (the key finding)
`__NEXT_DATA__` → `props.pageProps.apolloState.ROOT_QUERY` holds:
```
getGiveaways({"getGiveawaysInput":{"format":null,"genre":"all","sort":"RECENTLY_LISTED"},"pagination":{"after":null,"limit":5}})
```
Returns a `GiveawaysConnection`:
```
{ __typename: "GiveawaysConnection",
  edges: [ { __typename: "GiveawaysEdge", node: { __ref: "Giveaway:kca://giveaway/amzn1.gr.giveaway.v1.<opaque>" } } ],
  pageInfo: { hasNextPage: true, nextPageToken: "eyJmZWF0dXJlZF9vcmRlcmluZ19zZWVkIjpudWxsLCJzb3J0X3ZhbHVlIjoiMjAyNi0xMC0xN1QwMDowMDowMC4wMDAtMDc6MDAiLCJpZCI6NDUzOTk3fQ" },
  totalCount: 1788,
  errors: null }
```
- `nextPageToken` is **base64 JSON** (not hex like `getTopList`):
  `{"featured_ordering_seed":null,"sort_value":"2026-10-17T00:00:00.000-07:00","id":453997}`
  — chain it until `hasNextPage=false`. `totalCount` gives a live progress denominator.
- `apiKey` is present at `props.pageProps.apiKey` (`da2-…`). The **AppSync endpoint is
  NOT in the HTML or the `pages/giveaway-*.js` chunk** — it must be captured from the
  page's own traffic at runtime, exactly like `popularByDate.captureAppSyncMeta`
  (the page auto-fires `getUserSponsoredGiveaways` / `getGiveaways` on load, so the
  endpoint + `x-api-key` are observable). Keep a frozen endpoint fallback if the
  capture misses, as popular-by-date does.

### `Giveaway` entity fields (per edge node)
- `id` (opaque `kca://giveaway/…`), **`legacyId`** (e.g. `454009`) = the
  `/giveaway/show/454009-…` id.
- `details.book` → ref `Book:kca://book/amzn1.gr.book.v3.<opaque>`.
- `details.format` (`KINDLE`|`PRINT`), `details.genres:[{name}]`,
  `details.numCopiesAvailable`, `details.numEntrants`, `details.enterGiveawayUrl`.
- `metadata.startDate`/`endDate` (ISO), `metadata.countries:[{countryCode}]`.
- `webUrl` (`https://www.goodreads.com/giveaway/show/454009-…`).

### `Book` entity fields — WHERE THE BOOK ID LIVES
- The Book node exposes **only**: `id` (opaque), `imageUrl`, `title`, `titleComplete`,
  `description`, `primaryContributorEdge`, `secondaryContributorEdges`. **`legacyId` is
  absent** (the giveaway's `legacyId` is the *giveaway* id, not the book).
- The numeric book id (the `/book/show/<id>` key) appears **only embedded in
  `imageUrl`**: `…/books/1715215178i/`**`213082829`**`.jpg` → `213082829`.
  Confirmed mapping: giveaway `454009` → book `213082829` →
  `https://www.goodreads.com/book/show/213082829-…`.
- `primaryContributorEdge.node` → `Contributor` with `name` + `webUrl`
  (`/author/show/<numericId>.<Name>`) — in-memory fallback author label only.
- **Decision:** `book_id` = regex on `imageUrl` (`/books/[^/]+/(\d+)\.jpg`). This is the
  join key for the `browser_scrape` checkpoint (already-scraped?) and for `books` /
  `book_page`. `Book.legacyId` is an *opportunistic* extra if our authored query happens
  to expose it (optional, not required). A giveaway whose book has no cover →
  `imageUrl` null → **skip and log the giveaway id**, never fail.

### 2.5 Task 0 SPIKE RESULT (2026/10/17, headed browser, done)
Ran the authored query through the real `getBrowserContext()` headless-on-live page.
Findings — these supersede the guesses above where they differ:

- **Endpoint is the SAME AppSync URL as `popularByDate`**:
  `https://kxbwmqov6jgg3daaamb744ycu4.appsync-api.us-east-1.amazonaws.com/graphql`
  (identical to the frozen `APPSYNC_URL` const in `src/popularByDate.ts:11`).
- **The endpoint is NOT fired on plain page load** (the listing is SSR). It only fires
  once the client does something (clicking **"Show more giveaways"** produced two POSTs).
  So `captureAppSyncMeta`-style `page.on('request')` capture works **only after a click**;
  more robust: just reuse the frozen `APPSYNC_URL` constant (proven identical) and take
  `apiKey` from `__NEXT_DATA__.props.pageProps.apiKey`.
- **`x-api-key` was NOT present in the request headers Playwright exposed** on the AppSync
  POST (unlike popular-by-date's `getBasicGenres`). Don't rely on header capture for the
  key — read it from `__NEXT_DATA__` (it was there: `da2-qadjaw…`).
- **`Book.legacyId` IS selectable** — returning `213082829` etc., exactly matching the
  imageUrl-derived id (`212…`/`243411867`/`251256600`). So request `details.book { legacyId
  imageUrl title }`: `legacyId` is the primary book-id source; imageUrl regex is the
  proven fallback (still used for no-legacyId / no-cover edge cases).
- **Server caps page size at 15**: our query asked `limit: 30` and the server returned
  **15** per page (`perPage: [15,15,15]`). So a full feed is `ceil(1788/15) ≈ 120`
  fetches (not 60). Use `--page-size 15`.
- **Pagination chaining works**: 3 pages → 45 fetched / 45 **distinct** book ids
  (clean, no overlap), `totalCount: 1788`, `hasNextPage: true`, http 200.

## 3. Design

Two phases, mirroring `popularByDate` (walk a list → scrape its books → next list):

**Phase A — enumerate (browser engine required).** New `src/giveaways.ts`
(`runGiveaways`), launched via `getBrowserContext()`. On one page:
1. `page.goto('https://www.goodreads.com/giveaway?sort=recently_listed')`.
2. Resolve the AppSync endpoint + key: reuse the frozen `APPSYNC_URL` const (spike-proven
   identical to popular-by-date's) and read `apiKey` from `__NEXT_DATA__.props.pageProps.apiKey`
   (spike-proven present). Do NOT depend on `page.on('request')` header capture — the
   `x-api-key` header was not exposed, and the AppSync POST only fires after a click.
3. Drive the `getGiveaways` pagination loop **inside the page** with
   `page.evaluate(fetch)` — our own authored query selecting
   `edges { node { legacyId details { book { legacyId imageUrl title } format genres{name} } } }`
   (`book.legacyId` primary; `imageUrl` fallback), `pagination:{after,limit:15}`
   (**server caps at 15** — asking 30 returned 15), chaining `nextPageToken` until
   `hasNextPage=false` or a per-fetch cap. 250 ms pause between in-page fetches; stop on
   empty edges. ~120 fetches for the current ~1,788 feeds.
4. Extract `book_id` (`legacyId` if present, else `bookIdFromImageUrl`), dedupe preserving
   first-seen order (reuse `distinctIdsFromRows`-style helper), keep `title`/`author` in an
   in-memory `Map` for readable logs. **Persist nothing** for the listing.

**Phase B — book details.** Feed Phase A's ids into the EXISTING
`runBrowserBookScrape` with `candidateBookIds` (deduped, capped by `--limit`),
`candidateTitleByBook`/`candidateRatingsByBook` for output, `closeContext:false` so the
browser stays open. The `browser_scrape` checkpoint means already-scraped books are
skipped (no re-fetch) — that checkpoint IS the only dedup state needed. Filter with
`--skip-has` (default `genres`) so only incomplete books are fetched. Phase B is
effectively no-new-code reuse; only the candidate source is new.

Notes:
- Re-running re-walks the feed (cheap: ~60 fetches × 250 ms) but re-scrapes nothing
  already ok-checkpointed. No enumeration checkpoint needed.
- Walk whole feed by default (`--limit` only caps Phase B); `totalCount` drives a
  `×/1788` progress line.

## 4. CLI / wiring

- `src/giveaways.ts` + `./giveaways.sh` + npm script `giveaways`, command registered in
  `src/index.ts` with help text (mirror popular-by-date's wording).
- Options: `--limit` (Phase B budget, default 100; 500000 = all), `--skip-has`
  (default `genres`), `--sort recent|ending|popular|featured` (default recent →
  `RECENTLY_LISTED`; maps to the other enum values), `--pages` (max `getGiveaways`
  fetches, default 130; ~120 fills the current feed), `--page-size` (server limit per
  fetch, default **15** — server-capped), `--engine browser|axios` (Phase B), `--dryRun`
  (enumerate + print ids, no writes), `--no-details` (enumerate only), `--force`,
  `--cooldown-ms`, `--maxConsecutiveThrottles`.
- No `--skip-days` / `--year*` / `--month*` (no listing table, no time range).
- Example: `caffeinate -is ./giveaways.sh --limit 500000` = walk all live giveaways,
  detail-scrape every not-yet-scraped book.
- Run reporting: per-fetch `✓ gifts=<n> books=<n> (running/totalCount) · http=200`;
  final summary prints gifts seen, distinct book ids, Phase B ok/throttled/missing/
  error/skipped, and `+books · +authors added` deltas (`countBooks`/`countAuthors`).

## 5. What NOT to do (guardrails)

- **Do NOT hand-craft AppSync** — capture endpoint + `x-api-key` from the site's own
  traffic each run (frozen fallback only). Reuse `captureAppSyncMeta`'s approach.
- **Do not hammer**: one tab, sequential fetches, 250 ms in-page pause, browser
  book-scrape's 2–4 s per-book pacing; no unbounded retry on 202/403 (back off/report).
- **Do not `loadBookCache`** — no listing table; candidates are an in-memory id array
  bounded by `--limit`.
- Connectivity errors rethrow/abort with progress saved (no author/book failure strikes).
- **Do NOT add a `giveaway` table** (bookId-only MVP). Only revisit if the giveaway
  mechanics later prove interesting.

## 6. Verification plan

- **Task 0 spike — DONE 2026/10/17** (headed browser): endpoint resolved (same as
  popular-by-date), `apiKey` from `__NEXT_DATA__`, `Book.legacyId` selectable, pagination
  chains cleanly with distinct ids, server caps page size at 15. See §2.5.
- Unit (`src/giveaways.test.ts`): `bookIdFromImageUrl` (cover URLs, no-cover → null),
  book-id-from-node (legacyId preferred, imageUrl fallback), sort→enum mapping,
  `getGiveaways` payload parser (edges→book ids), pagination-token stop logic. Keep pure
  logic network-free.
- Unit suite: `./runUnitTests.sh` fully green (tsc + vitest + CLI smoke).
- Integration: one live browser walk of the giveaway page asserting N book ids extracted
  (gated like the existing suite, polite, strict-throttle aware).
- Add a `GOODREADS_CHANGES.md` entry (AppSync `getGiveaways` discovered; endpoint shared
  with popular-by-date; `book.legacyId`/imageUrl book-id extraction; page cap 15) and an
  `AGENTS.md` note under the crawler/AppSync section.

## 7. Implementation status (2026/10/17)

- `src/giveaways.ts`: `runGiveaways` + pure helpers (`sortToEnum`, `bookIdFromImageUrl`,
  `bookIdFromGiveawayNode`, `parseGiveawaysEdges`, `distinctBookIds`, `giveawaysQuery`).
  Endpoint = frozen `APPSYNC_URL` (spike-verified identical); apiKey from `__NEXT_DATA__`;
  Node-driven pagination (one `page.evaluate(fetch)` per page, 250 ms pause) with the same
  cooldown/retry/connectivity-probe machinery as popular-by-date; Phase B = the existing
  `runBrowserBookScrape({ candidateBookIds, closeContext:false })`.
- `src/giveaways.test.ts` (14 tests) — all pure helpers.
- `./giveaways.sh` (executable) + npm `giveaways` + `giveaways` command in `src/index.ts`.
- `AGENTS.md` throttling section + `GOODREADS_CHANGES.md` entry added.
- **Unit suite green**: `./runUnitTests.sh` → tsc clean, 86 files / 1074 tests, CLI smoke 2.
- **TODO**: live one-shot `./giveaways.sh --limit N` (headed) and an integration test.
