# PLAN: Tag "recent" monitor — tail-scrape every covered tag to find new books/authors

Status: **SHIPPED 2026/09/30** (user approved the design: "this is ready. go").
Implemented: `./tagRecentMonitor.sh` = `npm run tag-recent-monitor` =
`node src/index.ts tag-recent-monitor`. Gates green: `tsc --noEmit` clean,
71 test files / 830 unit tests, 2 CLI smoke tests. Live `--dryRun` verified
(exit 0, ~1m03s to load tag_books + compute the 2,893-tag order).
Created 2026/09/30. Feature request from the user: a new recent-monitoring
project that, for each tag the set-cover needs to reach 100% coverage, re-reads
the tail of that tag's shelf to discover NEW books and NEW authors.

## As-built notes (deviations / discoveries during implementation)

- **A tail read aimed past a shrunk shelf re-anchors instead of bailing.**
  `japanese-mythology` (2026-10-01): the xref has 509 rows with max position
  509 → anchor page 11, but the shelf is now 10 pages (9 stale rows sit at
  501-509 from books that have since come off the shelf). The old bail-out cost
  two requests and harvested *page 1* — the least useful page on a shelf — for
  `+0 new books`, every pass, forever. `reanchorShelfPage` (pure, unit-tested)
  now falls back to the last page the footer admits exists, once: the scan
  re-anchors to page 10 and reads the real tail. The second refusal (footers
  disagreeing) still bails. Residual cost is one refused request per affected
  tag per pass, because the stale xref rows are kept — see the open question
  below.
- **Coverage scoring caps a tag at the harvest ceiling (1,250 books).** Because
  every harvest stops at 25 pages x 50 books, a tag's xref row count above
  1,250 is `(tag, position)` drift, not extra coverage — yet the greedy scored
  the raw count, so a tag with 1,271 drift rows outranked a clean 1,250 harvest
  for no reason. `computeTagCoverage` now scores `min(pending, 1,250)`
  (`SHELF_HARVEST_BOOK_CAP`), and `tieBreakWins` caps its size comparison the
  same way. Scoring only: `pendingCount` stays EXACT, because capping the
  countdown zeroes it while uncovered books remain and strands the tail below
  100% (caught by the new regression test — it stopped at 99.2%). A pick still
  contributes every uncovered book, so `newBooks` can exceed the score and the
  100% guarantee is intact. With the cap, hundreds of big tags tie *exactly* and
  the tie-break (shelf size, then average rating) decides — so the head of the
  order is stable for a given dataset but reshuffles when the data shifts.
- **A completed pass is re-checked in full next run — hence `--minAgeHours`.**
  The 2026-10-01 pass finished all 2,893 tags, and the next morning's run started
  over from the top (correct: the pass was marked done so nothing is missed).
  The covered list itself is recomputed each run and legitimately changes — the
  xref grew 779,992 → 781,579 books, needing 2,888 tags instead of 2,893 — and
  the ORDER reshuffles at the head because every harvest is capped at 25 pages
  (~1,250 books), so hundreds of tags tie exactly on marginal gain and
  `tieBreakWins` (shelf size, then average rating) decides; one new book flips
  it. Note the per-tag log's old "covers X%" was the *cumulative* coverage, not
  the tag's own share — now printed as `+N new to the cover · X% cumulative`.
- **Open question for the user: should we prune xref rows past a shelf's real
  end?** Deleting `tag_books` rows with `position > advertisedPages * 50` would
  heal the anchor (and stop double-counting `COUNT(*)`), but `tag_books` is also
  the coverage universe the greedy set-cover runs over, so pruning changes the
  2,893-tag order. Not done.
- **The anchor is lowered to a shorter measured page count** (`pickAnchorPage`,
  pure + unit-tested) so the stale-max-position case costs ONE fetch instead of
  two: the monitor no longer has to spend a request discovering that its start
  page is past the end. It can only lower, never raise, so a shelf that grew
  still walks forward from the xref page and finds its new books. The two fixes
  compose: the re-anchor makes the *last* fetch of a refused tag land on the
  footer's real length (so `last_page_seen` stops being inflated by the page-1
  probe), and this turns that corrected value into a 1-fetch read next pass.
