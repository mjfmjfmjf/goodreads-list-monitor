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
- **List tags: ONE unified xref + one walk-history table (unified 2026/10/07).**
  `list_tags(list_id, tag_name, first_seen, last_seen, from_sidebar,
  from_directory)` is THE list↔tag xref: `from_sidebar` = learned from the
  list's own `Tags:` sidebar (`/list/show/<id>`, scrapeListBooks),
  `from_directory` = learned by enumerating a Listopia **directory** tag
  (`/list/tag/<tag>` via `listTagWalk.sh` / `walkListTag.sh`); a row can carry
  both. Per-tag counts (`listTagStats.sh`, `listTags.sh`) are over this table,
  so a walked tag's count is its REAL directory size (historical → 1,018, not
  the sidebar subset — sidebar coverage is only ~half of what a walk finds).
  `list_tag_walk_history(tag_name PK, first_walked, last_walked, num_walks,
  num_lists)` answers "did I walk this tag, when, how often, and how many
  lists did it yield" (`num_lists` NULL = walked before membership tracking).
  Writers: `upsertListTags` (sidebar), `recordListTagMembership` +
`recordListTagWalkHistory` (directory walks, recorded up front for ALL
  enumerated lists — before the already-scraped skip filter, which is what the
  2026/10/07 christian-walk bug was about). `reconcileListTagsXref()`
  (src/db.ts) runs at every startup: adds the provenance columns on an old DB,
  stamps legacy both-flag-0 rows as sidebar (only old code leaves both 0, and
  old code only ever wrote sidebar), and — while the LEGACY `list_tag_walks`
  (per-(tag,list) membership, still written by crawlers started before the
  unification) exists — mirrors its rows into list_tags and seeds/refreshes
  history. Seed rules: `num_walks` = distinct DAYS walked (per-row walked_at
  timestamps would invent hundreds of "walks"); `num_lists` = max of the two
  known enumerations, NULL preserved. `list_tag_walks` is ALREADY dropped from
  EXPORT_TABLES (it exports nothing a receiver can import) and lives in
  EXCLUDED_TABLES instead. **When the last pre-unification crawler exits: drop
  `list_tag_walks` + `idx_list_tag_walks_list`, delete that reconcile step, and
  remove `list_tag_walks` from EXCLUDED_TABLES** (keep `list_tag_walk_history`,
  which IS exported and imported). Newer round-trip importers: `author_slugs`
  (first_seen keeps earliest, last_seen keeps latest, name fill-blank), and
  `list_tag_walk_history` (earliest first_walked, latest last_walked, larger
  num_walks/num_lists) — both added 2026/10/10 so a restored DB doesn't revert
  to re-walking every tag or re-canonicalizing slugs.
