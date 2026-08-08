#!/bin/bash
if [ $# -lt 1 ]; then
  echo "Usage: ./next-books.sh <shelfTag> [--limit <n>] [--pages <n>] [--minTags <n>] [--export <path>]"
  echo "Scans a Goodreads shelf (e.g. picture-books, up to 25 pages) and lists the next N books"
  echo "you haven't reviewed yet, in shelf order."
  echo "Examples:"
  echo "  ./next-books.sh picture-books --limit 10"
  echo "  ./next-books.sh picture-books --pages 25 --limit 10"
  echo "Run ./next-books.sh --help for full details."
  exit 1
fi
npm run next-books -- "$@"
