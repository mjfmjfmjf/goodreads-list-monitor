# PLAN: Scraping Goodreads Genres and relating them to captured Tags

Status: goal 1 (genre scrape), goal 2 (exact tag compare), the goal-3
genre_tag_xref table (hit exact + cognate seed), and the gap-genre drill
(gapGenreTagDiscovery.sh) are built. USER DECIDED 2026/09/02: scrape ALL gap
genres (no cognate-skip), THEN map tags->genres by book overlap. 2.1 (near-match)
is now a POST-HOC tag<->genre book-overlap step.
Created 2026/09/02. Feature request from the user: the Genre list
(`https://www.goodreads.com/genres/list?page=N`, ~17 pages) should be scraped
and stored, then compared against the tags already captured, and used to
prioritize the remaining tag scrapes.

## Problem

Goodreads maintains a browseable, exhaustive list of Genres at
`https://www.goodreads.com/genres/list`. Today we do not capture these as a
first-class, deduped genre catalog — we only have scattered, uneven genre data:

- `emrys_tags`: a separate Emrys import, per-book `genre_name` + `member_count`
  (not a Goodreads genre catalog; suffix of a different pipeline).
- `books.genres`: a JSON column, but only **211** of 2.16M books are populated.
- `tag_books`: 908,749 rows / **728** distinct tags — the Goodreads tag-shelf
  scrape we already run. This is the primary "shelf" data.

The genre list is valuable because Genres are the canonical Goodreads taxonomy,
which we'd like to align our tag data against, and it gives us a discovery-
ordered, covered set of names to scrape.

## What we want to build (goals, in order)

1. **A `genres` table** — scrape all pages of `/genres/list`, storing each
   genre's name, date first discovered, and #books (the member/shelved count the
   page shows). Table:
   ```
   CREATE TABLE genres (
     name TEXT PRIMARY KEY,
     member_count INTEGER DEFAULT 0,   -- # books Goodreads reported at last scrape
     first_seen TEXT NOT NULL,          -- when we first discovered this genre
     last_updated TEXT NOT NULL         -- when we last saw it populate
   );
   ```
   Re-runs are incremental/idempotent: a genre just gets `last_updated` refreshed
   (and `member_count` updated) on every scrape where it's still present.
   `first_seen` stays fixed. This makes drift visible: a genre that STOPS
   appearing (Goodreads removed it) or stops being populated shows up as a
   stale `last_updated` row. (Schema mirrors the `authors.first_seen`/
   `last_seen` convention and `tag_books`.)

2. **Compare genres to captured tags** — are the genre names exact matches for
   tag names? (Normalize case/separators first — genres are Title Case
   "Science Fiction", tags are lowercase hyphenated "science-fiction".) Produce
   three sets: genres already captured as tags, genres not yet captured as tags,
   tags that are not genres (the long tail of personal shelves).
   MEASURED 2026/09/02 (offline, against 1,674 genres / 728 tags):
   **228 genres are exact matches to a tag; 1,446 genres have no exact tag
   match.** Top no-exact genres by Goodreads member count: `thriller-suspense`,
   `dark-fantasy`, `chapter-books`, `small-town-romance`, `medicine`,
   `fake-dating`, `italy`, `ireland`, `world-war-ii`, … — so the long-tail
   genres are mostly *the reason* to keep harvesting; exact match alone covers
   only ~14% of genres.
   ✅ SHIPPED 2026/09/02: `genre-list --compare` renders the three sets
   (exact-matched / no-tag / tags-not-genres) with Goodreads member count and
   our in-tag book count per row, sortable by count/member/alpha. Live run:
   1,674 genres · 756 tags · 228 exact · 1,446 no-tag (86%) · 528 tags-not-genres.
   NOTE: our per-tag book counts are shallow (~1,250 distinct books each) — the
   Goodreads `member_count` is the authoritative shelfcount.

