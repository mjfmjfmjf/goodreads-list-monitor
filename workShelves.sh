#!/bin/bash
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  echo "Usage: ./workShelves.sh [options]"
  echo "Scrape all shelves from https://www.goodreads.com/work/shelves/<workId> (page 1 only) for top-rated books not recently scraped."
  echo ""
  echo "Examples:"
  echo "  ./workShelves.sh                          (top 100 by ratings, not scraped in 30 days)"
  echo "  ./workShelves.sh --limit 500              (scrape 500 books)"
  echo "  ./workShelves.sh --minRatings 5000        (only books with >=5000 ratings)"
  echo "  ./workShelves.sh --maxAgeDays 7           (re-scrape if older than 7 days)"
  echo "  ./workShelves.sh --dryRun                 (show what would be scraped)"
  echo "  ./workShelves.sh --help                   (verbose command help from the CLI itself)"
  exit 0
fi
date
echo starting workShelves.sh
npm run work-shelves -- "$@"
echo ended workShelves.sh
date
