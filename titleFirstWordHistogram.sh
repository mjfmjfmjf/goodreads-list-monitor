#!/bin/bash
# titleFirstWordHistogram.sh — wrapper for `title-first-word-histogram`
#
# Histogram of the first word of every cached book title
# (offline, no network). Default shows top 100 words.
#
# Usage:
#   ./titleFirstWordHistogram.sh            # top 100
#   ./titleFirstWordHistogram.sh --limit 25 # top 25
set -euo pipefail
cd "$(dirname "$0")"
npm run title-first-word-histogram -- "$@"
