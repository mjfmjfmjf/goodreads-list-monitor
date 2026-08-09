#!/bin/bash
# Shows usage of your Bookshelves tags from the library export: per-shelf count
# and percentage of books, sorted by count (descending) or by shelf name.
# Defaults: --limit 20 --sortBy count. Uses the cached import; pass --export/--import to refresh.
# Examples:
#   ./shelf-stats.sh
#   ./shelf-stats.sh --limit 50
#   ./shelf-stats.sh --sortBy name --limit 50
#   ./shelf-stats.sh --minCount 5 --limit 10
#   ./shelf-stats.sh --export ~/Downloads/goodreads_library_export.csv
# Run ./shelf-stats.sh --help for full details.
npm run shelf-stats -- "$@"
