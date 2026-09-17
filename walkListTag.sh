#!/bin/bash
# Walk the Listopia by-tag index (e.g. https://www.goodreads.com/list/tag/mjf or
# /list/tag?id=mjf): enumerate every list under the tag, then walk EACH list
# top-to-bottom in a headed, logged-in Chromium, harvesting every book with the
# list-walk book engine (checkpoint/skip-has skipping, throttle cooldown +
# single retry, consecutive-throttle abort, pacing, --limit cap). Unlike
# list-tag-walk there is no description-chain following — one tag, all its
# lists, then stop.
#
# Resume: harvested books are checkpointed (browser_scrape 'ok') and fully
# walked lists are marked done in list_walk, so a re-run skips them unless
# --force / --relist-days N.
#
# Do not run this at the same time as heavy crawls (authorOrphans/authorRescan/
# gap-genre-tag-discovery) — Goodreads throttles; see AGENTS.md.
#
# Usage:
#   ./walkListTag.sh mjf --limit 100
#   ./walkListTag.sh "science fiction" --limit 200 --skip-has genres,tags
#   ./walkListTag.sh mjf --dryRun --limit 10     # enumerate tag + list pages, no fetches/writes
#   ./walkListTag.sh mjf --start-page 2 --max-pages 3
#   ./walkListTag.sh --help                       # full command help from the CLI
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  sed -n '2,24p' "$0"
  exit 0
fi
if [ -z "$1" ]; then
  echo "Error: a list tag is required."
  echo "Usage: ./walkListTag.sh <tag> [options]"
  echo "Example: ./walkListTag.sh mjf --limit 100"
  exit 1
fi
date
echo starting walkListTag.sh
# A bare leading argument is the tag: ./walkListTag.sh mjf --limit 50
case "$1" in
  -*) npm run walk-list-tag -- "$@" ;;
  *)  npm run walk-list-tag -- --tag "$1" "${@:2}" ;;
esac
echo ended walkListTag.sh
date