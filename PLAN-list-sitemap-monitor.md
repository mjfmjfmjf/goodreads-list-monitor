# PLAN-list-sitemap-monitor

A monitor for the Goodreads **list** sitemap, modeled on
`PLAN-author-sitemap-monitor-v2.md` (the streaming design; the author
implementation in the tree is still the older queue design, so this plan does
not depend on the queue).

## Requirements (the user's words + decisions)

- Walk `https://www.goodreads.com/siteindex.list.xml` entry by entry, in order.
- For each list entry (`/list/show/<id>.<slug>`), decide once:
  - **new** — no `list_scrapes` row → scrape the whole list;
  - **unchanged** — sitemap `lastmod <= list_scrapes.last_scraped` → skip;
  - **recent** — `lastmod > last_scraped` but `last_scraped` is younger than
    `--minAge` days → skip;
  - **stale** — `lastmod > last_scraped` and `last_scraped` is at least
    `--minAge` days old → scrape;
  - **unknown** — missing/unparseable `lastmod` or `last_scraped` → skip.
- This is the **same decision matrix as the author monitor**, with
  `list_scrapes.last_scraped` standing in for the author page's `last_seen`.
- Only a crawl that genuinely ran to the end of the list may advance
  `list_scrapes.last_scraped` (see "Completion signal" below).
- It should be able to run for days/weeks in one process and be resumed.
- Default: work **all shards** (there are only ~3 today); `--files`,
  `--start`, `--end`, `--maxLists` bound a run.
- Dry-run classifies and reports without scraping or writing.

## Verified facts this plan relies on

- Index: `https://www.goodreads.com/siteindex.list.xml`; shard URLs
  `https://www.goodreads.com/sitemap.<n>.xml.gz` (394/395/396 as of
  2026-11-07; shard 394 has 47,363 `<loc>` entries, ~119k lists total across
  the three). **Shard IDs drift — always read them from the index, never
  hard-code them.**
- Entry format: `https://www.goodreads.com/list/show/<id>.<slug>`.
- Recency ledger already exists: `list_scrapes(list_id, list_name,
  first_scraped, last_scraped)` with `loadListScrape` / `upsertListScrape` /
  `shouldSkipList` (src/storage.ts, src/listTagWalker.ts).
- Scrape path: `scrapeListBooks(listId, maxPages, source)` (src/scraper.ts)
  reads every page, persists the list's sidebar tags, and syncs authors.
  The caller persists books with `syncBooksToCache(books, {})` and records
  completion with `upsertListScrape`.
- `scrapeListBooks` sends the configured cookie when one exists (unlike the
  anonymous author default). Keep that behavior; no new cookie flag.
- **Do not write the `lists` table.** `saveState()` does `DELETE FROM lists`
  then reinserts from `state.lists`, so a sitemap write there would be
  clobbered. `list_scrapes` is the only list-side ledger this monitor writes.
- `list_scrapes` is already in `EXCLUDED_TABLES` (exportData.ts) and
  `IGNORED_TABLES` (fieldCoverage.ts); the new shard ledger joins them.

## Deliberate difference from the author monitor: a finished shard is re-walked

The author monitor skips `done` shards without downloading them. That cannot
work here: eligibility is **time-dependent** (a list that is "recent" today
becomes "stale" once `--minAge` passes, even if the shard bytes are identical).
With only ~3 shards (~27 MB total), every run re-downloads and re-parses the
selected shards and re-classifies every entry. The shard ledger's cursor is for
**resuming an interrupted pass**, not for permanently skipping a shard.

- New invocation on a `done` shard: start a new pass at entry 0, log
  `new pass`.
- New invocation on an `in_progress` shard:
  - shard hash unchanged → resume at `cursor_index`, log `resuming at #N`;
  - shard hash changed → reset to entry 0 and re-walk (already-scraped lists
    classify as unchanged/recent and are cheap skips).
- `done` therefore means "this shard completed its last pass"; it does not
  mean "never look here again".

## Completion signal (decision: add it)

Today `scrapeListBooks` catches HTTP errors and returns `[]` or a partial list,
so the caller cannot tell success from failure. Add an additive detailed
variant in `src/scraper.ts`:

