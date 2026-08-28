#!/bin/bash
# analyzeCsv.sh — wrapper for `analyze-csv`
#
# Field-level analysis of one CSV+gzip file: row count, gzipped size, and per-
# column population, type, numeric range, and value samples. Pure analysis; no DB.
#
# Usage:
#   ./analyzeCsv.sh mjf_books_20260828-100153.csv.gz
set -euo pipefail
cd "$(dirname "$0")"
npm run analyze-csv -- "$@"
