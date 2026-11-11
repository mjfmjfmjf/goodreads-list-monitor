# PLAN: authorSitemapMonitoring — sitemap-driven author discovery + change detection

Status: **REVISED DRAFT 2026/11/06 — planning only. No feature code written.**
Phase 1 is the dry-run scanner. Phase 2 is the persisted monitor + scraper.
Implement only after this plan is approved.

Feature request from the user: monitor the Goodreads author sitemap shards
(`sitemap.178.xml.gz` … `sitemap.367.xml.gz`) to find new author IDs and author
pages whose sitemap `lastmod` is newer than our last scrape date. First pass
must be able to process a chosen number of files, log download and parse
metadata, and delete each `.gz` after processing. Phase 2 applies the results:
new authors get a back-catalog scrape; existing changed authors get a single-page
recent-books scrape unless scraped within a configurable cooldown (default 30
days).

## 1. Verified ground truth (2026/11/06)

### Sitemap entry point and range

- `https://www.goodreads.com/sitemap.xml` is **404**.
- `robots.txt` publishes the author index at:
  `https://www.goodreads.com/siteindex.author.xml`
- The author index is the **only** source of shard file URLs: read each
  `<sitemap><loc>` and use that URL **verbatim**. Do **not** construct a shard
  URL by formatting `https://www.goodreads.com/sitemap.<n>.xml.gz`, and do not
  derive the range from the shard numbers.
- Every `<loc>` must match
  `^https://www\.goodreads\.com/sitemap\.(\d+)\.xml\.gz$`. If **any** entry
  does not, the run must **give up**: log the offending URL and abort before
  downloading or parsing any shard. Do not skip the entry and continue, and do
  not attempt to normalize or guess the filename.
- The index currently contains **190 shards, numbered 178–367, contiguous**;
  the numeric segment is parsed only for the `--start` ordering and the
  `shard_id` ledger key.
- All 190 index entries currently have an index-level `lastmod` of
  `2026-10-31`, so the index is the source of truth for the shard list — do not
  hard-code 367 or assume the range will never grow.
- `HEAD` on `sitemap.178.xml.gz` and `sitemap.367.xml.gz` returns HTTP 200,
  `content-type: application/x-gzip`, chunked (no `content-length`). Actual
  byte size and transfer time therefore come from the GET response, not HEAD.
- Local samples are ~0.82–0.85 MB compressed and ~8.2 MB uncompressed.
- The three locally downloaded shards are **completely disjoint**:
  178 ∩ 179 = 0, 178 ∩ 180 = 0, 179 ∩ 180 = 0; 145,561 unique IDs total.
  Do not assume this for every pair, but dedupe defensively.

### Shard shape

- Each `<url>` contains:
  - `<loc>https://www.goodreads.com/author/show/<id>.<slug></loc>`
  - `<lastmod>2026-10-30T03:24:02-07:00</lastmod>`
  - `<changefreq>weekly</changefreq>`
- Sampled shards have 48,423–48,703 author URLs each.
- Observed per-author `lastmod` range in shards 178–180: **2024-08-20 through
  2026-10-31**.
- The URL path is always `/author/show/<numeric-id>.<slug>`; the numeric ID is
  the stable key. The slug is display/fallback only.

### Exploratory comparison against the live DB

These are a moving snapshot because crawlers are active; the dry run must
compute them fresh.

| Shard | Entries | No author row (new) | Cached | Sitemap lastmod > `last_seen` | lastmod ≤ `last_seen` |
|---|---:|---:|---:|---:|---:|
| 178 | 48,703 | 13,517 | 35,186 | 21,224 | 13,962 |
| 179 | 48,423 | 20,379 | 28,044 | 18,676 | 9,368 |
| 180 | 48,435 | 22,896 | 25,539 | 15,205 | 10,334 |

### What “last scrape date” means in the current schema

- `authors.last_seen` is updated by author-page scrapes **and** by author mint /
  refresh from book and list walks (`syncAuthorsToCache`).
- There is **no dedicated `author_page_scraped_at` column**. The existing
  `wasAuthorPageScraped()` helper only infers whether stats exist
  (`numRatings`/`averageRating`/`numReviews`/`numShelves`/`catalogPages`), not
  when the author page was last read.
- Phase 1 definition: compare sitemap `lastmod` against `authors.last_seen`.
  Label the metric explicitly as **“sitemap newer than last_seen”**, not
  “last author-page scrape.”
