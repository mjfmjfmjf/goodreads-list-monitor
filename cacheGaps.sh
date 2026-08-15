#!/bin/bash
if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
  echo "Usage: ./cacheGaps.sh [options]"
  echo "Like tag-gaps but scans the book cache (sorted by ratings) instead of a shelf."
  echo "Lists up to N books per 'missing' review gap for a year (title / authorFirstName /"
  echo "authorLastName letters + publication years) that aren't already in your reviewed library."
  echo "Options pass through to cache-gaps:"
  echo "  --year <year>   Review year (default: most recent year with reviews)"
  echo "  --limit <n>     Books per missing bucket (default 3)"
  echo "  --library <n>   Named library cache to use"
  echo "  --export <path> Import + cache a Goodreads library export CSV first"
  echo "Examples:"
  echo "  ./cacheGaps.sh"
  echo "  ./cacheGaps.sh --year 2026"
  echo "  ./cacheGaps.sh --year 2026 --limit 3"
  exit 0
fi
npm run cache-gaps -- "$@"
