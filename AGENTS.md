# AGENTS.md — Working memory for this repo

## Testing cadence
- **Unit tests** (`./runUnitTests.sh`): fast, offline. Three gates in order:
  `tsc --noEmit` (full strict typecheck — ts-node typechecks at load time in
  production, vitest does NOT), Vitest WITH v8 coverage on `src/*.test.ts`,
  then the offline CLI smoke test which spawns the real CLI under the
  production ts-node/esm loader. Run after EVERY feature change or dependency/
  tool upgrade.
- **Integration tests** (`./runIntegrationTests.sh`): live lookups against real
  Goodreads pages (a dozen+ requests, pagination sweeps, one add-book lookup).
  Run deliberately BEFORE/AFTER risky scraper changes, when Goodreads markup may
  have drifted, or when the user asks. Needs cached `libraryExportCache.json` +
  `authorsCache.json` + `state.json` (monitored lists) + `config.json`.
- If the integration suite fails, FIRST retry after a cooldown (~60s+) before
  suspecting a parser change — see throttling below.

## Goodreads throttling / politeness — IMPORTANT
- Goodreads throttles aggressively. It has served HTTP 202 0-byte interstitial
  pages to this app's axios requests (most recently 2026/08/09 on `/search`)
  while a browser got the full 200 page. This is anti-bot throttling, not a
  markup change.
- The codebase already has MANY sleep/delay calls before Goodreads hits. Do not
  add new scrapers that hammer the site; keep existing delays; space out
  sequential requests (the integration suite uses a ~2s delay between live
  calls).
- The add-book live lookup is rate-limited to AT MOST once per minute (state in
  `os.tmpdir()/goodreads-addbook-lookup.json`). Do not bypass this.
- Never loop an unbounded retry on 202/403 — back off and report.
- The integration suite runs in STRICT throttle mode
  (`GOODREADS_STRICT_THROTTLE=1`): on a 202/403/429 it gives up immediately
  (no retry/backoff) so a throttled run fails fast with a clear message.
  A failure with a throttle message means cooldown, NOT a parser change.

## Goodreads page-change log
- Whenever a Goodreads page change forces a code fix (selector updates, markup
  shifts, URL changes, new anti-bot behavior), ADD AN ENTRY to
  `GOODREADS_CHANGES.md` (newest entry on top, timestamp `YYYY/MM/DD HH:MM`).
  Keep it concise: date, what changed, what was fixed, any throttling notes.

## Future work
- Longer-horizon plans live in `PLAN-*.md` files (e.g.
  `PLAN-edition-clustering.md`). Read the relevant one before working on that
  area; update it when facts on the ground change.

## Code conventions
- Scrapers live in `src/scraper.ts` using cheerio. Unit-test pure logic in
  `src/*.test.ts`; never hit the network in unit tests.
- Vitest configs are `.mjs` (must stay `.mjs` — tsconfig uses `rootDir: src`).
- `npm test` = fast unit; `npm run test:coverage` = unit + coverage;
  `npm run test:integration` = live suite (slow, polite).
