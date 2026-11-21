#!/bin/sh
# Snapshot the Goodreads /shelf directory: tag, #books, rank and scrape date.
# Default: pages 1-100, ~1000 tags, one polite GET per page.
# Usage examples:
#   ./shelfTagDirectory.sh                       # full 100-page snapshot
#   ./shelfTagDirectory.sh --pages 1-5           # first 5 pages only
#   ./shelfTagDirectory.sh --dryRun              # preview, no DB writes
date
echo starting shelfTagDirectory.sh
npm run shelf-tag-directory -- "$@"
echo ended shelfTagDirectory.sh
date