- Phase 2 cooldown uses the same convention as `authorRescan` / `authorRecent`:
  - a row with `wasAuthorPageScraped()` and a recent `last_seen` is considered
    recently scraped;
  - a mint-only/statless row is treated as never author-scraped and is due;
  - this is a proxy. A later refinement can add
    `authors.author_page_scraped_at` and have every author-page scraper stamp
    it, but that is not required for v1.

## 2. Definitions

| Term | Meaning |
|---|---|
| Index | `https://www.goodreads.com/siteindex.author.xml`; publishes one `<sitemap><loc>` per shard. The authoritative source of shard URLs. Every `<loc>` must match the `sitemap.<n>.xml.gz` pattern or the run aborts. |
| Shard/file | One sitemap entry from the index; its download URL is the index `<loc>` verbatim (currently `sitemap.<n>.xml.gz`). |
| New author | Numeric author ID has no row in `authors`. |
| Cached author | Numeric author ID already has an `authors` row. |
| Changed author | Cached author whose sitemap `lastmod` is **newer** than `authors.last_seen`. |
| Unchanged author | Cached author whose sitemap `lastmod` is at or before `authors.last_seen`. |
| Unknown | Missing/invalid `lastmod`, or cached author with missing/invalid `last_seen`. |
| Back-catalog scrape | Full author works crawl (`scrapeAuthorStats(..., crawlAllPages=true)`; CLI flag `--multiPage`). New IDs always use this. |
| Recent scrape | First page only of `/author/list/<id>?sort=original_publication_year` (`crawlAllPages=false`), matching `authorRecent`. |
| Skipped recent | Existing changed author whose last author-page scrape is within `--minAge` days (default 30). |
| Skipped unchanged | Existing author whose sitemap `lastmod` is not newer than our last-seen/scrape date. |
| Error-skipped | Author ID already retired by the normal failure ledger (`AUTHOR_FAIL_LIMIT`); silently skipped even if the sitemap says it changed. |
| Our last scrape date | `authors.last_seen`, gated by `wasAuthorPageScraped()` for the cooldown decision. |

## 3. Architecture

New files:

- `src/authorSitemap.ts` — pure parsing/classification helpers:
  - parse the author index into `{ shardId, url, indexLastmod }[]` from each
    `<sitemap><loc>…</loc>`; validate every `url` against
    `^https://www\.goodreads\.com/sitemap\.(\d+)\.xml\.gz$` and throw (abort
    the run) on the first mismatch; `url` is used verbatim and `shardId` is
    parsed from the validated numeric segment,
  - parse a shard into `{ id, slug, lastmod }[]`,
  - classify entries against chunked DB rows and the failure ledger,
  - format log/summary records.
- `src/authorSitemapMonitor.ts` — orchestration: index fetch, shard download,
  hash/size/restart state, temp-file lifecycle, preview, queue, scrape,
  logging.
- `authorSitemapMonitor.sh` — wrapper mirroring `tagRecentMonitor.sh`.
- `package.json` script: `author-sitemap-monitor`.
- CLI registration in `src/index.ts` as `author-sitemap-monitor`.

Do not duplicate author scraping. Phase 2 must reuse:

- `scrapeAuthorStats` (`src/scraper.ts`) — `crawlAllPages=true` for back
  catalog; `crawlAllPages=false` + `sort='original_publication_year'` for the
  single-page recent scrape. The CLI flag `--multiPage` maps to
  `crawlAllPages=true`.
- `updateAuthorStats` / `upsertAuthorById` / `upsertAuthorSlug`,
- `recordAuthorScrapeFailure` / `isRetiredAuthor` / `AUTHOR_FAIL_LIMIT` /
  `loadStrikeMap` / `clearAuthorScrapeFailure`,
- `withConnectivityProbe`, `delay`, `parseDelayRange`,
- the existing `storeAuthorStats` logic from `authorOne.ts` (refactor it to a
  shared helper that accepts a `source` parameter, or export it).

## 4. Phase 1 — dry-run scanner (no author scraping, no DB writes)

### CLI

```bash
./authorSitemapMonitor.sh --dryRun --files 3
./authorSitemapMonitor.sh --dryRun --files 3 --start 178
./authorSitemapMonitor.sh --dryRun --files 1 --start 200
```

