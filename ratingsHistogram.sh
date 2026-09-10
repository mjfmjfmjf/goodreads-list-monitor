#!/bin/bash
# ratingsHistogram.sh — wrapper for `ratings-histogram`
#
# Coarse offline histogram of the book cache by number of ratings, with a
# completeness-based estimate of the true (full) distribution.
#
# Usage:
#   ./ratingsHistogram.sh                  # all cached books
#   ./ratingsHistogram.sh --onlyWorkId      # only books that have a work id
set -euo pipefail
cd "$(dirname "$0")"

npm run ratings-histogram -- "$@"
