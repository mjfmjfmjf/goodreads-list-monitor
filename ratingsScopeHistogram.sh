#!/bin/bash
# ratingsScopeHistogram.sh — wrapper for `ratings-scope-histogram`
#
# Ratings histogram across three scopes (ALL cached books, WORK-ID books,
# WORKS distinct works). For each scope, per ratings bracket: #, % of scope,
# ROLLUP (this bracket and above) and ROLLDOWN (this bracket and below).
#
# Usage:
#   ./ratingsScopeHistogram.sh              # full table (% and ROLLDOWN included)
#   ./ratingsScopeHistogram.sh --reddit     # compact table for a Reddit post
#                                           # (drops % and ROLLDOWN; ~7.6k chars)
set -euo pipefail
cd "$(dirname "$0")"

npm run ratings-scope-histogram -- "$@"