Phase 1 implements **dry run only**. `--dryRun` is required; running without it
should print “Phase 2 not implemented yet” and exit non-zero until Phase 2 ships.
This guarantees the first pass cannot scrape or write author rows by accident.

Options:

| Option | Default | Meaning |
|---|---|---|
| `--dryRun` | required in Phase 1 | Parse/download/report only. |
| `--files <n>` | `1` | Number of consecutive shards to process. |
| `--start <shard>` | `178` | First shard number. |
| `--index <url>` | `https://www.goodreads.com/siteindex.author.xml` | Override for testing. |

No `--limit` for authors in Phase 1; the shard count is the budget.

### Flow

1. Fetch the author index (`--index`, default
   `https://www.goodreads.com/siteindex.author.xml`).
   - Log status, compressed/uncompressed bytes, duration, final URL.
   - Parse each `<sitemap>` entry into `{ shardId, url, indexLastmod }`.
   - Validate every `<loc>` against
     `^https://www\.goodreads\.com/sitemap\.(\d+)\.xml\.gz$`. On the first
     mismatch, log the offending entry and **abort the whole run** (exit
     non-zero) before any download; do not skip it and do not process a subset.
   - Use that entry's `<loc>` **verbatim** as the download URL. Never build
     `sitemap.<n>.xml.gz` from a number, and never assume the shard range.
   - Select `--files` consecutive shards starting at `--start` (by `shardId`).
   - If `--start` is not in the index, or fewer than N shards remain, report
     clearly and process the available ones.

2. For each selected shard:
   1. Download the shard's index-supplied `<loc>` URL to a temp file:
      `os.tmpdir()/author-sitemap-<runId>/sitemap.<shardId>.xml.gz`
      (the temp filename uses the shard id; the download URL always comes from
      the index, not from a constructed path).
   2. Log a `download` event with:
      - timestamp, run ID, shard, URL,
      - HTTP status, compressed bytes, duration,
      - `content-type`, `content-length` if present,
      - temp path.
   3. Decompress and parse `<url>` blocks into `{ id, slug, lastmod }`.
      - Count malformed blocks, missing IDs, missing/invalid `lastmod`,
        duplicate IDs within the shard.
   4. Look up IDs against the DB in chunks (see below) and classify.
   5. Load the failure ledger for these IDs and mark retired IDs as
      `errorSkipped` (see error handling below).
   6. Log a `shard`/`preview` event with:
      - shard, entries, unique IDs, duplicates, unparseable,
      - earliest `lastmod`, latest `lastmod`,
      - new, cached, changed, unchanged, unknown,
      - `errorSkipped`,
      - optional “cached and author-stats-present” split.
   7. Delete the temp `.gz` in a `finally` block.
      - Log a `delete` event with path and success/failure.
      - Also delete the run temp directory if empty.
   8. Continue to the next shard. A single shard failure is logged and does
      **not** stop the run unless it is a connectivity error.

3. Print an aggregate summary:
   - shards processed / failed,
   - total compressed bytes and download duration,
   - total entries and unique IDs,
   - total new / changed / unchanged / unknown / `errorSkipped`,
   - earliest and latest `lastmod` across the run,
   - temp files deleted count.

4. Exit non-zero only if all selected shards failed or the index could not be
   read; partial shard failures exit 0 with a warning.

### DB comparison without loading the whole table

Do **not** call `loadAuthorCache()` / materialize `authors`.

Use chunked primary-key lookups (500 IDs per query):

```sql
SELECT id, last_seen, num_ratings, average_rating, num_reviews, num_shelves, catalog_pages
FROM authors
WHERE id IN (?, …)
```

For each sitemap entry:

- retired in `author_scrape_failures` → `errorSkipped` (takes precedence);
- no row → `new`;
- row + valid `last_seen` + `lastmod > last_seen` → `changed`;
- row + valid `last_seen` + `lastmod <= last_seen` → `unchanged`;
- otherwise → `unknown`.

`errorSkipped` is a subset of the entries that would otherwise be new/changed;
report it separately, not instead of the raw new/changed counts.

For the failure ledger:

- dry run: load the retired ID set once per shard via `loadStrikeMap()` (or a
  chunked `author_scrape_failures` read); no network.
- apply: re-check `isRetiredAuthor(id)` immediately before each scrape, using
  the live ledger as normal.

### Logging

