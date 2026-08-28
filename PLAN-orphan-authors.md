# PLAN: Scraping book-cache authors missing from the author cache

Status: planning (phase 0 = list-only shipped).
Created 2026/08/27 after `authorTopBookHistogram.sh` surfaced a 49,851-author gap
between the ~90k authors seen in the book cache and the 54k `authors` rows; the
field-coverage run showed 28,413 author-cache entries are *also* missing stats.

## Problem

The book cache references many authors that have no matching row in the author
cache ("orphans"). We want to scrape their stats too, but a naive scan would
reprocess the same real person repeatedly because the book-cache author strings
are noisy.

Verified on 2026/08/27 (fresh book-cache scan):
- 325,544 orphan books (37% of the 880k book cache) whose `author` string is not
  a key in the author cache.
- **BUT** ~324,724 (99.7%) of those carry an `authorId`. That gives a stable
  identity we can dedup on, without relying on the name.
- The top orphans are mostly data-quality artifacts, not genuinely missing
  authors: `"John  Green"` (extra spaces), `"Jane AustenAnthea Bell"` (two
  authors concatenated), `"Ray BradburyTim HamiltonUnknown Author"` (dirty /
  multi-author). The real author (John Green, Jane Austen, …) is almost always
  already in the author cache under a clean name.
- Rating distribution of the 325k orphan books: ~293k are <100 ratings; only
  ~180 books are ≥100k ratings (149 in 100k–1M, 31 ≥1M). So the genuinely
  important orphans (famous authors) are few.

## Why re-scraping is a risk (the user's core concern)

- `authors` is keyed by `name` (`ON CONFLICT(name)` in `storage.ts`), with a
  non-unique `slug` (multiple dirty names can share a slug).
- If we scan orphans by **raw name**, the same author reappears under different
  dirty strings per run → repeated scrapes.
- `findAuthorBySlug(slug)` already exists (`storage.ts:396`) and can detect
  "this slug is already cached" regardless of the name key. That is the anchor
  for cross-run dedup.

## Design

Phased. Never combine network scraping into a "list" invocation.

### Phase 0 — list-only (no network) — <status: shipped 2026/08/27>
`author-orphans` command + `./authorOrphans.sh` wrapper. Read-only, prints
candidates ordered by top-book rating descending, deduped by `authorId`.

Live result (2026/08/27): **60,216 distinct orphan authors**. Top of the list is
dominated by multi-author concatenations (Jane AustenAnthea Bell, etc.) plus a
few genuinely-missing single authors (John Green id 1406384, Dan Brown id 630,
Lauren Roberts id 21728475).

## Verified facts about the site
- **`/author/show/{id}` (id only, no slug) WORKS standalone** — verified 2026/08/27
  with a single live probe: `https://www.goodreads.com/author/show/630` returned
  HTTP 200 (~319KB), resolved to `630.Dan_Brown` (canonical slug present in the
  body, page `<title>` = "Dan Brown (Author of Angels & Demons)"). No redirect
  needed. This satisfies the Phase-2 URL-construction dependency: we can scrape
  or inspect from `authorId` alone, or even use `/author/list/{id}`.
- **`/author/list/{id}` (id only) ALSO WORKS** — verified 2026/08/27 (live probe),
  HTTP 200 with the full books list and canonical slug in the body. The scraper now
  calls `/author/list/{id}` for all author pages (`extractAuthorId` in `scraper.ts`),
  keeping the slug only as a write-back/fallback identity.
- Clean author-show/list URLs are derivable from `authorId`:
  `/author/list/{id}.{Slug}` — e.g. `https://www.goodreads.com/author/list/1406384.John_Green`,
  `https://www.goodreads.com/author/list/1265.Jane_Austen`.
- 2026/08/27 datapoints:
  - `"John  Green"` (double space, 19 books) -> authorId **1406384** -> already cached
    as `John Green` (slug `1406384.John_Green`, 11.4M ratings). False orphan.
  - `"Jane AustenAnthea Bell"` (concatenation, 1 book) -> authorId **1265** -> already
    cached as `Jane Austen` (slug `1265.Jane_Austen`, 9.2M ratings). False orphan.
  - Both resolve to authorId values that are ALREADY in the author cache. The
    authorId==slug==clean-name is a single stable identity per author.
- Conclusion: most top "orphans" are dirty-name artifacts of authors we ALREADY
  have. id-based matching (landed in Phase 0) excludes them. Real orphans are
  those whose authorId is not cached at all (e.g. `Lauren Roberts` id 21728475).

## Author identity model (the decision the user needs)

Two coexisting mechanisms, NOT either/or:

1. Whitespace normalization. Handles spacing/`Unknown Author` trailing junk.
   Matches the cached key across dirt (e.g. `Michael  Grant` -> `Michael Grant`).
2. **`author_aliases` table** maps a dirty book-author STRING -> canonical
   authorId for cases normalization can't fix:
   - multi-author concatenations (`"Jane AustenAnthea Bell"` -> 1265)
   - co-author/narrator jammed into the string
   Only worthwhile for these messy strings; plain whitespace should NOT be a
   curated alias (a rule handles it).
