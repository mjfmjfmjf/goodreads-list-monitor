#!/bin/bash
# tagCoverage.sh — wrapper for `tag-coverage`
#
# Offline report over the tag_books table: greedy set-cover to find the least
# number of tags that cover the most books. Each row shows the tag that adds the
# most new (uncovered) books, with the tag's own book count plus the cumulative
# unique books covered and % of all unique books.
#
# Usage:
#   ./tagCoverage.sh                      # top 20 tags (or until 100% coverage)
#   ./tagCoverage.sh --limit 50           # show up to 50 tags
#   ./tagCoverage.sh --limit 1000         # show up to 1000 tags
set -euo pipefail
cd "$(dirname "$0")"
npm run tag-coverage -- "$@"
