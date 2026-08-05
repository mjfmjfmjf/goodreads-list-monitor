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

### 6. Author Statistics
Capture and rank authors by popularity. All author data lives in `authorsCache.json`.

**Capture Author Stats:**
```bash
npm run author-top-books [n] -- --minRatings [min] --maxRatings [max]
```
Scans the book cache for the top `n` books by number of ratings (optionally filtered by a ratings range), builds a distinct list of their authors, and scrapes each author's page **once** — capturing `averageRating`, `numRatings`, `numReviews`, and `numShelves` into `authorsCache.json`. Author stats are updated monotonically: a value is only replaced if it hasn't decreased.

**Read Top Authors from the Cache:**
```bash
npm run author-top-stats -- --limit [n] --sortBy [field] --minRatings [min] --maxRatings [max]
```
Lists the top authors from `authorsCache.json` sorted descending. `--sortBy` is one of `numRatings` (default), `averageRating`, `numReviews`, or `numShelves`; `--limit` defaults to 100. Authors missing a value for the sort field are excluded from the results.

## Files
- `state.json`: Stores your monitored lists and their book counts.
- `booksCache.json`: Global cache of book metadata (titles, years, ratings, average ratings, tags).
- `authorsCache.json`: Global cache of author metadata (slugs, average ratings, ratings, reviews, shelves).
- `changeLog.txt`: Permanent record of all additions and removals detected during monitoring.
- `auditReport.txt`: Record of all audit outliers and discovery findings.
- `bulkAuditConfig.json`: Default configuration for bulk audits.
- `tags/`: Directory containing tag-specific discovery configurations.

