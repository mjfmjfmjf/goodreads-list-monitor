# PLAN: Author id-first — completion (everything Phase 0 left open)

Status: draft. Created 2026/10/03 by auditing `PLAN-author-id-first.md` against the
live `goodreads.db` and the working tree.

Continues `PLAN-author-id-first.md`. That file's **Phase 0 is done and proven**
(see "Already achieved" below); this file covers the rest. Keep the same ground
rule: *whenever the author id is available, use it; name/slug are display-only.*

Every work item below carries the exact command(s) to run and what "done" looks
like. Items are ordered so each one's commands are safe to run when you reach it.

---

## The two goals

| | Goal | Measured by |
|---|---|---|
| **A** | **Coverage** — every distinct `books.author_id` has a row in `authors` (id = PK) | `unhosted_ids` = 0 |
| **B** | **First pass** — every author has stats **and** a fully crawled back catalog (`catalog_pages` set, all pages merged) | `catalog_pages` coverage = `authors.total` |

Goal A is offline and takes seconds. Goal B is a multi-day network grind (§5).

---

## Already achieved (do not redo)

Phase 0 of `PLAN-author-id-first.md` shipped into the working tree and verified
against live data:

- `authors` is `id TEXT PRIMARY KEY`; all six prove-before-drop queries pass.
  Live: 570,679 rows (from 572,051 pre-collapse), 0 duplicate ids, 0 rows lost,
  0 stat-bearing rows lost, `idx_authors_id` dropped.
- `author_slugs` ledger exists and is backfilled: 570,682 rows / 570,679 ids.
  Only 3 ids carry >1 slug (2 pre-existing, 1 real rename) — see the note at
  the end of §5.
- `author-rekey` command (`authorRekey.ts`) + `mergeAuthorRows` merge rule, unit
  tested on all four real shapes.
- Startup guard refuses a name-PK DB (`db.ts:257-269`).
- All four planned slug-lookup sites flipped to `getAuthorById`
  (`scraper.ts:1268`, `authorOne.ts:58`, `authorOrphans.ts:269`,
  `authorTopBooks.ts:134`). `findAuthorBySlug` has zero production callers.
- Every scrape path persists the canonical `name`/`slug` from the page
  (`authorOrphans.ts:276-277`, and the same in authorOne/Rescan/TopBooks/Recent).
  Verified live: an orphan logged as `Gina RussoPaul Lonardo (3338972)` now reads
  `name='Gina Russo'`, `slug='3338972.Gina_Russo'`.
- `importAuthorsFile` is id-first with the collision-family regression test
  (`importData.ts:501`; `exportData.test.ts:375-396`).

**Not committed.** `git status` shows ~30 modified files plus untracked
`src/authorRekey.ts`, `src/authorRekey.test.ts`, `authorRekey.sh`. §1 fixes that.

---

## Live baseline (2026/10/03, `goodreads.db`)

| Metric | Value |
|---|---|
| `authors` rows | 570,679 |
| distinct `books.author_id` | 939,900 |
| **book ids with NO `authors` row (Goal A backlog)** | **371,263** |
| `authors` rows whose id is in no book row | 2,042 |
| books rows | 11,575,138 |
| books with no `author_id` | 184 |
| statless authors (`num_ratings` 0/NULL) | 222,450 |
| ...of those, `catalog_pages` NULL (never crawled) | 204,343 |
| ...of those, `catalog_pages` set (crawled, no stats) | 18,208 |
| authors already crawled | 334,217 |
| catalog pages fetched so far | 692,848 (avg 2.07 pages/author) |
| authors with NULL/empty slug | 0 |
| `authors_old_20261003` | present (rollback, gated on §9) |

Baseline command (re-run any time to see these numbers move):

```bash
npm run field-coverage 2>&1 | tee /tmp/fieldcov.out
```

That reports `authors.total`, per-field coverage for `slug` / `catalog_pages` /
`num_ratings`, and `chronic_failures`. For the Goal A backlog number itself use
§2's query.

---

## Execution order

The 10 items are **not** in run order. This is the runbook. Key constraint: the
12-day grind holds the database-wide writer lock almost continuously, so
*everything else is front-loaded into a quiet window first*, then the grind is
launched and left alone.

| Stage | What | Who | Blocks |
|---|---|---|---|
| **0** | **Answer decision 1** (failure threshold) and **decision 2** (`library_entries`) — both change code in stage 2 | user | all code |
| **1** | **Commit Phase 0** (§1). Unit gate, stage the re-key, commit | both | everything |
| **2** | **All remaining code work, quiet DB** — §3 B1+B2, §2 `author-mint`, §4 ledger unify, §6 B5+B6, §7 B4, §8 tests. One or two commits, unit gate between each | AI (you review) | the grind |
| **3** | **Goal A** (§2a–2e): `idx_books_author_id`, mint dry-run, mint apply, verify `unhosted = 0` | user | §5 ordering |
| **4** | **Retire the rollback** (§9): integration pass, export/import round-trip, `DROP TABLE authors_old_20261003` | user | the grind |
| **5** | **Launch the grind** (§5): pass-1 loop, then pass 2. Weeks. Leave it alone | user | §10 |
| **6** | **Tail work** during/after the grind: §10 `author_aliases`, decision 4, §7's `library_entries` if deferred | both | — |