- Console output stays human-readable, e.g.:

```text
📥 [1/3] sitemap.178.xml.gz  http=200  817.2 KB  0.42s
📊 preview shard=178  entries=48,703  lastmod=2024-08-20..2026-10-31
   new=13,517  cached=35,186  changed=21,224  unchanged=13,962  unknown=0
   errorSkipped=317 (retired authors — not scraped)
🗑️  deleted /tmp/author-sitemap-…/sitemap.178.xml.gz
```

- Append structured lines to `authorSitemapMonitor.log` (already gitignored by
  `*.log`). JSONL proposal:

```json
{"ts":"2026-11-06T…","runId":"…","event":"index","url":"…","httpStatus":200,"bytes":25648,"durationMs":372}
{"ts":"…","runId":"…","event":"download","shard":178,"url":"…","httpStatus":200,"bytes":817000,"durationMs":420,"contentType":"application/x-gzip","contentLength":null,"sha256":"…","tempPath":"…"}
{"ts":"…","runId":"…","event":"preview","shard":178,"entries":48703,"uniqueIds":48703,"duplicates":0,"unparseable":0,"lastmodMin":"2024-08-20T…","lastmodMax":"2026-10-31T…","new":13517,"cached":35186,"changed":21224,"unchanged":13962,"unknown":0,"errorSkipped":317}
{"ts":"…","runId":"…","event":"delete","shard":178,"path":"…","deleted":true}
{"ts":"…","runId":"…","event":"error","shard":179,"message":"…"}
```

- Include both compressed and uncompressed byte counts if available.
- Flush each line immediately so a long run can be tailed live.

### Deletion guarantee

- Use `try/finally` around decompress/parse/compare.
- Delete the temp `.gz` even when parsing or DB lookup throws.
- If `unlink` fails, log the path and error; do not silently leave it.
- No shard cache is kept between Phase 1 runs.

### No writes in Phase 1

- No `authors` rows, no file/candidate tables, no queue.
- Only the log file and transient temp files are written.
- Verification will compare `countAuthors()` before/after the live dry run.

## 5. Phase 2 — apply mode (persisted monitor + scraper)

Phase 2 turns classification into a resumable monitor. Every shard still runs
the Phase 1 preview first; apply mode then uses the same parsed entries to
enqueue and scrape. `--dryRun` stops after the preview.

### New operational tables

Add to `src/db.ts` with the usual `CREATE TABLE IF NOT EXISTS` pattern, and add
both to `EXCLUDED_TABLES` in `src/exportData.ts` (operational state, not shared
data). The export schema test requires every new table to be listed.

#### `author_sitemap_files` — restart/monitoring ledger

One row per shard. This is what makes the monitor interruptible and lets us
detect Goodreads resetting/renumbering files via hash + size.

```sql
CREATE TABLE IF NOT EXISTS author_sitemap_files (
  shard_id          INTEGER PRIMARY KEY,
  url               TEXT NOT NULL,
  index_lastmod     TEXT,
  etag              TEXT,
  last_modified     TEXT,
  sha256            TEXT,
  bytes_compressed  INTEGER,
  bytes_uncompressed INTEGER,
  http_status       INTEGER,
  duration_ms       INTEGER,
  entries           INTEGER,
  lastmod_min       TEXT,
  lastmod_max       TEXT,
  new_ids           INTEGER,
  changed_ids       INTEGER,
  unchanged_ids     INTEGER,
  unknown_ids       INTEGER,
  error_skipped_ids INTEGER,
  back_catalog_scraped INTEGER,
  recent_scraped    INTEGER,
  skipped_recent    INTEGER,
  skipped_unchanged INTEGER,
  failed_ids        INTEGER,
  preview_at        TEXT,
  fetched_at        TEXT,
  parsed_at         TEXT,
  processed_at      TEXT,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending|downloaded|parsed|done|skipped|error
  error             TEXT
);
```

#### `author_sitemap_candidates` — actionable author queue

Only actionable rows live here: pending, deferred (inside cooldown), and
failed. Successful or unchanged authors are not retained as millions of rows;
the file ledger keeps the counts. This keeps the queue restartable and bounded.

