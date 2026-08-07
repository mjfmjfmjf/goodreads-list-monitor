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