```ts
export interface ScrapeListBooksResult {
  books: BookMetadata[];
  pagesRead: number;
  completed: boolean;   // reached the natural end of the list
  lastStatus?: number;  // last HTTP status seen
  error?: unknown;      // the caught fetch error, if the crawl stopped early
}

export async function scrapeListBooksDetailed(
  listId: string,
  maxPages = Infinity,
  source = 'list_page',
): Promise<ScrapeListBooksResult>;
```

`scrapeListBooks` becomes a thin wrapper returning `.books` (all existing
callers unchanged). The monitor uses the detailed variant and marks
`list_scrapes` only when:

- `completed === true` — pagination reached the end (including a genuinely
  empty list), or
- `lastStatus` is `404`/`410` — the list is gone; mark it so it is not retried
  every pass.

A capped crawl (`--listMaxPages`) is never `completed` and is never marked
scraped. A 202/403/429 or other page failure sets `completed = false`; the
monitor counts it as failed, does **not** advance the 90-day clock, and moves
on (the next pass retries). No unbounded retry loop.

## Data model

One operational table; **no candidate table**.

```sql
CREATE TABLE IF NOT EXISTS list_sitemap_files (
  shard_id            INTEGER PRIMARY KEY,
  url                 TEXT NOT NULL,
  index_lastmod       TEXT,
  etag                TEXT,
  last_modified       TEXT,
  sha256              TEXT,
  bytes_compressed    INTEGER,
  bytes_uncompressed  INTEGER,
  http_status         INTEGER,
  duration_ms         INTEGER,
  entries             INTEGER,
  lastmod_min         TEXT,
  lastmod_max         TEXT,

  -- resume state for an interrupted pass
  cursor_list_id      TEXT,              -- last entry fully acted on
  cursor_index        INTEGER,           -- ordinal fallback (0-based)
  processed_entries   INTEGER NOT NULL DEFAULT 0,

  -- per-pass counters (incremental, updated as the cursor advances)
  new_ids             INTEGER NOT NULL DEFAULT 0,
  stale_ids           INTEGER NOT NULL DEFAULT 0,
  recent_ids          INTEGER NOT NULL DEFAULT 0,
  unchanged_ids       INTEGER NOT NULL DEFAULT 0,
  unknown_ids         INTEGER NOT NULL DEFAULT 0,
  scraped             INTEGER NOT NULL DEFAULT 0,
  failed              INTEGER NOT NULL DEFAULT 0,
  gone_ids            INTEGER NOT NULL DEFAULT 0,
  capped_ids          INTEGER NOT NULL DEFAULT 0,

  pass_started_at     TEXT,
  pass_completed_at   TEXT,
  fetched_at          TEXT,
  parsed_at           TEXT,
  status              TEXT NOT NULL DEFAULT 'pending', -- pending|in_progress|done|error
  error               TEXT
);
```

Single-statement autocommit upserts. Persist the cursor after every entry
(sub-millisecond); never hold a transaction across a scrape or delay. On a new
pass, reset the counters and cursor for that shard.

Add `list_sitemap_files` to `EXCLUDED_TABLES` (src/exportData.ts) and
`IGNORED_TABLES` (src/fieldCoverage.ts) — it is operational bookkeeping, not
shared data. The schema unit test requires every table be in
`EXPORT_TABLES ∪ EXCLUDED_TABLES`.

## CLI

```bash
./listSitemapMonitor.sh --dryRun                 # classify/report all shards, no writes
./listSitemapMonitor.sh                          # walk all shards (days/weeks)
./listSitemapMonitor.sh --files 1                # one shard this run
./listSitemapMonitor.sh --start 394 --files 1    # shard 394 only
./listSitemapMonitor.sh --start 394 --end 396    # explicit range
./listSitemapMonitor.sh --maxLists 500           # stop after 500 scrapes, save cursor
./listSitemapMonitor.sh --minAge 60              # 60-day recency window
```