Two orderings that differ from the item numbering, deliberately:

- **§9 (retire `authors_old`) runs at stage 4, before the grind** — not after.
  It is the re-key's only rollback, and it needs a *short* live crawl cycle to
  prove writes work. Keeping the safety net in place for the whole 12-day grind
  is the point; retiring it at the end would be backwards.
- **§4 (ledger unify) runs in stage 2, before the grind** — the strike-migration
  statement wants a frozen window, and the grind then records every failure into
  the unified ledger from day one instead of splitting across two.

Two notes for stage 4: `DROP TABLE` frees pages but the 5.8 GB **file will not
shrink** — that is fine, do **not** `VACUUM` (it rewrites the whole DB). And the
daily `backupDb.sh` launchd job is safe alongside the grind (COW clone, verified
with 3 crawlers live per AGENTS.md).

### What is safe to run *while* the grind is running

- `./runUnitTests.sh` — fully isolated; the CLI smoke spawns against a throwaway
  DB (`cliSmoke.integration.ts:25`), and vitest uses temp DBs.
- Read-only reports: `field-coverage`, `author-top-stats`, `book-page-gaps`,
  `*.sh` histogram commands, the `sqlite3` verification queries.

### What is NOT safe while the grind is running

- `./runIntegrationTests.sh` — live Goodreads requests + DB writes; that is a
  second crawler and a second throttle source.
- `author-mint --apply`, the §4 strike migration, `import-data`, `author-rekey`
  — all writer transactions.
- Any other heavy crawler (`bookSweep`, `gap-genre`, `tag-recent-monitor`,
  `list-tag-walk`, `popular-by-date`, …). One writer at a time.

---

### B1b — `loadAuthorBookStats` blinded `--sortBy topRatings` to 0.16% of the grind *(FIXED 2026/10/03, stage 2)*

The most damaging bug found, and the reason the §5 grind reported "Done" after
~600 authors while 236k were untouched.

`loadAuthorBookStats` gated its **whole** aggregation on a parseable publication
year:

```sql
MAX(CASE WHEN (published GLOB '[0-9][0-9][0-9][0-9]*' AND … AND ratings >= @minRatings) THEN ratings END)
```

But `published` is the literal string **`'Unknown'`** for **8,780,422 of
11,578,563 books (75.8%)**. So any author whose books were all `'Unknown'`
produced **no stats row at all**, and `selectMultiPageAuthors` drops book-based-sort
authors with no stats row (`authorRescan.ts`: `if (bookBased && !stats) return false`).

Measured on live data, before the fix:

| | |
|---|---|
| never-crawled authors (`catalog_pages IS NULL`) | 236,804 |
| …with **no** qualifying book row → invisible to `--sortBy topRatings` | **236,411 (99.84%)** |
| …actually reachable by the grind | **~393** |

That matches the observed behaviour exactly: `--limit 500000` returned 205
candidates, then 53 on the next run, then "No authors match".

