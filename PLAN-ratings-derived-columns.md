# PLAN: book_page ratings-derived columns

Status: approved (2026-10-16). This file is the source of truth for the feature;
it survives session restarts.

## Original ask

Extend a `book_page` table with scalar summaries of the stored ratings
histogram (`ratings_dist`), so the distribution can be sorted/filtered without
JSON parsing:

> when we get the ratings_dist column, I want to fill in dependent columns -
> mean, median, variance, standard deviation, skewness and kurtosis. so whenever
> we get a new ratings_dist we would recalculate those columns. I want to have a
> backfill script that I would run (not the ai).

Plus:
- `./books.sh --sort editionCount --limit 10 --dedupe --minRatings 1000` should
  be able to take advantage of the new columns the same way it does editions.
- unit tests; indexes as needed.

## The 8 columns (all on `book_page`, derived from `ratings_dist`)

| Column | Type | Meaning | Notes |
|---|---|---|---|
| `ratings_total` | INTEGER | Σ bucket counts | sum of the histogram, NOT `books.ratings` |
| `ratings_mean` | REAL | weighted average star | |
| `ratings_median` | INTEGER | smallest star where cumulative ≥ half | whole-star value |
| `ratings_mode` | INTEGER | star with most ratings | ties → lower star |
| `ratings_variance` | REAL | population variance | |
| `ratings_stddev` | REAL | √variance | |
| `ratings_skewness` | REAL | 3rd standardized moment | NULL when stddev = 0 |
| `ratings_kurtosis` | REAL | EXCESS kurtosis (normal = 0) | NULL when stddev = 0 |

All 8 are NULL when `ratings_dist` is missing/empty/unparseable, so a write
always overwrites stale values with a consistent state.

## Confirmed findings

1. `ratings_dist` is a TEXT column holding JSON `Record<string, number>`
   (bucket → count) from `parsed.ratingsCountDist` (`src/bookPageParse.ts:71,177-183`).
2. Goodreads' advertised `stats.ratingsCount` populates `books.ratings`
   (`src/bookPageParse.ts:174`). It does NOT equal Σ buckets: over 260,387 rows
   with both, 156,492 match and 103,895 differ (103,892 where advertised is
   higher; avg ratio histogram/advertised ≈ 0.9959). `ratings_total` tracks the
   histogram, by design.
3. Write paths storing `ratings_dist`: `src/browserBookScrape.ts` (upsert) and
   `src/importData.ts` (INSERT) — both recompute on change.
4. `editionCount` sort pattern lives in `src/books.ts` (`PAGE_SORTS`,
   `loadPageStats`, `valueOf`, dedupe work aggregation).
5. Backfill pattern: `backfill-series-pos` / `backfill-pages`
   (`src/index.ts` + `src/backfillSeriesPos.ts` / `src/backfillPages.ts`).
6. Unit-test pattern for the editionCount sort: `src/books.test.ts:210-230`.

## Decisions (final, per user)

- **Sort keys:** expose **all 8** derived columns as `./books.sh --sort` keys,
  editionCount-style.
