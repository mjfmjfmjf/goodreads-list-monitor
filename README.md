# Goodreads List Monitor & Auditor

A production-grade CLI tool to monitor, audit, and discover books on Goodreads Listopia lists and shelves.

## Core Features
- **Smart Monitoring**: Detect additions and removals across hundreds of lists in seconds.
- **Rich Metadata**: Automatically tracks book positions, rating counts, and publication years.
- **Automated Audits**: Identify books that violate rating or year criteria.
- **Tag Discovery**: Cross-reference entire Goodreads shelves with your lists to find missing popular books.
- **Persistent Caching**: Saves book details locally in `booksCache.json` to minimize network calls and respect rate limits.

## Prerequisites
- Node.js v18.20.8 or later

## Setup
1. **Set your User ID**:
   ```bash
   npm run set-user [YOUR_USER_ID]
   ```
2. **Configure Authentication** (Optional but recommended for large audits):
   Create a `config.json` file in the root directory:
   ```json
   {
     "cookie": "your_browser_session_cookie"
   }
   ```

## Setup

1. **Clone the repository.**
2. **Install dependencies**: `npm install`
3. **Configure**: 
   - Copy `config.example.json` to `config.json`.
   - Update `config.json` with your Goodreads session cookie (found in your browser's dev tools while logged into Goodreads).
4. **Initialize User**: Update `start.sh` with your Goodreads User ID and run `./start.sh`.

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
Audit a specific list for books that don't meet criteria. You can audit by **Ratings** OR **Publishing Year**.

**By Ratings:**
```bash
npm run audit [listId] -- --min 1000 --max 50000
```

**By Publishing Year:**
```bash
npm run audit [listId] -- --minYear 2010 --maxYear 2024
```

### 4. Tag Discovery & Auditing
Find missing popular books from a shelf and cross-reference them with your lists.

**Single List Tag Audit:**
```bash
npm run tag-audit [tag] [listId] -- --min [minRatings] --minTags [minTags]
```

**Batch Discovery Run:**
Automate audits for an entire family of lists (e.g., Science Fiction):
1. **Generate Config**:
   ```bash
   npm run tag-config [hubListId] [tagName]
   ```
2. **Run Discovery**:
   ```bash
   npm run tag-discovery [tagName] -- --minTags 50
   ```

## Files
- `state.json`: Stores your monitored lists and their book counts.
- `booksCache.json`: Global cache of book metadata (titles, years, ratings, tags).
- `changeLog.txt`: Permanent record of all additions and removals detected during monitoring.
- `auditReport.txt`: Record of all audit outliers and discovery findings.
- `tags/`: Directory containing tag-specific discovery configurations.