| Option | Default | Meaning |
|---|---|---|
| `--files <n>` | all remaining | Shards to work this run. |
| `--start <shard>` | first shard | First Goodreads shard ID (394–396 as of 2026-11-07; read them from the index). |
| `--end <shard>` | — | Last shard, inclusive. Requires `--start`; mutually exclusive with `--files`. |
| `--index <url>` | list index | Override for tests. |
| `--force` | off | Reset an `in_progress` shard's cursor to 0 and start over. |
| `--maxLists <n>` | `0` (unlimited) | Stop after N list scrapes (skips are free); save the cursor. |
| `--minAge <days>` | `90` | Recency window for the lastmod decision. |
| `--listMaxPages <n>` | all pages | Cap a crawl for spot checks. A capped crawl is never marked scraped. |
| `--dryRun` | off | Download/parse/classify and print counts only; no list scrapes, no ledger writes. |

There is no `--withCookie`: `scrapeListBooks` already uses the configured
cookie. There is no `--multiPage`/`--only`: a list has exactly one scrape kind.

## Per-shard flow

1. Fetch the index; validate every `<loc>` against
   `^https://www\.goodreads\.com/sitemap\.(\d+)\.xml\.gz$`. Any mismatch aborts
   before downloading. Never construct a shard URL from a number.
2. Select shards in ascending `shard_id` (all remaining by default; explicit
   range with `--start`/`--end`/`--files`).
3. For each shard **sequentially**:
    1. Download the `.gz` and gunzip it **in memory** (no temp file).
    2. Parse into ordered `{ id, slug, lastmod }[]`. Compute the
      sha256 and validators; compare to the ledger to detect an interrupted
      pass on a changed shard.
   3. Determine the start entry:
      - prior `in_progress` and same hash → `cursor_index`;
      - otherwise → entry 0 (new pass).
   4. Upsert `status='in_progress'`, `pass_started_at`, validators, entries,
      `lastmod_min/max`; reset counters on a new pass.
   5. Iterate entries **in order** from the start:
      - Look up `list_scrapes` in bounded chunks (500 `IN (...)` ids at a
        time), not one query per entry.
      - Classify with the matrix above.
      - For a scrape:
        - `scrapeListBooksDetailed(id, listMaxPages, 'list_sitemap_monitor')`
          through `withConnectivityProbe`;
        - on `completed` (or 404/410): `syncBooksToCache(books, {})`, then
          `upsertListScrape(id, label)`; count scraped/new/stale and
          books new/enriched; on 404/410 count `gone`;
        - on incomplete/failed: count `failed`; do **not** touch
          `list_scrapes`; a `--listMaxPages` cap counts `capped` instead of
          `failed` (also never marked);
        - per-list `delay(1000, 3000)` between scrapes.
      - For a skip: count the bucket; no writes to `list_scrapes`.
      - Immediately after each entry, upsert `cursor_list_id`, `cursor_index`,
        `processed_entries`, and the affected counters.
      - On connectivity error: cursor is already saved; leave
        `status='in_progress'`; print "network error — progress saved"; exit.
      - Honor `--maxLists`: save the cursor, leave `status='in_progress'`, exit 0.
   6. After the last entry: `status='done'`, `pass_completed_at`, print the
      shard summary, continue to the next shard.
   7. A non-connectivity download/parse error marks the shard `status='error'`
      with the message and moves on (a later run retries it).

## Console / log

One header and one summary per shard; one line per **action** (skip lines are
cheap and useful, but do not write a JSONL record for each of 47k skips).

```text
[1/3] sitemap.394.xml.gz  47,363 entries  new pass
  [  1/47362] 1.Best_Books_Ever (1) — new → scrape
  [  2/47362] 2.The_Worst_Books_of_All_Time (2) — unchanged (lastmod <= scraped)
  [  3/47362] 3.Best_Science_Fiction_Fantasy_Books (3) — skip recent (12d < 90d)
  [  4/47362] 101690.Goodreads_Office_Arrivals (101690) — stale (changed since 2026-06-01) → scrape
  ...
🏁 sitemap.394.xml.gz pass done
   processed=47,363 / 47,363
   new=1,234 scraped=1,890 (stale=656) gone=5 failed=3
   unchanged=44,000 recent=1,470 unknown=2
   books: 4,812 new / 9,331 enriched
```

