# PLAN: Author identity — id-first everywhere (kill name/slug-keyed authors)

Status: planning (draft). Created 2026/09/19 from a code-audit the user drove:
`authors` is keyed by `name`, which is "almost certainly a mistake" — the author
id is effectively always available, and name-keying gets silently wrong under
Goodreads' duplicate/mangled display names.

Ground rule (user): whenever the author id / book id / work id is available, use
it; use author slug and title only to derive ids or for display.

## Problem — how this went wrong

- Pre-SQLite, `authorsCache.json` was keyed by display name. The SQLite migration
  (commit 0c6ee1b) carried `name` over as the PRIMARY KEY with `id`/`slug` as
  NOT NULL passengers (`db.ts:349-359`; `ON CONFLICT(name)` in `storage.ts:596`),
  so the DB has always been name-keyed as a vestige of the JSON era.
- Because the table is keyed by name, callers started treating name/slug as
  identity: `getAuthor(name)` (`storage.ts:563`), `findAuthorBySlug`
  (`scraper.ts:1152`, `authorOne.ts:54`, `authorOrphans.ts:264`),
  `Object.values(authorCache).find(e => e.slug === a.slug)` (`authorTopBooks.ts:80`),
  failure attribution by name (`recordAuthorFailure(name, …)`,
  `storage.ts:609`; callers `authorRescan.ts:254`, `authorTopBooks.ts`,
  `authorOne.ts:45` even throws a slug-derived *display name* at it:
  `fallbackNameFromSlug(parsed.slug)`).
- Band-aids accreted on top instead of fixing the key: `author-dedupe`
  (`authorDedupe.ts`), `findAuthorBySlug`, `normalizeAuthorName` in orphan
  classification, two separate failure trackers (see below).

## Verified ground truth (field-coverage, 2026/09)

- Books: 7,750,529 total · `author_id` present on 7,750,335 (only **194 missing**) ·
  **700,291 distinct** author ids referenced.
- `authors` table: **451,021 rows**, all with distinct ids, all with a slug; only
  44% have `num_ratings` (stats not yet scraped).