2.1. **Near-match genres (the 1,446 without an exact tag)** — assign each to the
   best tag by comparing **book coverage**: a near match is a tag whose book set
   most overlaps the genre's book set. Two sub-problems:
   (a) We currently have NO genre→book set (the `genres` table only has
   name+member_count). To judge overlap we must either scrape each genre's shelf
   (`/genres/<name>`) for its top books, or infer overlap from name/token
   similarity now and refine later.
   (b) Book-overlap comparison itself: given two book-id sets (from `tag_books`
   for tags), score pairwise overlap (Jaccard / shared-count) to rank candidate
   tags for each genre.
   OUTPUT: for each unmatched genre, a ranked list of candidate tags → feeds
   goal 3's `genre_tag_xref` (many-to-one aliases), seeded automatically and
   reviewed/hand-curated.
   OPEN: whether to (i) scrape genre shelves for real book sets now, or
   (ii) do offline token/name + tag-tag overlap first and scrape later.
   UPDATE 2026/09/02: the genre NAME doubles as a shelf URL —
   `/shelf/show/<genre>` — so a real genre→book set CAN be scraped directly
   with the existing `scrapeShelfBooks(tag, …)` (it fetches `/shelf/show/<tag>`
   and returns book ids). Verified live: `/shelf/show/fake-dating` = 11,795
   books, `/shelf/show/dark-fantasy` = 36,188 books. NOTE a big discrepancy:
   the shelf page count (11,795) is ~1/10th the genre-list `member_count`
   (fake-dating 117,877) — different counting scope, flag for goal 4.
    So goal 2.1 has two viable routes: (a) scrape genre shelves for real book
    sets and compute true genre↔tag overlap, or (b) scrape the top-N unmatched
    genres by member count only (highest-value first) — the "most books to
    least books" ordering goal 4 wants. Recommend (b) staged first, then (a).
    RESOLVED 2026/09/02 (USER DECISION): route (a) happens as a side effect of
    scraping ALL genres via `gapGenreTagDiscovery.sh` — after that every genre
    has a real book set in tag_books (keyed by genre name as the tag). Goal 2.1
    then becomes a POST-HOC book-overlap computation: for each genre, score each
    harvested tag's book set vs the genre's book set (Jaccard/shared-count) and
    rank candidates — feeds the goal-3 xref mapping. NO separate genre-shelf
    scrape step needed; it's already covered by the all-genres harvest.
    TOOLING 2026/09/02: `./genreTagPairings.sh` (cmd `genre-tag-pairings`) — for
    each scraped genre, rank its top-K NON-genre tags by book-set Jaccard
    (% overlap/union). Pure local over tag_books; full 1,674-genre sweep ~7s.
    Reveals the cognate/alias pairs for the xref mapping (e.g. fiction→read-fiction
    70%, young-adult→ya 83%, manga→mangas 69%, classics→classic 83%,
    non-fiction→nonfiction 79%). Unscraped genres report "(unscraped)".
    Options: --genre, --limit, --minMember, --allTags.
    INVERSE 2026/09/02: `./tagPairings.sh` (cmd `tag-pairings`) — flips it: for
    each NON-genre tag, rank the top-K GENRE-tags by Jaccard. Full ~566-tag sweep
    ~6.5s. Directly surfaces alias mappings (ya→young-adult 83%, nonfiction→
    non-fiction 79%). Options: --tag, --limit, --minBooks, --maxResults.

