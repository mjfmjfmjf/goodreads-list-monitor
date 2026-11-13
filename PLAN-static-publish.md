# PLAN — Static publish (HTML reports)

Status: in progress — page shell, collapsible left nav, per-field coverage,
overall ratings histogram, author, book id, work id, works, works (English),
book detail (including publisher tables), lists, highest-rated-by-year, titles,
top-list-tags, and derived-stat book reports (including avg-rating top/bottom)
implemented; remaining titles reports, extended book sort fields, and genres
planned.
Created: 2026-11-11

## Goal

Publish reports from the local SQLite database as static HTML. Published locally
first (`./publish`), then pushed to a website. This is a long-lived surface:
new sections and reports will be added over time.

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
  author/          7 reports (see below)
  book-id/         five histograms + seven derived-stat tables (see below)
  work-id/         same twelve reports
  works/           same twelve reports
  works-en/        same twelve reports (English editions, deduped)
  book-detail/     by-language, by-format, by-page-count,
                   publishers-most-books, publishers-most-ratings
  titles/          first-char, last-char, first-word (see below)
  year/            27 reports (2026..2000, see below)
  lists/           7 reports (see below), incl. top-list-tags
  tags/            (no reports yet — Tag-specific reports only)
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

`per-field.html` is a compact `fieldCoverage.sh`: one table per core table
(`books`, `authors`, `book_page`, `tag_books`, `lists`, `list_meta`,
`list_tags`) with one row per column: populated, total, coverage %, missing, and
distinct (where a scalar distinct count is meaningful). Coverage predicates
match `fieldCoverage.sh` (e.g. `published` excludes `Unknown`/empty, `genres`
excludes `[]`, `tags` excludes `{}`).

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

## Author section (first pass)

Seven reports, up to 1000 authors each:

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
| `highest-variance-min-100k` | `ratings_variance` desc | `books.ratings >= 100000` |
| `lowest-kurtosis-min-100k` | `ratings_kurtosis` asc | `books.ratings >= 100000` |
| `highest-review-ratio-min-1k` | `reviews_count / books.ratings` desc | `books.ratings >= 1000` |
| `highest-avg-rating-min-100k` | `books.avg_rating` desc | `books.ratings >= 100000` |
| `highest-avg-rating-min-10k` | `books.avg_rating` desc | `books.ratings >= 10000` |
| `lowest-avg-rating-min-10k` | `books.avg_rating` asc | `books.ratings >= 10000` |

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
- Nav labels: `Highest Skewness (min 100k)`, `Highest Variance (min 100k)`,
  `Lowest Kurtosis (min 100k)`, `Highest Review Ratio (min 1k)`, `Highest Avg
  Rating (min 100k)`, `Highest Avg Rating (min 10k)`, `Lowest Avg Rating (min
  10k)`.

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
  2026-11-11 with the derived-stat pages, 74 pages; the Per Field aggregate
  adds a full `books` pass, and the Overall ratings histogram adds another).
  The English works pass adds one `book_page` join + window over the
  ~318k English work rows, deduped in memory; the live run now publishes ~100
  pages.
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

- One report per publication year, **2026 back to 2000** (27 reports).
- Each report ranks books by `books.avg_rating` (highest first), restricted to
  `books.ratings >= 1000`.
- Ties on `avg_rating` break by **more ratings first** (then larger book id).
- Rows with `is_bad = 1` are excluded.
- Each year uses a **fixed 1000-row cap** (`YEAR_REPORT_LIMIT`), independent of
  the global `--limit`.
- Columns: rank, title (Goodreads link), author, avg rating, `#ratings`,
  published year.
- Source: `books` (`published` for the year, `avg_rating`, `ratings`, `is_bad`).
  `published` is usually `Unknown` or a bare 4-digit year, sometimes
  `YYYY.MM.DD`; only the leading 4-digit year is used, and only years in
  2000–2026 are kept.
- The single book scan feeds both the ratings histograms and 27 per-year
  min-heaps; titles/authors for the surviving rows are resolved in the same
  chunked metadata lookup as the ratings top-N.
- This is the first section expected to hold many reports (27), so it is the
  motivating case for the collapsible nav.

## Lists (implemented)

Top-N tables (N = `--limit`, default 1000) over `list_meta` (~26k lists),
plus the **top list tags** report over the unified `list_tags` xref. List
titles come from `list_scrapes.list_name` (nearly every row has one); `lists`
only holds a few hundred rows, so it is not used. These are small tables, not
histograms.

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
desc, ties keep `creator_id` ascending, and `Likes` is `—` for creators with no
likes data and always sorts last. Only creators with a non-empty `creator_id`
are ranked (~16k distinct; a small number of lists have no creator id and are
excluded). The Creator cell uses the shared lists-created link described above.

Data: `list_meta` (`num_books`, `num_voters`, `num_likes`, `created_at`,
`creator_id`, `creator_name`) joined to `list_scrapes.list_name`. All ~26k
rows fit in memory, so this is a small single pass (unlike the 18.6M-book
pass).

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

## Genres / Tags (later)

- Genres: `genres`, `genre_tag_xref`, `tag_books`.
- Tags: `tag_stats`, `list_tag_walk_history`.

`list_tags` also backs the top-list-tags report (now under Lists) and the
optional tag links on the title reports (above). The **Tags** nav section is
empty — rendered with the `soon` badge — until a tag-specific report is added.

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
  reports.
- Overall adds `per-field.html`, a compact `fieldCoverage.sh` over the core
  tables (books, authors, book_page, tag_books, lists, list_meta, list_tags).
- Overall adds `ratings-histogram.html`, the `ratingsCoverageHistogram.sh`
  coverage histogram: the CLI rating brackets split into ALL / WORK-ID / WORKS /
  FIELD / WORK+FIELD, each shown as `#` plus `ROLLUP` (this bracket and above).

## Open questions

- Titles `# per title` / `# per title length`: exact grouping (raw vs
  normalized titles) and metrics.
