# EMRYS-IMPORT — working memory (emrys-import)

## What
We received a CSV from partner **Emrys**:
`~/Downloads/UCSD_90k_26th_August_2026_complete.csv` (~31.4 MB, 88,480 rows, 66 cols,
exported 2026-08-26). Named "UCSD 90k complete". Analyzed for its OWN sake; NOT
being imported into the Goodreads DB.

## What the file is
Standard Goodreads library-export header (first 32 cols) but with the personal
columns EMPTIED, plus 20 appended `genreN`/`genreN_rating_count` pairs and
`Goodreads_rating_count` + `work_id`.

## KEY FINDING — what the genre columns are (Emrys's tags)
Each `genreN`/`genreN_rating_count` pair is a RANKED SHELF/TAG list for the book,
sorted by how many Goodreads members shelved the book under that shelf. Counts are
DESCENDING across N (proof of rank order). EVERY book has exactly 20 tags
(avg 20.0; only 3/88,480 rows have none).
- **Header labels are SWAPPED**: the `genreN_rating_count` column actually holds the
  shelf/tag NAME; the `genreN` column holds the member COUNT.
- Column layout (0-indexed): for g=1..20,
  `genre<g>_rating_count` = col `24+(g-1)*2` (holds NAME),
  `genre<g>`           = col `25+(g-1)*2` (holds COUNT).
  `Index number`=23, `Goodreads_rating_count`=64, `work_id`=65.
- Top tags by distinct books: Fiction (65,774), Books I Own (58,261), Series (42,072),
  Romance (35,466), Fantasy (26,219), Contemporary (25,293), Audiobooks (22,461)…

## Confused/contradictory numbers to RESOLVE
- My standalone parse read `f[63]` as Goodreads_rating_count and got min 1 / avg 18 /
  max 2637 — WRONG. Correct column is 64; the analyze-csv tool earlier reported
  32..11,766,636. Verify Goodreads_rating_count range/meaning.
- DB size ticked: 1,265,722 books (not the ~1.05M in the last STATUS). DB books with
  work_id = 541,617.

## LOADED into the DB (2026-08-29) — emrys schema
Two tables added to goodreads.db (idempotent, DROP+recreate via `./emrys_load.tmp.mjs`):
- `emrys_books`: emrys_book_id PK, work_id, title, author, goodreads_rating_count.
  Indexed: work_id, goodreads_rating_count.
- `emrys_tags`: emrys_book_id, work_id, genre_position (1..20), genre_name, member_count.
  Indexed: genre_name, work_id. One row per (book, position), 20/row.
- Loaded: 88,480 books (88,480 distinct work_id; 88,457 have grc). 1,769,600 tag rows,
  of which 1,769,292 non-null genre_name; 88,458 books have all 20 tags, 3 books have 0.

## INTERNAL ANALYSIS — DONE (results)
Ran via `./emrys_int.tmp.mjs` on the emrys tables. Results:
- TOP TAGS by distinct books (avg position 1..20 = how early the tag ranks):
  Fiction (65,774 books, avgPos 6.0), Books I Own (58,261, 10.6), Series (42,072, 8.7),
  Romance (35,466, 4.4), Fantasy (26,219, 5.4), Contemporary (25,293, 8.0),
  Audiobooks (22,461, 13.0), Audio (21,149, 13.0), Mystery (19,481, 5.6), Adult (19,464, 13.7),
  Owned Books (19,395, 14.9), Young Adult (18,199, 5.7), Non Fiction (16,233, 3.2),
  My Library (15,802, 14.9), Nonfiction (15,083, 5.6), Historical Fiction (14,401, 5.4),
  Ya (13,524, 7.5), Ebooks (13,342, 14.3), To Buy (13,194, 14.8), Historical (12,851, 8.3),
  Contemporary Romance (12,630, 7.2), Audible (11,820, 13.2), Thriller (11,746, 7.2),
  Paranormal (11,249, 6.0), Adventure (10,721, 11.5).
- NON-NULL tags per position: pos1..20 all ~88,458–88,477 → nearly every book has all 20.
- TAGS PER BOOK: 88,458 books have exactly 20; 3 books have 0; a small handful have 1/9/11/12/13.
- Goodreads_rating_count (CORRECT col 64): min 32, avg 19,236, max 11,766,636, 23 nulls.
  => high-ratings corpus (avg ~19k ratings/book), NOT a personal library.