3. **Genre→tag cross-reference (normalization) table** — a single genre may be
   represented by MANY tag spellings, and different users shelf the same genre
   differently (`young-adult`, `ya`, `ya-fiction`, `young-adult-fiction` →
   "Young Adult"; `scifi-fantasy`, `sci-fi-fantasy`,
   `science-fiction-fantasy` → "Science Fiction Fantasy"). So an exact-match
   comparison alone undercounts coverage. Build a mapping:
   ```
   CREATE TABLE genre_tag_xref (
     genre_name TEXT NOT NULL,   -- canonical genre from the genres table
     tag_name   TEXT NOT NULL,   -- a tag that maps onto that genre
     PRIMARY KEY (genre_name, tag_name),
     FOREIGN KEY (genre_name) REFERENCES genres(name)
   );
   ```
   This is the normalization layer: it lets "is genre X covered by our tags?"
   mean "is *any* of its alias tags harvested?" rather than "is the exact
   normalized spelling harvested?". The xref can be seeded from exact matches,
   then extended with curated many-to-one associations, and used to aggregate a
   genre's true book-coverage across all its alias tags.

   ✅ SHIPPED 2026/09/02:
   - `genre_tag_xref(genre_name, tag_name, kind)` table added (kind='exact' |
     'cognate'), so exact-match rows and curated spelling-variant (cognate)
     rows are distinguishable.
   - `genre-list --seed-xref` seeds it (idempotent) with the 228 exact matches
     + curated cognate families; `genre-list --xref` views it, `--cognateOnly`
     filters to the curated families.
   - The user's asked-for cognate families are the spelling/form variants of
     one canonical genre (each genre name doubles as a shelf): science-fiction
     ← sf/sci-fi/scifi/sff; non-fiction ← nonfiction; picture-books ←
     picture-book; plus science-fiction-fantasy ← sci-fi-fantasy/scifi-fantasy/
     fantasy-sci-fi/fantasy-scifi. NOTE: the user's earlier examples also
     mention `s-fiction` and generic pluralization — these are the pattern the
     cognate families encode; add more families to COGNATE_FAMILIES in
     src/genreXref.ts as found. No network; purely offline.
   - NOTE: to "combine" the counts, use loadXrefTagMap() to fold a variant tag
     onto its canonical genre when aggregating tag book counts (not yet wired
     into year/life-in-books reports — candidate follow-up).

4. **Prioritize tag scraping by coverage** — if the genres are covered by
   (mapped) tags, use the genre member counts to order the remaining tag scrapes
   from "most books" to "least books", i.e. harvest the highest-coverage shelf
   names we haven't scraped yet.
   ✅ SHIPPED 2026/09/02 (tooling): `./gapGenreTagDiscovery.sh` drills the gap —
   genres not yet present in tag_books — ordered by member_count desc
   (value-first), skipping already-scraped by default (`--force` to re-run,
   `--start`/`--count` to resume/bound, `--dryRun` to preview, `--shelfPages`
   to bound depth). Reuses `runTagDiscovery(cacheOnly)` so each gap genre writes
   book cache + tag_books. Live: 1,674 genres → 1,445 gaps; top gaps =
   dark-fantasy, chapter-books, small-town-romance, medicine, fake-dating,
   italy, ireland, psychological. Real scraping is network + politely delayed;
    use `caffeinate -is` for long runs.
    USER DECISION 2026/09/02: user will run it over ALL gap genres (no cognate
    skip), harvesting every genre's shelf into tag_books. Afterward, map the
    tags that match those genres onto them (goal 3/2.1) using the now-real
    genre<->tag book sets (book-overlap-informed, not name-guessing). The
    cognate/skip behavior stays available but the default workflow is scrape-all.

## Verified facts about the site / data (2026/09/02)

- Genre list URL is paged: `/genres/list?page=1` … the user reports **17 pages**.
- `member_count` (the "# books" per genre) is visible in the page HTML.
- 728 distinct tags already exist in `tag_books`; 908,749 tag-book rows.
- Only 211 books carry `books.genres` JSON; the genre catalog would be a far
  more complete source than that column.
- Tag names are already lowercased/hyphenated (e.g. `science-fiction`,
  `fantasy`, `young-adult`); genre names are Title Case with spaces. Need a
  normalization function for exact-match comparison.

## Open questions / decisions