**Fix applied:** only `newest` is a year, so only `newest` takes the year range.
`top`/`books` now use `ratings >= @minRatings` alone — unless `--minBookYear N`
is set, in which case all three narrow (that flag's documented job). Measured
after the fix: **234,573 of 236,803** never-crawled authors are reachable
(597× more). The remaining 2,230 have no book rows at all, which is correct to
exclude from a book-popularity sort.

Regression tests: `src/authorBookStats.test.ts` (6 cases, temp DB, covers
`'Unknown'`, BCE years above the ceiling, and `--minBookYear`/`--minRatings`).

**Lesson for any other "order by something in the books table" path:** a filter
that exists to tame one sort key must not silently gate the others. `ratings` is
dense; `published` is 24% dense.

---

## Verified 2026/10/03 — §2 `author-mint` and the dead-page retirement

`author-mint` (`src/authorMint.ts`, `./authorMint.sh`, `npm run author-mint`) proved
out on a rehearsal copy of the live DB:

| | |
|---|---|
| unhosted book author ids found | **371,132** |
| minted, offline | **371,132 in 45.4s** |
| unhosted remaining | **0** (re-run mints 0 — idempotent) |
| never-crawled queue before | 237,571 |
| never-crawled queue after | **607,457** |
| minted rows with `slug IS NULL` | 371,132 (by design — first scrape fills it) |

The same rows via `author-orphans --scrape` is ~2s/author ≈ **8.2 days**. Offline mint
is ~15,000× cheaper, and unlike the orphan sweep it keys on **id**, so it has no
name-collision hole.

Two composition facts worth keeping straight, since they look contradictory:

- **371,132** — book-referenced ids with *no* `authors` row. Invisible to
  `author-rescan`, which iterates the authors cache. This is what the mint fixes.
- **607,457** — authors that now have a row and still need their catalog scraped.

`authors` after mint ≈ 943,600 rather than exactly the 941,350 distinct book
`author_id`s, because 2,241 rows are real authors discovered via author pages that
currently have no book attributed. Those stay.

Only **30,782 of 371,132 (8.3%)** had a usable book author string; the other 91.7%
are Goodreads multi-author run-together strings (`"Terrie SmithMichele Light"`),
`"Unknown"`, or nothing. Those mint with `name = NULL` rather than storing a
fabricated display name — the first author-page scrape writes the canonical one.

### Dead author pages: a permanent failure that still burns a strike (REVERTED the `page_gone` retirement)

A 404/410/400 author page counts as a **permanent failure** and burns a strike like
any other 4xx. After `AUTHOR_FAIL_LIMIT` runs the author is filtered out of the
crawl queue for good, so a dead id costs three requests total and then disappears
from reports. `isPermanentAuthorPageFailure` is `4xx && !== 429`; 202/5xx/timeouts
stay transient.

**Do not reintroduce a retirement flag.** An earlier attempt added
`authors.page_gone` + `AUTHOR_PAGE_GONE`, where each sweep retired the id and
recorded *no strike*. That removed the only mechanism making progress — nothing was
ever filtered out, so on 2026/10/03 `--sortBy topRatings` queued 235,645 authors,
the first ~80 were one-book misattributed ids that 404'd, and the queue did not
shrink between runs (235,645 → 235,820). The lesson: "this id is bad forever" is
only actionable if it removes the author from the queue. A flag that is written
but never filters anything just makes the run louder and the queue permanent.

Why dead ids dominate the head of the queue: they come overwhelmingly from
`books.author_id` values naming a book-page *contributor* credit (translator /
editor / "Reteller") or a bad id attached to a mega-popular book. They all have
`books = 1`, so `--sortBy topRatings` sorts them **first**. The real fix for that
is repairing `books.author_id` against canonical authors already in the DB (e.g.
`Stockett Kathryn` id `18212882` is a duplicate row for `The Help`, whose canonical
author `Kathryn Stockett` is id `1943477` with 30 books), not suppressing the
symptom. Note also that 403 is classed permanent again: it is an anti-bot class per
the running notes, so a throttled author can burn strikes — pre-existing behavior,
kept as-is rather than reworked mid-revert.

### URLs are id-only; the slug never leaves the database

`authorScrapeRef()` now returns the **id** unconditionally. Goodreads resolves the
slug itself — `/author/list/<id>` 301-redirects to `/author/list/<id>.<Slug>` and
**preserves `?page=` and `?sort=`** (verified live), so stored slugs add nothing but
a way to fail. All six failure log lines are now keyed on
`authorId=<id> (name)` via `describeAuthorId()`, because the name is often a
book-page artifact (`"Last, First"`, `"(Editor)"`, co-author run-together) and is not
a key — ~8,071 name families map to 2+ ids. Measured across all 572,107 rows: **0**
have a slug prefix that disagrees with their id, and 0 have a NULL slug, so the old
slug-then-strip path never mis-fetched; it only made logs unreadable.

---

## Blockers that must be fixed before the grind

Found while planning. B1 and B2 make the Goal B commands **silently useless**, and
B1 only activates *because* of Phase 1 — so fix it before minting.

### B1 — `author-rescan` sends `slug`, which is NULL on every mint row
`authorRescan.ts:306` calls `scrapeAuthorStats(snapshotEntry.slug, …)`.
`extractAuthorId` (`scraper.ts:1414-1417`) turns `null` into `''` and then returns
the original `null`, so the URL becomes `https://www.goodreads.com/author/list/null`
— a guaranteed 404, five strikes, then permanently skipped at
`AUTHOR_FAIL_LIMIT=5`. Latent today (**0** null slugs) and activated by §2, which
mints with `slug NULL` exactly as `PLAN-author-id-first.md` Phase 1 specifies.
The other sweeps are fine: `authorOrphans.ts:246` passes the id.

Fix: pass `snapshotEntry.slug || id`, and make `buildAuthorListUrl` fall back to
`?` — no, just the one call site plus a guard in `extractAuthorId` that rejects a
non-numeric ref. Also log `slug ?? '(none)'` at `authorRescan.ts:303` so a NULL
slug is visible rather than printing `(null)`.

### B2 — `--rescanMissing` ignores `--limit` and does no sorting
`authorRescan.ts:167-169` maps every statless author with `value: 0` and applies
neither `.sort()` nor `.slice(limit)` — so `--rescanMissing --limit 100` scrapes
all 222,450 in arbitrary insertion order, despite the header printing
"limit 100". Fix: route it through `selectMultiPageAuthors` with
`sortBy: 'topRatings'` + `loadAuthorBookStats()` so it slices and orders by book
popularity like the `--multiPage` path.

### B3 — two failure ledgers, two thresholds
- `authors.fail_count`, limit **5** (`storage.ts:68`), written by
  `authorRescan/TopBooks/Recent/One` **and** `authorOrphans`.
- `author_scrape_failures.fail_count`, limit **3** (`storage.ts:849`), written by
  `scraper.ts` and `authorOrphans`.
- `authorOrphans.ts:252-253` records a strike in **both** for one event.
- `fieldCoverage.ts:174-186` hardcodes 5 and 3 instead of importing the constants.

### B4 — the Goodreads token refresh path is broken
`loadGoodreadsToken.sh:79-82` writes the cookie to `config.json` only. Runtime
reads it from the DB `config` table (`storage.ts:1123-1127`). So a token refresh
never reaches the app. Only the disabled `migrateToSqlite.ts:158` ever wrote it.

### B5 — one name-keyed write path survives
`browserBookScrape.ts:337` calls `upsertAuthor(authorName, …)`, which resolves
identity via `getAuthor(name)` (`storage.ts:777-782`). With a name→2+ids
collision family that can pick the wrong row and merge stats onto it.

### B6 — `author-orphans` skips by name *before* by id
`authorOrphans.ts:109-112` drops a book whose `author` string matches any
`authors.name`, so a collision family's secondary id is masked by the primary and
appears in neither sweep. Correct order is id first, name only as a fallback for
rows that have no id.

---

## Work items

### 1. Commit the Phase-0 work (do this first — nothing else is safe to build on)

The whole re-key is uncommitted. Also clean up the scratch files.

```bash
# 1a. unit gate BEFORE committing (tsc + vitest coverage + offline CLI smoke)
./runUnitTests.sh 2>&1 | tee /tmp/unit.out

# 1b. stage ONLY the re-key work; leave the scratch .tmp.* files out
rm -f *.tmp.cjs *.tmp.mjs lifestats_probe.mjs phase0-browser-spike.mjs smoke_scrape.mjs
git add src/ PLAN-author-id-first.md PLAN-author-completion.md authorRekey.sh package.json
git status --short          # confirm no *.tmp.* or scratch files staged
git commit -m "feat: authors re-keyed to id PK + author_slugs ledger; author-rekey command"

# 1c. verify the re-key is still intact afterwards (fast, no network)
sqlite3 goodreads.db "SELECT COUNT(*) FROM (SELECT id FROM authors GROUP BY id HAVING COUNT(*)>1);"   # 0
sqlite3 goodreads.db "SELECT COUNT(*) FROM authors;"                                                  # 570,679
sqlite3 goodreads.db "SELECT COUNT(*) FROM author_slugs;"                                            # 570,682
```

Done when: `git status` is clean of re-key files, the three queries return
`0 / 570,679 / 570,682`, and `/tmp/unit.out` ends with all three gates green.

---

### 2. Goal A — `author-mint` (offline backfill-mint, Phase 1)

Adds a one-shot, no-network command that inserts an `authors` row for every
distinct `books.author_id` that has none: `{id, name (from the book's author
string), slug NULL}`. Idempotent single-statement upserts, O(1) memory via
`iterateBooks()` (never `loadBookCache()`).

Implementation notes:
- New `src/authorMint.ts`: `runAuthorMint()` + `selectUnhostedAuthorIds()`.
  Stream `iterateBooks()`, skip `author_id` NULL/empty and `'Unknown Author'`,
  and for each id not in a sparse `Set` of already-hosted ids emit one upsert.
  To stay O(1) memory, keep the hosted-id set bounded: batch by streaming the
  books table twice — once to collect candidate ids for a slice, once to write.
  Simplest correct shape: `INSERT INTO authors (id, name, slug, last_seen, first_seen)
  SELECT ...` is **not** available (name comes from the row, so group by id and take
  one name), so do it in JS over `iterateBooks()` with a `Set` of ids seen in this
  run plus one `getAuthorById` per new id — a sparse per-entity cache, the
  documented pattern.
- Do **not** create an `author_slugs` row on mint (there is no slug yet); the
  ledger row is written by the first successful scrape.
- Register the command in `src/index.ts` (`.command('author-mint')`,
  `--dryRun` default / `--apply`), add the npm script + `authorMint.sh` wrapper.
- Add the Goal A count to `field-coverage` so the number is first-class
  (`authors.hosted_by_books` / `authors.unhosted_book_ids`) rather than a
  hand-written query.

First, make the anti-join fast. `books` has **no index on `author_id`** (only
`idx_books_author` on the *name*), so every coverage query is a full 11.5M-row
scan (~3 min). 78 GiB free, so the index is cheap:

```bash
# 2a. add the index (one-off, ~1-2 min on 11.5M rows)
sqlite3 goodreads.db "CREATE INDEX IF NOT EXISTS idx_books_author_id ON books(author_id);"
sqlite3 goodreads.db "ANALYZE books;"

# 2b. Goal A backlog, before and after (now instant)
sqlite3 goodreads.db "SELECT COUNT(*) FROM (SELECT DISTINCT b.author_id FROM books b
  WHERE b.author_id IS NOT NULL AND b.author_id <> ''
    AND NOT EXISTS (SELECT 1 FROM authors a WHERE a.id = b.author_id));"
```

Then the mint itself:

```bash
# 2c. dry run — prints how many ids would be inserted, writes nothing
npm run author-mint -- --dryRun 2>&1 | tee /tmp/mint-dry.out

# 2d. apply
npm run author-mint -- --apply 2>&1 | tee /tmp/mint.out

# 2e. prove it
sqlite3 goodreads.db "SELECT COUNT(*) FROM authors;"                                    # 941,942
sqlite3 goodreads.db "SELECT COUNT(*) FROM (SELECT DISTINCT b.author_id FROM books b
  WHERE b.author_id IS NOT NULL AND b.author_id <> ''
    AND NOT EXISTS (SELECT 1 FROM authors a WHERE a.id = b.author_id));"                 # 0
sqlite3 goodreads.db "SELECT COUNT(*) FROM authors WHERE slug IS NULL;"                  # 371,263
```

Done when: `unhosted_book_ids` is **0** and `authors` is **941,942**
(570,679 + 371,263; that is 939,900 book-referenced ids + the 2,042 rows whose
ids appear in no book). Expect ~371k rows with `slug IS NULL` — that is correct
and is exactly what B1 and §5 handle.

---

### 3. Fix B1 + B2 (blockers for the grind)

Do this **before** §4, otherwise the mint rows all burn five strikes each and are
skipped forever.

```bash
# 3a. unit gate
./runUnitTests.sh 2>&1 | tee /tmp/unit.out

# 3b. prove B2 is fixed without touching the network: --limit must bound the
#     candidate count, and the order must be by top-book ratings
GOODREADS_DB_PATH=/tmp/gr-rehearsal.db npm run author-rescan -- --rescanMissing --limit 5 --sortBy topRatings 2>&1 | tee /tmp/rescanmiss.out
grep -E "authors to scrape" /tmp/rescanmiss.out     # must say 5, never 222,450
```

Add unit tests for both: `authorRescan.test.ts` (a) `--rescanMissing --limit N`
returns at most N, ordered by descending top-book ratings; (b) an entry with
`slug: null` yields `scrapeAuthorStats` the **id**, not `null`
(assert on a stub/spy, no network).

Done when: `/tmp/rescanmiss.out` reports 5 candidates and the new tests pass.

---

### 4. Unify the failure ledger (B3)

One id-keyed ledger, one threshold, written once per failure on every path.
Decision 1 in `PLAN-author-id-first.md` was never made; **recommend limit 5**
(softer — a 404 id retried a few times over weeks costs nothing, and the softer
number avoids permanently discarding an author on a transient Goodreads blip).

- Keep `author_scrape_failures` (id-keyed, already the `scraper.ts` path); delete
  `authors.fail_count` / `authors.last_error` columns and
  `recordAuthorFailureById`, and point `recordAuthorFailure(name)` (dead code) at
  the id ledger or delete it.
- `AUTHOR_FAIL_LIMIT` becomes the single constant (`storage.ts:68`); delete
  `AUTHOR_SCRAPE_FAIL_LIMIT` (`:849`).
- `authorOrphans.ts:252-253`: delete the `recordAuthorFailureById` line.
- `authorRescan.ts:255,268,314`, `authorTopBooks.ts:85,101`,
  `authorRecent.ts:118,131,162`: read `loadAuthorScrapeFailure(id)?.failCount`
  instead of `entry.failCount`.
- `fieldCoverage.ts:174-186`: import the constants instead of hardcoding 5 / 3.
- Migrate the existing strikes: `UPDATE author_scrape_failures SET fail_count =
  MAX(fail_count, …)` from `authors.fail_count` so nobody loses their history.
  One statement, run inside the `author-rekey`-style frozen window or as a plain
  `db.transaction` (no crawler running).

```bash
# 4a. unit gate
./runUnitTests.sh 2>&1 | tee /tmp/unit.out

# 4b. migration — run with crawlers stopped
sqlite3 goodreads.db "SELECT COUNT(*) FROM author_scrape_failures;"   # before
sqlite3 goodreads.db "PRAGMA wal_checkpoint(TRUNCATE);"
#   (apply the max() merge, then:)
sqlite3 goodreads.db "SELECT COUNT(*) FROM authors;"                   # columns now dropped

# 4c. integration pass before resuming crawlers
./runIntegrationTests.sh 2>&1 | tee /tmp/integration.out
```

Done when: `PRAGMA table_info(authors)` has no `fail_count`/`last_error`, one
`AUTHOR_FAIL_LIMIT` constant remains, all five call sites read the id ledger,
and the integration suite is green (or shows only the known-flaky
`/book/show` `browser-book-scrape` 202 — see AGENTS.md).

#### DONE 2026/10/03 — and one correction that mattered

Applied to the live DB: `./authorLedgerMigrate.sh --apply`. `authors` is now
`id, name, slug, last_seen, average_rating, num_ratings, num_reviews,
num_shelves, first_seen, catalog_pages, ratings_rate`; `integrity_check: ok`.

**The merge must happen, and the candidate filter must read both ledgers until it
does.** Discarding the legacy counts — or filtering on the ledger while
`authors.fail_count` still exists — re-admits every author the old counter had
already retired. The ledgers barely overlap (569 ids legacy-only, 721
ledger-only); 519 never-crawled authors were re-admitted and the
`--sortBy topRatings` queue grew instead of shrinking. That is the whole reason a
"harmless looking" swap of the filter source is dangerous here: both tables look
like small ledgers, and neither is a superset of the other.

Current state: ledger 877 -> **1,403** rows (+526 merged by MAX), **520** authors
at/over the 5-strike threshold. `loadStrikeMap()` still unions the legacy column
if present, which is now a no-op on this DB (column dropped) but remains the
safety net for any older copy or a partially-migrated DB.

### 5. Goal B — first-pass back-catalog grind (the long one)

**This is the command you asked for.** One pass, anonymous, `caffeinate`d — a
12-day single-threaded crawl *will* otherwise be slept by the machine.

```bash
# ---- the whole grind: every author never crawled, in book-popularity order ----
# Covers the 204,343 with catalog_pages NULL — which is now every one of the
# 371,263 rows minted in §2. Crawls each author's WHOLE back catalog (all pages),
# not just page 1. Re-run the identical command until it reports
# "No authors match the criteria" — each run resumes where the last stopped,
# because a crawled author now has catalog_pages set.
caffeinate -is ./authorRescan.sh --multiPage --onlyUntouched --sortBy topRatings --minRatings 0 --limit 2000 2>&1 | tee /tmp/rescan1.out

# ---- the 18,208 statless authors that HAVE a catalog_pages value ----
# --onlyUntouched skips these (their catalog_pages is set). Re-grind them by
# stats recency instead: --minAge 1 skips nothing without a last_seen, and
# --sortBy topRatings puts the most-read first.
caffeinate -is ./authorRescan.sh --multiPage --sortBy topRatings --minRatings 0 --minAge 1 --limit 2000 2>&1 | tee /tmp/rescan2.out
```

Keep re-running each command. To grind unattended overnight, loop it:

```bash
# unattended loop: pass 1 until it comes up empty, 2000 authors per invocation
while caffeinate -is ./authorRescan.sh --multiPage --onlyUntouched --sortBy topRatings \
      --minRatings 0 --limit 2000 2>&1 | tee -a /tmp/rescan1.log \
      | grep -q "No authors match"; do
  echo "pass 1 slice done at $(date)"
done
```

**Do NOT also run `author-orphans --scrape`.** It is fully subsumed. Two
independent reasons:

1. `syncAuthorsToCache` (`storage.ts:1017-1067`) already mints an `authors` row by
   id for any new book, and it is called from `monitor.ts`, `harvestList.ts`,
   `newTagWalker.ts`, `bestOfYear.ts` — so crawl-discovered ids are hosted
   automatically, with a real `authorSlug` rather than a synthesized one.
2. After §2's mint every book-referenced id is hosted, so the orphan query's
   id-skip (`authorOrphans.ts:112`) matches every book that has an id and the
   candidate list goes to ~0.

`author-orphans` survives only as a **read-only drift check** —
`npm run author-orphans -- --inspect --limit 20` should print ~0 new orphans; a
healthy list means the mint is stale. Never `--scrape` it again. This also
**deprioritizes §6/B6** (orphans checking id before name): the id check already
catches everything post-mint, so that fix is cosmetic rather than load-bearing.

Verify Goal B:

```bash
npm run field-coverage 2>&1 | tee /tmp/fieldcov.out
#   authors.catalog_pages coverage should climb toward authors.total
sqlite3 goodreads.db "SELECT COUNT(*) FROM authors WHERE catalog_pages IS NULL;"   # → 0
sqlite3 goodreads.db "SELECT COUNT(*) FROM authors WHERE COALESCE(num_ratings,0)=0;"  # stragglers
sqlite3 goodreads.db "SELECT COUNT(*) FROM author_scrape_failures WHERE fail_count >= 5;"  # hard 404s, never retry
```

**Realistic runtime: ~12 days continuous.** At anonymous pacing (1.0–1.8 s between
authors, 0.9–1.7 s between catalog pages, plus ~1 s per request), the remaining
236,462 uncrawled authors at an expected ~1.3 pages each is roughly
236,462 × ~4.4 s ≈ 12 days single-threaded. It cannot be parallelised: SQLite
locks are database-wide (one writer) and Goodreads throttles aggressively. Run it
in slices like the loop above so a throttling event costs you one slice, not the
week.

**Do not shrink the pacing.** If Goodreads starts serving 202/403/429, that is
throttling — stop, wait ~60 s+, and re-run the same slice. Do not add retry loops
(AGENTS.md).

Done when: `catalog_pages IS NULL` is 0 and `chronic_failures` (ids at the fail
limit, almost all genuine dead 404 ids) has stopped growing.

---

### 6. Fix the remaining name-keyed paths (B5, B6)

- **B5**: `browserBookScrape.ts:337` — swap `upsertAuthor(authorName, …)` for
  `upsertAuthorById(authorId, {id: authorId, name: authorName, slug, …})`. Then
  delete `upsertAuthor`, `getAuthor(name)`, `findAuthorBySlug`, and
  `recordAuthorFailure(name)` — all now dead. Drop the corresponding
  `storage.test.ts` cases and replace with id-keyed equivalents.
- **B6**: `authorOrphans.ts:103-118` — check `book.authorId` against
  `knownByAuthorId` **first**; only fall back to the name/normalized-name skip for
  books with no id. That unmasks the collision families' secondary ids, which then
  become normal mint candidates (§2) / rescan candidates (§5).
- After §2 the orphan sweep's remaining job is only *new* discoveries (books that
  arrive after the mint), so it should be near-empty. Confirm and then narrow its
  role: keep `--inspect` + `--includeConcat`, and let `author-rescan` own the grind.

