#!/bin/bash
# scrapeBestOfYear.sh — wrapper for `scrape-best-of-year`
#
# Scrapes https://www.goodreads.com/list/best_of_year/<year> into the book
# cache, one year at a time, politely (~2s between years, existing page
# delays inside each list). Books missing Listopia pub metadata inherit the
# list's year. Max 100 pages per year.
#
# Usage:
#   ./scrapeBestOfYear.sh                          # 1980 .. current year
#   ./scrapeBestOfYear.sh --minYear 2020           # 2020 .. current year
#   ./scrapeBestOfYear.sh --minYear 1980 --maxYear 1999
set -euo pipefail
cd "$(dirname "$0")"
npm run scrape-best-of-year -- "$@"
