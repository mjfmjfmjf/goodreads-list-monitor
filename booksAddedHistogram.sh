#!/bin/bash
# booksAddedHistogram.sh — wrapper for `books-added-histogram`
#
# Histogram of book-cache growth over time, driven by the books.first_seen
# column. Shows, per period, how many books were ADDED and the running TOTAL of
# books in the DB as of that period.
#
# Usage:
#   ./booksAddedHistogram.sh                   # last 7 days
#   ./booksAddedHistogram.sh --days 30         # last 30 days
#   ./booksAddedHistogram.sh --weeks 12        # last 12 weeks (Monday-weeks)
#   ./booksAddedHistogram.sh --months 12       # last 12 calendar months
set -euo pipefail
cd "$(dirname "$0")"
npm run books-added-histogram -- "$@"