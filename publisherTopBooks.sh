#!/bin/bash
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  echo "Usage: ./publisherTopBooks.sh [options]"
  echo "For top publishers, show the top-rated book for each"
  echo ""
  echo "Options:"
  echo "  --publishers <n>    Number of top publishers (default 10)"
  echo "  --sortBy <field>    Sort by: books (default), avgRating, totalRatings"
  echo "  --minRatings <n>    Min ratings per work"
  echo "  --minBooks <n>      Min books per publisher"
  exit 0
fi
date
echo "starting publisherTopBooks.sh"
npm run publisher-top-books -- "$@"
echo "ended publisherTopBooks.sh"
date