- **`(tag_name, position)` is NOT unique — 1-3% of xref rows sit at a position a
  different book also claims.** A shelf page renders *~50* `.elementList` rows
  but only the ones carrying a real `/book/show/<id>` href parse as books (a
  quilting page 25 logged "52 books on page" and harvested 50), and the page's
  book set drifts between harvests, so an old book keeps a position a newer
  harvest gave to a different book (quilting 1249/1250 each hold two). The
  `📚` log line now reports `N book(s) from M shelf row(s)` and bases its
  [Top]/[Bottom] diagnostic on the *parsed* books, since a trailing non-book row
  used to suppress the [Bottom] line entirely. This drift is why the global
  `MAX(position)` is exactly 1,250 and no tag's xref anchor exceeds page 25 —
  the clamp stays a safety net, not a load-bearing correction.
- **The tail anchor comes from the tag_books xref — not any page count.** The
  first implementation used `getKnownShelfPages`, which is
  `COALESCE(last_page_seen, estimate_page)` — and `estimate_page` is a
  backfilled `shelf_book_count / 50` guess. The live `--dryRun` immediately
  exposed this: "manga" reported a *known last page of 125,293*. Restricting
  the anchor to a *measured* `last_page_seen` (`getMeasuredShelfPages`) fixed
  the estimate but left ~1,200 tags with no anchor at all, i.e. a full read
  from page 1 (up to 25 fetches each) — the real fix is the xref. `tag_books.position` is the book's
  GLOBAL 1-based shelf position (`bookPos = (startPage - 1) * 50` in
  `scrapeShelfBooks`, so 50 books/page), and there is already an index
  `idx_tag_books_position(tag_name, position)` on it. So the last page we
  actually harvested for a tag is just `ceil(MAX(position) / 50)` — no live
  request, always a page we can fetch. `loadTagAnchors` fetches
  `COUNT(*)`, `MAX(position)` and `last_page_seen` for the whole covered list
  in one chunked query (1.3s for all 4,084 tags).
  Live check: `tag_books` is **4,565,515 rows** and essentially every tag's
  harvest runs to position 1,250 = **page 25**, i.e. the harvests are all
  saturated at the same 25-page ceiling. So all 2,893 covered tags anchor at
  page 25 (or their own last page) and each costs ~1 fetch — versus the
  page-1 fallback, which would have cost up to 25 fetches for the ~1,200 tags
  with no measured page count. A harvest much sparser than its max position
  (e.g. only pages 7-11 were ever read) means there are gaps below us, so the
  anchor drops to page 1 and the footer stops the read (a too-low anchor only
  costs extra pages; a too-high one 404s).
- First pass cost is therefore ~1 fetch per tag (~2,900 requests), not the
  ~30,000 a page-1 fallback implied. The header prints the anchor-source split
  on every run.
- Pure decision helpers kept exported + unit-tested: `tailAnchorPage`,
  `tailReadWindow`, `needsTailReprobe`, `shouldResumePass`.
- `--dryRun` previews the first 25 covered tags, touches no network, and
  writes no pass state.
- The shrink/overestimate re-probe only re-reads the tail when the re-measured
  length actually *shrank*; a merely flaky page keeps its length, is left for
  the next pass, and costs only the one probe.
- **The measured page count is NOT reliably reachable — clamp at page 25.** The
  first live run showed `❌ Error fetching shelf page 100: 404` for "biology",
  "teen-reads", "police-procedural" …: the pagination footer advertises a
  `last_page_seen` of 100 for these shelves, but Goodreads only serves shelf
  content up to ~page 25. So a tail start of 100 404s every time, which then
  triggered a wasted page-1 re-probe, and the pass harvested nothing.
  `tailReadWindow` now clamps the start (and the outer wall) to
  `MAX_REACHABLE_SHELF_PAGE = 25`; a capped tag costs exactly one fetch.
  (Note: an anonymous curl of `?page=100` returns HTTP 200, but the page carries
  no pagination block and a soft/empty grid — the crawler's 404 is the
  authoritative "not reachable" signal.)
- **The re-probe's books are now kept.** Previously the page-1 probe's ~52 books
  were discarded when the shelf length turned out unchanged, throwing away a
  full cookie-paced fetch; they are now synced either way.