```sql
CREATE TABLE IF NOT EXISTS author_sitemap_candidates (
  author_id         TEXT PRIMARY KEY,
  shard_id          INTEGER NOT NULL,
  slug              TEXT,
  sitemap_lastmod   TEXT,
  reason            TEXT NOT NULL,                  -- new|changed
  scrape_kind       TEXT NOT NULL,                  -- back_catalog|recent
  status            TEXT NOT NULL DEFAULT 'pending', -- pending|deferred|failed
  not_before        TEXT,                           -- cooldown expiry for deferred
  attempts          INTEGER NOT NULL DEFAULT 0,
  first_seen        TEXT NOT NULL,
  last_attempt      TEXT,
  last_error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_author_sitemap_candidates_ready
  ON author_sitemap_candidates(status, not_before, sitemap_lastmod DESC);
CREATE INDEX IF NOT EXISTS idx_author_sitemap_candidates_shard
  ON author_sitemap_candidates(shard_id);
```

### Phase 2 CLI

```bash
./authorSitemapMonitor.sh --files 3 --start 178                 # preview + apply 3 shards
./authorSitemapMonitor.sh --files 3 --start 178 --enqueueOnly   # preview + enqueue, no scraping
./authorSitemapMonitor.sh --authors 100                         # drain ready queue
./authorSitemapMonitor.sh --files 3 --authors 100               # ingest + drain
./authorSitemapMonitor.sh --dryRun --files 3                    # preview only
```

Additional options:

| Option | Default | Meaning |
|---|---|---|
| `--files <n>` | `1` | Shards to ingest this run. |
| `--start <shard>` | next unprocessed | First shard. |
| `--force` | off | Re-download/reparse even when hash/size/validators say unchanged. |
| `--enqueueOnly` | off | Preview and enqueue candidates, scrape none. |
| `--authors <n>` | `100` | Max author scrapes this run (`0` = no cap; use carefully). |
| `--minAge <days>` | `30` | Skip an existing changed author when last author-page scrape is newer than this. |
| `--only <new\|changed>` | `all` | Restrict queue draining. |
| `--multiPage` | off | Force full catalog for all candidates (normally new = back catalog, changed = recent). |
| `--withCookie` | off | Use cookie-authenticated pacing. |
| `--dryRun` | off | Preview only; stop before enqueue/scrape. |

### Ingest flow (preview then apply)

1. Fetch the index; log it.
2. Select shards.
3. For each selected shard, issue a conditional GET when validators exist
   (`If-None-Match`/`If-Modified-Since`), otherwise a normal GET.
   - `304` → log `skip unchanged`, no download/parse.
   - `200` → download, compute SHA-256 of the compressed body and its byte size.
     - If `sha256` + `bytes_compressed` match the stored row and `--force` is
       not set → log `skip unchanged`, update `fetched_at`, no reparse.
     - If hash/size differ (or no prior row) → this is a new/reset file; parse.
4. Parse and classify exactly as Phase 1, **including `errorSkipped`**.
5. Emit the mandatory preview summary for this file (`preview` event). This
   happens in both dry-run and apply mode.
6. If `--dryRun`, delete the temp `.gz`, update the file ledger’s preview
   fields/status, and stop for that file.
7. Otherwise:
   - Upsert `author_sitemap_files` with hash/size/validators, preview counts,
     status=`parsed`.
   - Enqueue actionable candidates:
     - retired/error-skipped → no candidate; count only.
     - new → `scrape_kind='back_catalog'`, `status='pending'`.
     - changed + due → `scrape_kind='recent'`, `status='pending'`.
     - changed + inside cooldown → `scrape_kind='recent'`, `status='deferred'`,
       `not_before = last_seen + minAge`.
     - unchanged → no candidate; count only.
   - Delete the temp `.gz` immediately after parsing/enqueueing.
   - Drain ready candidates for this shard (unless `--enqueueOnly`), subject to
     `--authors`.
   - Update file status to `done` (or `parsed` if budget left rows pending) and
     print the end-of-file summary.

### Classification for apply mode

For each sitemap entry, in order:

1. **Retired/error-skipped:** `isRetiredAuthor(id)` → count `errorSkipped`;
   do not enqueue, do not log per author. This overrides new/changed status.
2. **New:** no `authors` row → back-catalog scrape.
3. **Unchanged:** cached and `lastmod <= last_seen` → `skippedUnchanged`.
4. **Changed, recently scraped:** cached, `lastmod > last_seen`, and
   `wasAuthorPageScraped(entry)` and `last_seen >= now - minAge` →
   `skippedRecent`; enqueue a `deferred` candidate row with
   `not_before = last_seen + minAge` so it is picked up when the cooldown ends,
   even if the file itself never changes again.
