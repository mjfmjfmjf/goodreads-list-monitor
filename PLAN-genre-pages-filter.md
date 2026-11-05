# PLAN: Add genre + pages filters to books command

> **IMPLEMENTED 2026/10/18, then amended same day:** the xref filter shipped as
> `--tag` (not `--genre`), and a separate `--genre` was added that matches the
> `books.genres` JSON column case-insensitively (populated on ~240k
> browser-scraped books — that curated set was the point of the split). Both
> flags combine with AND semantics. No new indexes were needed.

## Goal
Add `--genre`, `--minPages`, `--maxPages` to `books` so users can do:
```bash
./books.sh --genre fiction --minPages 100 --minRatings 100 --dedupe --sort avgRatings --asc --limit 50
```

## Design decisions (per user)
- **Genre resolution uses the tag xref tables, exact match only** — no regex, no
  `book.genres` JSON scanning. `--genre fiction` resolves via
  `genre_tag_xref.genre_name = 'fiction'` (exact), then each mapped tag's
  book set via `tag_books.tag_name = ?` (exact).
- **`--sort avgRatings` must exclude books with missing/0 avgRating** (required,
  not a follow-up — see "avgRatings fix" below).

## Index audit (verified 2026/10/17 — NO new indexes needed)
| Access path | Plan | Verdict |
|---|---|---|
| `genre_tag_xref WHERE genre_name = ?` | COVERING INDEX `sqlite_autoindex_genre_tag_xref_1` (PK prefix) | covered |
| `tag_books WHERE tag_name = ?` | COVERING INDEX `sqlite_autoindex_tag_books_1` (PK prefix) | covered |
| `tag_books WHERE book_id = ?` | full SCAN (no book_id index) | **avoid** — never do per-book lookups; build the id Set once |

Data sizes: `genre_tag_xref` 653 rows (224 exact / 14 cognate / 415 similarity);
`tag_books` 4.57M rows over 4,084 distinct tags.

## Changes needed

### 1) src/books.ts
- Add to `BooksOptions`: `genre?: string`, `minPages?: string`, `maxPages?: string`.
- Parse pages: `minPages = options.minPages ? parseNum(options.minPages) : 0;`
  `maxPages = options.maxPages ? parseNum(options.maxPages) : Infinity;`
- Genre filter — build a `Set<string>` of matching book_ids ONCE up front
  (cache it module-scope with the other maps + clear in `resetBooksCaches()`):
  - Lowercase/trim the input (tag names are stored lowercased; genre names are
    slugs like `science-fiction`).
  - `SELECT tag_name FROM genre_tag_xref WHERE genre_name = ?` (exact; all
    kinds — exact/cognate/similarity — count, the xref is the genre→tag map).
  - For each tag: `SELECT book_id FROM tag_books WHERE tag_name = ?`, add to Set.
  - If the genre has no xref rows and no tag_books tag of that name: error out
    with a hint (list near-matches if cheap, or point at genre_tag_xref
    seeding), same spirit as genrePairings' "scrape it first" message.
  - Memory: Set of string ids only (a large genre ≈ ~1M ids) — fine, and
    nothing like the forbidden `loadBookCache` full-row materialization.
- In the stream loop (after the year check):
  - Pages: `const pages = parseNum(book.pages); if (pages < minPages || pages > maxPages) continue;`
    Unknown pages → 0 → auto-excluded whenever `--minPages >= 1`.
  - Genre: `if (genreSet && !genreSet.has(book.id)) continue;`
- **avgRatings fix (required):** `valueOf` currently does
  `parseFloat(book.avgRating || '0')`, so null/0-rated books sort FIRST under
  `--asc`. Mirror the existing derived-stat exclusion (lines 446–449, "only
  books that actually HAVE the stat"): when `sortBy === 'avgRatings'`, skip
  books whose parsed avgRating is not `> 0` — both directions, consistent with
  the derived-stats behavior. Update the `valueOf` comment if needed.

### 2) src/index.ts (CLI)
- `.option('--genre <name>', 'Filter to books in this genre/tag (exact match against genre_tag_xref, e.g. fiction, science-fiction)')`
- `.option('--minPages <number>', 'Only include books with at least this many pages')`
- `.option('--maxPages <number>', 'Only include books with at most this many pages')`
- Pass through to `runBooks`.

### 3) books.sh (help text)
- Usage: `--genre <name> [--minPages N] [--maxPages N]`
- Example: `./books.sh --genre fiction --minPages 100 --minRatings 100 --dedupe --sort avgRatings --asc --limit 20`

### 4) src/books.test.ts
- Genre: xref hit → Set built → filter works; unknown genre → errors; exact
  match is case-insensitive; a book under a non-mapped tag is excluded.
- Pages: min/max bounds; unknown pages excluded under `--minPages`.
- avgRatings: `--sort avgRatings --asc` never returns null/0-rated books.

## Notes
- `iterateBooks` already pushes `minRatings` to SQL; pages/genre filter in JS
  (streaming, top-N retained in memory) — regex/JSON approaches discarded.
- "De-duped works" means `--dedupe` (keeps `is_work_rep` with
  English-edition preference when known).
