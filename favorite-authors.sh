#!/bin/bash
# Ranks your favorite authors by your own star rating (average of your My Rating),
# grouped by first author, from your read + rated books in the library export.
# Defaults: --limit 10 --minBooks 3 --sortBy avgRating. Uses the cached import;
# pass --export/--import to refresh.
# Examples:
#   ./favorite-authors.sh
#   ./favorite-authors.sh --limit 20 --minBooks 5
#   ./favorite-authors.sh --sortBy books --limit 10
#   ./favorite-authors.sh --export ~/Downloads/goodreads_library_export.csv
# Run ./favorite-authors.sh --help for full details.
npm run favorite-authors -- "$@"