5. **Changed, due:** cached, `lastmod > last_seen`, and (not recently scraped,
   or no author-page stats) → recent scrape.
6. **Unknown lastmod:** count `unknown`; skip unless `--includeUnknown` is added
   later.

`last_seen` is the existing proxy for “last scrape date”; the
`wasAuthorPageScraped()` guard prevents a mint-only row’s list-walk
`last_seen` from suppressing its first author-page scrape.

### Scrape flow

1. Select ready candidates:
   - `status='pending'`, or `status='deferred' AND not_before <= now`;
   - `--only` filter;
   - order by `sitemap_lastmod DESC`, then `shard_id`, then `author_id`;
   - apply `--authors` budget.
2. For each candidate:
   - Re-check `isRetiredAuthor` against the live ledger; if retired → mark/count
     `errorSkipped`, no network request, no per-author log line.
   - Choose the scrape:
     - `back_catalog` → `scrapeAuthorStats(..., crawlAllPages=true, ...)`:
       `/author/list/<id>`, then `?page=2..N`.
     - `recent` → `scrapeAuthorStats(..., crawlAllPages=false,
       sort='original_publication_year', ...)`:
       `/author/list/<id>?sort=original_publication_year`, page 1 only.
   - Use `withConnectivityProbe` and normal `delay` pacing
     (~1–1.8s anonymous between authors).
3. On success:
   - update `authors` stats/slug via the shared `storeAuthorStats` helper,
   - stamp `source='author_sitemap_monitor'` for newly created rows; the
     existing upsert preserves a non-empty/non-unknown source on existing rows
     and fills blank/unknown,
   - clear failure strikes,
   - delete the candidate row (or mark done and prune later),
   - count `backCatalogScraped` or `recentScraped`.
4. On no-stats / failure:
   - increment `attempts`, set `last_attempt` / `last_error`,
   - record strikes with `recordAuthorScrapeFailure` exactly as normal,
   - keep pending until `AUTHOR_FAIL_LIMIT` / retired logic says stop,
   - then mark `error_skipped`/delete and count; do not retry forever.
5. On connectivity error:
   - stop the drain, keep progress/queue, exit with the usual “network error —
   progress saved” message.
6. Print the end-of-file and aggregate summaries.

### End-of-file report

Every file reports at least:

- `skipped` (total), broken down into:
  - `skippedUnchanged`
  - `skippedRecent` (inside `--minAge` cooldown)
  - `errorSkipped` (retired failure ledger)
- `recentScraped`
- `backCatalogScraped`
- `noStats`
- `failed`
- `pendingRemaining` (if `--authors` budget stopped early)
- books new/enriched

Example:

```text
🏁 sitemap.178.xml.gz done  (illustrative)
   skipped=14,279 (unchanged=13,962, recent<30d=0, error=317)
   recentScraped=21,100  backCatalogScraped=13,300
   noStats=12  failed=3  pendingRemaining=0
   books: 4,812 new / 9,331 enriched
   temp file deleted
```

### Politeness / guardrails

- Use the same throttling rules as `authorOne` / `authorRescan` /
  `authorRecent`: anonymous pacing by default, `--withCookie` opt-in,
  `withConnectivityProbe` for blips, no unbounded retry on 202/403, stop on
  connectivity loss with progress saved.
- Default `--authors 100`; long runs under `caffeinate -is`.
- `--enqueueOnly` is the safe way to build the queue without hammering.
- Delete the `.gz` immediately after preview/enqueue; scraping happens from the
  queue afterward, so no sitemap files linger.
- Back-catalog scrapes are much heavier than recent scrapes; the new-author
  path should be budgeted first, not run unbounded.

### Scale warning

- 190 shards × ~48k URLs ≈ **9.2M author URLs** total. Shards 178–180 alone are
  145,561 URLs with ~58k new IDs at plan time.
- Phase 2 must never enqueue-and-scrape all pending rows by default. The queue
  plus `--authors` budget is the guardrail.
- Hash/size comparison prevents re-enqueueing an unchanged file, but it does
  not make a 9M-author back-catalog cheap.

## 6. Error handling (same failure ledger as normal)

