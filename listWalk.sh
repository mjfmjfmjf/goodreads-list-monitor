#!/bin/bash
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  echo "Usage: ./listWalk.sh [options]"
  echo "Walk a Goodreads Listopia list through its rating-range description chain,"
  echo "harvesting each book with the logged-in headed browser."
  echo ""
  echo "Examples:"
  echo "  ./listWalk.sh --list 35080 --limit 20     (One Million Ratings! then down the chain)"
  echo "  ./listWalk.sh --list 35177 --limit 50 --direction asc"
  echo "  ./listWalk.sh --list 35080 --dryRun --limit 10   (enumerate, no fetching/writes)"
  echo "  ./listWalk.sh --list 35080 --maxLists 3 --limit 50"
  echo "  ./listWalk.sh --help   (verbose command help from the CLI itself)"
  exit 0
fi
date
echo starting listWalk.sh
npm run list-walk -- "$@"
echo ended listWalk.sh
date