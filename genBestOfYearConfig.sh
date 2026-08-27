#!/bin/bash
# genBestOfYearConfig.sh — wrapper for `gen-best-of-year-config`
#
# Walks the "By year" cross-links on the Best Books of <year> list family
# (seeds: list/show/34595 and list/best_of_year/2026) via a polite BFS
# (~2s + jitter between fetches) and writes bulkBestBooksOfYear.json —
# one bulk-audit entry per year with criteria.minYear = criteria.maxYear.
#
# Usage:
#   ./genBestOfYearConfig.sh
#   ./genBestOfYearConfig.sh --out myYears.json
set -euo pipefail
cd "$(dirname "$0")"
npm run gen-best-of-year-config -- "$@"