- Not implemented (available if wanted): a per-pass budget on the *number of
  tags* (`--limit` already does this) beyond the plain resume/resume-horizon
  controls — the unmeasured-read cost this would have bounded is now gone
  (every covered tag has an xref anchor).

## Goal (from the user)

1. Produce the ordered tag list with `./tagCoverage.sh --limit 20000` (greedy
   set-cover: tags picked most-new-books-first; the loop stops at 100%).
2. For every tag in that list, scrape its **last page** — but use existing
   history (`tag_stats.last_page_seen` / `estimate_page`) to know what the
   last page *was*. Example: the shelf was previously 16 pages; if the live
   footer now says it is 17, read page 16 **and** the new last page 17.
3. This is a **regular tag page scrape** (`scrapeShelfBooks`) whose point is to
   find new books and new authors (books that only recently reached the tail).
4. If the walk is restarted mid-run, it must **start over from the last
   stopping point** — so we persist where the interrupted pass got to.
5. We only need to read **until 100% coverage** is reached (the set-cover's
   own stop), not the full 4,084-tag universe.

Grounding confirmed for this plan (fresh reads, 2026/09/30):

- Coverage engine: `computeTagCoverage` in `src/tagCoverage.ts:26` — greedy
  incremental set-cover, stops when `covered.size >= totalBooks` or `limit`.
  Live DB right now: **779,943 unique books across 4,084 tags; it picked 2,893
  tags to reach 100%** (compute 4.7s, total CLI run 45.8s — the load is the
  cost). So the walk set is 2,893 tags, NOT 4,084.
- `./tagCoverage.sh --limit 20000` = `npm run tag-coverage -- --limit 20000`
  (index.ts:440 → `runTagCoverage`). For the walker we call
  `computeTagCoverage` directly so we get the ordered tag list programmatically.
- Shelf tail mechanics: `scrapeShelfBooks(tag, minTags, maxPages, startPage, opts)`
  in `src/scraper.ts:321`. It starts at `startPage`, reads the pagination footer
  on the first fetch (`extractShelfPageLinks`, last element = live total),
  follows `rel=next`, and breaks at `page >= totalPages` (line 473). It also
  ensures an empty page (0 `.elementList`) stops the walk (lines 385-391) — the
  2026-09-11 phantom-page fix — so a loved shelf never spins. It persists
  `tag_books` membership (upsertTagBooks) and `tag_stats.last_page_seen`
  (persistShelfPageCount) itself.
- History source: `getKnownShelfPages(tag)` in `src/storage.ts:439` =
  `COALESCE(last_page_seen, estimate_page)` (measured first, estimate fallback).
  Current DB: 3,348 tag_stats rows (2,309 measured, 1,042 estimate-only),
  736 tags in tag_books have **no** tag_stats row at all.
- Resume patterns already in the codebase: `list_scrapes` table +
  `shouldSkipList(…)` (listTagWalker.ts:37, skip-window), and newTagWalker's
  "an interrupted walk resumes on re-run". We extend the run-scoped idea
  precisely (see Resume below).

## How the per-tag tail scrape works

For each tag in coverage order, the read is a single `scrapeShelfBooks` call:

```
known  = getKnownShelfPages(tag)         // e.g. 16 (or null)
start  = known ?? 1                      // unknown => read from page 1 once (also measures it)
books  = scrapeShelfBooks(tag, 0, maxPages=25, startPage=start, { skipAuthorSync: true })
```

- Unchanged shelf (footer still 16): reads page 16 only (`totalPages=16`,
  `page >= totalPages` breaks after page 16). ✓ the last page is re-read, so a
  book that newly reached the tail this week is caught even if the shelf didn't
  grow.
- Shelf grew 16 → 17: reads page 16, footer says 17, follows to page 17, breaks
  after page 17. ✓ "read page 16 and then read new last page".
- Grown by more: reads 16..live-last, bounded by `totalPages` from the footer
  (and `maxPages`=25 as an outer bound — the "should this page be 25" history
  check).
- Unknown count (`known == null`, 736 tags have no tag_stats row): start at
  page 1 and let the footer drive the stop; this one pass measures and records
  `last_page_seen`, so every later pass reads only the tail. Self-correcting.
