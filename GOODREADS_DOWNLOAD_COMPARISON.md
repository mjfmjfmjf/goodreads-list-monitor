# Goodreads "Interactive Download" — review/list page vs CSV export

Date: 2026/09/01
Scope: `https://www.goodreads.com/review/list/970632-mitchell-friedman?shelf=read&per_page=100`
(a real logged-in fetch, page 1 / 100 rows, 1,126,083 bytes HTML).

## What the interactive page contains

Every book row (`<tr class="bookalike review">`) carries 27 distinct `field` cells:

| field | visible? | content |
|---|---|---|
| checkbox | hidden | review id (`reviews[8908464811]`) |
| position | hidden | (empty) |
| cover | yes | cover image URL + book id (`data-resource-id="820075"`) |
| title | yes | title + `/book/show/<id>` link |
| author | yes | author name + `/author/show/<id>` link |
| isbn | hidden | ISBN10 |
| isbn13 | yes | ISBN13 |
| asin | hidden | ASIN |
| num_pages | yes | page count |
| avg_rating | yes | current average rating (e.g. 4.16) |
| num_ratings | yes | number of ratings (e.g. 5,490) |
| date_pub | yes | full pub date (May 01, 1991) |
| date_pub_edition | hidden | edition pub date (Oct 29, 1994) |
| rating | yes | my star rating + `data-rating` + rate endpoint |
| shelves | yes | all my shelves/tags with links (`read`, `childrens`, ...) |
| review | yes | review text (full copy in hidden span `freeText...`) + edit link |
| notes | hidden | private notes (empty → "None") |
| comments | hidden | comment count on my review |
| votes | yes | vote count on my review |
| read_count | yes | # times read |
| date_started | yes | date started reading (May be blank) |
| date_read | yes | date read/finished |
| date_added | yes | date added to library |
| owned | hidden | (empty in sample) |
| format | hidden | binding, e.g. Paperback + work editions link |
| actions | yes | edit / view / delete links + review id |

Notable IDs obtainable from the page but absent from CSV: **book id, author id,
review id, work id** (from `/work/editions/1310215`), ISBN10, ISBN13, ASIN.

## CSV export columns (23)

From `goodreads_library_export.20260823.csv`:

1. Book Id
2. Title
3. Author
4. Author l-f
5. Additional Authors
6. ISBN
7. ISBN13
8. My Rating
9. Publisher
10. Binding
11. Number of Pages
12. Year Published
13. Original Publication Year
14. Date Read
15. Date Added
16. Bookshelves
17. Bookshelves with positions
18. Exclusive Shelf
19. My Review
20. Spoiler
21. Private Notes
22. Read Count
23. Owned Copies

## Interactive page has that the CSV lacks

- **Cover image URL** (CSV has no image)
- **Book avg rating + num_ratings** — live current stats
- **ASIN** — CSV only has ISBN/ISBN13
- **Book id, author id, review id, work id** as opaque IDs (CSV keeps book id; the others are only derivable)
- **ISBN10 vs ISBN13** separate (CSV has both, so equal)
- **date_started** (when I began reading) — CSV only has Date Read/Added
- **Full pub date & edition pub date** (CSV reduces to Year Published / Original Pub Year)
- **votes / comments on my review**
- **read_count, date_added** (CSV has date_added & read count too)
- **per-shelf pagination** `?shelf=<tag>` — CSV only exports the whole library grouped by Exclusive Shelf
- Direct edit/rate/delete endpoints per row (interactive)

## CSV has that the interactive page lacks

- **Publisher** — confirmed absent from the page
- **Additional Authors** (page shows only first author)
- **Author l-f** (last, first) — page only shows "l-f" order actually (`Author l-f`: Scieszka, Jon shown as Scieszka, Jon) — both present on page? page shows `Scieszka, Jon` = l-f format
- **Year Published / Original Publication Year** as separate fields (page has date_pub but page only has full date; Year Published is a separate export field)
- **Bookshelves with positions** (page shows shelves but not per-shelf position)
- **Exclusive Shelf** label
- **Spoiler** flag
- **Owned Copies** count
- **ISBN** (page has it hidden — so equal)

## Hybrid recommendation

| want | use |
|---|---|
| everything | CSV (23 cols, one file) |
| live ratings / avg rating / num ratings / started date / review stats | interactive page |
| covers | interactive page |

The interactive page per book is ~11KB HTML vs a few hundred bytes CSV, and is
locked behind the login cookie. CSV remains the right bulk source; the page is a
good **add-on** (covers, live numeric stats, dates + IDs) but a poor replacement.

Implemented: `year-in-books --year <current> --live` walks the live
`review/list?shelf=read&sort=date_read` page (newest first) only until it
catches up to the last cached CSV export, then merges books read since that
export into the year's stats. See `src/reviewListSync.ts` (parser, new-vs-known
catch-up, pagination loop) + `src/reviewListSync.test.ts`.

## Throttle notes

1 live fetch only. Pagination is `per_page=100` with `page=N`. Respect the
existing ~2s delay between sequential live calls.