# PLAN: Author Stats — capture + reader

Status: approved (2026-08-04). This file is the source of truth for the feature; it survives session restarts.

## Original ask

> when scraping an author using a link like https://www.goodreads.com/author/list/19527332.Chanel_Miller
> I'd like to capture overall author statistics - specifically
> Average rating 4.67 · 274,250 ratings · 38,656 reviews · shelved 780,609 times
>
> averageRating, numRatings, numReviews, numShelves
>
> and whenever we need to scrape an author page, these values should be updated
>
> although ratings and reviews should go up - if the new number is not greater or equal to - none of these numbers should be replaced
>
> in addition we should add a new capability to scrape author pages looking at books with most ratings - so the n most (where n might be 10 or 100 or 1000) - but only scrape an author once with this new capability even if the author shows up more than once

Supports maintenance of: https://www.goodreads.com/list/show/232696.100_Authors_with_the_most_ratings

No SQL involved — all data lives in the existing JSON caches (`booksCache.json`, `authorsCache.json`).

## Flow (final, per user)

1. **Book cache → authors:** filter `booksCache.json` by `--minRatings`/`--maxRatings`, sort desc by ratings, take top `n` books, dedupe to a distinct author list.
2. **Read authors:** for each distinct author, fetch `https://www.goodreads.com/author/list/{slug}` **once**, parse only the stats line → `averageRating, numRatings, numReviews, numShelves`.
3. **Update author cache:** apply monotonically (only replace values that haven't decreased), save once.
4. **Report:** `author-top-stats` reads `authorsCache.json` and prints the ranked list.

We do NOT read the author page for book data at all — the top books come from the book cache. The author page is fetched only for the one stats line.

## Part 1 — Capture feature

### Already implemented

| Piece | Where |
|---|---|
| `AuthorCacheEntry` + `averageRating/numRatings/numReviews/numShelves` | `src/storage.ts:43-51` |
| Monotonic update: replace a stat only if ratings & reviews haven't decreased | `src/storage.ts:64-96` `updateAuthorStats` |
| Parse "Average rating 4.67 · 274,250 ratings · 38,656 reviews · shelved 780,609 times" | `src/scraper.ts` `parseAuthorStats` |
| Auto-update author stats on every author page scrape | `src/scraper.ts` `updateAuthorStatsFromPage` (called from `scrapeBookByAuthorPage`) |
| Single-fetch stats reader: fetch author list page once, return the 4 stats | `src/scraper.ts` `scrapeAuthorStats` |
| Pipeline: filter book cache by min/max ratings → sort desc → top n → distinct authors → scrape stats once each → update cache | `src/authorTopBooks.ts:13-` `runAuthorTopBooks` |
| CLI `author-top-books <n>` + `--minRatings/--maxRatings` | `src/index.ts`, `authorTopBooks.sh` |

### Verified
- `npx tsc --noEmit` passes (exit 0).
- `authorsCache.json` (44,809 authors): Chanel Miller already has all 4 stats captured.
- All top-200 books by ratings resolve to an author present in `authorsCache.json` (0 missing).

### Polish (do now)
- `authorTopBooks.ts` skips authors not yet in the author cache (no slug to scrape); harmless today (0 missing in top 200).

## Part 2 — Reader command (separate, generates the Goodreads list)

New `src/authorTopStats.ts` with `runAuthorTopStats(options)`, following `src/summaryTopRated.ts` conventions.

- CLI: `author-top-stats` command in `src/index.ts`, `author-top-stats` npm script in `package.json`, `authorTopStats.sh` wrapper:

```
./authorTopStats.sh --limit 100 --sortBy numRatings --minRatings X --maxRatings Y
```

- `--limit <n>` — number of authors to return (default 100)
- `--sortBy <field>` — `numRatings` (default) | `averageRating` | `numReviews` | `numShelves`
- `--minRatings` / `--maxRatings` — filter authors by ratings count (optional)
- Sorted descending; authors missing the sort field are excluded (count reported).
- Output: numbered list — rank, author name, slug, all four stats.

## Part 3 — Docs & commit

- README section for both `author-top-books` and `author-top-stats`.
- Commit the feature work (currently uncommitted).

## Part 4 — Rescan command (approved 2026-08-06)

Re-scrape the author page for every author matching the reader criteria, refreshing stats in `authorsCache.json`.

- Shared selection: `selectAuthors(authorCache, options)` extracted from `src/authorTopStats.ts` — same filter/sort/top-N logic used by both the reader and the rescan (`--limit`, `--sortBy`, `--minRatings`, `--maxRatings`).
- New `src/authorRescan.ts` `runAuthorRescan(options)`:
  - Select authors via `selectAuthors`, apply `--minAge <days>` (default 0) to skip entries whose `lastSeen` is younger than N days.
  - For each author: `scrapeAuthorStats` → warn-and-continue if no stats line (challenge/rate-limit) → `updateAuthorStats` (monotonic) → `saveAuthorCache` after every author → `delay(2000, 5000)`.
  - Per-author output matches `author-top-books` (current/prev values); end summary reports processed / updated / no-stats / failures / minAge-skipped / duration.
- CLI `author-rescan` + npm script + `authorRescan.sh`. Usage:
  ```
  ./authorRescan.sh --limit 120 --sortBy averageRating --minRatings 100000 --minAge 1
  ```
- Note: a concurrently running `check`/`ingest` process holds the author cache in memory and will overwrite rescan writes with its stale copy when it saves. Don't run `author-rescan` at the same time as monitoring.

## Part 5 — Book cache regex search + regex audit/discovery (2026-08-08)

Regex-based book cache search and regex criteria for list audits/discovery.

- Shared matcher `src/bookMatch.ts`:
  - `RegexCriterion { titleRegex?, authorLastRegex?, authorFirstRegex? }` — patterns are case-insensitive; multiple fields AND together.
  - `matchesRegex(book, criterion)` — title against the raw title; `authorLast`/`authorFirst` are the first and last tokens of the **first** author (author split on `,`, `&`, or ` and `), non-letter chars stripped.
  - `compileRegex`/`splitAuthorNames`/`authorFirstAndLast` helpers.
- New reader `books [pattern]` (`src/books.ts` + `books.sh` + npm script):
  - Positional `[pattern]` = title regex unless `--title`/`--authorLast`/`--authorFirst` given.
  - `--sort` = ratings (default), avgRating, year, title, author. Numeric fields sort desc, text asc by default; `--asc`/`--desc` override. Tie-break by ratings, then title.
  - `--limit` (default 100), `--minRatings`, `--maxRatings`, `--minYear`, `--maxYear`, `--includeBad`. `isBad` books excluded unless `--includeBad`.
  - Invalid regex / invalid sort → clear error, exit 1.
- Regex criteria in audits (`AuditOptions`, `AuditCriteria`):
  - `audit <listId> --titleRegex/--authorLastRegex/--authorFirstRegex` flags books ON the list that don't match → `[REGEX MISMATCH]` outlier.
  - Bulk audit forwards regex fields from `bulkAuditConfig.json` entries automatically.
- Regex in queue-discovery (`src/queueDiscovery.ts`): cached candidates must match the list's regex criteria, so it surfaces matching books not yet on the list.
- Docs: README sections 5b/6.

## Part 6 — Library export integration: `--excludeReviewed` (2026-08-08)

Exclude books the user has already reviewed when searching the book cache.

- New `src/libraryExport.ts`:
  - `loadLibraryExport(exportPath)` — parses a Goodreads library export CSV (BOM-tolerant, quoted commas, Excel `="..."` fields), requires columns `Book Id`, `Title`, `Author`, `Exclusive Shelf`, `Date Read`, `My Review`; throws a clear "format may have changed" error if columns are missing and warns once if `Date Read` values aren't `YYYY/MM/DD`.
  - Reviewed = entry on `read` shelf OR `Date Read` set OR review text nonempty (`isReviewedEntry`).
  - `matchesReviewed(library, bookId, title, author)` — id match first, normalized title+author fallback (same `normalizeTitle`/`normalizeAuthor` as `isSameBook`), "one instance is good enough".
- `books` command: new `--excludeReviewed` + `--export <path>` (`--import <path>` is an alias); `--excludeReviewed` without `--export`/`--import` errors. `--export`/`--import` alone loads + validates the file and reports its stats. Exclusion applies after regex/rating/year filters; footer reports `Excluded (already reviewed): N`.
- Verified live against 20240914 export: `^j` 786 → 717 (69 excluded). Jane Eyre (to-read-popular, no date/review) correctly NOT excluded; The New Jim Crow excluded via title/author fallback across editions. Error paths + date-format warning tested.
- Verified live against fresh 2026-08-08 export (goodreads_library_export.csv): loads cleanly (11,206 entries, 6,773 reviewed, no format warnings); `^j` → 709 (77 excluded).
- Docs: README section 6, `books.sh` usage.

## Part 7 — Cached library import (2026-08-08)

`--excludeReviewed` now defaults to a cached import.

- `loadLibraryExport` saves the parsed export to `libraryExportCache.json` (gitignored); `saveLibraryExportCache`/`loadLibraryExportCache` in `libraryExport.ts`. Cache shape: `{ version, sourcePath, importedAt, totalEntries, reviewedEntries, reviewedById[], reviewedByTitleAuthor[] }`; corrupt/missing cache → clear error telling the user to run once with `--export`.
- `books`: `--export <path>` imports + caches; `--excludeReviewed` without `--export` uses the cache. Header shows `(cached: <file>, imported <date>)` vs `(from <path>)`.
- Verified: cache built from fresh export (11,206/6,773), then `'^j' --excludeReviewed` alone → 709 (77 excluded) via cache; missing-cache error path tested.

## Part 8 — Library queries: `by-char` (2026-08-08)

Custom ad-hoc queries over the imported library. One command (`library`) + one wrapper (`library.sh`) + one module (`src/library.ts`) so future queries share parsing/caching/printing; refactor commonalities later.

- `libraryExportCache.json` bumped to v2: now stores `entries: [{ id, title, author, shelf, dateRead, hasReview }]` for every row (all shelves, not just reviewed). Stale v1 cache → clear "run once with --export to rebuild" warning.
- `library <query>` commander command (`--year`, `--export`, `--import`); queries registry in `src/library.ts`.
- `by-char --year N`: counts entries on `read` shelf **with** review text whose `Date Read` year is N, grouped by raw first character (A–Z, `#` otherwise); requires `--year`. All 26 letters always print (zeros included); `#` only when non-zero. `--field title|authorLast|authorFirst` (default `title`), reusing `splitAuthorNames`/`authorFirstAndLast` from `bookMatch.ts` for the author fields.
- Verified live: 2024 → 537 books (T: 129 largest, Q: 1, X: 1); 2020 → 301 via cache (no `--export`); 2026 authorLast/authorFirst both 227 total with sensible bucketing; missing `--year`, unknown query, invalid `--field`, and stale-cache paths tested; `books --excludeReviewed` still 709/77 on v2 cache.

## Part 9 — `published-year` query (2026-08-08)

Count books read + reviewed in a given year by their first publication year.

- Cache bumped to v3: `LibraryEntry` gains `published` (from the `Year Published` export column — plain 4-digit years). Stale cache → "run once with --export to rebuild" warning.
- `published-year --year N`: same read+review text filter as `by-char`, bucket by `Year Published` (leading 4-digit year; unparseable/missing → `Unknown`). Only non-zero buckets shown, oldest first, `Unknown` last.
- Verified live: 2024 → 537 (matches `by-char` 2024; span 1958–2024, 2023: 54 highest, 1 Unknown); 2026 → 227; 1999 → 0 (no books read that year). Docs: README section 8, `library.sh`.

## Part 10 — `missing` audit (2026-08-08)

One-shot zero-value audit for a review year.

- Refactored `library.ts`: shared `reviewedInYear` filter + `charCounts`/`publishedCounts` helpers now power `by-char`, `published-year`, and `missing` (registry: `by-char`, `published-year`, `missing`).
- `missing --year N`: for each of `title`/`authorLast`/`authorFirst`, lists the A–Z letters with 0 books; then lists publication years `1961–N` (upper = max(review year, newest publication year seen)) with 0 books. Same read+review-text filter as other queries.
- Verified live: 2024 (537 books) → title: none, authorLast: none, authorFirst: O,Q,X,Z, pub years 1961-2024 → 13 missing (1961, 1963, 1964, 1965, 1966, 1968, 1969, 1972, 1973, 1978, 1979, 1980, 1985). Cross-checked vs `by-char` (O/Q/X/Z all 0); 2026 → title X missing, authorFirst H,U,X,Y, 30 missing pub years. Docs: README section 8, `library.sh`.
- Docs: README section 8, `library.sh` usage.