- RESOLVED the contradictory numbers: 32..11.7M is correct; the earlier min1/avg18/max2637
  was from reading the wrong column (f[63] vs f[64]).

## CROSS-DB — DONE (2026-08-29)
- HANG ROOT CAUSE: NOT the index and not lock contention. SQLite emits pathological
  O(emrys × books) ≈ 88k × 1.27M nested-loop plans for BOTH anti-join forms:
  - `NOT EXISTS (...)` → plan is FULL "SCAN b USING COVERING INDEX idx_books_work_id_tmp"
    as the inner loop of the correlated subquery (re-scans all ~1.27M books per emrys row).
  - `LEFT JOIN books b ... WHERE b.work_id IS NULL` → plan is "SCAN b ... LEFT-JOIN" =
    same full books-index scan as inner loop. No SEARCH lookup despite the index.
  - `EXCEPT` avoids the hang (linear MERGE) BUT IS WRONG HERE: set ops compare raw values
    with no affinity coercion, so TEXT work_ids in books never equal INTEGER work_ids in
    emrys → returned all 88,480 ("nothing matches"). Do NOT use EXCEPT across the two tables.
  - `NOT IN (SELECT CAST(work_id AS INTEGER) FROM books WHERE work_id IS NOT NULL AND ...)`
    uses bloom filter + index search and is fast (~150ms). This is the working anti-join.
- TYPE MISMATCH: `books.work_id` is TEXT, `emrys_books.work_id` is INTEGER. JOINs coerce
  text→numeric by affinity and match fine, but any exact/set comparison must CAST. Also
  ~741,918 books rows have NULL work_id (of ~1.29M total).
- DB IS LIVE: writer processes (author-rescan, bulk-audit, monitor, server) are actively
  inserting rows — counts DRIFT between runs (distinct DB wids 533,023 → 537,172 and
  matched 55,207 → 55,234 across ~30min). Re-run `./emrys_cross.tmp.mjs` any time; treat
  non-distinct-DB numbers as a moving target.
- RESULTS (snapshot 2026-08-29 ~20:10Z; live DB):
  - 55,234 / 88,480 emrys work_ids ALREADY in DB (62.4%) | 33,246 NEW to DB (37.6%).
    Sanity: 55,234 + 33,246 = 88,480 exactly.
  - Overlap of emrys top-25 tags vs DB genre/tag vocab (243 distinct names): 14 of the
    top-25 exist in the DB vocab (Fiction, Romance, Fantasy, Contemporary, Mystery, Adult,
    Young Adult, Nonfiction, Historical Fiction, Ebooks, Historical, Contemporary Romance,
    Thriller, Paranormal, Adventure). DB coverage is SPARSE: only 211 books have `genres`
    (222 distinct names) and 4,055 have `tags` (21 distinct keys, lowercase slugs). Emrys
    is 3 orders of magnitude richer on shelf/tag data than the DB currently stores.
- UPDATE `emrys_cross.tmp.mjs` now does the full analysis: JOIN-match, CAST anti-join
  (with sanity check), distinct DB wids, DB vocab, and top-25 tag overlap, in one pass.

## Re-run candidate
`./emrys_load.tmp.mjs` is the loader (idempotent). If this becomes a recurring "compare an
external shelf-tag CSV against the DB" tool, promote it (with the emrys tables + loader +
analyze scripts) into `emrys-import.sh` + src modules. Not promoted yet.
Scratch analysis scripts present: `./emrys_load.tmp.mjs`, `./emrys_int.tmp.mjs`,
`./emrys_cross.tmp.mjs`, `./emrys_analyze.tmp.mjs`, `./idx.tmp.mjs`, `./ucsd_*` files.

## Progress notes
- 2026-08-29: confirmed genre-column semantics (ranked shelf tags). Built emrys tables &
  loaded CSV (88,480 books / 1,769,600 tags). Internal analysis done. Cross-DB join initially
  appeared to hang — root caused: pathological nested-loop plans for NOT EXISTS / LEFT JOIN
  anti-joins (88k×1.27M), EXCEPT broken by TEXT-vs-INTEGER work_id, DB is LIVE+writes. Fixed
  with CAST anti-join (NOT IN). Cross-DB results: 55,234 emrys books already in DB, 33,246 new;
  14/25 top tags seen in DB vocab. User asked to keep this in the plan file rather than burn
  time re-running.
