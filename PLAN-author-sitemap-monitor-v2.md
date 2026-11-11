# PLAN-author-sitemap-monitor-v2 (streaming)

Replaces the batch/queue design in `PLAN-author-sitemap-monitor.md` (kept for
history). That plan captured "process N files, enqueue candidates, drain a global
queue with a per-run `--authors` budget," which is **not** the intended model.

## Requirements (the user's words)

- Walk the author sitemap **entry by entry, in order**.
- For each entry, do exactly one thing:
  - back-catalog scrape (new author),
  - recent scrape (changed author),
  - skip due to recency (changed but author page scraped within `--minAge`),
  - skip due to error (retired failure ledger / unknown lastmod).
- It should be able to run for **days or weeks** in one process.
- Restarting the script should **quickly skip the files already finished** and
  resume the partially processed file where it left off.

The externally visible behavior is a line streamer. Internally we may parse the
whole shard first (8 MB) and then act in document order; that is an
implementation detail, not a queue.

## Non-goals / removed from the old design

- **No candidate queue table.** `author_sitemap_candidates` is deleted. Nothing
  is pre-enqueued for later; each entry is acted on when reached.
- **No `--enqueueOnly`.** Ingestion alone is not a mode anymore.
- **No `--authors` budget by default.** Replaced by optional `--maxAuthors`
  (safety valve; `0` = unlimited, the default).
- **No deferred/cooldown queue.** A recency skip is a skip for this pass: the
  cursor advances. **Re-running is the revisit mechanism** — but note a plain
  re-run skips finished shards, so a skipped-recent entry is only reconsidered
  when its shard is walked again (hash changed, or an explicit `--force`).
- **No `--only new|changed`.** Selecting one kind would silently treat the
  other as skipped and lose work.

## Preserved invariants (from the old plan, still required)

- Shard URLs come **only** from the index `<loc>` entries, used verbatim. Every
  `<loc>` must match `^https://www\.goodreads\.com/sitemap\.(\d+)\.xml\.gz$`;
  any mismatch aborts the run before downloading.
- Never construct `sitemap.<n>.xml.gz` from a number.
- Do **not** call `loadBookCache()`. Use point lookups (`getBook`-style) or
  chunked `IN (...)` reads; no whole-table materialization.
- Reuse `scrapeAuthorStats`, `storeAuthorStats`, the failure ledger
  (`recordAuthorScrapeFailure` / `isRetiredAuthor` / `clearAuthorScrapeFailure`),
  `withConnectivityProbe`, `delay`, and `parseDelayRange`. Do not duplicate
  scraping.
- Anonymous pacing by default (`--withCookie` opts in). Keep existing delays.
- No unbounded retry on 202/403. Connectivity errors stop the run with the
  cursor saved.
- Temp `.gz` is deleted after parse; no long-lived sitemap cache.
- NEVER chmod files; no code comments unless asked.

## Data model

Only one operational table. Replace `author_sitemap_files` with:

```sql
CREATE TABLE IF NOT EXISTS author_sitemap_files (
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

  -- streaming resume state
  cursor_author_id    TEXT,              -- last entry fully acted on
  cursor_index        INTEGER,           -- ordinal fallback (0-based)
  processed_entries   INTEGER NOT NULL DEFAULT 0,

  -- per-file counters (incremental; updated as the cursor advances)
  new_ids             INTEGER NOT NULL DEFAULT 0,
  changed_ids         INTEGER NOT NULL DEFAULT 0,
  unchanged_ids       INTEGER NOT NULL DEFAULT 0,
  unknown_ids         INTEGER NOT NULL DEFAULT 0,
  error_skipped_ids   INTEGER NOT NULL DEFAULT 0,
  back_catalog_scraped INTEGER NOT NULL DEFAULT 0,
  recent_scraped      INTEGER NOT NULL DEFAULT 0,
  skipped_recent      INTEGER NOT NULL DEFAULT 0,
  skipped_unchanged   INTEGER NOT NULL DEFAULT 0,
  failed_ids          INTEGER NOT NULL DEFAULT 0,

  preview_at          TEXT,
  fetched_at          TEXT,
  parsed_at           TEXT,
  processed_at        TEXT,
  status              TEXT NOT NULL DEFAULT 'pending', -- pending|in_progress|done|error
  error               TEXT
);
```

