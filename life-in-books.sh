#!/bin/bash
# Shows a lifetime "Life in Books" summary across all your reviewed years:
# reading stats, ratings + reviews, year-by-year (books / pages / mean rating),
# favorite authors, publishers, and bookshelves. Uses the cached import;
# pass --export/--import to refresh.
# Examples:
#   ./life-in-books.sh
#   ./life-in-books.sh --export ~/Downloads/goodreads_library_export.csv
#   ./life-in-books.sh --library friend --export ~/Downloads/friends_library_export.csv
# Run ./life-in-books.sh --help for full details.
npm run life-in-books -- "$@"