- So ~249k book-referenced ids have **no authors row at all**; ~89k hosted rows
  are **statless** (matches `author-rescan`'s 89,338 and `author-orphans
  --scrape`'s 243,164 — disjoint sets).
- **8,071 display-name strings map to 2+ distinct author ids** — a name-PK table
  cannot even represent these without dropping/colliding rows.
- Two failure trackers, different keys AND different thresholds:
  - name-keyed `authors.fail_count`, `AUTHOR_FAIL_LIMIT=5` (`storage.ts:65`),
    written by the bulk sweeps (authorRescan/authorTopBooks/authorOne/orphans)
    even though the id is on the same entry (e.g. `authorRescan.ts:238`).
  - id-keyed `author_scrape_failures`, `AUTHOR_SCRAPE_FAIL_LIMIT=3`
    (`storage.ts:624`), written by `scrapeBookByAuthorPage` (`scraper.ts:1217`).
  - The 5-vs-3 split is NOT slug-based or policy-based — it's two independent
    code vintages. Closest rationale: 3 fires on hard scrape failures (404 /
    dead-end ids → deterministic), 5 on soft "no stats line". One unified
    id-keyed ledger + one threshold is the target.
- Orphans still miss a sliver today: `authorOrphans.ts:107-108` skips any book
  whose author *string* is already a cache key, so the ~8,071 collision families
  hide their secondary ids behind the known name — those unhosted ids appear in
  neither sweep.
- Author id is derivable from the slug prefix everywhere
  (`extractAuthorId`, `scraper.ts:1290`; `/author/show/…` hrefs parse the same
  way, `scraper.ts:1169-1173`). Goodreads serves `/author/list/{id}` id-only
  (verified 2026/08/27, see PLAN-orphan-authors.md).

## Target design

1. **`authors` becomes id-keyed**: `id TEXT PRIMARY KEY`, plus `name`, `slug`
   (slug can be nullable until the first author-page scrape), last_seen etc.
   Identity everywhere = author id; name/slug are display columns only.
2. **Backfill-mint**: every book-referenced id missing from `authors` gets a row
   created directly from book data (id + display name from the book, no crawl).
   After this, ~700k book-referenced ids all resolve. The ~249k unhosted tail
   (including the ~6k collision-masked ids) stops being "orphans" and becomes
   ordinary statless candidates.
3. **One id-keyed failure ledger**, one threshold, written on every scrape path
   (`scraper.ts`, sweeps) keyed by author id.
4. **Slug stays out of lookups**: `findAuthorBySlug` call sites flip to
   `getAuthorById`. Slug kept for parsing ids and display; `fallbackNameFromSlug`
   only ever feeds a display string, never a key/attribute.

## Phases

### Phase 0 — storage layer (no external behavior change)
- `authors` table re-keyed to `id TEXT PRIMARY KEY` (migration of the existing
  451k rows; same-id name-variant rows collapse on the id — the dedupe
  authorDedupe does manually becomes the migration's natural behavior).
  `name`/`slug` become non-key columns.
- `upsertAuthorById(id, entry)`, `getAuthorById(id)`, id-keyed `recordAuthorFailure`,
  single `AUTHOR_FAIL_LIMIT` constant (value = decision point, see below).
- Keep legacy name/slug getters only where truly needed during transition; delete
  after Phase 3. All writes stay single-statement autocommit upserts (WAL rules).

### Phase 1 — backfill-mint (no network)
- `syncBooksToCache` / a one-shot `author-mint` command: for each distinct
  `books.author_id` missing from `authors`, insert `{id, name (from book)}`,
  slug NULL. ~249k rows, idempotent upserts, O(1) memory via `iterateBooks()`
  (never `loadBookCache()`).
- Re-run impact: two commands collapse. `author-orphans --scrape` no longer
  grinds ~243k ids; `author-rescan` (already `author_id`-aggregated via
  `loadAuthorBookStats`) sweeps every statless row, ordered by book popularity.

### Phase 2 — collapse orphan/rescan onto id
- `author-rescan` and `author-orphans` selection becomes: statless rows /
  unminted ids, all id-keyed, ordered by top-book ratings. Orphans is renamed or
  narrowed to its genuine jobs: the 194 truly id-less books (name→id via search,
  throttled, at most 1 lookup/min per existing convention), concat strings
  (`--includeConcat`), and collision review (`8,071 name→2+ id` families).

### Phase 3 — unify failure tracker + remove slug-keyed lookups
- One id-keyed ledger everywhere; delete `recordAuthorFailure(name)` (and the
  double-write at `authorOrphans.ts:247-248`). `scraper.ts:1217` becomes the
  single implementation; `unsplit` sweep code uses it too.
- Kill the four slug-lookup sites (`scraper.ts:1152`, `authorOne.ts:54`,
  `authorOrphans.ts:264`, `authorTopBooks.ts:80`) → `getAuthorById`.
- `authorOne` failure attribution keyed by parsed id, not
  `fallbackNameFromSlug`.

### Phase 4 — full exit from the JSON files
Four tiers. Two are eliminable, one is kept-but-fixed (the token), one is a
decision.

**4a. Legacy migration-only JSON — remove: `booksCache.json`, `authorsCache.json`,
`state.json`**
- File reads exist ONLY in `migrateToSqlite.ts` (one-time migration, already
  run in commit 0c6ee1b). Retire `migrate-to-sqlite` (detect the DB exists and
  no-op, then delete the command); archive/delete the three files once nothing
  references them. Runtime already reads the DB everywhere:
  `loadState()` = DB (`storage.ts:818`), `getBook`/`iterateBooks` = DB,
  `loadConfig()` = DB `config` table (`storage.ts:870-872`).

**4b. `config.json` — KEEP (token store), fix the sync gap**
- The Goodreads session token is necessary; `config.json` is the canonical file
  the user populates via `loadGoodreadsToken.sh` (cleans
  `rawGoodreadsToken.txt` → `config.json`). NOT dead — it stays.
- Runtime reads the cookie from the DB `config` table via `loadConfig()`
  (`storage.ts:870-872`), so a token refreshed in config.json never reaches the
  DB today — that's the real bug, not the file itself.
- Fix: `loadGoodreadsToken.sh` also upserts the DB `config` table's `cookie`
  key (single-statement, no network → fine under WAL). Runtime remains
  JSON-free; config.json remains the editable source of truth.
- Reword cookie warnings that imply a live file read so they name the refresh
  path (`./loadGoodreadsToken.sh` → DB): `index.ts:1786,1798,1811`,
  `scraper.ts:407`.

**4c. Stale usage/help messages naming removed files — update:**
- `index.ts:479` (booksCache.json), `:1174`/`:1190` (state.json), `:1409`
  (booksCache.json) → reword to "the local book cache" / "the most monitored
  lists".
- `backfillPages.ts:20,22,27`, `backfillPages.sh:4`, `backfillSeriesPos.ts:40`,
  `harvestList.ts:30`, `addBook.ts:420` all WRITE the DB (`upsertBook` /
  `backfillBookPagesFromLibrary`) but print "saved to booksCache.json" → fix to
  "the book cache".
- `monitorYearlyHighlyRatedLists.ts:103` ("(state.json lastCount)") → "(saved
  lastCount)".
- Keep `index.ts:713` / `browserBookScrape.ts:223`: accurate context about the
  browser-auth path (config.json still exists). Delete stray backup
  `src/scraper.ts.20260727`.

**4d. Integration tests + docs — remove mentions:**
- `src/integration/goodreads.integration.ts`: comment `:25`, message `:55`,
  describe `:154`, assertion messages `:189`/`:192`, message `:237` already use
  DB-backed `loadConfig()`/`loadState()` — reword so no text names
  state.json/config.json/authorsCache.json.
- `runIntegrationTests.sh:9-10` and `AGENTS.md:17-18` comments → restate the
  real requirements: a Goodreads session token (DB config; refresh via
  `./loadGoodreadsToken.sh`), a cached library export, and monitored lists
  (DB). Drop authorsCache.json/state.json/config.json from the list.
- README lines 11/96/104/199/227/233/239/245/349-352 → point at SQLite (the
  book/authors tables) + the token workflow. Historical PLAN-*.md mentions stay
  (records of the JSON era).

**4e. `libraryExportCache.json` — decision (only true live JSON read left)**
- Still live-read by `library.ts:170-171` / `libraryExport.ts:13-17` (cached
  `--import`, `--excludeReviewed`, library queries; per-person via `--library`;
  gitignored; ~11k user-import rows). Options:
  - (a) Port to SQLite: new `library_entries` table (id, title, author, shelf,
    dateRead, hasReview, published, myRating, pages, publisher, bookshelves) +
    `--library <name>` as a scoped config key; `--import` streams the CSV in.
    The integration add-book lookup reads the table. Runtime fully off JSON.
  - (b) Keep it as the one deliberate exception: an imported user-import
    artifact, documented as such.
  - Default recommendation (a) so the runtime is fully DB — confirm with user.

### Phase 5 (deferred/optional) — work_id adoption
`work_id` present on only 35.9% of books (2,630,447 distinct). Same id-first
philosophy applies when edition-clustering work lands; not part of the author fix.

## Decisions needed
1. Unified failure threshold: keep 3, keep 5, or one value (e.g. 3) everywhere?
2. `libraryExportCache.json`: migrate to a `library_entries` DB table (option 4e-a,
   recommended) or keep as the one documented user-import JSON exception?
3. Name→id resolution for the 194 id-less books: new throttled search-scrape
   command, or manual/curated alias table (matches PLAN-orphan-authors.md's
   `author_aliases` idea)?
4. Does `author-orphans` keep its name after Phase 2 (narrowed role) or fold
   into `author-rescan` + a dedicated `author-missing-ids` review command?
5. `config.json` is retained as the token store (4b) — confirm the refresh path
   goes through `loadGoodreadsToken.sh` writing both the file and the DB.

## Locked once the author-id work ships (non-negotiables from the audit)
- `booksCache.json` / `authorsCache.json` / `state.json` are fully out: no
  runtime reads, no messages, no test/docs mentions, `migrateToSqlite` retired.
- `config.json` lives on as the token source (user decision) but stops being the
  runtime cookie read — DB sync added.
- The Goodreads token itself is REQUIRED for cookie-authenticated scrapes
  (author-page crawls stay anonymous by default; cookie paths throttle tighter).

## Constraints
- No `loadBookCache()` (2016/09/13 OOM refactor; stream with `iterateBooks()`).
- Crawler writes = single-statement upserts; no `db.transaction` during crawls.
- Keep Goodreads polite; `author_aliases`/search resolutions are rate-limited.
- Gates after each phase: `./runUnitTests.sh 2>&1 | tee /tmp/unit.out`, then a
  deliberate integration pass before/after risky scraper changes.
- Add a GOODREADS_CHANGES.md entry per the repo convention if any page-behavior
  shifts surface while verifying.