#!/bin/bash
# Ranks your favorite publishers by your own star rating (average of your My Rating),
# grouped by publisher, from your read + rated books in the library export.
# Defaults: --limit 10 --minBooks 3 --sortBy avgRating. Uses the cached import;
# pass --export/--import to refresh.
# Examples:
#   ./publisher-stats.sh
#   ./publisher-stats.sh --limit 20 --minBooks 5
#   ./publisher-stats.sh --sortBy books --limit 10
#   ./publisher-stats.sh --books --sortBy avgRating --limit 3 --minBooks 10
#   ./publisher-stats.sh --export ~/Downloads/goodreads_library_export.csv
# Run ./publisher-stats.sh --help for full details.
npm run publisher-stats -- "$@"
