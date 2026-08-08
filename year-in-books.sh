#!/bin/bash
if [ $# -eq 0 ]; then
  echo "Usage: ./year-in-books.sh [year] [--export <path>]"
  echo "Shows a text 'Year in Books' summary for a year (default: most recent review year)."
  echo "Sections: reading stats (pages read, shortest/longest, mean/median), ratings (star"
  echo "histogram + average), distribution (first letters A-Z + publication years + missing),"
  echo "and the five-star book list. No book covers — just summaries."
  echo "Examples:"
  echo "  ./year-in-books.sh"
  echo "  ./year-in-books.sh 2026"
  echo "  ./year-in-books.sh 2026 --export ~/Downloads/goodreads_library_export.csv"
  echo "Run ./year-in-books.sh --help for full details."
  exit 1
fi
npm run year-in-books -- "$@"
