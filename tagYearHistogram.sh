#!/bin/bash
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  echo "Usage: ./tagYearHistogram.sh <tag> [options]"
  echo "Show books per year for a specific tag from tag_books xref"
  echo ""
  echo "Options:"
  echo "  --min-tags <number>  Minimum total number of tags per book (default 1)"
  echo "  --by-decade          Group by decade instead of year"
  exit 0
fi
date
echo "starting tagYearHistogram.sh"
npm run tag-year-histogram -- "$@"
echo "ended tagYearHistogram.sh"
date
