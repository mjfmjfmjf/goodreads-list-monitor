#!/bin/bash
# tagHistogram.sh — wrapper for `tag-histogram`
#
# Offline report over the tag_books table: for each tag, the share of books
# shelved under only that tag, and under one or two tags, plus min/max/avg
# rating counts (and shelves min/max) for the tag's books.
#
# Usage:
#   ./tagHistogram.sh                            # top 25 tags by single-tag share
#   ./tagHistogram.sh --limit 500                # show the top 500 tags
#   ./tagHistogram.sh --min 10                   # only tags with >= 10 books
#   ./tagHistogram.sh --sortBy pct2              # sort by the one-or-two-tag share
#   ./tagHistogram.sh --sortBy upTo2 --asc       # largest count of one/two-tag books first
set -euo pipefail
cd "$(dirname "$0")"
npm run tag-histogram -- "$@"
