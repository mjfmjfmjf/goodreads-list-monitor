#!/bin/bash
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  echo "Usage: bash rescrapeTopWorks.sh [options]  (or: npm run rescrape-top-works -- [options])"
  echo "Rescrapes the union of the top N English works by ratings, reviews, currently-reading,"
  echo "to-read, and edition count, skipping editions scraped successfully within 3 days."
  echo ""
  echo "Examples:"
  echo "  ./rescrapeTopWorks.sh --dryRun              (show the union, no network or writes)"
  echo "  ./rescrapeTopWorks.sh                       (default: N=2000 per metric, minAge=3d)"
  echo "  ./rescrapeTopWorks.sh -n 500 --minAge 7"
  echo "  ./rescrapeTopWorks.sh --help                (verbose command help from the CLI itself)"
  exit 0
fi
date
echo starting rescrapeTopWorks.sh
npm run rescrape-top-works -- "$@"
echo ended rescrapeTopWorks.sh
date
