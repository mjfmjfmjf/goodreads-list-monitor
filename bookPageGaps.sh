#!/bin/bash
# bookPageGaps.sh — wrapper for `book-page-gaps`
#
# Offline report: how many of the top-N books by ratings are missing from the
# browser book-page field coverage (the book_page table), plus a ranked list of
# the top missing books so you can decide what to scrape next.
#
# Usage:
#   ./bookPageGaps.sh
#   ./bookPageGaps.sh --top 100000 --limit 25
set -euo pipefail
cd "$(dirname "$0")"
npm run book-page-gaps -- "$@"