- **`avgRatings`:** unchanged — keeps sorting by the cached `books.avg_rating`
  (Goodreads' displayed average). The new keys are purely additive.
- **Backfill is run by the user**, not the AI.

## Tasks

| # | Task | Status |
|---|---|---|
| 1 | `ALTER TABLE` migration for the 8 `book_page` columns (CREATE TABLE diff exists, migration missing) | done (uncommitted) |
| 2 | pure `ratingsStats` module (mean/median/mode/variance/stddev/skewness/kurtosis/total from `ratings_dist`) + unit tests | done (uncommitted) |
| 3 | wire recompute into the `ratings_dist` write paths (`browserBookScrape` + `importData`) | done (uncommitted) |
| 4 | `backfill-ratings-stats` CLI command (+ npm script + shell wrapper) for the user to run | done (uncommitted) |
| 5 | wire `./books.sh --sort` to all 8 derived columns (editionCount-style) + tests; leave `avgRatings` alone | done (uncommitted) |
| 6 | add indexes as needed; run full unit suite (`./runUnitTests.sh`) green | done — no index needed (JS-side sort over the in-memory `pageStats` map; no SQL `ORDER BY` on the derived columns). Full suite green: 83 files / 1046 tests + 2 CLI smoke, `tsc` clean |
| 7 | run `./backfillRatingsStats.sh` against the live DB to overwrite the wild-session values, then re-run to confirm all-unchanged (idempotent) | done (2026-10-16: run 1 → 237,003 updated / 23,384 unchanged / 45 skipped in 7.6s; run 2 → 0 updated) |
| 8 | confirm write paths recompute on the next live scrape | done — covered offline instead of waiting for a live scrape: `saveBookPage` (the `browserBookScrape` `book_page` upsert) was exported and unit-tested (4 tests: recompute-from-dist, all-NULL when no dist, upsert overwrites stale + clears on missing dist, agrees with `computeRatingsStats`); `importData` write path already covered by its 4 tests. Full suite green: 85 files / 1056 tests + 2 CLI smoke, `tsc` clean. Live end-to-end (2026-10-16): `browserBookScrape.sh --candidate coverage-gap --limit 1` scraped book 14437701 "A Tale of Two Cities" (http 200, 475KB) into a brand-new `book_page` row; all 8 derived columns matched an independent recompute from the stored `ratings_dist` exactly. `ratings_total`=1,037,063 (bucket sum) vs `books.ratings`=1,036,543 — expected. |

## Artifacts (uncommitted, tasks 1–4)

Modified: `src/db.ts`, `src/browserBookScrape.ts`, `src/importData.ts`,
`src/index.ts`, `package.json`, `src/exportData.test.ts`, `src/importData.test.ts`
(tasks 1–4); `src/books.ts`, `src/books.test.ts`, `books.sh` (task 5).
New: `src/ratingsStats.ts`, `src/ratingsStats.test.ts`,
`src/backfillRatingsStats.ts`, `backfillRatingsStats.sh`

Verification done in-session: `tsc --noEmit` clean, 84 files / 1049 unit tests +
2 CLI smoke tests pass; backfill verified against a throwaway DB (empty → 0 rows;
seeded row → all 8 columns correct; re-run → Updated 0 / Unchanged 1).

## Backfill rewrite — no whole-table materialization (2026-10-16)

The first cut did `const rows = [...streamRows(SELECT ... FROM book_page)]` — a
full-table snapshot. That is the same "materialize the table" anti-pattern
AGENTS.md removed with `loadBookCache`. The snapshot existed only to dodge a
real constraint: better-sqlite3 cannot `.run()` while a read iterator on the
same connection is open (`DOES_MUTATE` → `REQUIRE_DATABASE_NO_ITERATORS_UNLESS_UNSAFE`;
`.get()`/`.all()` are allowed, `.run()` throws "This database connection is busy
executing a query"). The sanctioned pattern is keyset-chunked pagination —
documented in code at `authorMint.ts:26-36`: read a chunk with `.all()` (fully
consumes/closes the statement), write it, resume after the last id. The backfill
now does exactly that (`CHUNK = 5000`, `WHERE book_id > ? ORDER BY book_id LIMIT ?`),
peak memory O(CHUNK), and has a test crossing the chunk boundary.

## Finding — `backfillSeriesPos.ts` was latently broken (FIXED 2026-10-16)

`runBackfillSeriesPos` used to do
`for (const snap of iterateBooks()) { ... upsertBook(book); }`. `iterateBooks()`
holds an open better-sqlite3 iterator, and `upsertBook` is a raw `.run()`
(`src/storage.ts:286`) — so the first row that actually needed a change threw
"This database connection is busy executing a query" (verified with a throwaway
test). It only survived when every title already matched its stored `series_pos`
(i.e. it silently no-opped).

Fixed: rewritten to keyset-chunked pagination (`CHUNK = 5000`, `.all()` per page)
with a **targeted** `UPDATE books SET series_pos = ? WHERE id = ?` — no whole-row
`upsertBook`, so concurrent writers to other columns can't be clobbered. Added
`backfillSeriesPos.test.ts` (fill/correct/clear, `CHUNK+1` boundary, idempotency)
which would have caught the old throw. Also dropped the stale "Cache saved to
booksCache.json" line. AGENTS.md gained a rule so neither this nor the
table-materialization pattern reappears.

Live run (2026-10-16, 3m 8s, 13,264,888 books): **Filled 1,293,353** /
Corrected 0 / Cleared 58. The fills are the sparse rows written by
list/shelf/tag walks + `authorMint` (they never pass through the `upsertBook`
seriesPos logic, so stayed NULL); Corrected 0 means no stored value disagreed
with a fresh parse; the 58 Cleared exercise the NULL-write branch. Idempotency
covered by the unit test (a live second run would be another ~3 min).

Task-5 note: the 8 sort keys read `book_page` directly. `--dedupe` applies
exactly as it does for every other sort key (the collapse is sort-independent):
one row per work, English edition preferred, falling back to `is_work_rep` when
no English sibling is known. The **only** editionCount-specific extra is the
per-work `MAX(editions_count)` aggregation (`loadWorkEditions`); the ratings
stats are per-edition, so the surviving edition shows its own values (no
across-edition aggregation). Missing distributions (`NULL`) do **not** sort as
0 — books lacking the sorted stat are excluded from the match set (both
directions), because a missing stat is unknown, not zero; see the perf/fix note
below. Verified live: `./books.sh --sort ratingsMean
--limit 10 --dedupe --minRatings 1000` yields one row per work, English
preferred. Write-path tests added: `importData.test.ts` (insert recompute,
all-null without dist, `scraped_at` fallback, skip-newer guard) and
`books.test.ts` (sort by `ratingsMean`/`ratingsStddev`, null→0, total
formatting, dedupe keeps the English edition). `browserBookScrape`'s
INSERT/DO-UPDATE-SET is now covered: `saveBookPage` was exported and
`browserBookScrape.test.ts` gained 4 tests (recompute-from-dist, all-NULL when
no dist, upsert overwrites stale + clears on missing dist, agrees with
`computeRatingsStats`). Verified live end-to-end too (a real coverage-gap scrape
wrote a new `book_page` row whose 8 columns matched an independent recompute).

## Data-integrity note — the live DB is dirty

On 2026-10-16 ~15:48–16:23 PDT a runaway session (`ses_eb919476`) mutated the
live `goodreads.db` **out of band** via ad-hoc `python3`/`sqlite3`:

- ran its own `ALTER TABLE book_page ADD COLUMN ...` directly against the DB;
- ran its own inline `compute()` backfill over ~260k rows;
- made only ONE repo edit (the `CREATE TABLE` hunk in `src/db.ts`), leaving no
  migration code — which is why the follow-on sessions "couldn't find the code"
  (the real change was in the SQLite file, invisible to git).

Its inline formula differs from the finished `ratingsStats.ts`:

- empty distributions were written as zeros (2,292 rows:
  `total=0, mean=0, median=3, mode=1, stddev=0, skewness=0, kurtosis=0`) where
  the code writes NULL;
- 5,373 rows have `stddev=0` with a non-zero total handled differently;
- the ad-hoc script only handled star keys 1–5.

**Resolution:** task 7. `runBackfillRatingsStats` recomputes EVERY row that has
a distribution (it does not skip already-populated rows), so the sanctioned
re-run overwrites the wild values, including the zero-fills → NULL, and is
idempotent on the second run.

### Backfill timing (benchmarked 2026-10-16)

Real `better-sqlite3`, WAL + `synchronous=NORMAL`, same logic as `ratingsStats.ts`,
against a copied `book_page`:

- 260,432 rows → 258,095 updated, 2,337 skipped, in **3.8 s** (~68,500 upd/s).

Expected live runtime: a few seconds to ~15 s (plus startup and the initial
in-memory row snapshot from `[...streamRows(...)]`). Progress is already printed
every 25,000 rows (`PROGRESS_EVERY`): `… scanned N / 260,432 (M updated)` — about
10 lines total, so no tuning is needed. The only silent gap is the opening
snapshot of all rows into memory.

## Perf — `books --sort <derived>` was scanning all 13M books (2026-10-16)

`./books.sh --sort editionCount --limit 10 --dedupe --minRatings 1000` took
**32.3 s**. Root cause: `runBooks` iterated `iterateBooks()` = `SELECT * FROM
books` (13,264,652 rows) and applied the `ratings < minRatings` filter in JS
*after* `rowToBook()` had already `String()`-cast every field and `JSON.parse`d
`genres`/`tags` for each row. The slow path was never the sort (top-K is bounded
at `limit`); it was touching all 13M rows when only the ~507,579 with
`ratings >= 1000` can ever match.

Fix: `iterateBooks(opts?: { minRatings?: number })` pushes `WHERE ratings >= ?`
into SQL when `minRatings > 0`, which seeks `idx_books_ratings`; `runBooks`
passes `{ minRatings }`. (NULL ratings are excluded by the predicate, matching
JS `parseNum(null) = 0 >= min` for any `min > 0`, so semantics are unchanged.)
Result: **32.3 s → 12.1 s**, identical top-10, identical "Total books matching:
452,104". Added 3 `storage.test.ts` cases for the filter.

**Behavior change to flag:** the footer `Deduplicated works:` now counts only
editions excluded *within* the min-ratings universe (55,475) instead of across
the whole table (381,646) — because the dedupe check precedes the ratings check
in the loop. The matched set (hence the top-10) is unchanged; only this counter's
scope changed, and the new scope is arguably the correct one.

Remaining hotspots (~12 s): `loadPageStats` 1.36 s, `loadWorkEditions` 1.28 s,
`loadEnglishWorkKeepers` 0.9 s, and the still-`JSON.parse`-heavy 507k scan
2.4 s (a lean scan that skips the unused `genres`/`tags` parse would save ~1.1 s).
A SQL top-N rewrite is the bigger lever but out of scope here.

## Fix — derived-stat sorts no longer treat "missing" as 0 (2026-10-16)

Reported via `./books.sh --sort ratingsVariance --asc --limit 50 --dedupe
--minRatings 100000`: the asc list was entirely distribution-less books. Cause:
`valueOf` returned `pageStats?.get(id)?.variance ?? 0`, so a missing variance
(= unknown) sorted as 0 and, ascending, ranked FIRST — ahead of every real
low-variance book. (Desc was accidentally fine: 0 lands last.)

Fix: when `sortBy` is one of the 8 derived ratings stats, `runBooks` now skips
any book whose stat is missing (`typeof value !== 'number'`), for BOTH
directions — the match set becomes "books that have this stat". Scope is
deliberately just the 8 derived stats; the older page-sourced sorts
(`editionCount`/`numReviews`/`currentlyReading`/`toRead`) keep their null→0
behavior (user decision). `books.test.ts`: the old "missing = 0" test was
replaced by two (excludes missing under desc; asc no longer surfaces unknowns).

Live after the fix: asc top-5 are real low-variance hits (HP3 var=0.1593,
Light Bringer 0.2546, …); "Total books matching" 35,383 → 3,584 (books with a
variance). `--dedupe` is unaffected (its counter runs before the new filter).

## Out of scope

- Changing `--sort avgRatings` semantics.
- Reconciling `ratings_total` against `books.ratings` (they legitimately differ).
