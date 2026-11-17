# AGENTS.md — Working memory for this repo

## Bash Handling
- Pipe verbose command outputs (tests, builds, linters, logs) directly to a temp file (`> /tmp/<name>.out 2>&1`, never `| tee`) and inspect only the tail or failure lines (`tail -n 40`).

## Working agreement — COMMUNICATE (do not go dark)
- **Report before digging:** Emit one short sentence stating the task and what you will check before starting tool calls.
- **No silent tool marathons:** After every 3–4 tool calls, post a 1-line update on what you found and what is next.
- **Surface findings & blockers immediately:** Report broken builds or half-finished features as soon as you find them. If a decision is needed, present brief options and stop to wait.
- **Keep concise breadcrumbs & wrap-ups:** Note current state as you go. End every task with a brief status: changed, verified (command + result), not done, and next step.
- **Resuming a session:** Reconstruct current tree state, what is done/missing, and open questions before making any edits.

## Testing cadence
- **Unit tests (`./runUnitTests.sh`):** Run after every feature change or dependency upgrade (`tsc --noEmit`, Vitest + v8 coverage, offline CLI smoke test). Redirect output (`./runUnitTests.sh > /tmp/unit.out 2>&1`) so the user can `tail -f /tmp/unit.out`; inspect only `tail -n 40 /tmp/unit.out`.
- **Integration tests (`./runIntegrationTests.sh`):** Run **only with ALL scrapers/crawlers OFF**, before/after risky scraper changes, or when requested (requires cached `libraryExportCache.json`, `authorsCache.json`, `state.json`, `config.json`).
- **Integration failure handling:** Retry once after a 60s+ cooldown before suspecting markup drift—except if only `/book/show` `browser-book-scrape` fails with HTTP 202 (known anti-bot interstitial; do not retry).

## Goodreads throttling / politeness — IMPORTANT
- Never bypass rate limits (e.g., 1/min add-book lookup) or add unbounded retries on HTTP 202/403.
- Before modifying scrapers, pacing delays, or tag/author crawlers, read `GOODREADS_NOTES.md`.

## SQLite writes / database locking
- **Never call `loadBookCache()`** (OOMs on 5.6M+ rows) or re-add `--max-old-space-size` to `NODE_OPTIONS`. Use `iterateBooks()`, `streamRows()`, `getBook(id)`, or bounded SQL queries.
- **No writes inside a read iterator:** `better-sqlite3` throws if `.run()` executes while `streamRows()`/`iterateBooks()` is open. Use keyset-chunked pagination (`.all()` with `WHERE id > ? ORDER BY id LIMIT ?`).
- **Keep `published` in `idx_books_author_pub (author_id, ratings DESC, published)`** so `loadAuthorBookStats` remains a covering index scan.
- **Crawler writes must be single-statement autocommit upserts** (`stmt.run()`), never wrapped in `db.transaction` (which blocks concurrent crawlers). Writes must stay idempotent for lock retries.
- **Do not add backups back into `monitor.sh`** (`./backupDb.sh` runs via `launchd` `com.goodreads.backupdb`).
- Before modifying DB schema, indexes, or bulk writers, read `SQLITE_NOTES.md`.

## Static publish schedule
- **`publishAndUpload.sh`** (launchd `com.goodreads.publishsite`, daily 09:00; log `~/Library/Logs/goodreads-publish.log`) runs `./publishSite.sh --out ~/goodreadsZeitgeist` then `uploadHostpapa.sh ~/.hostpapa-ftp.env <dir>`.
- Upload omits `--delete`, so removed local reports stay on the server until manually deleted. Check status with `launchctl print gui/$(id -u)/com.goodreads.publishsite`.

## Sanitized export / import (data sharing)
- **Schema completeness invariant:** Whenever adding a SQLite table, add it to either `EXPORT_TABLES` or `EXCLUDED_TABLES` (live cookies/scrape state) in `exportData.ts` (enforced by unit test).
- **Merge semantics (`import-data`):** Fill-blank-only (never overwrites existing data); unions genres/tags and `lists.seen_book_ids`, keeps newest `scraped_at`/`last_updated`/runs, and never re-stamps `first_seen`.
- **CSV parsing:** Always use `CsvRecordParser` (`importData.ts`) for RFC 4180 multi-line records (`book_page.description` contains escaped newlines; line-oriented parsers corrupt rows).

## Goodreads page-change log
- When a Goodreads change (selectors, markup, URLs, anti-bot) requires a code fix, prepend a concise entry to `GOODREADS_CHANGES.md` (`YYYY/MM/DD HH:MM`: what changed, fix applied, throttling notes).

## Future work
- Longer-horizon plans live in `PLAN-*.md` files (e.g., `PLAN-edition-clustering.md`). Read the relevant one before working on that area; update it when facts on the ground change.

## Code conventions
- **Structure & testing:** Scrapers live in `src/scraper.ts` (cheerio). Put pure unit tests in `src/*.test.ts` (never hit the network). Keep Vitest configs as `.mjs` (`tsconfig.json` uses `rootDir: src`).
- **`.ts` import extensions:** All relative imports use `.ts` (`from './storage.ts'`). Keep `allowImportingTsExtensions` and `noEmit` paired in `tsconfig.json`—dropping either causes hundreds of `TS5097` errors and crashes the `ts-node/esm` loader.
- **Test scripts:** `npm test` (fast unit), `npm run test:coverage` (unit + coverage), `npm run test:integration` (live, slow, polite).

## Agent behavior / safety
- **Never change file permissions or execute bits** (`chmod +x`, etc.); always respect existing permission settings.
- **STOP means STOP:** When the user says "stop", "abort", or "halt", immediately cease all tool calls and wait.
- **Never auto-retry aborted or timed-out commands** without explicit user permission.

