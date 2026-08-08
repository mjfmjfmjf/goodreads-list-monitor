# Goodreads List Monitor & Auditor

A production-grade CLI tool to monitor, audit, and discover books on Goodreads Listopia lists and shelves.

## Core Features
- **Smart Monitoring**: Detect additions and removals across hundreds of lists in seconds.
- **Rich Metadata**: Automatically tracks book positions, rating counts, average ratings, and publication years.
- **Automated Audits**: Identify books that violate rating, average rating, or year criteria.
- **Tag Discovery**: Cross-reference entire Goodreads shelves with your lists to find missing popular books.
- **Persistent Caching**: Saves book details locally in `booksCache.json` to minimize network calls and respect rate limits, now including average ratings.

## Prerequisites
- Node.js v18.20.8 or later

## Setup
1. **Clone the repository.**
2. **Install dependencies**: `npm install`
3. **Set your User ID**:
   ```bash
   npm run set-user [YOUR_USER_ID]
   ```
4. **Configure Authentication** (Optional but recommended for large audits):
   Create a `config.json` file in the root directory:
   ```json
   {
     "cookie": "your_browser_session_cookie"
   }
   ```
   
## Usage

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
Same book set as the queries above (read shelf + review text, year from `Date Read`). Sections: **Reading stats** (books read, pages read with a note if any books lack page counts, shortest & longest book, mean & median page length), **Ratings** (non-zero star histogram + average rating, from the export's `My Rating`), **Distribution** (first-letter A–Z counts for title / author last name / author first name plus publication-year counts — each letter and publication year also shows the first book that met it that year, and each block lists its missing letters/years), and **Five-star books** (every book rated 5, as an id link with `Year`, `Ratings`, `Avg` pulled from `booksCache.json` when present, else `N/A` — no live fetching; Goodreads locks the API down after a few lookups, so missing cache entries are just left blank). Page counts come from the export's `Number of Pages`; books without page counts are excluded from shortest/longest/mean/median and noted in the stats.

## Files
- `state.json`: Stores your monitored lists and their book counts.
- `booksCache.json`: Global cache of book metadata (titles, years, ratings, average ratings, tags).
- `authorsCache.json`: Global cache of author metadata (slugs, average ratings, ratings, reviews, shelves).
- `libraryExportCache.json`: Cached, parsed Goodreads library export (all entries + reviewed sets), gitignored.
- `changeLog.txt`: Permanent record of all additions and removals detected during monitoring.
- `auditReport.txt`: Record of all audit outliers and discovery findings.
- `bulkAuditConfig.json`: Default configuration for bulk audits.
- `tags/`: Directory containing tag-specific discovery configurations.