- Reuse `author_scrape_failures`, `AUTHOR_FAIL_LIMIT`, `isRetiredAuthor`,
  `recordAuthorScrapeFailure`, and `clearAuthorScrapeFailure`. Do not introduce
  a second error system.
- Retired IDs are `errorSkipped` **before** classification decides new/changed.
  This applies even when the sitemap says the author was updated.
- `errorSkipped` is quiet: no per-author console line and no extra strike. The
  count appears in the dry-run preview, the apply/file summary, the aggregate
  summary, and the JSONL log.
- In apply mode, re-check the live ledger immediately before each scrape, so a
  concurrent crawler’s strikes are respected.
- On normal scrape failure/no-stats, record strikes exactly as `authorOne` /
  `authorRescan` do. Once the author reaches the limit, future runs skip it
  quietly as `errorSkipped`.
- A successful scrape clears the failure ledger, so the author becomes eligible
  again if its sitemap `lastmod` changes later.

## 7. Testing and verification

### Unit tests

- Index parser: `<loc>` URLs used verbatim, numeric IDs extracted from the loc
  path, non-contiguous/renumbered/malformed entries, and entries whose filename
  does not match `sitemap.<n>.xml.gz`.
- Index validation: a different host/path/filename (or a malformed `<loc>`)
  aborts the run with a non-zero exit before any shard is downloaded, and the
  error names the offending `<loc>`.
- Shard parser: `<loc>` + `<lastmod>`, missing lastmod, malformed URL,
  duplicate IDs, XML entities.
- Classification: new / changed / unchanged / unknown / error-skipped,
  timezone-aware date comparison, missing `last_seen`, mint-only rows.
- Chunked DB lookup: >500 IDs, chunk boundary, empty result.
- Failure-ledger integration: retired IDs are counted as `errorSkipped` and not
  enqueued/scraped; dry-run and apply summaries both include the count.
- Cooldown: changed author inside/outside `--minAge`; recent vs back-catalog
  selection.
- Hash/size/restart: same hash skips reparse; changed hash re-enqueues; 304/ETag
  path; temp deletion on success and failure.
- Source stamping: new rows get `author_sitemap_monitor`; existing non-empty
  source is preserved.
- Temp lifecycle: file deleted on success, parse error, and DB error.
- Log writer: JSONL fields, append/flush behavior (temp dir).
- Phase 1 dry run: no `authors` writes, no scrape calls, counts match fixture.
- Phase 2: candidate upsert/deferred/reset semantics, shard skip, `--only`/
  `--authors` ordering and budget, failure strikes, resume.

### Live verification

1. `./authorSitemapMonitor.sh --dryRun --files 3` against the real index.
2. Confirm:
   - 3 shards processed, HTTP 200, sizes/durations/hashes logged,
   - preview entries/lastmod min/max/new/changed/unchanged/errorSkipped counts,
   - temp `.gz` files gone,
   - `authorSitemapMonitor.log` has the expected index/download/preview/delete
     records,
   - `countAuthors()` unchanged before/after.
3. Phase 2 after implementation:
   - `--enqueueOnly --files 1` then inspect the file and candidate tables,
   - `--authors 5` on a small pending set,
   - verify recent vs back-catalog scrape kind,
   - verify `authors.source='author_sitemap_monitor'`,
   - verify `errorSkipped` appears in both preview and apply summaries,
   - verify hash/size restart behavior, strikes, and no leftover `.gz`.

## 8. Open questions before implementation

1. **Timestamp source:** confirm the `authors.last_seen` + `wasAuthorPageScraped`
   proxy is acceptable for the 30-day cooldown. If not, add
   `authors.author_page_scraped_at` first and stamp it in every author-page
   scraper.
2. **Scrape budget:** is `--authors 100` the right default, with `0` meaning
   “no cap,” or should each selected file be fully drained by default?
3. **File-change detection:** is conditional GET + SHA-256 + compressed size the
   desired approach, or should every selected file always be fully downloaded
   and hashed?
4. **Log format:** JSONL in `authorSitemapMonitor.log` (proposed) versus the
   older plain-text log style.

## 9. Explicit non-goals for this plan

- No automatic full-queue drain; no 9M-author unattended crawl.
- No retention of downloaded sitemap files.
- No changes to `authorOne` sitemap parsing beyond sharing helpers.
- No second failure/error system; the normal ledger is authoritative.
- No implementation until this plan is approved.