One row per shard, single-statement autocommit upserts. **Persist the cursor
after every entry** (the write is sub-millisecond); never hold a transaction
across a scrape or delay.

`author_sitemap_candidates` is dropped. Remove it from `EXCLUDED_TABLES`
(`exportData.ts`) and `IGNORED_TABLES` (`fieldCoverage.ts`) once it no longer
exists.

### One-time migration (live DB already has data from the old test run)

Today's live DB contains `author_sitemap_files` rows (178/179, mostly `done`)
and ~39k `author_sitemap_candidates` rows from the apply-mode test. The new
semantics must re-walk those shards entry-by-entry.

- Guard with a marker (existing `config`/state mechanism) so it runs once:
  `DROP TABLE IF EXISTS author_sitemap_candidates;`
  `DROP TABLE IF EXISTS author_sitemap_files;`
  then recreate the table above.
- This discards the old queue (intended) and the old ledger counts
  (re-derivable). Known outcome: shards 178/179 are re-walked; authors whose
  `last_seen` was updated by the 100 test scrapes classify as unchanged or
  changed-within-cooldown and are skipped.
- If a marker mechanism is awkward, a `DROP ... IF EXISTS` + recreate on every
  startup is acceptable because the table is new and uncommitted; document the
  choice in code.

## CLI

```bash
./authorSitemapMonitor.sh --dryRun --files 2
./authorSitemapMonitor.sh                       # all remaining shards, no author cap (days/weeks)
./authorSitemapMonitor.sh --files 1             # one shard this run
./authorSitemapMonitor.sh --start 200 --files 10        # really walk shards 200..209
./authorSitemapMonitor.sh --start 200 --end 210        # really walk shards 200..210
./authorSitemapMonitor.sh --maxAuthors 500      # safety cap; saves cursor and exits
./authorSitemapMonitor.sh --force --files 1     # reset cursor and re-walk a finished shard
```

| Option | Default | Meaning |
|---|---|---|
| `--files <n>` | all remaining | Number of shards to work in this run. With `--start`, it bounds an explicit range. |
| `--start <shard>` | next unfinished | First shard. **Supplying it selects explicit-range mode**: every selected shard is freshly re-walked (unconditional download, all entries, cursor reset) regardless of `done`. |
| `--end <shard>` | — | Last shard, inclusive. Requires `--start`. Mutually exclusive with `--files`. |

`--start` and `--end` are **Goodreads shard IDs** (currently 178–367), not
1-based positions in the index. The console/log always shows both the shard ID
and its position (e.g. `sitemap.200.xml.gz (23/190)`).
| `--index <url>` | author index | Override for tests. |
| `--force` | off | Ignore the done/hash shortcut and reset the shard's cursor. |
| `--maxAuthors <n>` | `0` (unlimited) | Stop after N individual author actions (scrapes only; skips are free), saving the cursor. |
| `--minAge <days>` | `90` | Skip a changed author whose author page was scraped within this many days. |
| `--multiPage` | off | Force a full back-catalog crawl for changed authors too. |
| `--withCookie` | off | Use cookie-authenticated pacing. |
| `--dryRun` | off | Preview/classify and print counts only; no scrapes and no DB writes. |

Remove `--enqueueOnly`, `--authors`, `--only` from the CLI and help text.

## Re-running and explicit ranges

There are two modes.

**Resume mode (no `--start`, no `--force`).** Re-running is how you continue:

1. Shards with `status='done'` are skipped **without downloading the shard**
   (only the index fetch happens), so earlier files are skipped quickly.
2. The one `status='in_progress'` shard is re-downloaded/parsed and resumed at
   its cursor.
3. Remaining shards are walked in order until the run ends (`--files`,
   `--end`, `--maxAuthors`, Ctrl-C, connectivity loss).

A recency-skipped author in a finished shard is only reconsidered when that
shard is walked again (explicit range, `--force`, or its hash changed).

**Explicit-range mode (`--start` given, or `--force`).** The selected range is
*really* processed, not skipped:

- Selection is `--start` through `--end` (inclusive), or `--start` plus
  `--files` count, or just `--start` = that shard to the end of the index.
