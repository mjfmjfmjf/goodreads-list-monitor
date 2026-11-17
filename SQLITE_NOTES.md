## SQLite writes / database locking
- **Do NOT call `loadBookCache()` — it materializes the whole `books` table
  (~5.6M rows / several GB of V8 heap) into a JS object.** Commands OOM'd at
  Node's default ~3.9GB cap on 2026/09/13, so a 2026/09/13 refactor removed
  every production call site. `loadBookCache` now survives only as its own unit
  test in `storage.ts`. Replacements, in order of preference:
  - `iterateBooks()` / `streamRows()` — stream rows with O(1) memory; the
    mapping/histogram/audit commands use these (plus `countBooks()` for totals).
  - `getBook(id)` — single-row lookup; sparse per-entity caches (monitored
    lists, CSV entries, queue candidates) and `syncBooksToCache` merge against
    the live DB, so sync-only walkers pass an empty in-run `BookCache = {}`.
  - Bounded streaming (per-bucket / top-N by ratings) where the command needs
    only the best candidates (`books`, `tagGaps`, `authorTopBooks`,
    `monitorTopRatedList`, `bookSweep`), or SQL-side aggregation/helpers
    (`cachedPublishedYear`, `summaryTopByYear`, `booksAddedHistogram`).
  Keep new bulk writers as plain single-statement upserts (see below) and
  reach for these patterns instead of a new full-table load.
- **A streaming read and a write cannot share one connection at the same time.**
  better-sqlite3 treats `.run()` as `DOES_MUTATE`: it throws "This database
  connection is busy executing a query" while any read iterator on the same
  connection is open. `.get()`/`.all()` are fine (they only need the connection
  not to be mid-statement). So `for (const r of streamRows(...)) { stmt.run(...) }`
  NEVER works — and `[...streamRows(...)]` (materializing the whole table just to
  dodge the throw) is the `loadBookCache` anti-pattern all over again. For a
  read→recompute→write pass use **keyset-chunked pagination**: read a bounded
  chunk with `.all()` (which fully consumes and closes the statement), write it,
  then resume after the last id (`WHERE id > ? ORDER BY id LIMIT ?`). See the
  `authorMint.ts` comment plus `backfillRatingsStats.ts` / `backfillSeriesPos.ts`.
  `db.unsafeMode(true)` lifts the restriction but the codebase does NOT use it.
- **`idx_books_author_pub (author_id, ratings DESC, published)` must keep
  `published`.** It is the only reason `loadAuthorBookStats`'s
  `GROUP BY author_id` (MAX(ratings) + year-over-`published` + COUNT across
  ~12.3M books) is a covering scan: 189s cold without `published` in the index
  vs 2.2s with it (83×, benchmarked 2026/10/07). Without it SQLite reads the
  grouping from the index but still table-fetches `published` for every row —
  EXPLAIN says `USING INDEX` instead of `USING COVERING INDEX`. The old
  `idx_books_author_id` was a strict prefix and was dropped; `ensureIndexes()`
  creates the replacement first, then drops (see `SCHEMA_DROP_INDEXES`).
- Earlier npm scripts had a central `--max-old-space-size=8192` in NODE_OPTIONS
  to make the full-cache commands fit; that bump was reverted on 2026/09/13
  once the loads were gone. `NODE_OPTIONS='--loader ts-node/esm --no-warnings'`
  must stay — do not re-add a heap bump to paper over a new full-table load.
- SQLite locks are database-wide (WAL: ONE writer at a time, whole DB) — NOT
  per-row/per-table. Any write transaction you hold blocks every other crawler's
  writes for its whole duration.
- Crawler writes are single-statement autocommit upserts: NO `db.transaction`
  batches. Each statement is sub-ms (`synchronous=NORMAL` in WAL = memory-only
  commits), so a write lock is held only for one statement and never across a
  network read/sleep. Keep new bulk writers as plain `stmt.run()` loops.
- `db.transaction` is reserved for atomic multi-step ops that don't run during
  crawls (importData, migrateToSqlite, authorDedupe, saveState).
- Under WAL, `SQLITE_BUSY` (busy_timeout waits it out) and `SQLITE_BUSY_SNAPSHOT`
  (stale snapshot — busy_timeout does NOT help) are both retried 3× with a
  checkpoint-before-retry for the snapshot case. Overrides for tests/tuning:
  `GOODREADS_BUSY_TIMEOUT_MS`, `GOODREADS_LOCK_RETRY_DELAY_MS`. Writes must stay
  idempotent upserts so replay-after-abort is safe.
- Avoid running several heavy crawlers at once (e.g. gap-genre + author-rescan +
  list-tag-walk) — they serialize on the same writer lock either way.
- **Daily DB backup runs on a schedule via `./backupDb.sh`, NOT inside
  `monitor.sh`** (a 2026/09/20 incident: the backup API snapshot took 57min
  under crawler load and looked hung — fast to ~60% while the OS-cache-warm
  bulk copied, then ~200KB/s through the cold tail). **Scheduler (installed
  2026/10/03): launchd agent `com.goodreads.backupdb` at
  `~/Library/LaunchAgents/com.goodreads.backupdb.plist`, daily 08:00, output
  to `backups/backup.log`.** History: the backup used to be a tail step of
  `monitor.sh`; that was removed on 2026-09-20 (committed 1ef2273, 2026-09-25)
  with a comment to "run it on its own schedule", but no cron/launchd job was
  ever actually installed — so backups silently stopped 2026-09-20 → 2026-10-03.
  If `backups/backup.log` goes stale, check the job with `launchctl print
  gui/$(id -u)/com.goodreads.backupdb`. Crawlers are always running, so the
  backup never waits for idle time. Fast path in `backupDb()`
  (src/db.ts): `PRAGMA wal_checkpoint(TRUNCATE)` then an APFS copy-on-write
  clone (`COPYFILE_FICLONE`) — instant, point-in-time, consistency verified
  (re-verified 2026-10-03: 5.59GB cloned in 19.3s with 3 crawlers live).
  Falls back to the SQLite backup API when another connection holds a read
  mark and the WAL can't be reclaimed (`checkpointCompleted()` decides).
  Do not re-add the backup to monitor.sh; do not make it skip when crawlers
  are running.
