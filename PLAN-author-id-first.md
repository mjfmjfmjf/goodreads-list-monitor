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
- **The canonical identity Goodreads hands back is parsed but discarded.** Every
  author page yields a clean display `name` and a canonical `slug` from
  `parseAuthorStats` (`scraper.ts:1227-1258`), but `updateAuthorStatsFromPage`
  (`scraper.ts:1260-1271`) uses `stats.slug` only as the argument to
  `findAuthorBySlug`, merges the counts into `found.key` (the *existing* dirt
  string), and never writes `stats.name`/`stats.slug` back to the row; on a slug
  miss it silently drops the author (no insert). `storeAuthorStats`
  (`authorOne.ts:52-83`) uses the scraped slug/name to find-or-mint, but on a hit
  keeps the existing row's key/slug — so the canonical name is still never
  applied to an existing row. Net effect: the good identity is only ever a lookup
  key, which both entrenches dirty names and explains why variant rows keep
  re-forming after `author-dedupe`. Re-keying on id and *persisting* the scraped
  name/slug closes the loop.

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

### Refreshed 2026/10/03 (live `goodreads.db`)

- `authors`: **569,743 rows / 567,639 distinct ids** → re-key collapses only
  **2,104** rows, so the new table is a known 567,639-row target.
- `books` distinct `author_id`: **936,418**; referenced ids with **no** `authors`
  row: **371,114** (the Phase-1 mint target — up from the ~249k of 2026/09).
- Statless authors: **221,509** (the `author-rescan` grind).
- Same-id variant profile (the 2,104 groups): 25 groups have 0 stat-bearing rows,
  270 have exactly 1, **1,809 have 2+**; conflicting `num_ratings` on 1,120
  groups, conflicting `average_rating` on 74, conflicting `last_seen` on all
  2,104. So this is real reconciliation, not a no-op.
- Multi-**slug** ids: only **2** (`52191614` `YUHO_OKITA`/`Yuho_Okita`;
  `9013570` `Stephen_Richard_Witt`/`Stephen_Witt`); slugs not id-prefixed: **0**;
  slugs shared across ids: **0**; null/empty id: **0**; null slug: **0**. All
  2,102 other groups share one canonical `{id}.{Slugified_Name}` slug and differ
  only in the `name` column — i.e. **slug is already canonical; name is the dirt.**
- `idx_authors_id` (`db.ts:558`) has been added to make `WHERE id = ?` cheap
  while the table is still name-keyed. It becomes redundant after the id-PK
  re-key (the PK is the index) and should be dropped then.

## Cross-id same-human families (verified 2026/09/26)

Beyond same-id name variants, Goodreads genuinely keeps **distinct author ids
for the same human**. Fresh scan of the 489,133-row authors table,
name-normalized (lowercase, non-alphanumerics stripped):

- **624 groups hold ≥2 different ids that share an identical book title (578)
  and/or a book `work_id` (123)** — the direct answer to "do the ids share books
  with the same work id": **yes, 123 groups do** (78 of them also share a title).
- **46 groups share a work_id but NO title** — the language/edition-profile
  class (`Bob Goff` 52537053 ↔ `鮑伯．戈夫 (Bob Goff)` 45709377; slug-leak
  profiles like `ed-mcbain` 35321735, `juliet-marillier` 30765616). These look
  like deliberate per-language pages, not stray duplicates.
- **234 of the 624 involve a mint on/after 2026-09-20** — the current
  popular-by-date / author-rescan / list walks keep minting second profiles of
  already-crawled humans. Today **1,209** untouched-rescan candidates are
  dup-profiles of an already-scraped sibling, so the running grind double-crawls
  ~1.2k same-humans.
- Everything else in the 3,399 multi-id name groups is same-name-different-
  people (David Scott, James Thomson, George Smith…) — name equality alone is
  NOT proof; work_id/title equality is.
- Caveat: `work_id` covers only ~25% of these ids' book rows, so the title-only
  501 groups are the *floor* of confirmation-by-work; bookSweep's ongoing
  work_id capture will keep raising the work-confirmed count.

