#!/bin/bash
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  echo "Usage: ./browserBookScrape.sh [options]"
  echo "Harvests rich per-book fields for the highest-ratings books that are missing genres."
  echo ""
  echo "Examples:"
  echo "  ./browserBookScrape.sh --limit 20    (headed Chromium window, logged-in; default)"
  echo "  ./browserBookScrape.sh --limit 100 --minRatings 100000"
  echo "  ./browserBookScrape.sh --skip-has genres,work-id --sort random --limit 5"
  echo "  ./browserBookScrape.sh --engine axios --limit 20   (SSR fallback when not throttled)"
  echo "  ./browserBookScrape.sh --dryRun --limit 10"
  echo "  ./browserBookScrape.sh --help   (verbose command help from the CLI itself)"
  exit 0
fi
date
echo starting browserBookScrape.sh
npm run browser-book-scrape -- "$@"
echo ended browserBookScrape.sh
date