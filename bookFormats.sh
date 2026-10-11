#!/bin/bash
# bookFormats.sh — wrapper for `book-formats`
#
# Top book formats by number of books, by average star rating, or by total
# ratings, computed from the cached books + browser book-page scrapes (format
# lives in book_page). Editions of the same work collapse into one work per
# format. Case/whitespace variants ("Paperback" vs "paperback ") fold together
# unless --raw is passed.
#
# Usage:
#   ./bookFormats.sh                                # formats by # works
#   ./bookFormats.sh --sortBy avgRating --minRatings 1000 --minBooks 5
#   ./bookFormats.sh --sortBy totalRatings --limit 20
#   ./bookFormats.sh --minBooks 50                  # skip the messy tail
#   ./bookFormats.sh --raw                          # keep variants separate
set -euo pipefail
cd "$(dirname "$0")"
npm run book-formats -- "$@"