```bash
./runUnitTests.sh 2>&1 | tee /tmp/unit.out
./authorOrphans.sh --inspect --limit 20 2>&1 | tee /tmp/orphans-inspect.out
```

Done when: `grep -c findAuthorBySlug src/*.ts` finds only the test file (or
nothing at all), and no `upsertAuthor(` remains in `src/`.

---

### 7. Phase 4 — JSON exit

- **B4 (the real bug)**: make `loadGoodreadsToken.sh` also upsert the DB
  `config.cookie` in the same run (single statement, no network — WAL-safe).
  Keep `config.json` as the user-editable source of truth, per decision 5.
- Add a `set-cookie` CLI command as the script-free path.
- Reword the ~25 surviving `booksCache.json` / `authorsCache.json` / `state.json`
  mentions (all cosmetic — they are CLI descriptions, log strings, README lines;
  no runtime reads remain). List is in the audit: `index.ts:496,1290,1306,1531`,
  `addBook.ts:420`, `backfillPages.ts:20,22,27`, `backfillSeriesPos.ts:40`,
  `harvestList.ts:30`, `monitorYearlyHighlyRatedLists.ts:103`,
  `integration/goodreads.integration.ts:55,154,192,237`,
  `runIntegrationTests.sh:10`, `backfillPages.sh:4`, `README.md` (11, 104, 199,
  227, 233, 239, 245, 251, 306, 349, 350, 351), plus `migrateToSqlite.ts`
  (delete the file outright).
