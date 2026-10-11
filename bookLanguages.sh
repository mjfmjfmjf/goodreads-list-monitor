#!/bin/bash
# bookLanguages.sh — wrapper for `book-languages`
#
# Top book languages by number of books, by average star rating, or by total
# ratings, computed from the cached books + browser book-page scrapes (language
# lives in book_page). Editions of the same work collapse into one work per
# language, so a 10-edition series counts once.
#
# Usage:
#   ./bookLanguages.sh                                # languages by # works
#   ./bookLanguages.sh --sortBy avgRating --minRatings 1000 --minBooks 5
#   ./bookLanguages.sh --sortBy totalRatings --limit 20
#   ./bookLanguages.sh --minBooks 50                  # skip rare languages
#   ./bookLanguages.sh --raw                          # don't fold case/whitespace
set -euo pipefail
cd "$(dirname "$0")"
npm run book-languages -- "$@"
