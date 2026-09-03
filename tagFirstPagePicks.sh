#!/bin/bash
# tagFirstPagePicks.sh — wrapper for `tag-first-page-picks`
#
# Offline report over the tag_books table: books that appear on the most tag
# "first pages" (position 1-50 on a tag's shelf), excluding any book you've
# already reviewed (from the cached library export).
#
# Usage:
#   ./tagFirstPagePicks.sh                  # top 20 books (excludes reviewed)
#   ./tagFirstPagePicks.sh --limit 50       # show up to 50 books
#   ./tagFirstPagePicks.sh --terse --limit 50  # one line per book
#   ./tagFirstPagePicks.sh --includeReviewed   # include books you've already reviewed
set -euo pipefail
cd "$(dirname "$0")"
npm run tag-first-page-picks -- "$@"