- Delete `src/migrateToSqlite.ts` (its command is already unregistered).
- **Decision 2 (`libraryExportCache.json`) is still open.** It is the last live
  JSON read, at `libraryExport.ts:13,304` with six callers (`library.ts:171`,
  `books.ts:258`, `commonUnreviewedMonitoredBooks.ts:24`,
  `tagFirstPagePicks.ts:134`, `backfillPages.ts:10`,
  `integration/goodreads.integration.ts:228`). Recommendation is option (a): a
  `library_entries` table. Do it as its own item, not inside this one.

```bash
./runUnitTests.sh 2>&1 | tee /tmp/unit.out
./runIntegrationTests.sh 2>&1 | tee /tmp/integration.out

# token path — prove the refresh actually reaches the DB
./loadGoodreadsToken.sh
sqlite3 goodreads.db "SELECT length(value) FROM config WHERE key='cookie';"   # non-zero

# no runtime JSON reads left
grep -rn "booksCache.json\|authorsCache.json\|state.json" src/ | grep -v migrateToSqlite
```

Done when: the grep returns nothing, the cookie length is non-zero after a token
refresh, and both suites are green.

---

### 8. Test-coverage gaps found in the audit

Not blockers, but the Phase-0 plan asked for these and they were never written.
Add alongside whichever phase you are already touching:

