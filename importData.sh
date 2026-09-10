#!/bin/bash
# importData.sh — wrapper for `import-data`
#
# Import library data from the sanitized CSV+gzip exports produced by
# export-data (books, authors, tag_books, genres, genre_tag_xref, book_page,
# tag_stats, lists). Merges fill-blank-only per field with genre/tag union;
# book_page keeps the newest scrape per book and lists.seen_book_ids is
# union-merged. Never overwrites a known-good DB value unless --ratingPolicy
# update is given.
# The schema is upgraded automatically (current spec) on open.
#
# Usage:
#   ./importData.sh --books books.csv.gz --authors authors.csv.gz
#   ./importData.sh --books books.csv.gz --authors authors.csv.gz --ratingPolicy update
set -euo pipefail
cd "$(dirname "$0")"
npm run import-data -- "$@"
