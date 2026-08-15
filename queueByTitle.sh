#!/bin/bash
if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
  echo "Usage: ./queueByTitle.sh [options]"
  echo "Queue-discovery for title-letter lists defined in queueByTitle.json."
  echo "Finds cached books whose title matches each list's regex but are NOT"
  echo "yet on that Goodreads list (e.g. 'Titles that start with X')."
  echo "Options pass through to queue-discovery:"
  echo "  --listId <id>      Only run discovery for one list ID"
  echo "  --sortBy <type>    year, ratings, or avg (default ratings)"
  echo "  --minAvg <number>  Global minimum average rating"
  echo "  --maxAvg <number>  Global maximum average rating"
  echo "Examples:"
  echo "  ./queueByTitle.sh"
  echo "  ./queueByTitle.sh --listId 17759"
  echo "  ./queueByTitle.sh --minAvg 3.9"
  exit 0
fi
npm run queue-discovery -- queueByTitle.json "$@"