Canonical pick (offline, no network): the id that owns the shared works'
`is_work_rep` rows (edition-clustering infra already exists). **115/123
work-sharing groups resolve to a single rep owner** — Stephen King 3389 owns the
shared *Full Dark No Stars* rep (vs 56783466: 15 books / 120k ratings);
Chomsky 2476, Donald Miller 4829, Eric Carle 3362 — all the well-known profile.
Only **8 groups split rep ownership** (e.g. Plato 879 ↔ 69581394) and need
tie-breaks (majority rep ownership → higher total ratings → cleaner name).

## Cross-id canonicalization (orthogonal to the re-key)

The id-PK re-key cannot merge distinct ids (id stays unique per row), so
same-human families need a second-layer mapping bridging the edition-clustering
infra and PLAN-orphan-authors' `author_aliases`:

- `author_aliases` table: `(author_id, canonical_id, kind ['dup'|'language'],
  evidence ['work_id'|'title'], verified_at)`. Built offline by the same
  iterateBooks sweep that owns `is_work_rep`; never written during crawls.
- Writer-side resolution (`upsertAuthorById`, failure ledger, book-author
  attribution) maps `author_id → canonical_id` at write time, so scraped stats
  land on the canonical row and crawl loops skip alias ids outright — kills the
  ~1,209 double-crawls without a destructive merge.
- Optional hard merge (user sign-off only): rewrite `books.author_id`,
  `popular_by_date_book` variants, and any stats rows to the canonical id, delete
  the aliased row — a `db.transaction` op reserved for crawlers-stopped windows.
- "Retire one" semantics: canonical = rep owner; the retiree is aliased, its
  rows (if any) folded in, never deleted while writers are live.

## Same-id collapse + `author_slugs` ledger (Phase 0)

Re-keying on id collapses the 2,104 same-id name-variant groups to one row each.
The columns need an explicit rule:

- **Canonical `slug`**: the max-`num_ratings` row's slug (tie-break decision
  below). **Canonical `name`**: among the group's stored names, the one whose
  normalized form (whitespace collapsed) equals the canonical slug's suffix — so
  `John Green` beats `John  Green` / `John Grisham(Editor)`, while punctuation
  that slug-stripping loses is preserved by matching stored names rather than
  reconstructing from the slug. Fallback: the max-`num_ratings` row's `name`.
- **Counts** (`num_ratings`/`num_reviews`/`num_shelves`/`catalog_pages`/
  `fail_count`): field-wise **MAX** (the statless mint rows are all 0, so MAX is
  how the scraped values survive). **`average_rating`/`ratings_rate`**: from the
  max-ratings row. **`first_seen`**: MIN. **`last_seen`**: MAX.
- The 2,102 single-slug groups differ only in the dirty mint `name`; those names
  are noise and die in the collapse, by design.

Keep the slug **history** in a ledger (not on the row):

```
author_slugs(
  author_id  TEXT NOT NULL,
  slug       TEXT NOT NULL,
  name       TEXT,              -- display variant seen with this slug (optional)
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  PRIMARY KEY (author_id, slug)
)
```

- Rationale: the only multi-slug ids today are slug changes over time —
  `52191614` `YUHO_OKITA` (2026-08-31→09-29, 2546) vs `Yuho_Okita` (09-26);
  `9013570` `Stephen_Richard_Witt` (08-31→09-29, 6538) vs `Stephen_Witt`
  (09-25). The ledger records when a slug appeared/retired without retaining a
  stale author row. Size ≈ distinct `(id,slug)` = **~567.7k**.
- **History/audit only — never an identity source.** Slugs are 100% id-prefixed
  (0 exceptions), so inbound slug → id stays `extractAuthorId`; lookups stay
  id-first. Adopting this must not re-introduce slug-as-key.
- **Write path**: one extra idempotent single-statement upsert per author scrape
  (`first_seen` on insert, `last_seen` on every sighting) plus on mint — WAL-safe,
  no transaction.
- **Backfill**: seed from the pre-collapse rows
  (`SELECT id, slug, name, MIN(first_seen), MAX(last_seen) GROUP BY id, slug`).
- **Distinct from `author_aliases`** (cross-id same-human mapping): different
  table, different job — don't conflate.
