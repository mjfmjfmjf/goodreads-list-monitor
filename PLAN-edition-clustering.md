# PLAN: Edition clustering via Goodreads workIds

Status: infrastructure shipped, coverage growing, clustering not started.
Created 2026/08/22 after diagnosing edition-fragmentation bugs.

## Problem

Goodreads splits one "work" across many book IDs (formats, reprints,
translated titles). Our books db stores each ID as an unrelated row, so:

- ratings counts are split across editions
- suggestion engines compare editions of the SAME work as if they were
  different books (real case: Brian Sibley — db suggested swapping
  "The Lord of the Rings: The Trilogy" [40201113] for "The Lord of the Rings"
  [3862393]; both are editions of work 62400415, the latter being the BBC
  dramatization Sibley adapted, which is why his author id was on it)
- rankings and series positions can pick obscure editions

## What exists today (2026/08)

- `books.work_id TEXT` column (auto-migration in `db.ts`)
- `extractWorkId()` in `scraper.ts` — parses `/work/editions/{id}` from HTML
- Opportunistic capture: `scrapeBookDetails` (book-page path only — the
  author-page shortcut cannot see it) writes it via BookMetadata.workId
- **Author-scan capture (primary, since 2026/08/22)**: `scrapeAuthorStats` now
  parses the works table (`parseAuthorListBooks`) on every /author/list fetch
  and merges rows via `mergeBooksFromAuthorPage` (storage.ts) — improve-only:
  inserts unknown books; fills blank title/author/authorId/ratings/avg/
  published/workId; NEVER overwrites existing values. Logs per author:
  new/enriched counts + catalog page total (pagination max).
- Backlog capture: **bookSweep** (`./bookSweep.sh`, ex genreHarvest) selects
  books missing genres OR workId; COALESCE upsert guard prevents nulling

Verified facts about the site:
- 2026/08/22 CORRECTION: /author/list pages DO expose workIds — each works-table
  row carries an "N editions" link (`href="/work/editions/{workId}-{slug}"`).
  Verified on Stephen King page 1: 29 of 30 rows had one. The author scan is
  therefore the primary harvest source.
- workIds do NOT appear on list/shelf/user_vote rows and are NOT in the
  library export CSV (23 columns, edition-level Book Id only)
- Editions page lists the whole family:
  `https://www.goodreads.com/work/editions/{workId}?utf8=%E2%9C%93&per_page=100`
  Verified with work 62400415: single response, 26 distinct edition IDs, no
  pagination left at per_page=100.

## The play, once workId coverage is meaningful

1. Offline suspects report (zero network): cluster cached books by
   normalizeTitle + authorId; report groups containing >1 distinct id.
   Expect hundreds-to-low-thousands of clusters, prioritized by ratings.
2. Targeted family harvester (2 requests per cluster max):
   - representative's book page → workId (if unknown)
   - editions page with per_page=100 → every sibling book id
   - stamp work_id on ALL sibling rows (COALESCE-guarded update)
3. Consumers switch to grouping by work_id where editions matter:
   - pickSuggestionBook / computeReplacements operate per-work
   - work-level ratings = max (or sum?) across editions — decide then
   - series positions and audit reports gain work awareness

## Politeness constraints

- Never fetch book pages outside the existing throttle-aware pattern
  (bookSweep machinery: delay, jitter, consecutive-throttle exit)
- 2 requests/work ceiling for step 2; suspects list keeps volume tiny
- Strict-throttle mode applies to any live suite additions
