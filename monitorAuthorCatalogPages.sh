#!/bin/bash
# monitorAuthorCatalogPages.sh — wrapper for `author-list-diff`
#
# Monitor the "100 Authors With Most Catalog Entries" Listopia list
# (https://www.goodreads.com/list/show/421407) by diffing the user's votes
# page against the current author ranking by catalog pages (the number of
# scraped catalog pages per author). Reports voted authors that fell out of
# the top 100 and qualifying authors/books to add in their place.
#
# Basis: ./authorTopStats.sh --sortBy catalogPages --limit 100
#
# Usage:
#   ./monitorAuthorCatalogPages.sh
#   ./monitorAuthorCatalogPages.sh 11136110            # explicit votes-page id
#   ./monitorAuthorCatalogPages.sh https://www.goodreads.com/list/user_vote/11136110
set -euo pipefail
cd "$(dirname "$0")"

VOTES="${1:-11136110}"
shift 2>/dev/null || true

npm run author-list-diff -- "$VOTES" --sortBy catalogPages --limit 100 --minRatings 0 "$@"