Keep a JSONL log at `listSitemapMonitor.log` mirroring the author monitor
(index/shard download, preview counts, per-scrape, failures, pass summary).
Flush progress so the run can be tailed for days.

## Failure / politeness

- Per-list failures never stop a shard; they advance the cursor.
- A 202/403/429 page failure counts as failed and does not advance the 90-day
  clock; the next pass retries. Do not loop a retry on throttle responses.
- Connectivity errors stop the process with the cursor saved; the next run
  re-downloads the in-progress shard and resumes (or restarts if its hash
  changed).
- Reuse the scraper's per-page `delay()` and add a 1000–3000 ms gap between
  lists, matching `listTagWalker` / `listPopularWalker`.
- The first full pass is the bulk (~119k lists, many already in `list_scrapes`);
  later passes mostly classify and skip.
- Long runs under `caffeinate -is`.

## Code changes

- `src/db.ts`: add `list_sitemap_files` (table only; no candidates table).
- `src/listSitemap.ts`: `LIST_SITEMAP_INDEX_URL`, index/shard parsers, entry
  parser (`/list/show/<id>.<slug>`), `classifyListEntries`, shard selection.
- `src/listSitemapStore.ts`: ledger + cursor accessors
  (`getListSitemapFile`, `beginListSitemapPass`, `resumeListSitemapPass`,
  `advanceListSitemapCursor`, `completeListSitemapPass`,
  `markListSitemapFileError`).
- `src/listSitemapMonitor.ts`: the streaming loop above.
- `src/scraper.ts`: add `scrapeListBooksDetailed`; make `scrapeListBooks`
  delegate to it (no behavior change for existing callers).
- `src/index.ts`: `list-sitemap-monitor` command + help.
- `package.json`: `list-sitemap-monitor` script.
- `listSitemapMonitor.sh`: wrapper matching `authorSitemapMonitor.sh`.
- `src/exportData.ts`, `src/fieldCoverage.ts`: exclude/ignore the new table.
- Do not modify `scrapeListBooks`'s cookie behavior, the walkers, or `lists`.

## Tests (unit, no network)

- Index parser: valid locs, duplicate shard ids, BOM, and an invalid `<loc>`
  aborting the run.
- Shard parser: id/slug/lastmod extraction, duplicates, missing lastmod.
- Classification matrix: new > unknown > unchanged > recent > stale, with
  concrete dates on both sides of the `--minAge` boundary.
- Monitor: a new list is scraped and marked; an unchanged list is skipped; a
  recent list is skipped; a stale list is scraped.
- Resume: process entries 0–2, abort, restart, verify 0–2 are not re-scraped
  and entry 3 is acted on.
- A changed shard hash resets the cursor to 0.
- A `done` shard starts a **new pass** on the next run (not skipped).
- `--maxLists` saves the cursor and exits `in_progress`.
- Connectivity abort leaves `in_progress` at the last completed entry.
- `--dryRun` writes no ledger rows and performs no list scrapes.
- Completion: a partial/error crawl does not advance `list_scrapes`; a 404/410
  is marked gone; a capped crawl is not marked scraped.
- Full `./runUnitTests.sh` gate (tsc + coverage + CLI smoke) stays green.

## Acceptance

- `./listSitemapMonitor.sh --dryRun` classifies all shards and writes nothing.
- `./listSitemapMonitor.sh --files 1 --maxLists 5` prints one action line per
  entry, can be Ctrl-C'd, and resumes at the saved cursor on restart.
- A finished shard is re-walked on the next invocation (a new pass), not
  permanently skipped.
- `list_scrapes.last_scraped` advances only for completed full crawls.
- No `list_sitemap_candidates` table exists; the `lists` table is untouched.
- Live check: run shard 394 with a small `--maxLists`, interrupt, restart,
  confirm `resuming at #N`, then confirm unchanged/recent lists are skipped.

## Open items

- None blocking. If Goodreads ever omits `<lastmod>` from list entries, those
  lists classify as `unknown` and are skipped (same as the author monitor);
  revisit only if that becomes common.