- Every selected shard is freshly walked: cursor reset to entry 0, **no**
  `If-None-Match`/`If-Modified-Since`, no hash/size short-circuit. It downloads
  the file and reads every entry in order, even if the shard is `done`.
- On an unchanged, recently-scraped shard this is quiet: no new IDs, cached
  authors `unchanged`, changed-but-inside-`--minAge` authors `skippedRecent`;
  it reaches the end, prints the summary, and moves to the next selected shard.
- `--end` and `--files` are mutually exclusive; `--end` must be >= `--start`.
- `--maxAuthors` still bounds total author actions and saves the cursor.

So `--start 200 --files 10` and `--start 200 --end 210` both mean "walk shards
200 through 210 for real, regardless of prior status."

## Per-shard flow

1. Fetch the index (log status/bytes/duration; validate all `<loc>`s).
2. Choose shards in ascending `shard_id`:
   - explicit range: `--start` … `--end` (inclusive), or `--start` plus
     `--files`, or `--start` to the end of the index;
   - otherwise (resume mode): first row whose `status != 'done'`, for
     `--files` shards (default: all remaining).
3. For each shard **sequentially**:
   1. If `status = 'done'` and not in explicit-range mode and not `--force`:
      log `skip finished` and move on **without downloading the shard** (only
      the index request happened).
   2. In explicit-range mode (or `--force`): reset the cursor to entry 0 and
      force a **fresh full download** — send no `If-None-Match` /
      `If-Modified-Since`, and do not let hash/size short-circuit the walk.
   3. Otherwise issue a conditional GET when validators exist.
      - `304` → treat as unchanged; log `skip unchanged` and move on.
      - `200` + same `sha256`/`bytes_compressed` as the ledger → unchanged;
        log `skip unchanged` and move on.
      - `200` + different hash/size (or no prior row) → download and parse.
        If the shard was `in_progress` and the hash changed, reset the cursor
        to the start and re-walk: already-decided authors then classify as
        unchanged / changed-within-cooldown and are skipped cheaply. This is
        safer than resuming by author id into a reordered file.
   4. On a fresh/reset walk: upsert `status='in_progress'`, `fetched_at`,
      `parsed_at`, hash/bytes, per-file totals.
   5. Parse all `<url>` entries into ordered `{ id, slug, lastmod }[]`.
      Delete the temp `.gz` immediately after parsing (the entries are in
      memory; restart re-downloads if the file is not yet done).
   6. Determine the resume point: skip entries until `cursor_index`
      (`cursor_author_id` is a cross-check; if it disagrees with the ordinal —
      e.g. Goodreads reordered a same-hash file — use the ordinal and log a
      warning). Log `resuming at entry N/total` when N > 0.
   7. Iterate entries **in order** from the resume point:
      - Classify with point lookups (fresh at the moment of action):
        - retired in `author_scrape_failures` → skip, count `errorSkipped`;
        - no `authors` row → `new` → back-catalog scrape;
        - missing/invalid `lastmod` or `last_seen` → skip, count `unknown`;
        - `lastmod <= last_seen` → skip, count `unchanged`;
        - `lastmod > last_seen` and author page present and
          `last_seen >= now - minAge` → skip, count `skippedRecent`;
        - otherwise → `changed` → recent scrape (`--multiPage` forces
          back-catalog).
      - Perform at most one action, then **immediately upsert the cursor**
        (`cursor_author_id`, `cursor_index`, `processed_entries`) and the
        affected counters.
      - On scrape success: `storeAuthorStats(..., 'author_sitemap_monitor')`,
        `clearAuthorScrapeFailure`, count `recentScraped`/`backCatalogScraped`,
        books new/enriched.
      - On no-stats / failure: `recordAuthorScrapeFailure`, count `failed`;
        if the ledger now retires the author, count `errorSkipped`; either way
        advance the cursor (no retry loop).
      - On connectivity error: save the cursor (already saved), leave
        `status='in_progress'`, print "network error — progress saved", exit.
      - Honor `--maxAuthors`: when reached, save the cursor, leave
        `status='in_progress'`, exit 0.
   8. After the last entry: `status='done'`, `processed_at`, print the file
      summary, continue to the next shard.
   9. A non-connectivity download/parse error marks the shard `status='error'`
      with the message and moves on (a later run retries it).