3. **Canonical identity = authorId/slug**, not the name. Books keep their raw
   `author` string; resolution happens at read time. Orphan detection reports a
   dirty string as an orphan ONLY if its authorId isn't cached AND its
   normalized name isn't cached AND no alias resolves it.

Recommendation: rely on authorId (99.7% coverage) + normalized-name matching
(both now in Phase 0), and add the alias table only if Phase-1 inspection shows
enough non-normalizable concatenations to justify it.

## False-orphan classes (confirmed 2026/08/27)
| Class | Example | Excluded by |
|---|---|---|
| whitespace, has authorId | `John  Green` -> 1406384 cached | id-match |
| whitespace, NO authorId | `Michael  Grant` -> cached "Michael Grant" | normalized-name match |
| multi-author concat, has authorId | `Jane AustenAnthea Bell` -> 1265 cached | id-match |
| genuinely missing | `Paolo Cognetti` (not cached), `Mélissa Da Costa` 17506857 | (kept as orphan) |
| no-id, genuinely missing | `Irene Solà` | (kept; needs name resolution) |

## Design

Phased. Never combine network scraping into a "list" invocation.

### Phase 0 — list-only (no network) — <status: shipped 2026/08/27>
`author-orphans` command + `./authorOrphans.sh` wrapper. Read-only, prints
candidates ordered by top-book rating descending, deduped by `authorId`.
Harden landed 2026/08/27: books whose `authorId` maps to an already-cached
author id are excluded (kills John Green / Jane Austen false positives).
`authorTopBookHistogram` aligned to the same id-first identity model the same
day: it now groups by `authorId` (name fallback) instead of raw name, so
mangled-name concatenations are no longer double-counted. Live run: **84,144**
distinct authors (down from ~90,728), with the in/not-in-author-cache split now
id-based (43,449 / 40,695).

Live result (2026/08/27): distinct orphan authors ~60k pre-harden; post-harden
substantially fewer because id-matched cached authors drop out.

Inputs:
- book cache (authors + `authorId` + ratings)
- author cache (existing names + slugs)

Selection:
1. Orphan = every distinct author string on a book where the author string is
   not already a key in the author cache.
2. For each orphan, pick its **highest-rated book** by rating count.
3. Order orphans by that rating descending (tie: author name).
4. `--limit N` (default all? or a sane cap), `--minRatings`, `--maxRatings`
   filters on the top book's rating.
5. Show per orphan: cleaned/normalized name, raw name, `authorId`, top-title,
   top-rating, whether `authorId` already maps to an author-cache slug
   (via `findAuthorBySlug`) — so we can see how many "orphans" are actually
   already known.

Output columns: `RANK | authorId | author (raw) | author (normalized) | top title | top ratings | known? (slug already cached)`.

Name normalization (shared pure function, unit-tested, used by later phases):
- trim, collapse multiple spaces
- strip a trailing "Unknown Author"/"Unknown"/"n/a"
- (later, phase 1) split multi-author concatenations — deliberately NOT guessed
  here; surfaced as a flag for manual review.

### Phase 1 — inspect-only (no network)
Reuse phase-0 selection with `--inspect`: for the selected orphans, resolve the
author-show URL via `authorId` and print the exact URL + current `findAuthorBySlug`
hit, so we can eyeball what a scrape WOULD touch before doing it.

### Phase 2 — scrape (network, throttled), later
New `author-rescan` mode `--fromBookCache` (or a dedicated command):
- build slug/URL from `authorId` (author-show URL needs a slug; may need a
  search/redirect resolve)
- skip if `findAuthorBySlug(slug)` already findable (cross-run dedup)
- skip if already seen this run (in-run set keyed by authorId)
- scrape stats (reuse `scrapeAuthorStats`), `upsertAuthor` under the **cleaned**
  canonical name so future orphan scans match by name and don't re-scrape
- same 2s–5s throttle + fail-count backoff as existing rescans

### Open questions
- ~~author-show URL from `authorId` without slug: does Goodreads redirect
  `/author/show/{id}` → canonical?~~ **RESOLVED 2026/08/27**: `/author/show/{id}` returns
  HTTP 200 with the canonical slug in the body; no redirect/external resolution needed.
  (Open sub-question: does `/author/list/{id}` — id only, no slug — also work, or does it
  need the `.Slug`? `/author/show/{id}` at minimum confirms id-only is viable.)
- Multi-author concatenations ("Jane AustenAnthea Bell"): are these even
  scrapable as one? Likely split only with manual review; keep flagged.

## What exists today (2026/08)
- `authors` table keyed by name; `findAuthorBySlug`, `upsertAuthor`,
  `recordAuthorFailure` in `src/storage.ts`.
- `scrapeAuthorStats(slug, onError, crawlAllPages?, sort?)` in `src/scraper.ts`
  (author-list path also harvests books).
- `author-rescan` selects targets ONLY from the author cache
  (`selectAuthors`/multiPage/rescanMissing) — no book-cache source.
- `author-top-books <n>` picks top-N books by ratings but requires the author to
  already be cached (skips `!authorCache[book.author]?.slug`).
