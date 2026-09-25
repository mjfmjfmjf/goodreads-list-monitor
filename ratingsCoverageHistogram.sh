#!/bin/bash
# ratingsCoverageHistogram.sh — wrapper for `ratings-coverage-histogram`
#
# Coarse offline histogram of the book cache by number of ratings, split by
# coverage subset: ALL cached books vs books with a work id vs books present
# in the book_page field-coverage cache, with within-bracket coverage %.
#
# Usage:
#   ./ratingsCoverageHistogram.sh
set -euo pipefail
cd "$(dirname "$0")"

npm run ratings-coverage-histogram -- "$@"