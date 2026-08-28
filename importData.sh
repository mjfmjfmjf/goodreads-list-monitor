#!/bin/bash
# importData.sh — wrapper for `import-data`
#
# Import book + author data from the sanitized CSV+gzip exports produced by
# export-data. Merges fill-blank-only per field with genre/tag union; never
# overwrites a known-good DB value unless --ratingPolicy update is given.
# The schema is upgraded automatically (current spec) on open.
#
# Usage:
#   ./importData.sh --books books.csv.gz --authors authors.csv.gz
#   ./importData.sh --books books.csv.gz --authors authors.csv.gz --ratingPolicy update
set -euo pipefail
cd "$(dirname "$0")"
npm run import-data -- "$@"