- **Edge — shelf shrank** (footer `totalPages < startPage`): `scrapeShelfBooks`
  prints "⚠️ Nothing to scan" and returns empty (scraper.ts:366-369). A monitor
  treats this as "re-probe from the new last page": on an empty result whose
  known>1, re-call with `startPage = totalPages` (second footer read already
  available) — 1 extra fetch, vanishingly rare. See Edge cases.

Then, mirroring newTagWalker (src/newTagWalker.ts:140-170) for book/author sync:

```
bookOutcome  = syncBooksToCache(books, {})        // inserted = NEW books found
authorAdded  = syncAuthorsToCache(books, authorCache)   // minted authors
```

`authorCache` is loaded ONCE per run (loadAuthorCache) and passed in — we do
NOT let `scrapeShelfBooks` do its own per-call author sync (`skipAuthorSync`),
so we can count new authors exactly. `scrapeShelfBooks` already wrote
`tag_books` (positions/shelved counts for the tail books) and refreshed
`tag_stats.last_page_seen`.

Per-tag log line (📚 style of the other walks): tag, `known → live` page span,
books read, `+new books`, `+new authors`; running totals. Every network op goes
through `withConnectivityProbe` and the walk paces 1–3s between tags
(`delay(1000,3000)`), exactly like newTagWalker.

## Resume ("start over from last stopping point")

We need to know where the interrupted pass got to *and* still re-check
everything on a genuinely new, later pass. Two tables (schema in `db.ts`, same
CREATE-IF-NOT-EXISTS pattern):

```
CREATE TABLE IF NOT EXISTS tag_tail_scrapes (
  tag_name       TEXT PRIMARY KEY,
  last_scraped   TEXT NOT NULL,      -- ISO; updated every time the tag is tail-scraped
  last_page_seen INTEGER,
  books_added    INTEGER,
  authors_added  INTEGER
);

CREATE TABLE IF NOT EXISTS tag_tail_monitor_state (
  id              TEXT PRIMARY KEY,  -- single row: '1'
  run_started_at  TEXT NOT NULL,
  run_completed   INTEGER NOT NULL DEFAULT 0
);
```

- **Run start**: read the state row. If `run_completed = 0` **and**
  `run_started_at` is recent (same pass), this is a restart → resume: skip any
  tag whose `last_scraped >= run_started_at` (i.e. already done in this pass).
  Otherwise start a new pass: `run_started_at = now`, `run_completed = 0`.
- **Per tag**: on success store `last_scraped=now` (+ page span + counts).
- **Pass end** (walked through the tag that hit 100%): set `run_completed = 1`.
  The next invocation then begins a fresh pass and re-reads every tail again —
  which is what a *recurring monitor* wants.

This is precise crash-resume: a killed run restarts at the first un-scraped
tag; a monitor run a week later re-checks everything. It reuses the existing
`list_scrapes`-style table idiom plus a single tiny state row. Simpler
alternative (skip-window only, "skip tags tail-scraped within N days") loses
exact restart, so the state-row approach is the recommendation.

## CLI / wiring (to add when implemented)

- `src/tagRecentMonitor.ts` — `runTagRecentMonitor(options)`, new module.
- `src/index.ts` — `.command('tag-recent-monitor')`, options:
  - `--limit <number>` (coverage cap, default `20000`, effectively "all needed")
  - `--dry-run` (print the ordered tag list + known page span + skip set; no network)
  - `--fresh` (ignore the in-flight pass, force a new full pass)
  - `--shelfPages <number>` (outer page bound, default `25`)
  - `--minAgeHours <number>` (age gate, default `0` = off): skip a covered tag
    whose tail was read within this many hours. A pass re-checks EVERY covered
    tag and a stable shelf yields nothing, so this is what makes a recurring run
    cheap — the first full pass (2026-10-01, ~2,890 tags) is what makes the
    following ones nearly free. Set it to your re-check cadence (`168` = weekly).
    Skips are counted, not logged per tag, and never saved as a pass row.
  - `--resume-horizon-hours <number>` (how "recent" a restart must be to resume;
    default e.g. `36`) — present only if we keep the horizon guard.
- `./tagRecentMonitor.sh` wrapper (mirror `./gapGenreTagDiscovery.sh`):
  `npm run tag-recent-monitor -- "$@"`, `caffeinate -is` note in the header.