| Missing | Where |
|---|---|
| `upsertAuthorSlug` / `loadAuthorSlugs` behavior — `first_seen` on insert, `last_seen` advances, one row per `(id, slug)` | `storage.test.ts` (neither symbol is imported today) |
| `getAuthorById` / `upsertAuthorById` directly, incl. `ON CONFLICT(id)` merge | `storage.test.ts` |
| `recordAuthorFailureById` (only the *other* ledger is tested, at `storage.test.ts:474-509`) | `storage.test.ts` |
| `exportData` actually emitting `author_slugs` (it is in `EXPORT_TABLES` but the emission test asserts 9 tables and never it) | `exportData.test.ts:68-110` |
| the name-PK startup guard throwing | `db.test.ts` (builds a `name TEXT PRIMARY KEY` table and asserts `getDb()` throws) |

```bash
./runUnitTests.sh 2>&1 | tee /tmp/unit.out
```

---

### 9. Retire `authors_old_20261003` (Phase 0 step 6, gated)

`authors_old_20261003` is the rollback for the re-key. Per the Phase-0 post-steps
it is dropped **only** after all of: unit gate green, integration pass green,
export/import round-trip verified, **and** the code committed (§1) with crawlers
resumed and one scrape cycle confirmed writing `authors` by id +
`author_slugs`. §1 through §5 satisfy those; run the checklist explicitly:

