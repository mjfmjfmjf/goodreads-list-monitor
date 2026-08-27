# Goodreads List Monitor & Auditor

A production-grade CLI tool to monitor, audit, and discover books on Goodreads Listopia lists and shelves.

## Core Features
- **Smart Monitoring**: Detect additions and removals across hundreds of lists in seconds.
- **Rich Metadata**: Automatically tracks book positions, rating counts, average ratings, and publication years.
- **Automated Audits**: Identify books that violate rating, average rating, or year criteria.
- **Year in Books & Life in Books**: text summaries of your own reading — stats, star ratings, letter/published-year distributions, favorite authors, publishers, and bookshelves — generated from your Goodreads library export. No login or cookies required.
- **Tag Discovery**: Cross-reference entire Goodreads shelves with your lists to find missing popular books.
- **Persistent Caching**: Saves book details locally in `booksCache.json` to minimize network calls and respect rate limits, now including average ratings.

## Output Color Legend

Most reports share a consistent color scheme:

- **Yellow** — raw counts from the cache (books, ratings, reviews, shelves).
- **Green** — derived/modeled values and success states (average ratings, estimates, "updated" confirmations).
- **Cyan** — percentages and supporting context (share of total, completeness, cache %).
- **Magenta** — the emphasized cumulative/total figure in a row (e.g. CUM >=).
- **Gray** — zeros, empty cells, timers, and background detail so your eye lands on the real data.
- **White** — names, labels, and list nicknames (the primary text of a line).
- **Red** — errors, failures, removed/outlier books, and "Unknown" values.
- **Dim** — muted scrape progress sublines (e.g. per-page author crawl lines).
- **Blue** — one-off section headings (e.g. "Out of position" in author list diffs).
- **Red background (🛑 banner)** — a critical Goodreads site-structure warning; stop and check the scrape.

## Year in Books & Life in Books (no account needed)

The signature features: a full **text-only** "Year in Books" for any year, plus a
lifetime **Life in Books**. Each report covers reading stats (pages, shortest/longest,
mean/median), a star-rating histogram and average, a distribution of titles by
first letter and by publication year (with the first book for each), five-star
books, favorite authors, publishers, and bookshelves. No book covers, no Goodreads
login, no cookies — they read **your own library export file**.

**3 steps to your own Year in Books:**

1. **Install once** (Node 18.20.8+; see "Install & Run" below for macOS and Windows):
   ```bash
   git clone https://github.com/mjfmjfmjf/goodreads-list-monitor.git
   cd goodreads-list-monitor
   npm install
   ```
