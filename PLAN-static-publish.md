# PLAN — Static publish (HTML reports)

Status: in progress — page shell, collapsible left nav, per-field coverage,
overall ratings histogram, author, book id, work id, works, works (English),
book detail (including publisher tables), lists (including the metadata
backfill), highest-rated-by-year, titles, top-list-tags, top shelf tags, tag
first-page picks, tag book reports, and derived-stat book reports (including
avg-rating top/bottom and the lower-threshold variants) implemented; the
remaining titles reports, extended book sort fields, and genres planned.
Database growth/arrival histograms (publication years, books added, authors
added) implemented.
Created: 2026-11-11

## Goal

Publish reports from the local SQLite database as static HTML. Published locally
first (`./publish`), then pushed to a website. This is a long-lived surface:
new sections and reports will be added over time.

## How report requirements are written

A report is often described by the existing shell wrapper / CLI command that
captures the requirement (for example `./booksAddedHistogram.sh --days 1000`,
`./summaryYear.sh`, or `./authorHist.sh --by day`). That reference names the
report's **intent and exact behavior/metrics**; it is **not an implementation
mandate**. The static publisher computes each report directly from SQLite and
must not shell out to, or depend on, the wrapper. Where a report cites a CLI
module for its bucket/filter math (e.g. `src/booksAddedHistogram.ts`), reuse that
logic, not the CLI's console formatting.

## Command

```
npm run publish-site -- [--out <dir>] [--limit <n>]
```

- `--out` output directory (default `./publish`).
- `--limit` rows per report (default 1000).

## Output layout

```
publish/
  index.html
  per-field.html
  ratings-histogram.html
  publication-years.html
  books-added.html
  authors-added.html
  author/          9 reports (see below)
  book-id/         five histograms + twelve derived-stat tables (see below)
  work-id/         same reports
  works/           same reports
  works-en/        same reports (English editions, deduped)
  book-detail/     by-language, by-format, by-page-count,
                   publishers-most-books, publishers-most-ratings
  titles/          first-char, last-char, first-word (see below)
  year/            38 reports (2027..1990, see below)
  lists/           7 reports (see below), incl. top-list-tags
  tags/            top-tags, books-on-tag-first-pages, 18 tag book reports (see below)
```

## Page shell

- Left sidebar navigation; main content to the right.
- Content `<h1>` title, with `Last generated: <UTC>` immediately below in
  smaller, muted text.
- Self-contained CSS inlined for now (extract to `assets/style.css` later).
- Nav sections: **Overall, Author, Book ID, Work ID, Works, Works (English),
  Book Detail, Titles, Highest Rated by Year, Lists, Genres, Tags.**
- Sections are collapsible (no-JS `<details><summary>`); only the section
  containing the active report starts open and the sidebar scrolls.
- Sections with no reports yet render with a muted `soon` badge (no dead links).
- Active report is highlighted in the nav.

## Regeneration / atomicity

- Write each page **as soon as it is generated**, one file at a time, so files
  appear (and get their own `Last generated` stamp) as the run progresses.
  Author pages appear during the author pass; the book pages appear in a burst
  after the single books scan; `index.html` is written last.
- Each file is written atomically: write `<file>.tmp-<pid>-<n>`, then `rename`
  over the target. A reader always sees either the old or the new complete file.
- A failure mid-run leaves the already-written pages updated and the rest at
  their previous contents; re-running finishes the job.
- Never wipe or delete the output directory.
- Files for removed reports are left in place until an explicit cleanup step
  (future).

## Overall: Per Field (implemented)

`per-field.html` is the HTML form of `field-coverage`: one table per
report-backed schema table (every `REPORTED_TABLES` entry except the pending-drop
`list_tag_walks`, plus `list_walk` when the lazy walker has created it), with
one row per column: populated, total, coverage %, missing, and distinct (where
a scalar distinct count is meaningful). Coverage predicates match
`field-coverage` (e.g. `published` excludes `Unknown`/empty, `genres` excludes
`[]`, `tags` excludes `{}`). It includes the derived `book_page` rating-stat
columns and the `books` flags used by the static reports. Only cheap aggregate
queries are used — the CLI's 20M-row genres/tags JSON scan is not repeated.

## Overall: Ratings Histogram (implemented)

`ratings-histogram.html` is the HTML form of `ratingsCoverageHistogram.sh`
(`buildCoverageCounts` / `renderCoverageHistogram` in
`src/summaryHistogram.ts`). It uses the same rating brackets
(`buildRatingBuckets`: `10,000,000+`, then `9,000,000 to 9,999,999` down
through each decade, then the single digits down to `0`) and splits every
bracket by coverage subset:

| column | meaning |
| --- | --- |
| `ALL` | every `books` row |
| `WORK-ID` | books with a non-empty `books.work_id` |
| `WORKS` | distinct works (`books.is_work_rep = 1`) |
| `FIELD` | books with a `book_page` row (the field-coverage cache) |
| `WORK+FIELD` | distinct works whose representative edition has a `book_page` row (`WORKS ∩ FIELD`) |

