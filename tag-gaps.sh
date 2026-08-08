#!/bin/bash
if [ $# -lt 1 ]; then
  echo "Usage: ./tag-gaps.sh <shelfTag> [--year <year>] [--pages <n>] [--limit <n>] [--minTags <n>] [--export <path>]"
  echo "Scans a Goodreads shelf (e.g. picture-books, up to 25 pages) and lists up to N books per 'missing'"
  echo "review gap for a year (title / authorFirstName / authorLastName letters + publication years)."
  echo "Examples:"
  echo "  ./tag-gaps.sh picture-books"
  echo "  ./tag-gaps.sh picture-books --year 2026 --pages 25 --limit 3"
  echo "Run ./tag-gaps.sh --help for full details."
  exit 1
fi
npm run tag-gaps -- "$@"