- **Walk-tag history is ALREADY SEEDED (56 tags) — do not re-run this.** The
  user ran, on 2026/10/05:
  `history -1000 | grep listTagWalk.sh | egrep -v history | sed 's/.*Walk.sh //' | sed 's/ .*//' | sort | uniq | egrep -v "\-\-"`
  Result: 56 distinct tags — years `2010`–`2027` plus `author average-ratings
  best Castilian children covers Dutch fantasy fiction flemish french gay german
  graphic-novels historical-fiction historical-romance horror italian japanese
  latin manga middle-grade mystery non-fiction nonfiction paranormal
  picture-books polish Portuguese queer romance science science-fiction spanish
  swedish thriller titles young-adult`. Seeded into `list_tag_walks` with
  `list_id = ''` (`WALKED_TAG_MEMBERSHIP_UNKNOWN`) because the tag names survive
  in shell history but the per-list membership does not. `listTagStats.sh
  --exclude-walked` subtracts these. Don't re-derive the list from history and
  don't re-seed; just check `SELECT COUNT(DISTINCT tag_name) FROM
  list_tag_walks` (expect 56). Re-running is harmless but pointless.
- **Tag names are LOWERCASED at the storage boundary** — `parseListTags()`
  lowercases, and `upsertListTagWalk()` lowercases too, because Goodreads treats
  `/show_tag/Dutch` and `/show_tag/dutch` as the same tag. Shell history
  preserves whatever case was typed, so the seeded set was `Castilian Dutch
  Portuguese` capitalized; those 3 rows were normalized in place on 2026/10/05.
  `loadWalkedTagNames()` lowercases on read as well, and `rankListTags()`
  compares lowercased on BOTH sides — otherwise `--exclude-walked` silently
  fails to exclude a tag you already walked. If you add a tag source that isn't
  lowercased, fix it at the write, not in the report.
- **Connectivity errors get a probation window, not an instant abort**
  (2026-09-25 fix + 2026-09-26 follow-up). `scrapeAuthorStats` rethrows
  `isConnectivityError` errors (both the outer fetch and the inner multiPage
  page loop) so an outage is never recorded as an author-level failure strike
  (a lost connection is not an author defect). On top of that, every author
  crawl and tag/list walker runs its network ops through `withConnectivityProbe`
  (utils.ts): a connectivity blip is logged, waited out (~60s), and the same
  scrape is retried — up to `GOODREADS_CONNECTIVITY_PROBES` probes by default.
  Only after the connection stays down does the run abort with the usual
  "network error — progress saved" message. The popular-by-date page walker
  does the same inline via `connectivityProbeDefaults()`. Defaults: wait 60s
  (`GOODREADS_CONNECTIVITY_WAIT_MS`), 3 probes
  (`GOODREADS_CONNECTIVITY_PROBES`). This survives Wi-Fi/modern blips without
  hammering; probes still respect the per-request pacing between scrape calls.
- **Integration suite runs in STRICT throttle mode**
  (`GOODREADS_STRICT_THROTTLE=1`): on a 202/403/429 it gives up immediately
  (no retry/backoff) so a throttled run fails fast with a clear message.
  A failure with a throttle message means cooldown, NOT a parser change.
  On a throttle failure, do NOT re-run the whole suite — re-run ONLY the failing
  test (`GOODREADS_STRICT_THROTTLE=1 npx vitest run --config
  vitest.config.integration.mjs src/integration/goodreads.integration.ts -t
  "<test name>"`). If the failing test is the known-flaky `/book/show`
  `browser-book-scrape` 202 case (GOODREADS_CHANGES.md 2026/09/25), don't re-run
  even that one — it's the first URL to be throttled, and 14 green with only it
  202'ing is the expected outcome.
- **Giveaways feed is AppSync `getGiveaways` (book-id discovery only).**
  `./giveaways.sh` (`src/giveaways.ts`, command `giveaways`) walks
  `https://www.goodreads.com/giveaway?sort=recently_listed` purely to harvest BOOK
  ids, then hands them to `browser-book-scrape`. It uses the SAME AppSync endpoint
  as popular-by-date (`APPSYNC_URL` in both files) and reads the api key from
  `__NEXT_DATA__.props.pageProps.apiKey`. The listing is server-rendered, so no
  request fires on plain load — the walker drives `getGiveaways`
  (`getGiveawaysInput:{format:null,genre:"all",sort:RECENTLY_LISTED}`,
  `pagination:{after,limit}`) from inside the page, chaining the **base64**
  `nextPageToken` (unlike getTopList's hex). The server **CAPS a page at 15**
  (asking 30 returned 15) → ~120 fetches for the current ~1.8k feed. `book_id`
  comes from `details.book.legacyId` (spike-verified selectable) falling back to
  the cover `imageUrl` tail (`/books/<digest>i/<id>.jpg`). **BOOK-ID ONLY**:
  nothing giveaway-specific (copies/entries/dates/region) is persisted — the book
  detail page is the canonical source. Already-scraped books are skipped by the
  `browser_scrape` checkpoint, so re-walking the feed re-fetches nothing. Feed
  fetches are paced 1500–3500ms (`GR_FEED_DELAY_MS="min,max"`), matching the
  popular-by-date walker — ~120 sequential fetches must not hammer Goodreads.
  Discovered 2026/10/17 (see GOODREADS_CHANGES.md).
