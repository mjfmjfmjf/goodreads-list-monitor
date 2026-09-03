#!/bin/bash
# exportData.sh — wrapper for `export-data`
#
# Sanitized share export: writes the books + authors + tag_books + genres +
# genre_tag_xref tables as timestamped, gzipped CSV files. Excludes config
# (live session cookies / userId), lists, and author_scrape_failures.
# Pass a mandatory identifier (basename) as the first argument, e.g. mjf.
#
# Usage:
#   ./exportData.sh mjf
#   ./exportData.sh mjf --out ~/Downloads
set -euo pipefail
cd "$(dirname "$0")"
npm run export-data -- "$@"
