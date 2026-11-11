# PLAN — Static publish (HTML reports)

Status: in progress — page shell, left nav, author, book id, work id, works, and
book detail reports implemented; titles, highest-rated-by-year, lists, genres,
and tags planned.
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

## Output layout (current)

```
publish/
  index.html
  author/          6 reports (see below)
  book-id/         ratings, reviews, currently-reading, to-read, edition-count
  work-id/         same five reports
  works/           same five reports
  book-detail/     by-language, by-format, by-page-count
```

## Page shell

- Left sidebar navigation; main content to the right.
- Content `<h1>` title, with `Last generated: <UTC>` immediately below in
  smaller, muted text.
- Self-contained CSS inlined for now (extract to `assets/style.css` later).
- Nav sections: **Overall, Author, Book ID, Work ID, Works, Book Detail,
  Titles, Highest Rated by Year, Lists, Genres, Tags.**
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

## Author section (first pass)

Six reports, up to 1000 authors each:

| page | sort field | min ratings |
| --- | --- | --- |
| `top-authors-by-ratings` | `numRatings` | 0 |
| `top-authors-by-reviews` | `numReviews` | 0 |
| `top-authors-by-shelves` | `numShelves` | 0 |
| `top-authors-by-catalog-pages` | `catalogPages` | 0 |
| `top-authors-by-avg-rating-min-100k` | `averageRating` | 100000 |
| `top-authors-by-avg-rating-min-10k` | `averageRating` | 10000 |

Columns: `#`, `Author`, then the report's **entry attribute**, then the remaining
attributes (`Ratings`, `Reviews`, `Shelves`, `Catalog pages`, `Avg rating`).

- Author cell: link text = author name; `href` =
  `https://www.goodreads.com/author/show/<id>`.
- Counts formatted with thousands separators; average rating to 2 decimals.

Data: `authors` table (`num_ratings`, `num_reviews`, `num_shelves`,
`catalog_pages`, `average_rating`) via
`selectAuthors(iterateAuthors(), …)`.

## Book ID / Work ID / Works (implemented)

- **Book ID** = all editions (`books`).
- **Work ID** = books with a non-empty `work_id`.
- **Works** = distinct works (`books.is_work_rep = 1`, equivalently one row per
  `work_id`).
- Each section has five reports: `ratings`, `reviews`, `currently-reading`,
  `to-read`, `edition-count`.
- Each report is a **histogram + top-N table** (N = `--limit`).
- Sources: `books.ratings`; `book_page.reviews_count`,
  `book_page.currently_reading`, `book_page.to_read`,
  `book_page.editions_count`. `book_page` coverage is partial, so these reports
  state their denominator: "Based on N books with <metric> data (of M books in
  scope)."
- Buckets: powers of ten for the count metrics; finer buckets for edition count.
- Work ID and Works tables add a Work ID column linking to
  `https://www.goodreads.com/work/editions/<work_id>`.

## Book Detail (implemented)

Frequency pages:

- `# per language` (`book_page.language`)
- `# per format` (`book_page.format`)
- `# per page` (`books.pages`), with **client-side sort** buttons: by page
  value or by number of books at that page count.

## Performance

- A full run over the live DB (~18.6M books) takes ~2 minutes; the `books`
  pass dominates.
- That pass selects only `id, ratings, work_id, is_work_rep, pages` (no
  title/author strings) and resolves title/author for only the surviving
  top-N ids afterwards. One joined pass over `book_page` (~411k rows) handles
  the detail metrics.

## Titles (next)

Reports over `books.title` — the title string itself, not a book's ratings
(those live under Book ID / Work ID / Works):

- `# per title` — most common exact titles (e.g. "The Odyssey" across
  editions), with the number of book ids and the number of distinct authors.
- `# per title length` — frequency of title character length (and optionally
  word count).
- Open: whether to normalize titles (case, punctuation, leading articles)
  before grouping, and whether to exclude `is_bad` rows.

## Highest Rated by Year (next)

- One report per publication year, **2026 back to 2000** (27 reports).
- Each report ranks books by `books.avg_rating` (highest first), restricted to
  `books.ratings >= 1000`.
- Columns: rank, title (Goodreads link), author, avg rating, `#ratings`,
  published year.
- Source: `books` (`published` for the year, `avg_rating`, `ratings`).
- This is the first section expected to hold many reports (27), so it is the
  motivating case for the collapsible nav (see Future).
- Open: tie-breaking (e.g. more ratings first), whether to exclude `is_bad`
  rows, and whether the top-N per year uses the global `--limit` or a smaller
  fixed count.

## Lists / Genres / Tags (later)

- Lists: `lists`, `list_meta`, `list_scrapes`, `list_tags`.
- Genres: `genres`, `genre_tag_xref`, `tag_books`.
- Tags: `tag_stats`, `list_tags`, `list_tag_walk_history`.

## Future

- Shared `assets/style.css` instead of inline CSS.
- Pagination / client-side sort for large reports.
- Incremental generation (regenerate only changed reports).
- Site index / sitemap of all pages.
- **Collapsible left-nav sections (expando).** A section may eventually hold
  dozens of reports, so the sidebar must not show them all at once. Render each
  section as a collapsible group (preferred first cut: no-JS
  `<details><summary>`, collapsed by default except the section containing the
  active report), keep the `soon` badge on empty sections, and let the sidebar
  scroll. This is the mechanism that lets new reports be added without
  redesigning the nav.
- Deploy step (rsync or git) — out of scope for now.
- `publish/` is gitignored (generated output, not source).

## Resolved decisions

- `work_id` vs `works`: Work ID = all books with a non-empty `work_id` (every
  edition); Works = `is_work_rep = 1` (one row per work).
- Book metric reports: **histogram + top-N table** for each metric.
- Page-count sort toggle: **client-side sort** on a single page.

## Open questions

- Titles section: exact grouping (raw vs normalized titles) and metrics.
- Collapsible nav: `<details>` vs JS, and which section starts expanded.