```bash
# 9a. all three unit gates
./runUnitTests.sh 2>&1 | tee /tmp/unit.out

# 9b. integration pass
./runIntegrationTests.sh 2>&1 | tee /tmp/integration.out

# 9c. export/import round-trip on a scratch copy
GOODREADS_DB_PATH=/tmp/gr-export.db ./exportData.sh /tmp/gr-export
GOODREADS_DB_PATH=/tmp/gr-import.db ./importData.sh /tmp/gr-export
sqlite3 /tmp/gr-import.db "SELECT COUNT(*) FROM authors;"
sqlite3 /tmp/gr-import.db "SELECT COUNT(*) FROM author_slugs;"

# 9d. only after 9a-9c are green AND §1 is committed AND a crawl has run since:
sqlite3 goodreads.db "DROP TABLE IF EXISTS authors_old_20261003;"
sqlite3 goodreads.db "SELECT name FROM sqlite_master WHERE name LIKE 'authors%';"
```

Rollback until 9d: `DROP TABLE authors; ALTER TABLE authors_old_20261003 RENAME
TO authors;` (or restore the manual pre-rekey copy).

Done when: `SELECT name FROM sqlite_master WHERE name LIKE 'authors%'` returns
only `authors`.

---

### 10. Cross-id same-human canonicalization (decisions 6, 7, 8)

