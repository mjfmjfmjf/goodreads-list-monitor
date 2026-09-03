#!/bin/bash
if [ $# -eq 0 ]; then
  echo "Usage: ./year-in-books.sh [year] [--export <path>] [--requireReviews]"
  echo "Shows a text 'Year in Books' summary for a year (default: most recent review year)."
  echo "By default counts every book with a Date Read that year; add --requireReviews"
  echo "to only count books that also have review text. Five-star books are listed,"
  echo "falling back to your top rating if you have no five-star books."
  echo "Sections: reading stats (pages read, shortest/longest, mean/median), ratings (star"
  echo "histogram + average), distribution (first letters A-Z + publication years + missing),"
  echo "and the five-star book list. No book covers — just summaries."
  echo "Examples:"
  echo "  ./year-in-books.sh"
  echo "  ./year-in-books.sh 2026"
  echo "  ./year-in-books.sh 2026 --export ~/Downloads/goodreads_library_export.csv"
  echo "  ./year-in-books.sh 2026 --userId 5464134  # someone else's profile, from the live review-list page (no CSV)"
  echo "Run ./year-in-books.sh --help for full details."
  exit 1
fi
npm run year-in-books -- "$@"
