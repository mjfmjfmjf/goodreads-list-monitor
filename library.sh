#!/bin/bash
if [ $# -lt 1 ]; then
  echo "Usage: ./library.sh <query> [--year <year>] [--field title|authorLast|authorFirst] [--export <path>]"
  echo "Queries:"
  echo "  by-char        — count books read + reviewed (review text) in a year, by first letter of a field"
  echo "  published-year — count books read + reviewed in a year, by publication year"
  echo "  missing        — audit: first letters A-Z (title/authorLast/authorFirst) and publication years >1960 with 0 books"
  echo "Examples:"
  echo "  ./library.sh by-char --year 2024"
  echo "  ./library.sh by-char --year 2024 --field authorLast"
  echo "  ./library.sh by-char --year 2024 --field authorFirst"
  echo "  ./library.sh published-year --year 2024"
  echo "  ./library.sh missing --year 2024"
  echo "  ./library.sh by-char --year 2024 --export ~/Downloads/goodsreads_library_export.csv"
  echo "Run ./library.sh --help for full details."
  exit 1
fi
npm run library -- "$@"