- **Export/import**: add `author_slugs` to `EXPORT_TABLES` (non-secret, needed
  for sanitized round-trip); its importer upserts on `(author_id, slug)`.

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
5. **Author scrapes persist the canonical `name`/`slug`.** Today
   `updateAuthorStatsFromPage` (`scraper.ts:1260-1271`) parses them and throws
   them away. The id-keyed write path (`upsertAuthorById`) overwrites `name`/`slug`
   from the scrape so dirty names self-heal instead of re-forming, and every
   scrape upserts the `author_slugs` ledger.
6. **`author_slugs` variant ledger** (same-id slug history, see above): kept out
   of the identity path; id remains the only key.

## Phases

### Phase 0 — storage layer (no external behavior change)
- `authors` table re-keyed to `id TEXT PRIMARY KEY` (collapse the 2,104 same-id
  groups per the merge rule above; `name`/`slug` become non-key columns). New
  `author_slugs` ledger + backfill.
- `upsertAuthorById(id, entry)`, `getAuthorById(id)`, id-keyed `recordAuthorFailure`,
  single `AUTHOR_FAIL_LIMIT` constant (value = decision point, see below).
- Keep legacy name/slug getters only where truly needed during transition; delete
  after Phase 3. All writes stay single-statement autocommit upserts (WAL rules).

#### Phase 0 execution — rekey runbook (scrapers stopped)
The re-key is raw SQL run deliberately with every crawler stopped — **not** an
auto-migration in `initSchema` (which would drop the old table with no rollback).
Schema and code must flip together: id-PK code cannot run against a name-PK DB
(`ON CONFLICT(id)` has no unique target) and vice versa.

**0. Freeze + snapshot**
- Stop every crawler: `monitor.sh`, `tagRecentMonitor.sh`, `authorRescan.sh`,
  `authorOne.sh --file …`, `listTagWalk.sh` / `walkListTag.sh` / `listWalk.sh`,
  `gapGenreTagDiscovery.sh`, `monitorTopRatedList.sh`,
  `monitorYearlyHighlyRatedLists.sh`, `monitorTopStandalones.sh`, `bookSweep.sh`,
  `popularByDate.sh`, `publisherCatalog.sh` — plus any manual/playground process.
  Pause the launchd backup for the window
  (`launchctl bootout gui/$(id -u)/com.goodreads.backupdb`): it clones the whole
  DB and contends for the writer lock.
- Confirm no writer holds the DB: `lsof goodreads.db` (empty).
- `./backupDb.sh`, then a manual rollback copy **outside** `backups/` (e.g.
  `~/goodreads-pre-rekey.db`): `rotateBackups` keeps only 7 `goodreads.db.*` files,
  a same-dated copy is clobbered by `fs.removeSync(dest)` (`db.ts:272`), and a
  `goodreads.db.*`-named file sorts after the dates and would evict real backups.
  Run `PRAGMA wal_checkpoint(TRUNCATE)` first so the `.db` copy is whole.

**1. Build the flip (before touching live)**
- Add the pure `mergeAuthorRows(rows)` merge rule and
  `author-rekey --dryRun|--apply` (prefer a standalone raw-`better-sqlite3`
  script; see open questions).
- Schema/code changes per the bullets above; then
  `./runUnitTests.sh 2>&1 | tee /tmp/unit.out`.

**2. Rehearse end-to-end on a copy**
- `cp ~/goodreads-pre-rekey.db /tmp/gr-rehearsal.db`
- `GOODREADS_DB_PATH=/tmp/gr-rehearsal.db … author-rekey --dryRun` → review all
  2,104 collapses (name/slug/stats choices).
- `… author-rekey --apply` on the copy, then the prove-before-drop queries.
- `GOODREADS_DB_PATH=/tmp/gr-rehearsal.db ./runIntegrationTests.sh` plus an
  `export-data`→`import-data` round-trip into an empty DB. Burn the slow gates
  here so live stays down only minutes.

**3. Live cutover (still frozen)**
- `… author-rekey --apply` on `goodreads.db`, one `db.transaction`:
  - `CREATE TABLE authors_new (id TEXT PRIMARY KEY, name, slug, …same columns)`.
  - `INSERT … SELECT` per the merge rule; backfill `author_slugs` from old rows.
  - drop the old indexes (see gotcha), verify (below), then
  - `ALTER TABLE authors RENAME TO authors_old_YYYYMMDD;`
  - `ALTER TABLE authors_new RENAME TO authors;` recreate the two stats indexes;
    commit.
