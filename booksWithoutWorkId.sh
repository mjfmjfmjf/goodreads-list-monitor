#!/bin/bash
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  echo "Usage: ./booksWithoutWorkId.sh"
  echo "Analyze books missing work_id (ratings breakdown, authors, dates)"
  exit 0
fi
date
echo "starting booksWithoutWorkId.sh"
npm run books-without-work-id -- "$@"
echo "ended booksWithoutWorkId.sh"
date