Still entirely open — there is no `author_aliases` table. This was scoped as
*orthogonal to the re-key* and correctly deferred, but it is the last substantive
gap: Goodreads keeps distinct ids for the same human (624 name-normalized groups
held ≥2 ids sharing a book title and/or `work_id`; 123 share a `work_id`; 1,209
untouched-rescan candidates are dup profiles of an already-scraped sibling, so the
§5 grind will double-crawl them).

Do **not** start this until §5 has finished — the duplicate-crawl count will keep
climbing during the grind, and the canonical pick depends on `is_work_rep`
ownership from edition-clustering, which is still landing.

Plan sketch (write it in full when you pick it up):
1. `author_aliases(author_id, canonical_id, kind, evidence, verified_at)`, built
   **offline** by the same `iterateBooks` sweep that owns `is_work_rep`; never
   written during a crawl. Canonical = rep owner of the shared work; 115 of 123
   work-sharing groups resolve to a single owner, 8 need the tie-break
   (majority rep ownership → higher total ratings → cleaner name).
2. Writer-side `author_id → canonical_id` resolution at upsert time so scraped
   stats land on the canonical row and §5's loop skips alias ids outright.
3. Optional hard merge of `books.author_id` + `popular_by_date_book` variants,
   `db.transaction`, crawlers-stopped window, user sign-off only.

No commands yet — this is a planning item.

---

## Note on your `author_slugs` question

> *the slug table would have at least two rows — the old slug and the new slug*

**True in principle, but in practice almost never.** Live: 570,682 rows across
570,679 ids — only **3** ids have more than one.

The reason is that orphans are minted with `slug = NULL`, so there is no "old
slug" to preserve; the first successful scrape writes exactly one row and there is
nothing to pair it with. Multiple rows only appear when Goodreads genuinely
serves a different slug for an id the row already had — the 2 pre-existing cases
(`52191614`, `9013570`) plus 1 real rename found since (`10270319`).

One subtlety worth knowing: `author_slugs.name` is written with
`COALESCE(excluded.name, author_slugs.name)` (`storage.ts:1029`), so it keeps the
**first** display name ever seen with that slug and does not follow a rename.
That is intentional (it is rename history), and it is why nothing reads that
column for identity — `author_slugs` is history/audit only.

---

## Decision log (new items needing your call)

1. **Unified failure threshold** — recommend **5** (see §4). Keeps 3 or 5?
2. **`libraryExportCache.json`** — port to a `library_entries` DB table
   (recommended) or keep as the one documented user-import exception? (§7)
3. **Cross-id same-human policy** — merge language/edition profiles
   (`鮑伯．戈夫` Bob Goff, slug-leak profiles) into the canonical id, or alias for
   lookup only? (§10)
4. **`author-orphans`'s name** — keep it narrowed to discovery/inspection, or fold
   it into `author-rescan` + a dedicated `author-missing-ids` review command?
5. **The ~184 id-less books** — throttled name→id search scrape, or a curated
   alias table? (unchanged from the original plan, decision 3)

---

## Constraints (carried forward)

- No `loadBookCache()` — stream with `iterateBooks()`.
- Crawler writes = single-statement upserts; no `db.transaction` during crawls.
- Keep Goodreads polite; do not add retry loops on 202/403/429.
- One heavy crawler at a time (database-wide writer lock).
- Gates after each phase: `./runUnitTests.sh 2>&1 | tee /tmp/unit.out`, then a
  deliberate integration pass before/after risky scraper changes.
- Add a `GOODREADS_CHANGES.md` entry if verifying surfaces any page-behavior shift.