- **Keep `authors_old_YYYYMMDD` as the rollback — do not drop at swap time.**
  Retirement is gated on the post-step checklist below. Until then, rollback =
  `DROP TABLE authors; ALTER TABLE authors_old_YYYYMMDD RENAME TO authors;`
  (or restore the manual copy).
- Start the new code; a read command confirms it opens against id-PK.

**4. Post** — see "Phase 0 post steps" below.

**Gotcha — index names are DB-global, not per-table.** `idx_authors_id`,
`idx_authors_num_ratings`, `idx_authors_num_shelves` exist on `authors`; after
`RENAME TO authors_old_YYYYMMDD` they still occupy those names, so creating them
on `authors_new` collides. Drop them before the rename, then recreate the two
stats indexes on the new table (the rollback table is left index-less — fine).

**Schema**: update `initSchema`'s `CREATE TABLE authors` to `id TEXT PRIMARY
KEY` so fresh DBs are born id-PK (existing DBs no-op on `IF NOT EXISTS` and are
handled by the swap). Drop the now-redundant `idx_authors_id` (`db.ts:558`).

**Prove-before-drop queries:**
```
SELECT COUNT(*) FROM (SELECT id FROM authors GROUP BY id HAVING COUNT(*)>1); -- 0
SELECT COUNT(*) FROM authors;                                                 -- 567,639
SELECT COUNT(*) FROM authors_old o WHERE NOT EXISTS (SELECT 1 FROM authors n WHERE n.id=o.id); -- 0
SELECT COUNT(*) FROM authors n WHERE NOT EXISTS (SELECT 1 FROM authors_old o WHERE o.id=n.id); -- 0
SELECT COUNT(*) FROM authors_old o WHERE o.num_ratings>0
  AND NOT EXISTS (SELECT 1 FROM authors n WHERE n.id=o.id AND n.num_ratings>0); -- 0
