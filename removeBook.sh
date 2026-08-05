#!/bin/bash
if [ $# -lt 1 ]; then
  echo "Usage: ./removeBook.sh <bookId> [bookId...]"
  echo "Example: ./removeBook.sh 51477729"
  exit 1
fi

npm run remove-book "$@"
