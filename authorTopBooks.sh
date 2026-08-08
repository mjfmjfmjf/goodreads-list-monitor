#!/bin/bash
if [ $# -lt 1 ]; then
  echo "Usage: ./authorTopBooks.sh <n> [--minRatings N] [--maxRatings N] [--skip]"
  echo "Example: ./authorTopBooks.sh 100"
  echo "Example: ./authorTopBooks.sh 100 --minRatings 100000 --skip"
  echo "Run ./authorTopBooks.sh --help for full details."
  exit 1
fi
date
echo starting authorTopBooks.sh
npm run author-top-books -- "$@"
echo ended authorTopBooks.sh
date
