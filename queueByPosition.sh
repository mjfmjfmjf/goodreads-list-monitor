#!/bin/bash
if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
  echo "Usage: ./queueByPosition.sh [options]"
  echo "Queue-discovery for series-position lists defined in queueByPosition.json."
  echo "Finds cached books matching each list's series position (standalone,"
  echo "boxed set, 1st book, 2nd book, 3rd book) with 100000+ ratings that are"
  echo "NOT yet on that Goodreads list."
  echo "Options pass through to queue-discovery:"
  echo "  --listId <id>      Only run discovery for one list ID"
  echo "  --sortBy <type>    year, ratings, or avg (default ratings)"
  echo "  --minAvg <number>  Global minimum average rating"
  echo "  --maxAvg <number>  Global maximum average rating"
  echo "Examples:"
  echo "  ./queueByPosition.sh"
  echo "  ./queueByPosition.sh --listId 35080"
  echo "  ./queueByPosition.sh --minAvg 3.9"
  exit 0
fi
npm run queue-discovery -- queueByPosition.json "$@"
