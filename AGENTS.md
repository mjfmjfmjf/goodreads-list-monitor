# AGENTS.md — Working memory for this repo

## Testing cadence
- **Unit tests** (`./runUnitTests.sh`): fast, offline. Three gates in order:
  `tsc --noEmit` (full strict typecheck — ts-node typechecks at load time in
  production, vitest does NOT), Vitest WITH v8 coverage on `src/*.test.ts`,
  then the offline CLI smoke test which spawns the real CLI under the
  production ts-node/esm loader. Run after EVERY feature change or dependency/
  tool upgrade.
- **Tee test output**: whenever running unit or integration suites, pipe the
  run through `tee` to a log (e.g. `./runUnitTests.sh 2>&1 | tee /tmp/unit.out`)
  so the user can `tail -f` it live and confirm the run is progressing; analyze
  the saved log afterwards.
- **Integration tests** (`./runIntegrationTests.sh`): live lookups against real
  Goodreads pages (a dozen+ requests, pagination sweeps, one add-book lookup).
  Run deliberately BEFORE/AFTER risky scraper changes, when Goodreads markup may
  have drifted, or when the user asks. Needs cached `libraryExportCache.json` +
  `authorsCache.json` + `state.json` (monitored lists) + `config.json`.
- If the integration suite fails, FIRST retry after a cooldown (~60s+) before
  suspecting a parser change — see throttling below.

## Goodreads throttling / politeness — IMPORTANT
- Goodreads throttles aggressively. It has served HTTP 202 0-byte interstitial
  pages to this app's axios requests (most recently 2026/08/09 on `/search`)
  while a browser got the full 200 page. This is anti-bot throttling, not a
  markup change.
- The codebase already has MANY sleep/delay calls before Goodreads hits. Do not
  add new scrapers that hammer the site; keep existing delays; space out
  sequential requests (the integration suite uses a ~2s delay between live
  calls).
- The add-book live lookup is rate-limited to AT MOST once per minute (state in
  `os.tmpdir()/goodreads-addbook-lookup.json`). Do not bypass this.
- Never loop an unbounded retry on 202/403 — back off and report.
- **Goodreads pages just hang on their own, routinely** (the site is flaky; the
  user opens the same link 5–6 times, sometimes minutes later, and it usually
  loads — often in the newest tab). So a `>45s` `fetchListPage` hang is most
  likely ordinary site flakiness, NOT anti-bot or a parser change. The list
  walker gives a hang ONE patient retry after ~60s (env
  `GOODREADS_HANG_RETRY_MS`) before marking the list `error` and moving on.
  Keep the walker gentle — no multi-retry loops, no hammering. Do not shrink
  that tolerance without a good reason.
- **Likely root cause of the 2026-09-11 "spin" incident**: lists with < 100
  books have no real pagination, but Goodreads returns "has next" on empty
  `?page=2..N` pages, so the walker used to step through phantom empty pages
  of small lists until a flaky one hung > 45s in `page.goto` (seen on
  `list/show/75483` and `79774`). Fixed by stopping when a page parses 0 books
  (dead-reckon the list's real end). If you see the walker re-walking empty
  pages or lingering on a small list, LOOK HERE first before blaming
  anti-bot/throttling.
- Author-page crawls are ANONYMOUS by default: `scrapeAuthorStats` sends no
  cookie unless `--withCookie` or `GR_USE_COOKIE=1`. Anonymous pacing is faster
  than cookie-authenticated: author gap ~1.0–1.8s (vs 2.0–5.0s), page gap
  ~0.9–1.7s (vs 2.0–4.0s). Override with `GR_AUTHOR_DELAY_MS="min,max"` and
  `GR_PAGE_DELAY_MS="min,max"`. Author pages are public; we verified cookie and
  anonymous returns are byte-identical.
- **`author-rescan --sortBy topRatings`** orders candidates by the max ratings
  across the author's books (`books.author_id` GROUP BY, via
  `loadAuthorBookStats`), NOT the author-page `numRatings` — which is still
  0 for authors minted but never author-scraped (e.g. by a list/shelf walk).
  That makes `--multiPage --onlyUntouched --sortBy topRatings --minRatings 0`
  grind the untouched tail in book-popularity order. In `topRatings` mode,
  `--minRatings`/`--maxRatings` filter on that top-book rating.
- **`author-rescan --sortBy newestYear [--minBookYear Y] [--minRatings N]`**
  ranks candidates by the NEWEST qualifying book year (recent books first) and
  is the way to "prefer authors with recent books" over the ~260k untouched
  tail. `--minBookYear` restricts the aggregation to books published ≥ that
  year with ≥ `--minRatings` ratings (authors with no qualifying book are
  dropped), and auto-upgrades `--sortBy topRatings` to `newestYear` when both
  are given. Both keys share `loadAuthorBookStats`, whose SQL drops years above
  `currentYear+5` (Goodreads encodes some BCE works as positive years, e.g.
  2600, which would otherwise outrank genuinely recent books).