2. **Get your library export**: Goodreads → *My Books* → *Import and Export*
   (https://www.goodreads.com/review/import) → **Export Library** → grab
   `goodreads_library_export.csv` when it's emailed to you.
3. **Run it** (first run uses `--export` to import the CSV; it's cached after that):
   ```bash
   ./year-in-books.sh 2026                          # or without a year for the most recent
   ./year-in-books.sh 2026 --export ~/Downloads/goodreads_library_export.csv
   ./life-in-books.sh                                # your whole reading life at once
   ```

You can also generate someone else's (with their CSV): `./year-in-books.sh 2026 --library friend --export ~/Downloads/friends_library_export.csv`.

## Install & Run (macOS & Windows)

**1. Install Node.js (18.20.8 or later — the current LTS works).**
- **macOS**: download from https://nodejs.org, or `brew install node`.
- **Windows**: download the LTS installer from https://nodejs.org (or
  `winget install OpenJS.NodeJS.LTS`), then open PowerShell.

**2. Clone and install dependencies:**
```bash
git clone https://github.com/mjfmjfmjf/goodreads-list-monitor.git
cd goodreads-list-monitor
npm install
```
There's no build step — it runs TypeScript directly.

**3. Run a command.**
- **macOS / Linux**: use the wrapper scripts (`./year-in-books.sh`, `./life-in-books.sh`, …):
  ```bash
  ./year-in-books.sh 2026
  ```
- **Windows**: the `*.sh` wrappers need bash, so either use **Git Bash** (installed
  with Git for Windows) to run the same commands, or use the equivalent `npm run`
  commands in PowerShell/CMD:

  | `./<cmd>.sh` wrapper | PowerShell equivalent |
  |---|---|
  | `./year-in-books.sh 2026` | `npm run year-in-books -- 2026` |
  | `./life-in-books.sh` | `npm run life-in-books` |
  | `./favorite-authors.sh` | `npm run favorite-authors` |
  | `./publisher-stats.sh` | `npm run publisher-stats` |
  | `./shelf-stats.sh` | `npm run shelf-stats` |
  | `./books.sh '^j'` | `npm run books -- '^j'` |
  | `./library.sh by-char --year 2024` | `npm run library -- by-char --year 2024` |

**Optional — account features.** The monitoring, auditing, and discovery commands
scrape Goodreads, so they need your User ID and a session cookie:
```bash
npm run set-user [YOUR_USER_ID]
```
plus a `config.json` in the repo root holding your browser session cookie:
```json
{
  "cookie": "your_browser_session_cookie"
}
```
**You do NOT need any of this for `year-in-books`, `life-in-books`,
`favorite-authors`, `publisher-stats`, or `shelf-stats`** — those read only your
export CSV (and your local `booksCache.json` when present).

## Usage

> This README renders nicely at the command line — no raw markdown:
> `./readme.sh` (or `npm run readme`). For a compact color swatch sheet
> showing every output color documented above: `npm run color-legend`.

### 1. Daily Monitoring
Check for any changes in the lists you've created:
```bash
npm start
```

### 2. Initial Ingest
Perform a one-time full download of all book titles for your lists:
```bash
npm run ingest
```

### 3. List Auditing
Audit a specific list for books that don't meet criteria. You can audit by **Ratings**, **Average Ratings**, OR **Publishing Year**.
Multiple criteria can be combined.

**By Ratings:**
```bash
npm run audit [listId] -- --min 1000 --max 50000
```

**By Average Ratings:**
```bash
npm run audit [listId] -- --minAvg 4.0 --maxAvg 4.5
```

**By Publishing Year:**
```bash
npm run audit [listId] -- --minYear 2010 --maxYear 2024
```

**Combined Criteria Example:**
```bash
npm run audit [listId] -- --minAvg 4.0 --min 1000
```

### 4. Tag Discovery & Auditing
Find missing popular books from a shelf and cross-reference them with your lists.

**Single List Tag Audit:**
```bash
npm run tag-audit [tag] [listId] -- --min [minRatings] --minTags [minTags] --minAvg [minAvgRating]
```

**Batch Discovery Run:**
Automate audits for an entire family of lists (e.g., Science Fiction):
1. **Generate Config**:
   ```bash
   npm run tag-config [hubListId] [tagName]
   ```
2. **Run Discovery**:
   ```bash
   npm run tag-discovery [tagName] -- --minTags 50 --minAvg 4.0
   ```

### 5. Bulk Auditing
Run sequential audits using a configuration file that defines multiple lists and their criteria.

**Generate Default Bulk Config**:
```bash
npm run gen-bulk-config
```
This command generates `bulkAuditConfig.json` based on your existing lists and tag configs.

**Run Bulk Audit (Default Config)**:
```bash
npm run bulk-audit
```

**Run Bulk Audit (Custom Config File)**:
```bash
npm run bulk-audit -- bulkAvgRatings.json
```
(Replace `bulkAvgRatings.json` with your custom configuration file.)

### 5b. Regex Auditing & Discovery
Every list entry in a bulk config can carry regex criteria in its `criteria` object: `titleRegex`, `authorLastRegex`, and `authorFirstRegex` (patterns are case-insensitive; combined with AND). `authorLast`/`authorFirst` refer to the **first** author listed on the book.

- **Audit** (`npm run audit -- <listId> --titleRegex '^[a-l]'`): flags books currently **on** the list that do **not** match the regex, so you can remove strays. Bulk audits pick the regex up automatically from `bulkAuditConfig.json`.
- **Queue discovery** (`npm run queue-discovery`): only cached books matching the regex are treated as candidates, so it surfaces books that **meet** the regex but are **not yet** on the list.

Example bulk config entry:
```json
{ "nickname": "A-L", "id": "233818", "criteria": { "titleRegex": "^[a-l]" } }
```

### 6. Book Cache Search
Search `booksCache.json` with case-insensitive regexes against title, the first author's last name, or the first author's first name. Default sort is by number of ratings.

```bash
npm run books -- '^j'                                  # titles starting with j
npm run books -- --title '^[jqx]'                      # titles starting with j, q, or x
npm run books -- --authorLast '^sanderson'             # author's last name
npm run books -- --authorFirst '^brandon' --sort year  # first name, sort by year
npm run books -- --title 'space' --sort avgRating --minRatings 1000 --limit 50
```
`--sort` is one of `ratings` (default), `avgRating`, `year`, `title`, or `author`. Also supports `--limit`, `--minRatings`, `--maxRatings`, `--minYear`, `--maxYear`, `--asc`/`--desc`, and `--includeBad`. A bare `[pattern]` applies to the title. A convenient wrapper is `./books.sh`.

**Exclude books you've already reviewed** (using a Goodreads library export CSV, e.g. from https://www.goodreads.com/review/import):
```bash
npm run books -- '^j' --excludeReviewed --export ~/Downloads/goodreads_library_export.20240914.csv
```
The export is imported **once** and cached to `libraryExportCache.json`, so subsequent runs just need `--excludeReviewed` (no `--export`) — re-pass `--export`/`--import` only when you download a new CSV. `--import <path>` is an alias for `--export <path>` (Goodreads calls it an export, but we're importing it). A book counts as reviewed if any export entry for it is on the `read` shelf, has a `Date Read`, or has review text — id matches first, falling back to normalized title+author (so a different edition of a book you read is still excluded). The export loader validates the expected columns and `YYYY/MM/DD` dates and warns if the Goodreads format has changed.

To run a query against **someone else's export without overwriting yours**, pass `--library <name>` (e.g. `--library friend`) — the cache becomes `libraryExportCache.friend.json`, leaving your default `libraryExportCache.json` untouched:

```bash
npm run year-in-books -- 2026 --library friend --export ~/Downloads/friends_library_export.csv  # imports theirs
npm run year-in-books -- 2026 --library friend    # loads their cached library (no --export needed again)
npm run year-in-books -- 2026                     # still yours (default cache)
```

`--library` works on `library`, `year-in-books`, `life-in-books`, `favorite-authors`, `publisher-stats`, `shelf-stats`, `tag-gaps`, `next-books`, and `books --excludeReviewed`, each with its own `--export`/`--import`.

### 7. Author Statistics
Capture and rank authors by popularity. All author data lives in `authorsCache.json`.

**Capture Author Stats:**
```bash
npm run author-top-books [n] -- --minRatings [min] --maxRatings [max]
```
Scans the book cache for the top `n` books by number of ratings (optionally filtered by a ratings range), builds a distinct list of their authors, and scrapes each author's page **once** — capturing `averageRating`, `numRatings`, `numReviews`, and `numShelves` into `authorsCache.json`. Author stats are updated monotonically: a value is only replaced if it hasn't decreased. Add `--skip` to skip authors that already have captured stats in the cache.

**Read Top Authors from the Cache:**
```bash
npm run author-top-stats -- --limit [n] --sortBy [field] --minRatings [min] --maxRatings [max]
```
Lists the top authors from `authorsCache.json` sorted descending. `--sortBy` is one of `numRatings` (default), `averageRating`, `numReviews`, or `numShelves`; `--limit` defaults to 100. Authors missing a value for the sort field are excluded from the results.

**Refresh Stats for a Selected Set of Authors:**
```bash
npm run author-rescan -- --limit [n] --sortBy [field] --minRatings [min] --maxRatings [max] --minAge [days]
```
Re-scrapes the author page for every author matching the same criteria as `author-top-stats`, refreshing their stats in `authorsCache.json`. Use `--minAge [days]` to skip authors whose stats were updated within the last `[days]` days (default 0 = scrape everything). Progress is saved to disk after every author, so an interrupted run can be resumed with `--minAge`.

**Update Stats for a Single Author:**
```bash
npm run author-one -- [url-or-slug]
```
Scrapes the stats for one author, e.g. `https://www.goodreads.com/author/show/14018357.Steve_the_Noob` (or the slug/ID), and updates `authorsCache.json` — creating the entry if it doesn't exist yet.

### 7a. Author/List Membership Check
Compare your `user_vote` page on a list against the live top-100 author ranking and get paste-ready instructions. Convenient wrapper: `./authorHighestAverageRatingUpdate.sh`.

```bash
npm run author-list-diff -- --userVote [url-or-id] --limit [n] --sortBy [field] --minRatings [min]
```

Fetches all books you voted for on a Goodreads list (`--userVote` accepts a full user_vote URL, e.g. `.../list/show/118483/user_vote/10400982`, or just the ID), ranks authors from the cache with the same selection logic as `author-top-stats`, dedupes by id keeping each author's best-ranked book, and reports:

- **Replacements** — voted authors holding a slot whose book isn't their highest-rated one with ≥1000 ratings (swap without moving).
- **Removed** — voted authors who fell outside the top `n`, with current rank.
- **Missing** — top-`n` authors you haven't voted for, suggested into freed slots (highest-rated ≥1000-ratings book as candidate).
- **Out of position** — votes sitting at a slot that no longer matches their live rank.
- **Can't verify** — voted authors with no cached stats; fetch stats (`./authorOne.sh`) and rerun instead of trusting a removal.

The paste-ready block emits instructions in execution order using the list's link syntax — `removed [author:Name|id] [book:Title|id] - was #x, now #y`, then `add … - to #n`, then `move … - from #a to #b`, then `replace … with …`. Book link text drops series parentheticals and converts square brackets to parens so references never nest.

**Author cache hygiene:** `npm run author-dedupe` merges duplicate author rows that share an id under different name variants (mangled spacing, `(Editor)` suffixes) and un-mangles names. Dry run by default; `--apply` writes after an automatic backup. New book-row syncs no longer create variant rows.

### 8. Library Queries
Run custom queries over your imported Goodreads library export (the same cached import used by `books --excludeReviewed`). `libraryExportCache.json` keeps every parsed entry (`id, title, author, shelf, dateRead, hasReview, published, myRating, pages`), so queries never touch the CSV again until you refresh with `--export`. Convenient wrapper: `./library.sh`.

```bash
./library.sh by-char --year 2024                    # books read + reviewed (review text) in 2024, by first letter of title
./library.sh by-char --year 2024 --field authorLast # ...by first letter of the first author's last name
./library.sh by-char --year 2024 --field authorFirst
./library.sh published-year --year 2024             # ...by publication year (Year Published)
./library.sh missing --year 2024                    # audit: letters A-Z and pub years >1960 with 0 books
./library.sh by-char --year 2020 --export ~/Downloads/goodreads_library_export.csv   # refresh the cache first
```
Each query requires `--year <YYYY>`; a book counts if it's on the `read` shelf **and** has review text, attributed to a year via `Date Read`. `by-char` supports `--field title` (default), `authorLast`, or `authorFirst` (first author, same name-splitting as `books`); all 26 letters always print (zero counts included), plus `#` for non-alphabetic when non-zero. `published-year` shows only non-zero publication years, oldest first, with `Unknown` (missing/unparseable year) last. `missing` reports, for all three char fields, the letters A–Z with zero books, plus publication years 1961–N (where N is the later of the review year and the newest publication year seen) with zero books. `--import` is an alias for `--export`.

**Fill gaps from a shelf** (same missing-audit buckets, but found from a live Goodreads shelf):
```bash
./tag-gaps.sh picture-books                       # most recent review year, scans 25 shelf pages, 3 per dimension
./tag-gaps.sh picture-books --year 2026 --pages 25 --limit 3
./tag-gaps.sh non-fiction --year 2026 --pages 1 --limit 3
```
Scans `https://www.goodreads.com/shelf/show/<tag>` page-by-page (reusing `scrapeShelfBooks`) and, in shelf order, reports up to `--limit` (default 3) books **per missing bucket** — each missing title / author first name / author last name letter and each missing publication year — that aren't already in your reviewed library. `--pages` defaults to 25, `--year` defaults to the most recent year with reviews.

**Next unreviewed books from a shelf** (no gap logic — just what's next):
```bash
./next-books.sh picture-books --limit 10           # next 10 picture books you haven't reviewed
./next-books.sh non-fiction --pages 25 --limit 10
```
Scans the same shelf and lists the first `--limit` (default 10) books in shelf order that aren't in your reviewed library, skipping already-reviewed ones. `--pages` defaults to 25; `--minTags` and `--export`/`--import` also supported.

**Year in Books** (a better version of https://www.goodreads.com/user/year_in_books — text only, no covers):
```bash
./year-in-books.sh                 # most recent review year
./year-in-books.sh 2026            # a specific year
./year-in-books.sh 2026 --export ~/Downloads/goodreads_library_export.csv   # refresh the cache first
```
By default every book with a `Date Read` that year counts (read shelf, year from `Date Read`); the header always shows both totals (books read and how many of those were also reviewed). Add `--requireReviews` to only count books that also have review text (matching the queries above). Sections: **Reading stats** (books read, pages read with a note if any books lack page counts, shortest & longest book, mean & median page length), **Ratings and reviews** (non-zero star histogram + average rating from the export's `My Rating`, plus review-length stats — min, max, mean, median in characters — from the review text), **Distribution** (first-letter A–Z counts for title / author last name / author first name plus publication-year counts — each letter and publication year also shows the first book that met it that year, and each block lists its missing letters/years), **Top-rated books** (every book rated 5 — falling back to 4-star if you have no five-star ratings that year — as an id link with `Year`, `Ratings`, `Avg` pulled from `booksCache.json` when present, else `N/A` — no live fetching; Goodreads locks the API down after a few lookups, so missing cache entries are just left blank), and **Favorite authors** (authors of that year's read + rated books ranked two ways — top 10 by number of books and top 10 by average of your rating, both requiring at least 3 rated books that year), **Bookshelves** (usage of your `Bookshelves` tags across that year's books — count and percentage of books, sorted descending; a note lists how many books had no shelf tags), and **Publishers** (distinct publisher count + top 10 publishers by number of books with percentage; a note lists how many books had no publisher). Page counts come from the export's `Number of Pages`; books without page counts are excluded from shortest/longest/mean/median and noted in the stats.

**Life in Books** (the lifetime version — same sections, all years at once; no five-star list since it would be huge). Same book-set rule as Year in Books: any book with a `Date Read` by default (header shows both read and reviewed totals), `--requireReviews` to require review text:
```bash
./life-in-books.sh                       # all your years
./life-in-books.sh --requireReviews       # only books with review text
./life-in-books.sh --export ~/Downloads/goodreads_library_export.csv   # refresh the cache first
./life-in-books.sh --library friend --export ~/Downloads/friends_library_export.csv  # someone else's export
```
Sections: **Reading stats** (lifetime books/pages, shortest & longest ever, active span with your first + most recent book), **Ratings and reviews** (lifetime star histogram + review lengths), **Year by year** (one row per year — books read, pages read, mean of your ratings, with notes for missing page counts/ratings), **Distribution** (first-letter A–Z counts for title / author last name / author first name plus publication-year counts — each letter and publication year also shows the first book that met it, and each block lists its missing letters/years), **Favorite authors** (lifetime top 10 by books and by avg rating, min 3), **Publishers** (lifetime distinct count + top 10), and **Bookshelves** (lifetime shelf usage with percentages).


**Favorite authors** (ranked by *your* star rating):
```bash
./favorite-authors.sh                     # top 10, min 3 books, by avg rating
./favorite-authors.sh --limit 20 --minBooks 5
./favorite-authors.sh --sortBy books --limit 10   # or --sortBy avgRating (default)
./favorite-authors.sh --export ~/Downloads/goodreads_library_export.csv   # refresh the cache first
```
Groups every read + rated book (on the `read` shelf with `My Rating` 1–5) by first author, computes the average of your rating per author, and lists the top `--limit` authors (default 10) that have at least `--minBooks` (default 3) rated books — sorted by `--sortBy` (`avgRating` default: average rating desc, then book count; `books`: book count desc, then average rating), then name. Each row shows book count, average of your rating, and the star breakdown; the footer reports total reviewed books and distinct authors.

**Favorite publishers** (same shape, grouped by publisher instead of author):
```bash
./publisher-stats.sh                     # top 10, min 3 books, by avg rating
./publisher-stats.sh --sortBy books --limit 10
./publisher-stats.sh --books --sortBy avgRating --limit 3 --minBooks 10  # also list each publisher's books, by your rating (desc)
./publisher-stats.sh --library friend --export ~/Downloads/friends_library_export.csv  # someone else's export
```

**Shelf usage** (Bookshelves tags across all books, count + percentage, sorted by count desc or name):
```bash
./shelf-stats.sh                                   # top 20 shelves by count
./shelf-stats.sh --sortBy name --limit 50          # alphabetical
./shelf-stats.sh --minCount 5 --limit 10           # only shelves with 5+ books
```
The footer reports the total distinct shelves and how many books had none.

## Testing
- `./runUnitTests.sh` — fast, offline unit tests with code coverage (Vitest). Run after every change.
- `./runIntegrationTests.sh` — live Goodreads lookups (~a dozen requests; run deliberately, needs `config.json` + cached export). Runs in strict-throttle mode: if Goodreads throttles, it gives up immediately — wait ~60s and retry before suspecting a parser bug.
- See `AGENTS.md` for the test cadence and throttling policy, and `GOODREADS_CHANGES.md` for the history of Goodreads page changes that forced fixes.

## Files
- `state.json`: Stores your monitored lists and their book counts.
- `booksCache.json`: Global cache of book metadata (titles, years, ratings, average ratings, tags).
- `authorsCache.json`: Global cache of author metadata (slugs, average ratings, ratings, reviews, shelves).
- `libraryExportCache.json`: Cached, parsed Goodreads library export (all entries + reviewed sets), gitignored.
- `changeLog.txt`: Permanent record of all additions and removals detected during monitoring.
- `auditReport.txt`: Record of all audit outliers and discovery findings.
- `bulkAuditConfig.json`: Default configuration for bulk audits.
- `tags/`: Directory containing tag-specific discovery configurations.
- `AGENTS.md`: Contributor notes — when to run unit vs. integration tests, and Goodreads throttling policy.
- `GOODREADS_CHANGES.md`: Log of Goodreads page changes that required code fixes (newest first).