- Does the user want the raw Goodreads member count stored, or the count of
  books *we* hold per genre after scraping tags? (I lean: store the Goodreads
  shelfcount in `genres.member_count`, and keep our own harvested book counts in
  `tag_books` as today.)
- Exact-match comparison: normalize to lowercase-hyphenated before comparing, or
  keep a mapping of genre->canonical tag? Some genres may map to multiple tag
  spellings. (Answered directionally: use the `genre_tag_xref` normalization
  table with many-to-one aliases, seeded from exact matches and extended
  manually.)
- Scrape cadence / politeness: mirror the existing tag-harvest rate limits
  (review-list / tag scraping delays + strict-throttle mode), and respect
  Goodreads' anti-bot 202/403 behavior (see AGENTS.md).
- How to handle ~17 pages of a list we've never hit before: first confirm the
  page count and pagination semantics (page param, per-page count, last-page
  detection) before committing the harvest loop.

## Related / prior art

- `PLAN-orphan-authors.md` and `PLAN-edition-clustering.md` — same
  PLAN-file convention; `authorHist.sh` / `authorTopBookHistogram.sh` show the
  pattern of one-off `.sh` analyzers backed by plain Node CJS + SQL.
- `tag_books` harvest already exists and is the natural home for per-shelf book
  counts; see `storage.ts` (`upsertTagBooks`, `loadTagBooks`) and the
  `year-in-books` / `life-in-books` `computeTagCounts` usage.
- Goodreads throttling rules live in `AGENTS.md`; keep the new genre scrape
  polite and rate-limited.

## Next actionable steps (when work begins)

1. Confirm genre-list page count + markup (cheerio parse of `/genres/list`).
   ✅ 2026/09/02 CONFIRMED: 17 pages, 100 shelfStat rows/page (~1,700 total),
   parse via `div.shelfStat` → `a.mediumText.actionLinkLite[href^="/genres/"]`
   (slug/name) + `div.smallText.greyText` ("N books" → `member_count`).
   Pagination: `?page=1..17`, next link `a.next_page[rel=next]`. Filter select
   is All (default) / Top Level Only (`?filter=top-level`).
   Names can be percent-encoded (e.g. "%E6%BC%AB%E7%94%BB" = 漫画) — decode.
2. Add `genres` table migration (`db.ts`) — name PK, member_count, first_seen,
   last_updated. ✅ SHIPPED 2026/09/02 (`first_seen` fixed, `last_updated`
   refreshed on re-run; re-runs idempotent).
3. Write `scrapeGenreList()` in `scraper.ts` + storage helpers + unit tests.
   ✅ SHIPPED: `genre-list` command, `genreList.sh` wrapper. First live scrape
   2026/09/02: 1,674 genres / 17 pages, 0 dupes.
4. ~~Build the genre↔tag comparison~~ ✅ SHIPPED (goal 2, `--compare`). After the
   table is populated, surface stale/unpopulated genres (rows whose
   `last_updated` is old or that stopped appearing on a re-run). (Report mode
   already flags >30-day-stale rows.)
   NEXT (goal 2.1, AFTER the all-genres harvest): book-overlap near-match for
   the no-genre-tag genres — each genre now has a real book set in tag_books
   (genre name as tag); score each harvested tag's book set vs the genre's
   (Jaccard/shared-count) and rank candidates → feeds the goal-3
   `genre_tag_xref`.
 5. Wire up a command (e.g. `genre-list --scrape`) and a `genreList.sh`
    wrapper. User runs it (and re-runs). ✅
 6. Re-run unit gate (`./runUnitTests.sh`) + deliberate integration run. ✅
    (471 unit + 2 CLI smoke green on goal-2 ship.)
 7. Scrape ALL gap genres (USER DECISION): `./gapGenreTagDiscovery.sh` run to
    completion over the 1,445 gaps → every genre shelf into tag_books. THEN map
    tags→genres via xref using real book overlap (goal 2.1 result).