- **Author crawls abort on connectivity errors** (2026-09-25 fix). Previously
  `scrapeAuthorStats` swallowed ENOTFOUND/ECONNRESET/etc. and returned
  `undefined`, so author-rescan/orphans/top-books treated an outage as
  author-level failures — bumping the author's persistent `failCount` strikes
  AND grinding through the whole doomed candidate list. Now `scrapeAuthorStats`
  rethrows `isConnectivityError` errors (both the outer fetch and the inner
  multiPage page loop), and the author loops abort with a "network error —
  progress saved" message without recording failure strikes (mirrors the
  walkers). Do not remove this — a lost connection is not an author defect.
- **Integration suite runs in STRICT throttle mode**
  (`GOODREADS_STRICT_THROTTLE=1`): on a 202/403/429 it gives up immediately
  (no retry/backoff) so a throttled run fails fast with a clear message.
  A failure with a throttle message means cooldown, NOT a parser change.

## SQLite writes / database locking
- **Do NOT call `loadBookCache()` — it materializes the whole `books` table
  (~5.6M rows / several GB of V8 heap) into a JS object.** Commands OOM'd at
  Node's default ~3.9GB cap on 2026/09/13, so a 2026/09/13 refactor removed
  every production call site. `loadBookCache` now survives only as its own unit
  test in `storage.ts`. Replacements, in order of preference:
  - `iterateBooks()` / `streamRows()` — stream rows with O(1) memory; the
    mapping/histogram/audit commands use these (plus `countBooks()` for totals).
  - `getBook(id)` — single-row lookup; sparse per-entity caches (monitored
    lists, CSV entries, queue candidates) and `syncBooksToCache` merge against
    the live DB, so sync-only walkers pass an empty in-run `BookCache = {}`.
  - Bounded streaming (per-bucket / top-N by ratings) where the command needs
    only the best candidates (`books`, `tagGaps`, `authorTopBooks`,
    `monitorTopRatedList`, `bookSweep`), or SQL-side aggregation/helpers
    (`cachedPublishedYear`, `summaryTopByYear`, `booksAddedHistogram`).
  Keep new bulk writers as plain single-statement upserts (see below) and
  reach for these patterns instead of a new full-table load.
- Earlier npm scripts had a central `--max-old-space-size=8192` in NODE_OPTIONS
  to make the full-cache commands fit; that bump was reverted on 2026/09/13
  once the loads were gone. `NODE_OPTIONS='--loader ts-node/esm --no-warnings'`
  must stay — do not re-add a heap bump to paper over a new full-table load.
- SQLite locks are database-wide (WAL: ONE writer at a time, whole DB) — NOT
  per-row/per-table. Any write transaction you hold blocks every other crawler's
  writes for its whole duration.
- Crawler writes are single-statement autocommit upserts: NO `db.transaction`
  batches. Each statement is sub-ms (`synchronous=NORMAL` in WAL = memory-only
  commits), so a write lock is held only for one statement and never across a
  network read/sleep. Keep new bulk writers as plain `stmt.run()` loops.
- `db.transaction` is reserved for atomic multi-step ops that don't run during
  crawls (importData, migrateToSqlite, authorDedupe, saveState).
- Under WAL, `SQLITE_BUSY` (busy_timeout waits it out) and `SQLITE_BUSY_SNAPSHOT`
  (stale snapshot — busy_timeout does NOT help) are both retried 3× with a
  checkpoint-before-retry for the snapshot case. Overrides for tests/tuning:
  `GOODREADS_BUSY_TIMEOUT_MS`, `GOODREADS_LOCK_RETRY_DELAY_MS`. Writes must stay
  idempotent upserts so replay-after-abort is safe.
- Avoid running several heavy crawlers at once (e.g. gap-genre + author-rescan +
  list-tag-walk) — they serialize on the same writer lock either way.
- **Daily DB backup runs on a schedule via `./backupDb.sh` (cron), NOT inside
  `monitor.sh`** (a 2026/09/20 incident: the backup API snapshot took 57min
  under crawler load and looked hung — fast to ~60% while the OS-cache-warm
  bulk copied, then ~200KB/s through the cold tail). Crawlers are always
  running, so the backup never waits for idle time. Fast path in `backupDb()`
  (src/db.ts): `PRAGMA wal_checkpoint(TRUNCATE)` then an APFS copy-on-write
  clone (`COPYFILE_FICLONE`) — instant, point-in-time, consistency verified.
  Falls back to the SQLite backup API when another connection holds a read
  mark and the WAL can't be reclaimed (`checkpointCompleted()` decides).
  Do not re-add the backup to monitor.sh; do not make it skip when crawlers
  are running.

## Goodreads page-change log
- Whenever a Goodreads page change forces a code fix (selector updates, markup
  shifts, URL changes, new anti-bot behavior), ADD AN ENTRY to
  `GOODREADS_CHANGES.md` (newest entry on top, timestamp `YYYY/MM/DD HH:MM`).
  Keep it concise: date, what changed, what was fixed, any throttling notes.

## Future work
- Longer-horizon plans live in `PLAN-*.md` files (e.g.
  `PLAN-edition-clustering.md`). Read the relevant one before working on that
  area; update it when facts on the ground change.

## Code conventions
- Scrapers live in `src/scraper.ts` using cheerio. Unit-test pure logic in
  `src/*.test.ts`; never hit the network in unit tests.
- Vitest configs are `.mjs` (must stay `.mjs` — tsconfig uses `rootDir: src`).
- `npm test` = fast unit; `npm run test:coverage` = unit + coverage;
  `npm run test:integration` = live suite (slow, polite).