## Console / log

Per shard, one header and one summary; per **action**, one line:

```text
[1/190] sitemap.178.xml.gz  48,703 entries  resuming at #0
  [  1/48703] 56399.Pat_Hackett (56399) — recent
  [  2/48703] 12345.New_Author (12345) — back_catalog
  [  3/48703] 67890.Seen_Recently (67890) — skip recent (12d < 90d)
  ...
🏁 sitemap.178.xml.gz done
   processed=48,703 / 48,703
   new=2,836 backCatalog=2,836
   changed=21,095 recent=16,878 skippedRecent=4,215 errorSkipped=2
   unchanged=24,772 unknown=0 failed=3
   books: 4,812 new / 9,331 enriched
```

- Do **not** write a JSONL line per skipped entry (48k lines/shard); log
  counters. Log per scrape/failure, per shard start/done, and the run summary.
- Progress lines are flushed so the run can be tailed for days.

## Failure / politeness behavior

- Per-entry failures never stop the shard; they advance the cursor.
- Connectivity errors and `--maxAuthors` stop the process with the cursor
  saved; the next run re-downloads the in-progress shard (hash may match; we
  still need the entries) and resumes at the cursor.
- Keep the existing `authorOne` pacing (~1.0–1.8s anonymous; cookie mode
  slower). Back-catalog crawls are much heavier; they happen only for genuinely
  new authors.
- Long runs under `caffeinate -is`.

## Code changes

- `src/db.ts`: replace the two Phase 2 tables with `author_sitemap_files`
  (cursor schema); one-time drop/reset migration; remove candidate indexes.
- `src/authorSitemap.ts`: keep index/shard parsing + `classifySitemapEntries`;
  delete `planSitemapCandidates`, candidate decision types, and
  `nextSitemapStart` (replace with `firstUnfinishedShard(shards, rows)`).
- Delete `src/authorSitemapStore.ts` candidate functions; keep/rewrite file
  ledger + cursor accessors (`getSitemapFile`, `listUnfinishedShardIds`,
  `upsertSitemapFile`, `advanceSitemapCursor`, `markSitemapFileError`,
  `resetSitemapCursor`).
- `src/authorSitemapMonitor.ts`: rewrite the loop as ingest-once-per-shard then
  ordered per-entry act/resume; remove `enqueueCandidates`/`drainCandidates`.
- `src/index.ts`, `authorSitemapMonitor.sh`, `package.json`: CLI/help updates.
- `src/exportData.ts`, `src/fieldCoverage.ts`: drop candidate table references.
- Tests: replace queue/drain tests with cursor/streaming tests (below).

## Tests (unit, no network)

- Entry decision matrix: retire > unknown > unchanged > skip-recent > changed >
  new, including mint-only rows (no stats) inside the window → scrape.
- Resume: process entries 0–2, simulate abort, restart from the same shard,
  verify entries 0–2 are skipped without reclassification/scrape and entry 3
  is acted on.
- Finished shard is skipped with **no shard download** (only the index fetch).
- `--force` resets the cursor and re-walks.
- Hash change mid-file resets the cursor to the start.
- `--maxAuthors` saves the cursor and exits `in_progress`; next run resumes.
- Connectivity abort leaves `in_progress` at the last completed entry.
- Recency skip advances the cursor and writes no candidate row.
- Dry run writes nothing (no file ledger, no cursor).
- Migration drops the old candidate table and re-walks affected shards.
- Full `./runUnitTests.sh` gate (tsc + coverage + CLI smoke) stays green.

## Acceptance

- `./authorSitemapMonitor.sh --files 1` prints one action line per entry and can
  be Ctrl-C'd at any point.
- Rerun: finished shards are skipped instantly; the in-progress shard resumes at
  the saved cursor (log shows `resuming at #N`).
- With no `--files`/`--maxAuthors`, a single process can walk all remaining
  shards for days/weeks.
- No `author_sitemap_candidates` table exists; no candidate queue writes.
- Live check: run one shard, interrupt after a handful of authors, restart,
  confirm the cursor resumes and the finished shard is skipped.
