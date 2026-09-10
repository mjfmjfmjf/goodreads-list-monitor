# PLAN: Per-book harvest by walking the Goodreads list hierarchy (browser path)

Created 2026/09/05. User proposal; not yet scoping or implementing.

## Starting point

`https://www.goodreads.com/list/show/35080` — a list-of-lists page whose
entries correspond to list links already captured in `bulkTopics.json` and
`state.json`. Each list entry links to a paginated book list. The user's
manual workflow is: open the list, click a book into a new tab/window, go
back, click the next book, page through, then when a list is exhausted
follow the link in that list's description to the next list in the chain
(e.g. "1 million" → "500,000" → "999,999").

## What the browser path gives us that the current scraper doesn't

The existing `browser-book-scrape` (Phase 1, axios transport) pulls books
from `SELECT ... FROM books WHERE genres IS NULL`. It never *walks* a
Goodreads list page — it reads from the DB. The proposed sub-project lets
the browser engine do the navigation itself, inheriting whatever session
the browser carries (currently not logged-in; see login section) and
possibly avoiding per-request anti-bot throttling since the browser is
behaving like a human (tab, back, page forward, follow chain link).

## Workflow to automate (per the user's manual behavior)

1. Visit the list-of-lists page (35080).
2. Pick the next list entry (sorted as the user specifies — descending
   "1 million" first, ascending after, etc.).
3. Within that list: click the first book (open in a new page/tab, parse
   the `/book/show/<id>` page), then navigate back to the list, then
   click the next book.
4. When the current page of the list is exhausted, page to the next page
   of the same list.
5. When all pages of the current list are done, follow the list
   description link to the next list in the chain and repeat.
6. Same skip criteria as `browser-book-scrape`: skip books already
   harvested for the target fields (genres, publisher, editions, etc.);
   the checkpoint/browser_scrape table applies here too.

## Key design decisions to resolve before scoping

### Navigation model
- **Tab-per-book** (like the user's manual workflow): open each book in a
  new page within the same persistent context, close it after parse, go
  back to the list. More realistic human-like, but slightly heavier.
- **Single-page navigation** (goto list → goto book → back): same window,
  faster but less faithful to the manual pattern.
- User preference needed.

### List discovery / list-of-lists ordering
- Which list is "1 million", which is "500,000", which is "999,999"?
  This ordering is by list name/title, not URL. Where is the sequence
  defined — manually in the code, or is there a list ordering captured
  in `bulkTopics.json` / `state.json`?
- The list-of-lists page (35080) may have its own internal order
  (numbered entries, next-list links in descriptions).

### List pagination and list-of-lists paging
- Goodreads list pages have `?page=N` pagination. Need to detect last page.
- The list-of-lists page may itself be paginated.

### Per-book parsing: what to capture
- Everything the current `browserBookScrape.ts` captures (SSR via
  `page.content()` — genres, publisher, ISBNs, ratings-by-star, etc.).
- Editions count: only available in the logged-in rendered DOM ("Show all N
  editions") — may finally be capturable if the browser is logged-in via
  the one-time login path (see §Browser login status below).

### Throttling / pacing
- Same 2–4s uniform-ms pacing between books.
- Inside a list: human behavior is fast (click, read, back); but this is
  an automated walk, so pacing still applies.
- Cooldown on 202/403: same rules.

## Browser login status (required for editions count)

The config cookie works over axios but **does not log the headed Playwright
browser in** (confirmed 2026/09/05 — `addCookies` with bare name/value
strips Secure/HttpOnly flags; browser silently ignores them). Fix SHIPPED
2026/09/05: `npm run browser-login` — a one-time interactive login into the
durable persistent profile (`~/.goodreads/browser-profile`,
`src/browserSession.ts`). Every `--engine browser` run now auto-verifies the
profile header and reports `✓ Session verified` or `⚠️ logged OUT`.
This sub-project becomes fully powerful (editions count per book) once the
profile is logged in via that flow.

## Files in scope (to create or extend)

- `src/listWalk.ts` or `src/listBookHarvest.ts` — new runner, command
  `list-book-harvest` or similar.
- Extension to `browser_scrape` checkpoint table (or reuse as-is if
  book-level granularity is sufficient; list-level progress needs a
  `list_walk` / `list_progress` table).
- New npm script + `.sh` wrapper.

## Open questions

- List-of-lists source of truth: `bulkTopics.json`? `state.json`? The
  list page itself (35080)?
- List-chain traversal: how is the "next list" determined — from the
  description of the current list (link text like "500,000 books")?
  What if the link is missing or malformed?
- Do we want to combine this with the existing `browser-book-scrape`
  queue, or keep them as separate entry points?

## Goodreads list-reading hard cap (confirmed 2026/09/05)

**Any list can only be read to page 100** — no matter its declared size.
`https://www.goodreads.com/list/show/1.Best_Books_Ever` declares 79,000
books but only exposes the first 100 pages (up to ~10,000 books). This cap
applies to every list, for every purpose. So a list's declared book count
(`total_books`) is NOT fully reachable; we also track the walkable span
(`walkable_pages` ≤ 100, `walkable_books` ≤ 10,000). The walker stops at the
cap and marks the list `done` (there is nothing further to read).

## Scraped-list ledger (list_walk table)

`list_walk` records, per list: `list_id`, `title`, `status`
(done/started/error), `current_page` (resume point), `total_pages`,
`total_books` (declared), `walkable_books` (reachable, ≤ 10k), `next_list_id`
+ `next_list_label` (chain target), `scraped_at` (date last written).
Any list-book scraper (chain walker, tag walker, future) reuses these rows
to skip lists already book-scraped. Freshness: `--relist-days N` re-walks a
done list only if last scraped more than N days ago (default 0 = never,
without `--force`).

## Future variation 2 — walk a list TAG (list-of-lists) page

Follow-up idea (2026/09/05). Instead of the rating-chain inside one list,
walk a *list-of-lists* page where each entry is a full list:

- Starting point: `https://www.goodreads.com/list/tag?id=mjf&ref=ls_ts`
  (a tag page = many lists; mjf has 12 pages of lists).
- Workflow: right-click one list → scan it top-to-bottom like the chain
  walk → return to the list-of-lists → pick the next list → repeat.
- When a page of the list-of-lists is exhausted, page to the next one
  via the pagination at the bottom of the list-of-lists page.
- Shares the per-book parse/checkpoint/skip machinery with the chain walk;
  the difference is the SOURCE of incoming lists (tag page pagination
  instead of the description-chain link).

Reuses almost everything in `src/listWalker.ts` (book fetch + skip +
`browser_scrape`/`list_walk` checkpoints); needs a small "next list" source
that enumerates a tag page's list entries + its pagination.

## Deferred from earlier work

- `--engine browser` headed window login: fixed 2026/09/05 via
  `npm run browser-login` + `src/browserSession.ts` (durable profile at
  `~/.goodreads/browser-profile`, auto-verified on context open).
  Cookie seeding via `addCookies` does NOT authenticate (proven).