- `package.json` script `"tag-recent-monitor": "NODE_OPTIONS='--loader ts-node/esm --no-warnings' node src/index.ts tag-recent-monitor"`.
- `src/tagRecentMonitor.test.ts` — pure logic only (no network): resume/skip
  decision, pass-complete flip, deterministic coverage-order walk, shrank-shelf
  re-probe decision, dry-run list. Mirror `src/newTagWalker.test.ts` structure.
- `src/db.ts` schema (two tables above) + `src/storage.ts` helpers:
  `upsertTagTailScrape`, `loadTagTailScrape`, `loadTagTailState`,
  `saveTagTailState`.

## Politeness / runtime / operations

- The walk reuses `scrapeShelfBooks`, which already spaces page requests
  2–5s anonymous / 4–10s cookie and stops at the footer's last page. Distilled
  through `withConnectivityProbe` + 1–3s inter-tag delay. No new scraper that
  hammers the site.
- Expected cost for a pass: 2,893 tags, mostly 1 live page fetch each when the
  shelf is unchanged → roughly **4–8h** (cookie pacing), dominated by the
  per-request delay. Matches the "recent monitoring" cadence; use
  `caffeinate -is`. Most of the early picks have big shelves; tags in the
  ~100%-tail near the end are small (fewer pages), so pacing, not size, rules.
- Run it ALONE (don't stack with author-rescan / gap-genre-tag / list-tag-walk
  — they serialize on the one SQLite writer anyway; AGENTS.md).
- The set-cover list is computed against `tag_books` **at run start**; we do
  NOT recompute mid-pass. New books discovered during the walk enrich the DB
  and show up on the NEXT pass's coverage. The `--limit 20000` guarantee of
  reaching 100% holds while `limit >= tag count` (4084 now).

## Edge cases / decisions to confirm with the user

1. **702 of the 2,893 picked tags** may be genre-tags — keep or exclude?
   (Recommend keep: the tail can still hold new books/authors; other walkers
   treat genres as tags anyway.)
2. **Tag never measured** (`known == null`, 736 DB-wide): read page 1→end once
   (measures it), then tail-only forever after. (Recommend yes.)
3. **Shelf shrank**: empty result + `known>1` → one re-probe at the new last
   page. (Recommend yes.)
4. **Coverage relists every run** — the walk order is by value
   (most-new-books first), so a resumed pass skips done tags and continues down
   a fresh list; fine because resume is by tag name, not by list index.
5. **Do we stamp `books.tags[tag]` presence** like newTagWalker does
   (per-tag shelf counts)? (Recommend **no** for the monitor — the walk's goal
   is discovery, and the newTagWalker stamping is a separate concern; skip to
   keep it light. Easy to add if wanted.)

## Next actionable steps

1. ~~Add the two tables to `src/db.ts` + storage helpers in `src/storage.ts`.~~ done
2. ~~Re-factor the shared "load tag_books + ratings join" (`loadTagCoverageInputs` in `src/tagCoverage.ts`).~~ done
3. ~~Write `src/tagRecentMonitor.ts`.~~ done
4. ~~Wire `src/index.ts` command, `./tagRecentMonitor.sh`, `package.json` script.~~ done
5. ~~`src/tagRecentMonitor.test.ts` (no network).~~ done — 19 tests
6. ~~Run the AGENTS.md gates: `./runUnitTests.sh` (tsc strict first), tee to a log.~~ done, all green
7. First real pass: `--dryRun` already verified; a live pass under
   `caffeinate -is` is **not** started by the agent — the user runs it.

## Related / prior art

- `src/tagCoverage.ts` (+ `tagCoverage.test.ts`) — the ordered list source.
- `src/newTagWalker.ts` — per-tag scrape + `syncBooksToCache` /
  `syncAuthorsToCache` / counting + resume-on-rerun, the closest structural twin.
- `src/listTagWalker.ts` (`shouldSkipList`, `list_scrapes`) — skip/reuse idiom.
- `src/scraper.ts` `scrapeShelfBooks` + `extractShelfPageLinks` — the tail reads.
- `src/storage.ts` `getKnownShelfPages` / `persistShelfPageCount` —
  history the "previously 16 pages" check uses.
- AGENTS.md throttling + SQLite write rules — the walk reuses existing behavior.