Each subset contributes **two** numeric columns: `#` (books in this bracket)
and `ROLLUP` (this bracket and every higher bracket — "at least this many
ratings"; the brackets run high→low, so ROLLUP is an inclusive prefix sum).
The table columns are therefore:

```
RATING BRACKET | ALL # | ALL ROLLUP | WORK-ID # | WORK-ID ROLLUP |
WORKS # | WORKS ROLLUP | FIELD # | FIELD ROLLUP |
WORK+FIELD # | WORK+FIELD ROLLUP
```

**Compact headings.** To keep the table narrow, do not repeat each subset name
twice. Render a **two-row grouped header**:

- Row 1: `RATING BRACKET` (rowspan 2), then one group cell per subset (`ALL`,
  `WORK-ID`, `WORKS`, `FIELD`, `WORK+FIELD`), each with `colspan="2"`.
- Row 2: `#` and `↑` under each group.
- `↑` means ROLLUP (this bracket and above), explained once in the legend.
- Put the full subset meaning in a `title`/`<abbr>` tooltip on each group
  heading (e.g. `WORK+FIELD` → "distinct works whose representative edition
  also has a book_page row") so the visible headings stay short. If space is
  still tight, the CLI's `WORK+F` may be the visible label with the full text
  in its tooltip.
- Right-align numeric cells with tabular numerals and mute zero counts.

- Counts use thousands separators; a `Total` row at the bottom carries each
  subset's total in both its `#` and `ROLLUP` cells.
- A legend above the table explains the subsets, copied from the CLI:
  "ALL = cached books · WORK-ID = has a work id · WORKS = distinct works
  (de-duplicated) · FIELD = has a book_page field-coverage row · WORK+FIELD =
  a distinct work whose representative edition also has a field-coverage row".
- Data: one `book_page.book_id` id-set load (~411k) plus one streaming `books`
  scan (`id, ratings, work_id, is_work_rep`); no whole-cache materialization.
  Unlike `per-field.html`, this report shows no percentages.

## Overall: Database growth & arrival histograms (implemented)

Three existing terminal reports should also be published as Overall subpages,
so the growth/arrival history is browsable next to Per Field and the Ratings
Histogram. They are aggregate tables (not subject to `--limit`) and cover the
whole DB (not `--scope`). Nav order after Ratings histogram:

- `overall/publication-years` → `publication-years.html`
- `overall/books-added` → `books-added.html`
- `overall/authors-added` → `authors-added.html`

### Publication years (`summary-year`)

HTML form of `./summaryYear.sh` (`runSummaryByYear` in `src/summary.ts`): one
ascending row per publication year with the number of `books` rows whose
`published` parses to that year, then the non-year buckets the command prints —
`Unknown` (empty / `"Unknown"`) and every other unparseable `published` string
as its own label — plus the total book count. Mirror the command exactly: no
year filtering (including the Goodreads BCE-as-positive outliers) and no
de-duplication by work. Implement as a streaming `iterateBooks()` pass that
keeps only a `Map<year, count>` (O(1) memory); do not materialize the cache.

### Books added by day (last 1000 days; implemented)

1000 contiguous UTC day buckets ending today, oldest first, driven by
`books.first_seen` (same bucket math as `src/booksAddedHistogram.ts`).

| column | meaning |
| --- | --- |
| Period | bucket-start date (`YYYY-MM-DD`) |
| Added | books first seen that day |
| Total | running count first seen on/before that day |
| Of DB | `Total / all books`, one decimal |
| Avg rating | mean `books.ratings` of that day's additions, rounded |
| Max rating | largest `books.ratings` among that day's additions (`—` when 0) |

Footer: total books in DB, added in window, count predating the window
(cumulative baseline), and books with missing `first_seen`. Avg/max are for
that day's additions, not cumulative. Reuse the command's bucket math: extract
a loader (`loadBooksAddedBuckets({ days, todayIso })`) shared by the CLI and
the page; pass `todayIso` explicitly so tests are deterministic.

### Authors added by day (`authorHist.sh --by day`; implemented)

HTML form of `./authorHist.sh --by day`, driven by `authors.first_seen`. Unlike
books-added, there is **no fixed 1,000-day window**: buckets are contiguous UTC
days spanning the data's own `min(first_seen)` → `max(first_seen)`, oldest
first, including empty days. Every row uses `authors.num_ratings` (author-level
ratings, not a book's).

| column | meaning |
| --- | --- |
| Period | bucket date (`YYYY-MM-DD`) |
| Added | authors first seen that day |
| Total | running count first seen on/before that day |
| Of DB | `Total / all authors`, one decimal |
| Avg rating | mean `authors.num_ratings` of that day's additions, rounded |
| Max rating | largest `authors.num_ratings` among that day's additions (`—` when 0) |

Footer: total authors in DB, added in the window, count predating the window
(cumulative baseline), authors with missing/empty `first_seen`, and the
earliest `first_seen`. Avg/max are for that day's additions, not cumulative.
`Of DB` divides by **all** authors, so authors with unknown `first_seen` stay in
the denominator while being excluded from the buckets and additions totals
(same convention as books-added). Show the shared growth caveat below.

`authorHist.sh` is currently a standalone Node script embedded in the shell, so
promote its bucket math to `src/authorArrivalHistogram.ts` (pure builder +
loader, mirroring `booksAddedHistogram.loadBooksAddedBuckets`) with an
injectable bounds argument for tests; the static page uses it, and the shell can
delegate to the same module (follow-up) so the two cannot drift.

### Caveat shown on both growth pages

`first_seen` did not exist from the start: old `books` / `authors` rows were
backfilled (`books.first_seen = last_updated - 1 day`,
`authors.first_seen = last_seen - 1 day`). Buckets before live stamping began
are synthetic proxies (a few giant spikes), not real arrival times. Render the
same note the commands print, above the table.

### Cost

Publication years is one streaming `books` pass; books-added is one indexed
`first_seen` group-by plus small counts; authors-added is one `authors`
group-by. None materializes the cache; the 1000-day window is rendered in full
(~100KB of HTML).

## Author section (first pass)

Nine implemented reports, up to 1000 authors each:

| page | sort field | min ratings |
| --- | --- | --- |
| `top-authors-by-ratings` | `numRatings` | 0 |
| `top-authors-by-reviews` | `numReviews` | 0 |
| `top-authors-by-shelves` | `numShelves` | 0 |
| `top-authors-by-catalog-pages` | `catalogPages` | 0 |
| `top-authors-by-avg-rating-min-100k` | `averageRating` | 100000 |
| `top-authors-by-avg-rating-min-10k` | `averageRating` | 10000 |
| `bottom-authors-by-avg-rating-min-10k` | `averageRating` (asc) | 10000 |

Columns: `#`, `Author`, then the report's **entry attribute**, then the remaining
attributes (`Ratings`, `Reviews`, `Shelves`, `Catalog pages`, `Avg rating`).
The bottom report sorts average rating ascending; ties still put more ratings
first, then author name ascending.

- Author cell: link text = author name; `href` =
  `https://www.goodreads.com/author/show/<id>`.
- Counts formatted with thousands separators; average rating to 2 decimals.

Data: `authors` table (`num_ratings`, `num_reviews`, `num_shelves`,
`catalog_pages`, `average_rating`) via
`selectAuthors(iterateAuthors(), …)`.

### Author reports (min 1,000 ratings) (implemented)

Two average-rating reports with the same shape and rules, for authors with at
least **1,000** `num_ratings`:

| page | sort field | min ratings |
| --- | --- | --- |
| `author/top-authors-by-avg-rating-min-1k` | `averageRating` | 1000 |
| `author/bottom-authors-by-avg-rating-min-1k` | `averageRating` (asc) | 1000 |

Nav labels: `Top Authors by Avg Rating (min 1k ratings)` and `Bottom Authors by
Avg Rating (min 1k ratings)`. The top report ties by more ratings, then name;
the bottom report sorts ascending but still puts more ratings first on a tie,
then name. These are additions — the min-100k/min-10k reports stay.
## What is a work? (book id vs work id vs work)

Goodreads has three related identities; the reports use all three:

- **Book ID** (`books.id`) = one edition (one `/book/show/<id>` page). Different
  formats and translations have different book ids.
- **Work ID** (`books.work_id`) = Goodreads' work identity. Editions of the same
  book share it (US/UK titles, translations). It is scraped from the book page
  (`extractWorkId`) and stored on every edition row. The `work-id` reports
  include every edition that has a non-empty `work_id`.
- **Work** (one report row) = one representative edition per `work_id`, marked
  by `books.is_work_rep = 1`. It is **derived, not scraped**: one row per
  `work_id`, chosen by highest `books.ratings`, then lowest numeric `books.id`
  (`recomputeWorkReps()` in `src/db.ts`). A full recompute runs on import
  (`importData.ts`); a per-work refresh (`refreshWorkRep()`) runs when
  `upsertBook` writes a row. Writers that bypass those paths (e.g. some
  `popularByDate` upserts) can leave the flag **stale**, so the all-language
  Works report may show an edition that is no longer the highest-rated one.
  `works-en` avoids this by choosing its representative on the fly.
- **Works (English)** = one row per `work_id`, choosing the highest-ratings
  edition whose `book_page.language` is exactly `English`; works with no known
  English edition are excluded. It then collapses duplicate `work_id`s that
  share a normalized title (`stripTitleSuffix`, case/punctuation-folded) and
  `author_id`, keeping the highest-ratings row. This removes translations and
  Goodreads' occasional split work ids (e.g. Harry Potter #3: `2402163` and
  `276903466`). Language coverage is partial (`book_page.language` covers
  ~5.7% of all works but ~98% of the top 1000), so the English report is
  reliable at the top and thins out in the long tail. **Series position is not
  used for dedupe**: an author can have several series with a `series_pos = 1`,
  so author + position alone would merge unrelated books. A future version
  could store/parse the series name to make that key safe.

Every Works and Works (English) page carries a static toggle:
`View: All languages · English only`, linking to the same report in the other
scope.

## Book ID / Work ID / Works (implemented)

- **Book ID** = all editions (`books`).
- **Work ID** = books with a non-empty `work_id`.
- **Works** = distinct works (`books.is_work_rep = 1`, equivalently one row per
  `work_id`).
- **Works (English)** = the on-the-fly English representative per `work_id`,
  deduped by normalized title + author (see "What is a work?" above).
- Each section has five histogram reports: `ratings`, `reviews`,
  `currently-reading`, `to-read`, `edition-count`.
- Each of those is a **histogram + top-N table** (N = `--limit`).
- Sources: `books.ratings`; `book_page.reviews_count`,
  `book_page.currently_reading`, `book_page.to_read`,
  `book_page.editions_count`. `book_page` coverage is partial, so these reports
  state their denominator: "Based on N books with <metric> data (of M books in
  scope)."
- Buckets: powers of ten for the count metrics; finer buckets for edition count.
- Work ID and Works tables add a Work ID column linking to
  `https://www.goodreads.com/work/editions/<work_id>`.

Derived-stat top-N tables (no histogram), using the
`book_page.ratings_dist` columns and `--limit` (default 1000):

| page suffix | sort | filter |
| --- | --- | --- |
| `highest-skewness-min-100k` | `ratings_skewness` desc | `books.ratings >= 100000` |
| `highest-skewness-min-10k` | `ratings_skewness` desc | `books.ratings >= 10000` |
| `lowest-skewness-min-100k` | `ratings_skewness` asc | `books.ratings >= 100000` |
| `lowest-skewness-min-10k` | `ratings_skewness` asc | `books.ratings >= 10000` |
| `highest-variance-min-100k` | `ratings_variance` desc | `books.ratings >= 100000` |
| `highest-variance-min-10k` | `ratings_variance` desc | `books.ratings >= 10000` |
| `lowest-variance-min-100k` | `ratings_variance` asc | `books.ratings >= 100000` |
| `lowest-variance-min-10k` | `ratings_variance` asc | `books.ratings >= 10000` |
| `highest-kurtosis-min-100k` | `ratings_kurtosis` desc | `books.ratings >= 100000` |
| `highest-kurtosis-min-10k` | `ratings_kurtosis` desc | `books.ratings >= 10000` |
| `lowest-kurtosis-min-100k` | `ratings_kurtosis` asc | `books.ratings >= 100000` |
| `lowest-kurtosis-min-10k` | `ratings_kurtosis` asc | `books.ratings >= 10000` |
| `highest-review-ratio-min-1k` | `reviews_count / books.ratings` desc | `books.ratings >= 1000` |
| `highest-review-ratio-min-100` | `reviews_count / books.ratings` desc | `books.ratings >= 100` |
| `highest-avg-rating-min-100k` | `books.avg_rating` desc | `books.ratings >= 100000` |
| `highest-avg-rating-min-10k` | `books.avg_rating` desc | `books.ratings >= 10000` |
| `highest-avg-rating-min-1k` | `books.avg_rating` desc | `books.ratings >= 1000` |
| `highest-avg-rating-min-100` | `books.avg_rating` desc | `books.ratings >= 100` |
| `lowest-avg-rating-min-10k` | `books.avg_rating` asc | `books.ratings >= 10000` |
| `lowest-avg-rating-min-1k` | `books.avg_rating` asc | `books.ratings >= 1000` |
| `lowest-avg-rating-min-100` | `books.avg_rating` asc | `books.ratings >= 100` |

- The minimum-ratings filter uses the **advertised** `books.ratings`, not the
  histogram `ratings_total`.
- Rows with a NULL derived stat (missing/unparseable `ratings_dist`, or a
  missing/zero `avg_rating`) are excluded in both directions — unknown is not
  zero.
- The derived stats are **per edition**. Book ID uses every `book_page` row;
  Work ID uses rows with a non-empty `work_id`; Works uses `is_work_rep = 1`;
  Works (English) uses the on-the-fly English representative + title/author
  dedupe. No cross-edition aggregation (unlike `editionCount` under `--dedupe`).
- Columns: `#`, Title, Author, [Work ID for Work ID/Works/Works (English)],
  then the sort metric, then `# ratings`. Stat values use 4 decimals (average
  rating 2 decimals) and counts use thousands separators. The review-ratio
  table adds a `Reviews` column: `#`, Title, Author, [Work ID], Reviews /
  Ratings (3 decimals), Reviews, # ratings.
- The skewness/variance/kurtosis tables (all 12, both directions) drop the
  Work ID column in every scope and add an `Avg rating` column (2 decimals,
  `—` when missing) from the same source edition: `#`, Title, Author, stat
  value, Avg rating, # ratings. Other derived reports keep the Work ID column
  in non-Book-ID scopes and do not get an Avg rating column.
- Nav labels: `Highest Skewness (min 100k)`, `Highest Skewness (min 10k)`,
  `Lowest Skewness (min 100k)`, `Lowest Skewness (min 10k)`,
  `Highest Variance (min 100k)`, `Highest Variance (min 10k)`,
  `Lowest Variance (min 100k)`, `Lowest Variance (min 10k)`,
  `Highest Kurtosis (min 100k)`, `Highest Kurtosis (min 10k)`, `Lowest
  Kurtosis (min 100k)`, `Lowest Kurtosis (min 10k)`, `Highest Review Ratio (min
  1k)`, `Highest Review Ratio (min 100)`, `Highest Avg Rating (min 100k)`,
  `Highest Avg Rating (min 10k)`, `Highest Avg Rating (min 1k)`, `Highest Avg
  Rating (min 100)`, `Lowest Avg Rating (min 10k)`, `Lowest Avg Rating (min
  1k)`, `Lowest Avg Rating (min 100)`.

The lower-threshold variants (`min-10k`/`min-1k`/`min-100`) are additional rows
rather than replacements: 21 reports × 4 scopes = 84 pages. Skewness, variance
and kurtosis have no `min-100` variant.

Avg-rating histogram pages (`avg-ratings-histogram-min-<threshold>`) exist at
four thresholds — 100k, 10k, 1k and 100 — in all four scopes (16 pages). They
use the same `book_page`-only eligibility as the CLI's
`avgHistogram.sh --hasDetails`, at bucket widths 0.5 / 0.2 / 0.1.

### Book sort fields (parity with `books.sh --sort`)

Publish uses the same sort vocabulary as `books.sh`. Default is `numRatings`;
aliases `ratings` → `numRatings` and `avgRating` → `avgRatings`. Natural
direction is desc except `title`/`author` (asc); `--asc`/`--desc` override.
Ties break on ratings desc, then title asc (case-insensitive), with the chosen
direction applied to the whole comparator (so tie-breaks reverse under `--asc`).

| field | value | source / rule |
| --- | --- | --- |
| `numRatings` | int | `books.ratings` (commas stripped) |
| `numReviews` | int | `book_page.reviews_count`; 0 when no page |
| `avgRatings` | float | `books.avg_rating` (Goodreads' displayed average) |
| `numShelves` | int | `SUM(tag_books.shelved)` per book; 0 when none |
| `numTags` | int | `COUNT(*)` of `tag_books` rows per book; 0 when none |
| `currentlyReading` | int | `book_page.currently_reading`; 0 when no page |
| `toRead` | int | `book_page.to_read`; 0 when no page |
| `editionCount` | int | `book_page.editions_count`; under `--dedupe` + `work_id`, `MAX` per work (`loadWorkEditions`), else the edition's own value |
| `reviewRatio` | float | `numReviews / numRatings`; 0 when `numRatings = 0` |
| `ratingsMean` | float | `book_page.ratings_mean` (weighted star average) |
| `ratingsMedian` | int | `book_page.ratings_median` (smallest star with cumulative ≥ half) |
| `ratingsMode` | int | `book_page.ratings_mode` (most-rated star; ties → lower star) |
| `ratingsVariance` | float | `book_page.ratings_variance` (population variance) |
| `ratingsStddev` | float | `book_page.ratings_stddev` (`√variance`) |
| `ratingsSkewness` | float | `book_page.ratings_skewness` (3rd standardized moment) |
| `ratingsKurtosis` | float | `book_page.ratings_kurtosis` (**excess** kurtosis, normal = 0) |
| `ratingsTotal` | int | `book_page.ratings_total` (Σ histogram buckets; may differ from `books.ratings`) |
| `year` | int | `getYear(books.published)`; 0 when unparseable |
| `title` | string | lowercased `books.title` |
| `author` | string | lowercased `books.author` |

The eight `ratings*` derived fields come from the stored `book_page.ratings_dist`
histogram and are **NULL** when the distribution is missing/empty/unparseable.
A NULL stat is *unknown*, not zero: a sort by a derived field excludes books
that lack it (both directions). `avgRatings`/`numRatings` stay the advertised
Goodreads values, distinct from the histogram-derived fields.

`--dedupe` collapses to one row per work (English edition preferred, falling
back to `is_work_rep`). Only `editionCount` aggregates across the work; the
derived ratings stats are per-edition, so the surviving edition shows its own
values.

Display formats (from `books.ts`): mean 3 decimals; median/mode integer;
variance/stddev/skewness/kurtosis 4 decimals; total with thousands separators;
avg rating 2 decimals; year integer.

Publish exposure: the existing five numeric reports (ratings, reviews,
currently-reading, to-read, edition-count) keep their histogram + top-N shape.
The additional fields are exposed as top-N tables; continuous stats
(`avgRatings`, `reviewRatio`, `ratings*`) need bucket definitions before they
can also get a histogram. The first four such tables are decided for all three
scopes: highest skewness and highest variance (min 100,000 ratings), lowest
kurtosis (min 100,000 ratings), and highest review ratio (min 1,000 ratings).
`title`/`author`/`year` are sort orders, not top-N metrics, and are not planned
as standalone reports.

## Book Detail (implemented)

Frequency pages:

- `# per language` (`book_page.language`)
- `# per format` (`book_page.format`)
- `# per page` (`books.pages`), with **client-side sort** buttons: by page
  value or by number of books at that page count.

Publisher tables (top 1,000 each, over `book_page.publisher` joined to `books`;
publisher strings are trimmed and matched exactly, with no variant
normalization):

- `book-detail/publishers-most-books` — publishers ranked by **number of
  books** (distinct works; editions collapse on
  `COALESCE(NULLIF(work_id, ''), id)`, and each (publisher, work) is
  represented by its highest-rated edition, mirroring `publisherCatalog`'s
  `books`). Columns: `#`, Publisher, Books, Total ratings.
- `book-detail/publishers-most-ratings` — the same publishers ranked by
  **total ratings** (sum of `books.ratings` over those representative
  editions, mirroring `publisherCatalog`'s `totalRatings`). Columns: `#`,
  Publisher, Total ratings, Books.

Both exclude `is_bad` books and empty/NULL publishers. Ties: the other metric
desc, then publisher name asc. Size is fixed at 1,000 per report (not
`--limit`).

## Performance

- A full run over the live DB (~18.6M books) takes ~3–4 minutes: the narrow
  `books` scan plus the title-only pass dominate (measured 3m9s on
  2026-11-11 with the derived-stat pages, 74 pages; the lower-threshold variants
  add 20 more; the Per Field aggregate adds a full `books` pass, and the
  Overall ratings histogram adds another). The English works pass adds one
  `book_page` join + window over the ~318k English work rows, deduped in
  memory; the live run now publishes ~120 pages.
- That pass selects only `id, ratings, work_id, is_work_rep, pages` (no
  title/author strings) and resolves title/author for only the surviving
  top-N ids afterwards. One joined pass over `book_page` (~411k rows) handles
  the detail metrics and the derived-stat reports (adds
  `bp.ratings_skewness`, `bp.ratings_variance`, `bp.ratings_kurtosis`,
  `bp.reviews_count`, `b.ratings`, and `b.avg_rating`).
- Titles use a **second, title-only pass** (`SELECT title FROM books`), so the
  main scan stays narrow. It keeps only per-character and per-first-word count
  maps (O(1) memory in the number of books).
- The publisher tables reuse `publisherCatalog`'s `loadPublisherRows` +
  `computePublisherCatalog`; the per-(publisher, work) representative map holds
  ~400k keys, so memory stays bounded. Per Field adds one aggregate pass over
  `books` (plus the smaller tables); the Overall ratings histogram adds a
  `book_page.book_id` id-set plus one streaming `books` scan.

## Titles (implemented)

Reports over `books.title` — the title string itself, not a book's ratings
(those live under Book ID / Work ID / Works). The three reports below are built
from the second title-only pass.

- `titles/first-char` — books per **first character** of the title. The
  character label links to the matching Listopia tag directory when one exists
  (see below).
- `titles/last-char` — books per **last character** of the title.
  Both mirror `titleCharHistogram.sh` (`computeTitleCharHistogram`): the title
  is normalized with `stripTitleSuffix` first, and the exact first/last
  character is counted (so punctuation is its own row, not folded into
  letters). Any character is listed as long as it has **at least 1,000 books**;
  rows are sorted by count desc, then character code. `titles/last-char` labels
  stay plain text.
- `titles/first-word` — **top N** first words of the title (N = `--limit`,
  default 1000), mirroring `titleFirstWordHistogram.sh`
  (`computeTitleFirstWordHistogram` / `extractFirstWord`). Normalization:
  `stripTitleSuffix`, drop leading whitespace/quotes/brackets/dashes/
  underscores, take the first whitespace-delimited token, lowercase it, strip
  trailing punctuation, and keep it only if it contains a letter or digit.
  Sorted by count desc, then word asc. Columns: `#`, First word, Books. The
  first-word label links to the matching Listopia tag directory when one exists
  (see below).

### List-tag links on title rows

For `titles/first-char` and `titles/first-word`, the row label links to the
matching Goodreads Listopia tag directory **if that tag exists**:
`https://www.goodreads.com/list/tag/<label>` (URL-encoded). Existence is
decided from the same unified `list_tags` xref used by the top-list-tags
report: load the distinct `tag_name` set once (`tag_name` is lowercased at the
storage boundary), fold the label to lowercase, and link only on an exact
match; with no match the label renders as plain text. Examples: first character
`T` links to `https://www.goodreads.com/list/tag/t` only when `t` is a
`list_tags.tag_name`; first word `the` links to
`https://www.goodreads.com/list/tag/the` only when `the` exists. `last-char` is
not linked.

Planned (needs decisions):

- `# per title` — most common exact titles (e.g. "The Odyssey" across
  editions), with the number of book ids and the number of distinct authors.
- `# per title length` — frequency of title character length (and optionally
  word count).
- Open: whether to normalize titles (case, punctuation, leading articles)
  before grouping, and whether to exclude `is_bad` rows.

## Highest Rated by Year (implemented)

- One report per publication year, **2027 back to 1990** (38 reports).
- Each report ranks books by `books.avg_rating` (highest first), restricted to
  `books.ratings >= 1000`.
- Ties on `avg_rating` break by **more ratings first** (then larger book id).
- Rows with `is_bad = 1` are excluded.
- Each year uses a **fixed 1000-row cap** (`YEAR_REPORT_LIMIT`), independent of
  the global `--limit`.
- Columns: rank, title (Goodreads link), author, avg rating, `#ratings`,
  published year.
- Each page links at the top to the year's Goodreads list tag
  (`https://www.goodreads.com/list/tag/<year>`), shelf tag
  (`https://www.goodreads.com/shelf/show/<year>`), and most-popular books
  (`https://www.goodreads.com/book/popular_by_date/<year>`).
- Source: `books` (`published` for the year, `avg_rating`, `ratings`, `is_bad`).
  `published` is usually `Unknown` or a bare 4-digit year, sometimes
  `YYYY.MM.DD`; only the leading 4-digit year is used, and only years in
  1990–2027 are kept.
- The single book scan feeds both the ratings histograms and 38 per-year
  min-heaps; titles/authors for the surviving rows are resolved in the same
  chunked metadata lookup as the ratings top-N.
- This is the first section expected to hold many reports (38), so it is the
  motivating case for the collapsible nav.

### Year-page de-duplication (implemented)

Each year page (`year/<YYYY>.html`) collapses editions to **one row per work**
(hardcover/paperback/translation editions with different book ids no longer
appear several times):

- Group by `books.work_id` when it is non-empty.
- Otherwise group by normalized title (`stripTitleSuffix`, case/punctuation
  folded) + `author_id` (falling back to lowercased author name).
- Within a group keep the highest-`books.ratings` edition; tie → lower numeric
  `books.id` (same rule as `recomputeWorkReps`).
- Dedupe during the existing single `books` scan — the query already selects
  `work_id`/`is_work_rep` — using a per-year candidate map, then build the
  1,000-row heap from the survivors. Do not dedupe after the heap, or a year
  could end up with fewer than 1,000 distinct works.
- The page intro notes "one edition per work (highest-ratings edition kept)".
  No new column is required.

### Author links (planned)

Year rows should link the author name the same way every other book report
does; today `renderYearTable` prints `books.author` as plain text, making it
the only book table without the author link.

- Add `authorId` to `YearBook` and populate it from `books.author_id` in the
  existing single `books` scan (the query already selects the needed columns).
- `resolveBookTitles` must copy `authorId` onto year rows as well (it already
  resolves `author_id` for the ratings top-N).
- `renderYearTable` renders the author with the shared
  `renderAuthorLink(author, authorId)` helper: link to
  `https://www.goodreads.com/author/show/<author_id>` when an id is present,
  otherwise plain text (and `—` when the name is empty). Same
  `target="_blank" rel="noopener noreferrer"` as the other tables.
- No new column and no extra query.

## Top Rated by Year (implemented)

- One report per publication year, **2027 back to 1990** (38 reports), in a
  left-nav section directly after "Highest Rated by Year". Paths are
  `top-rated-year/<YYYY>.html`.
- English-language works only: `book_page.language = 'English'`, one
  highest-ratings edition per `work_id`, plus the same normalized title+author
  dedupe as the `works-en` scope (`dedupeEnglishWorks`).
- Ranked by **`books.ratings` descending** (most ratings first); ties break on
  higher `avg_rating`, then lower book id. **No minimum-ratings floor** — the
  1,000-rating gate belongs only to the highest-rated report. This matters in
  sparse years: 2027 has 1,510 known English works but only 6 with ≥1,000
  ratings.
- Same table columns, top-1000 cap and Goodreads browse links as the
  highest-rated year pages; `renderTopRatedYearTable` shares the table body.
- Built inside the existing `scanEnglishWorks` pass (`published` was added to
  the English-works SQL and `BookPageRow`), so there is no second scan of
  `book_page`.

## Lists (implemented)

Top-N tables (N = `--limit`, default 1000) over `list_meta` (~46k lists and
growing), plus the **top list tags** report over the unified `list_tags` xref.
List titles come from `list_scrapes.list_name` (nearly every row has one);
`lists` only holds a few hundred rows, so it is not used. These are small
tables, not histograms.

| page | sort attribute | direction |
| --- | --- | --- |
| `lists/most-books` | `num_books` | desc |
| `lists/most-voters` | `num_voters` | desc |
| `lists/most-likes` | `num_likes` | desc |
| `lists/earliest-created` | `created_at` | asc |
| `lists/latest-created` | `created_at` | desc |
| `lists/creators-most-lists` | lists per creator | desc |

List report columns — always show every attribute, with the report's sort
attribute first: `#`, `List` (link), `Books`, `Voters`, `Likes`, `Created`,
`Creator` (link).

- List link: `https://www.goodreads.com/list/show/<list_id>`.
- Creator link (used **everywhere a list creator is mentioned** — the
  per-list reports' Creator column and the creators report; implemented):
  `https://www.goodreads.com/list/created/<creator_id>` (the creator's
  lists-created page), e.g.
  `https://www.goodreads.com/list/created/970632`. A list whose creator has no
  `creator_id` (deleted user) shows `creator_name` as plain text instead of a
  link.
- `Created` rendered as the stored `YYYY-MM-DD`; `—` when NULL.
- `Likes` NULL (pre-metadata rows) renders `—` and sorts last; the likes report
  states "Based on N lists with likes data (of M lists)."
- Ties break on `list_id` ascending.

Creator report columns: `#`, `Creator` (link), `Lists created`, `Books`,
`Voters`, `Likes` (sums over that creator's lists). Default order is `Lists
created` descending, tie-break `creator_id` ascending. All four numeric
columns — **Lists created, Books, Voters, Likes** — are **client-side
sortable** (implemented) on the single page (same no-build approach as the page-count table):
a sort control per column toggles desc→asc→desc, the default is Lists created
desc, ties keep `creator_id` ascending (creator-less rows last, then by name),
and `Likes` is `—` for creators with no likes data and always sorts last.
Creators with a non-empty `creator_id` are ranked (~16k distinct). Lists with
no creator id (deleted users) are also ranked, grouped by their scraped
plain-text name; rows where an older scrape left the name NULL are folded into
the same "deleted user" group (~3,050 lists total). These rows have no
lists-created link. The Creator cell uses the shared lists-created link
described above for rows that have an id.

Data: `list_meta` (`num_books`, `num_voters`, `num_likes`, `created_at`,
`creator_id`, `creator_name`) joined to `list_scrapes.list_name`. All rows fit
in memory, so this is a small single pass (unlike the 18.6M-book pass).

### List metadata backfill (implemented)

The six list reports and the creators report only rank lists that have a
`list_meta` row, so lists that were discovered but never book-crawled are
invisible. Coverage today: 122,277 lists in `list_scrapes`, but only 46,247
`list_meta` rows (76,031 lists with no metadata), and ~5,970 existing rows have
at least one NULL field. `list-meta-backfill` reads only the first page of each
such list and records the header metadata and sidebar tags (`src/listMetaBackfill.ts`).

- **Candidates.** Every list id known to the DB (`list_scrapes`, plus the
  handful of `list_tags`-only lists), **earliest-discovered first**: order by
  `list_scrapes.first_scraped` ascending, then `list_id` ascending; ids with no
  scrape row go after those. This walks the oldest lists first.
- **Filter.** Keep a list when its `list_meta` row is absent, or any of
  `num_books`, `num_voters`, `num_likes`, `created_at` is NULL, or both
  `creator_id` and `creator_name` are NULL. A deleted-user list legitimately
  has no `creator_id`; a stored `creator_name` satisfies the creator
  requirement so it is not re-walked forever.
- **Fetch.** Exactly one request per list:
  `GET https://www.goodreads.com/list/show/<list_id>` (page 1 only). No
  pagination and no book rows. The header metadata and `Tags:` sidebar repeat
  on every page, so page 1 is sufficient.
- **Parse / persist.** Reuse `parseListMeta()` + `parseListTags()` and
  `upsertListMeta()` / `upsertListTags()` (idempotent single-statement upserts;
  tags recorded with `from_sidebar = 1`). Counts track the latest read; the
  creation date and creator only fill blanks.
- **Do not touch `list_scrapes`.** This is a metadata backfill, not a crawl:
  leave `first_scraped`, `last_scraped`, `num_scraped`, and
  `num_books_scraped` untouched so book-crawl schedules and the "not yet
  scraped" set are unaffected. `list_meta.last_seen` still advances.
- **Politeness / resume.** Sequential requests paced with the same plain
  `delay()` gap `scrapeListBooks` uses between list pages (~0.25–3.1s; note
  `delay()` scales its bounds by 1.5 and adds 100ms); on 202/403/429 the run
  stops (the page fetch itself is bounded, no unbounded retry). `--limit`
  batches the queue, and re-running resumes naturally because completed rows
  fall out of the filter.
  The run logs added/filled/no-metadata/unreadable/tag counts.
- **Command.** `list-meta-backfill` (`--limit`, `--dryRun`) plus the
  `backfillListMeta.sh` wrapper, matching the existing wrapper conventions.
- **Effect.** Re-run `publishSite.sh` afterwards: the new rows flow into all
  six list reports and the creators report, and (because `list_meta` is in
  `EXPORT_TABLES`) into data sharing.

### List creation-date parsing (implemented 2026/11/14)

Goodreads **omits the year** in a list's header meta when the list was created
in the current calendar year:

- `232 books · 37 voters · list created January 17th by Brittiny Harrand` —
  [list/380105](https://www.goodreads.com/list/show/380105)
- `100 books · 1 voter · list created November 1st by Mitchell Friedman` —
  [list/424056](https://www.goodreads.com/list/show/424056.Most_popular_3rd_book_in_a_series)
- [list/291061](https://www.goodreads.com/list/show/291061) is probably the last
  2025 list that still carries a year.

`parseListMeta()` matches `/list created <Month> <day>, <YYYY>/`
(`src/scraper.ts:653`) and `ordinalMonthDateToIso()` requires a 4-digit year
(`src/scraper.ts:617`), so a year-less date leaves `createdAt` undefined and the
list silently gets a NULL `created_at`. Impact:

- Current-year lists are absent or mis-sorted on `lists/earliest-created` and
  `lists/latest-created`, and are omitted from the `Created` column.
- `list-meta-backfill` **re-walks them every run**, because its filter treats a
  NULL `created_at` as incomplete metadata (never converges).
- `field-coverage` undercounts `created_at` coverage.

Implemented fix:

- The year is now optional in `parseListMeta()`'s creation regex; when absent,
  `ordinalMonthDateToIso()` assumes the **current calendar year** at parse time
  (`new Date().getFullYear()`; `parseListMeta` accepts an injectable `now` for
  deterministic tests). Goodreads only drops the year for the actual current
  year.
- **Raw creation text is captured** alongside the derived ISO date: nullable
  `created_at_raw TEXT` on `list_meta` (created-column migration for existing
  DBs; fill-blank-only like `created_at`), stored via `upsertListMeta()`,
  round-tripped through export/import, and surfaced in `field-coverage` (CLI)
  and the publish-site coverage page. The ISO `created_at` stays the sortable
  value. `list-meta-backfill` records it too.
- Covered by scraper tests for both shapes (`"May 1st, 2013"` and a year-less
  `"January 17th"`), a backfill integration-style test, and the field-coverage
  distinct-count test.
- Still to run against live data: `./backfillListMeta.sh` to repopulate the
  NULL `created_at` rows; with the fix the queue drains and
  earliest/latest-created pick up the new lists.

Related, still open: early **2008** lists
(`SELECT * FROM list_meta WHERE created_at IS NOT NULL ORDER BY created_at ASC`)
do not render correctly on `lists/earliest-created.html`. `created_at_raw` is
now captured, so the next step is to confirm whether their ISO dates are wrong,
NULL, or simply sorted out by the tie-break/limit before changing the report.

### Top list tags (moved here from Tags; implemented)

- `lists/top-list-tags` — **top N** list tags by number of lists carrying them
  (N = `--limit`, default 1000), from the unified `list_tags` xref (sidebar
  reads + directory walks). This report belongs under **Lists**, not Tags,
  because it ranks Listopia tags; its path and nav entry move to the Lists
  section.
  Count is `COUNT(*) GROUP BY tag_name`; ties break by tag name asc. Tag names
  are lowercased at the storage boundary.
- Columns: `#`, Tag (link), Lists.
- Tag link: `https://www.goodreads.com/list/tag/<tag>` (URL-encode the tag,
  e.g. `https://www.goodreads.com/list/tag/romance`).
- Includes every tag (no `--exclude-walked` filter).

## Tags

### Top tags from the /shelf directory snapshot (implemented 2026/11/20)

`tags/top-tags.html` — top 1,000 rows of `shelf_tag_directory`, loaded in
directory order (book count desc, rank asc). The table shows `#` (Goodreads
directory rank), Tag, `# books`, `Scraped` (UTC timestamp), and Links. Sort
buttons support rank, tag name, # books and scrape date
(`TOP_TAG_SORT_SCRIPT`); ties return to rank order.

Every tag gets a `https://www.goodreads.com/shelf/show/<tag>` link. A `list tag`
link is added only when `list_tags` has that tag; a `genre` link is added when
`genres.name` matches exactly, falling back to a `genre_tag_xref` association
(exact preferred over cognate). Links open in a new tab.

The snapshot itself is captured by `npm run shelf-tag-directory -- --pages 1-100`
(`./shelfTagDirectory.sh`), one polite authenticated GET per `/shelf?page=N`,
parsing `div.shelfStat`. The directory fills three floated columns top-to-bottom
and advertised counts descend in DOM order (col 1 ranks 1–34, col 2 35–67,
col 3 68–100), so DOM order is the rank. Ranks are global:
`(page - 1) * 100 + DOM index + 1`. No book-detail fetches. The table is
exported/imported like other shareable data; imports keep the row with the
newest `scraped_at`.

### Books on first page of tags (`tagFirstPagePicks.sh --limit 1000 --terse --includeReviewed`)

- `tags/books-on-tag-first-pages` — **top 1,000** books ranked by how many
  distinct tags they appear on that tag's **first page** (position 1–50).
  HTML form of `./tagFirstPagePicks.sh --limit 1000 --terse --includeReviewed`.
  Path `tags/books-on-tag-first-pages.html`; nav label
  "Books on tag first pages".
- Data: `tag_books` rows with `position BETWEEN 1 AND 50`, joined to `books`.
  Skip books missing from the cache; drop `books.is_bad = 1` and
  `title = 'Unknown'`. Count distinct `tag_name` per `book_id`.
- Rank: tag count desc, then `books.ratings` desc, then title asc. Render the
  top 1,000 rows. `--includeReviewed` means **no** library-export filter — show
  books you have already reviewed too.
- `--terse` parity: no tag-name lists, just the count.
- Columns: `#`, Title (book detail link), Author (author link), Year, Pages,
  Tags (distinct first-page tag count).
- Footer: tags with first-page data, distinct books on a tag first page,
  books not in cache, and displayed count. (The CLI's "Excluded (already
  reviewed)" count is always 0 here because reviewed books are included.)
- Add a loader (`loadTagFirstPagePicks({ limit })`) over one aggregate query so
  the page does not issue 1,000 `getBook` calls; keep the existing pure
  `findTagFirstPagePicks` for the CLI and its unit tests. Tag names are
  lowercased at the storage boundary.

### Top books per shelf tag — two forms (implemented 2026/11/20)

Nine shelf tags — 2026, fantasy, graphic-novels, manga, mystery, non-fiction,
romance, science-fiction, young-adult — each have two fixed **top 1,000**
reports from the `tag_books` (tag → book) xref:

- **By ratings** (original URLs, unchanged): `tags/<tag>.html`, nav section
  "Tag Books — by Ratings". Rank: `books.ratings` desc, then lower numeric
  book id, then book id.
- **By shelf count**: `tags/<tag>-by-tag-count.html`, nav section
  "Tag Books — by Shelf Count". Rank: `tag_books.shelved` desc (how many times
  Goodreads showed the book as shelved under this tag), then `books.ratings`
  desc, then lower numeric book id, then book id. This reproduces the order of
  `https://www.goodreads.com/shelf/show/<tag>` for the scraped pages.

Both sections list the nine tags alphabetically by nav label ("2026",
"Fantasy", "Graphic Novels", "Manga", "Mystery", "Non-Fiction", "Romance",
"Science Fiction", "Young Adult"). The overview **Tags** section keeps only
Top Tags and Books on First Page of Tags.

- Columns: `#`, Title (Goodreads book link), Author (author link), Ratings,
  Avg rating (2 decimals, `—` when missing), Shelved (`tag_books.shelved` for
  this tag only — not the book's total number of distinct tags). No `is_bad`
  filter and no minimum-ratings floor.
- Client-side sort buttons on Ratings, Avg rating and Shelved; rows carry
  `data-ratings`, `data-avg-rating`, `data-shelved`, `data-book-id`, and the
  table starts sorted by the report's ranking metric (`TAG_BOOK_SORT_SCRIPT`).
- Intro links to `https://www.goodreads.com/list/tag/<tag>` and
  `https://www.goodreads.com/shelf/show/<tag>` (new tab).
- Ratings form: one `tag_books` scan per tag. Shelf-count form: one CTE with
  `ROW_NUMBER()` per tag, so it is a true top-by-shelf-count rather than the
  ratings top-N re-sorted. Neither form adds a schema/index change.

## Genres / Tags

- Genres: `genres`, `genre_tag_xref`, `tag_books`. The Genres nav section now
  holds `genres/books-and-ratings` (implemented 2026/11/17): one row per genre
  with both the `/shelf/show/<slug>` and `/genres/<slug>` links and four
  client-side sortable columns — `Books` (1 per work), `Points` (genre position
  1 = 10, 2 = 9, …), `Ratings` (summed rating counts), `Weighted ratings`
  (ratings × position weight). Data is `books.genres` JSON (ordered), one row
  per work (work rep preferred), works with at least 1,000 ratings, all genres
  up to 2,000 (1,348 today). Ties break on genre name. See `PLAN-genres-tags.md`
  for the prototype CLI and decisions.
- MAYBE (not implemented): a `book_genre_xref(book_id, genre_name, position)`
  table could replace the per-publish JSON scan/parse of ~233k `books.genres`
  arrays and speed up generation. Recorded as a possible future model only,
  not in scope for the shipped report.
- Tags: `tag_stats`, `list_tag_walk_history`.

`list_tags` also backs the top-list-tags report (now under Lists) and the
optional tag links on the title reports (above). The **Tags** nav section is no
longer empty: it holds the books-on-tag-first-pages report above (planned).

## Future

- Shared `assets/style.css` instead of inline CSS.
- Pagination / client-side sort for large reports.
- Incremental generation (regenerate only changed reports).
- Site index / sitemap of all pages.
- Deploy step (rsync or git) — out of scope for now.
- `publish/` is gitignored (generated output, not source).

## Resolved decisions

- `work_id` vs `works`: Work ID = all books with a non-empty `work_id` (every
  edition); Works = `is_work_rep = 1` (one row per work).
- Book metric reports: **histogram + top-N table** for each metric.
- Page-count sort toggle: **client-side sort** on a single page.
- Lists: **top-N tables** (not histograms) from `list_meta` +
  `list_scrapes.list_name`; titles come from `list_scrapes`, not `lists`; links
  use numeric `list_id` / `creator_id`.
- Lists creator report: show **all** per-creator aggregates — lists created,
  books, voters, and likes — and make all four columns **client-side
  sortable** on one page.
- List creator links (every place a creator is shown: the per-list reports and
  the creators report) use
  `https://www.goodreads.com/list/created/<creator_id>`, not `/user/show/`
  (implemented).
- List metadata backfill: `list-meta-backfill` (`src/listMetaBackfill.ts`,
  `backfillListMeta.sh`) reads page 1 of every known list missing metadata,
  earliest-discovered first, and writes `list_meta` + sidebar `list_tags`
  without touching `list_scrapes` (no scrape date, no book rows).
  `--limit`/`--dryRun` supported; a dead list is skipped, throttling stops the
  run, and re-running resumes.
- Titles: three reports (first char, last char, first word) from a second
  title-only pass; first/last char rows require **>= 1,000 books**; first
  words are top `--limit` (default 1000). On `titles/first-char` and
  `titles/first-word`, a label links to `https://www.goodreads.com/list/tag/<label>`
  when the lowercased label exists as a `list_tags.tag_name`; otherwise it is
  plain text. `titles/last-char` is not linked. (Implemented.)
- List tags: the top `--limit` report lives under **Lists**
  (`lists/top-list-tags`, not `tags/`) and links each tag to
  `https://www.goodreads.com/list/tag/<tag>`.
- Publishers: two fixed 1,000-row tables from `book_page.publisher` — most
  books (distinct works, highest-rated edition per publisher/work) and most
  total ratings — with trimmed, exact-matched publisher names.
- Derived-stat reports: for Book ID, Work ID, Works, and Works (English), add
  `highest-skewness-min-100k`, `highest-variance-min-100k`,
  `lowest-kurtosis-min-100k` (all filtered on `books.ratings >= 100000`),
  `highest-review-ratio-min-1k` (filtered on `books.ratings >= 1000`),
  `highest-avg-rating-min-100k`, `highest-avg-rating-min-10k`, and
  `lowest-avg-rating-min-10k` (avg-rating rows filtered on `books.ratings >=
  100000`/`10000`); NULL stats are excluded, and the stats are per edition.
- Lower-threshold derived-stat additions (all four scopes):
  `highest-skewness-min-10k`, `highest-variance-min-10k`,
  `lowest-kurtosis-min-10k`, `highest-avg-rating-min-1k`, and
  `lowest-avg-rating-min-1k` (20 new pages).
- Opposite-direction derived-stat additions (all four scopes): lowest skewness,
  lowest variance, and highest kurtosis, at both min 100k and min 10k ratings
  (24 new pages). Same NULL-exclusion and per-edition rules; the six reports
  are interleaved beside their existing counterparts in the nav and in
  `DERIVED_REPORTS`.
- Min-100 derived additions (all four scopes): `highest-review-ratio-min-100`,
  `highest-avg-rating-min-100`, `lowest-avg-rating-min-100` (12 new pages), plus
  `avg-ratings-histogram-min-100` (4 new pages). No min-100 skewness/variance/
  kurtosis reports.
- Works (English): a sibling scope under Works, selecting the highest-ratings
  English edition per `work_id` and deduping by normalized title + author;
  works with no known English edition are excluded. Each Works and Works
  (English) page links to the same report in the other view.
- Avg-rating reports use `books.avg_rating` (2 decimals) rather than the
  histogram-derived fields; a missing/zero average is treated as unknown and
  excluded.
- Collapsible nav: no-JS `<details><summary>` per section; only the section
  containing the active report starts `open`; empty sections keep the `soon`
  badge and render as a plain heading; the sidebar scrolls.
- Book tables (Book ID / Work ID / Works, histogram top-N and derived-stat
  tables) link the author name to
  `https://www.goodreads.com/author/show/<author_id>` when `author_id` is
  present; otherwise the name is plain text.
- Author section adds `bottom-authors-by-avg-rating-min-10k` (ascending average
  rating, ties by more ratings then name), alongside the two top-average
  reports, plus `top-authors-by-avg-rating-min-1k` and
  `bottom-authors-by-avg-rating-min-1k` (min `num_ratings = 1000`).
- Overall adds `per-field.html`, a compact `fieldCoverage.sh` over the core
  tables (books, authors, book_page, tag_books, lists, list_meta, list_tags).
- Overall adds `ratings-histogram.html`, the `ratingsCoverageHistogram.sh`
  coverage histogram: the CLI rating brackets split into ALL / WORK-ID / WORKS /
  FIELD / WORK+FIELD, each shown as `#` plus `ROLLUP` (this bracket and above).
- Overall adds `publication-years.html` (`summary-year`), `books-added.html`
  (last 1000 days), and `authors-added.html`
  (`authorHist.sh --by day`): the same aggregate tables as the terminal
  reports, driven by `published`, `books.first_seen`, and `authors.first_seen`.
  They are not `--limit`-capped.
- Highest Rated by Year pages dedupe to one row per work: group by
  `books.work_id` when non-empty, else normalized title + author (`author_id`,
  falling back to lowercased name); keep the highest-ratings edition, tie →
  lower numeric book id. The title+author fallback is accepted: only ~9.2k of
  ~309k year candidates lack a `work_id`, and it matches the Works (English)
  de-dupe rule.

## Open questions

- Titles `# per title` / `# per title length`: exact grouping (raw vs
  normalized titles) and metrics.
