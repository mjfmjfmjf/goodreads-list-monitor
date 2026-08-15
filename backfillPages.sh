#!/bin/bash
if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
  echo "Usage: ./backfillPages.sh"
  echo "Copy page counts from the cached Goodreads library export into booksCache.json"
  echo "where the cache has none (existing page counts are never overwritten)."
  echo "Options pass through to backfill-pages."
  echo "Examples:"
  echo "  ./backfillPages.sh"
  exit 0
fi
npm run backfill-pages -- "$@"
