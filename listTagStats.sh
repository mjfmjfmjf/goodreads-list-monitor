#!/bin/bash
# Show the tags carried by the most lists.
#
# Ranks list_tags by how many lists have each tag — e.g. "fiction" on 49 lists,
# "romance" on 36. Ties break alphabetically so repeated runs print the same
# order and two runs can be diffed.
#
# Purely local: it is a GROUP BY over the list_tags table, no network, no writes.
# Populate list_tags first with ./listTagBackfill.sh.
#
# Usage:
#   ./listTagStats.sh                          # top 25 tags
#   ./listTagStats.sh --limit 100              # top 100
#   ./listTagStats.sh --limit 10 --min-lists 5 # only tags on 5+ lists
#   ./listTagStats.sh --help                    # full command help from the CLI
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  sed -n '2,15p' "$0"
  exit 0
fi
date
echo starting listTagStats.sh
npm run list-tag-stats -- "$@"
echo ended listTagStats.sh
date