SELECT id,name,num_ratings FROM authors ORDER BY num_ratings DESC LIMIT 20;    -- eyeball
```

#### Phase 0 — import/export
- `exportData` needs no structural change: headers come from `PRAGMA table_info`
  and rows from `SELECT *` (`exportData.ts:82-93`), and the importer is
  header-keyed (`decodeAuthorRow` uses `headers.indexOf`, `importData.ts:263-266`),
  so column reorder is harmless.
- `importAuthorsFile` (`importData.ts:491-546`) flips to id-first:
  `ON CONFLICT(name)` → `ON CONFLICT(id)` (`:501`), `WHERE name = ?` → `WHERE id = ?`
  (`:510`), `mergeAuthor` identity keyed by id. This is the actual correctness fix
  — a name-PK table cannot represent the 8,071 name→2+id families, so only
  id-keyed import round-trips losslessly. Decide the per-field aggregation for
  importing a *pre-rekey* export (duplicate-id rows).
- Add `author_slugs` to `EXPORT_TABLES`; the schema-coverage guard test fails if a
  new table is in neither `EXPORT_TABLES` nor `EXCLUDED_TABLES`.

#### Phase 0 post steps — retire `authors_old` (gated on the full checklist)
`authors_old_YYYYMMDD` is the rollback; it is dropped only after the change is
proven end-to-end and shipped, in this order:

1. **Unit gate** green: `./runUnitTests.sh 2>&1 | tee /tmp/unit.out` (tsc + vitest
   coverage + offline CLI smoke). The schema-coverage guard
   (`exportData.test.ts:375-380`) runs against an isolated temp DB
   (`exportData.test.ts:7-10`), so the leftover live `authors_old_*` does not fail
   it — but `author_slugs` must be in `EXPORT_TABLES`/`EXCLUDED_TABLES`.
2. **Integration pass** (`./runIntegrationTests.sh`) before crawlers resume, while
   the site is still quiet.
3. **Export/import round-trip on a scratch copy** (`GOODREADS_DB_PATH`): run
   `export-data`, then `import-data` into an empty DB; assert the author count, id
   set, per-id counts, and `author_slugs` all survive, and a re-import is
   idempotent.
4. **Commit + push** the code + schema change.
5. **Resume crawlers** and confirm one scrape cycle writes `authors` (by id) and
   `author_slugs` with no constraint/`ON CONFLICT` errors and that id lookups work.
6. **Only then drop**: `DROP TABLE authors_old_YYYYMMDD;` (plus any WAL/SHM); prune
   the manual pre-rekey copy after a further confidence window.

Rollback stays available (rename `authors_old` back, or restore the manual copy)
until step 6.

#### Test coverage to add/refresh
Unit (`src/*.test.ts`, offline):
- `db.test.ts`: `authors` is `id TEXT PRIMARY KEY`; `author_slugs` exists; the old
  `idx_authors_id` is gone; the schema-coverage guard includes `author_slugs`.
- **Merge rule** extracted as a pure function (e.g. `mergeAuthorRows(rows)`),
  tested on the four real shapes: statless dirty + scraped (`John Green`), role
  suffix (`John Grisham(Editor)` → `John Grisham`), 2+ stat-bearing conflict
  (field-wise MAX), and the dual-slug tie-break (latest-seen vs max-ratings).
- Storage id-first: `getAuthorById`, `upsertAuthorById`, id-keyed
  `recordAuthorFailure`, single `AUTHOR_FAIL_LIMIT`.
- `author_slugs` ledger: `first_seen` set on insert, `last_seen` advanced on
  repeat, one row per `(id, slug)`; the backfill yields the same set as the
  pre-collapse `GROUP BY id, slug`.
- `importAuthorsFile`: **two distinct ids sharing a name both insert** (the
  collision-family regression a name-PK table cannot represent); duplicate-id rows
  in one CSV collapse per the merge rule; re-import idempotent.
- `exportData`: `authors` + `author_slugs` emitted; header-keyed decode unaffected.
- Failure attribution in `authorOne`/`authorRescan` keyed by id, not
  `fallbackNameFromSlug`.

Integration (`src/integration/goodreads.integration.ts`, live + polite):
- A live author scrape stores the page's canonical `name`/`slug` on the `authors`
  row and adds/updates the `author_slugs` entry.
- `getAuthorById(id)` resolves a known id; `extractAuthorId(slug)` resolves to the
  same id (slug→id path unchanged).
- Confirm the known-flaky `/book/show` `browser-book-scrape` 202 case is not made
  worse (see AGENTS.md).
- Verify the new modules clear the unit coverage thresholds
  (`vitest.config.mjs`) — the `runUnitTests.sh` gate fails below threshold.

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
6. Cross-id same-human policy (new, verified 2026/09/26): do language/edition
   profiles (`鲍伯．戈夫` Bob Goff, slug-leak profiles) merge into the canonical
   id, or only alias for lookup/dedup while the row stays? Genuine dups (Stephen
   King 3389 ↔ 56783466) are assumed merge-candidates.
7. Canonical-id tie-break when `is_work_rep` ownership splits (8 of 123
   work-sharing groups): majority rep ownership → higher total ratings → cleaner
   name — confirm the order.
8. Add the alias-based dup skip to `author-rescan` now (kills the ~1,209
   double-crawls this session) or defer until the `author_aliases` table ships?
9. Canonical slug tie-break for the 2 multi-slug ids: **latest-seen** slug (what
   Goodreads serves now — `52191614` → `Yuho_Okita`, `9013570` → `Stephen_Witt`)
   vs max-ratings slug (what we scraped most). Proposed: latest-seen for the row,
   every slug retained in `author_slugs`.
10. `author_slugs.name`: keep the display name per slug (free during the upsert,
    supports rename history) or omit as pure slug history? Proposed: keep it.
11. Pre-rekey export aggregation when a duplicate id collides on import (two
    name-variant rows → one id): MAX counts / newest `last_seen` / canonical name
    — confirm.
12. `author-rekey` implementation: standalone raw-`better-sqlite3` script (avoids
    loading name-keyed `storage.ts`) vs an `index.ts` command? Proposed: standalone.
13. Should the new code **refuse to start against a name-PK DB** (a startup guard)
    so a stray process can't run mid-migration? Proposed: yes.
14. Does Phase-1 `author-mint` run in the same frozen window (it needs the id-PK
    schema) or after crawlers resume? Proposed: after the rekey, same window.

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