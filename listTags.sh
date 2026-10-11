#!/bin/bash
# Bare list of tags → number of lists, straight from the unified list_tags xref.
#
# One line per tag: rank, tag, how many lists carry it. The count includes
# lists learned from sidebar reads AND lists a directory walk discovered, so
# once a tag has been walked the number reflects the real directory size
# (e.g. "historical" → 1,018, not the 480 sidebars we happened to read).
# Ties break alphabetically so repeated runs print the same order and two runs
# can be diffed.
#
# Purely local: a GROUP BY over list_tags, no network, no writes.
# Populate it with ./listTagBackfill.sh (sidebar) and ./listTagWalk.sh (directory).
#
# Usage:
#   ./listTags.sh                  # top 30 tags
#   ./listTags.sh --limit 100      # top 100
#   ./listTags.sh --help           # full command help from the CLI
#
# Want bars, freshness ages, and walk history? Use ./listTagStats.sh instead.
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  sed -n '2,18p' "$0"
  exit 0
fi
date
echo starting listTags.sh
npm run list-tags -- "$@"
echo ended listTags.sh
date
