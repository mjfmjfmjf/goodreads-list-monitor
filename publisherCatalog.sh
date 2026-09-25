#!/bin/bash
# publisherCatalog.sh — wrapper for `publisher-catalog`
#
# Top publishers by number of books or by average star rating, computed from
# the cached books + browser book-page scrapes (publisher lives in book_page).
# Editions of the same work collapse into one work per publisher.
#
# Usage:
#   ./publisherCatalog.sh                          # publishers by # works
#   ./publisherCatalog.sh --sortBy avgRating --minRatings 1000 --minBooks 5
#   ./publisherCatalog.sh --sortBy totalRatings --limit 20
#   ./publisherCatalog.sh --minBooks 3 --limit 30
set -euo pipefail
cd "$(dirname "$0")"
npm run publisher-catalog -- "$@"