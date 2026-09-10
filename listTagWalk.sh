#!/bin/bash
# Walk every list under a Listopia tag (e.g. https://www.goodreads.com/list/tag/2024).
#
# Reads the tag index page by page (following the pager at the bottom), then
# crawls each list into the DB — books + authors — reporting per list:
#   how long it took, how many books it had, how many books were added,
#   how many authors were added.
#
# By default it starts at page 1 and reads ALL lists to the end, skipping any
# list that was fully scraped within the last 7 days (list_scrapes table);
# override the window with --skip-days (0 disables skipping entirely).
#
# Usage:
#   ./listTagWalk.sh 2024                     # all lists under list/tag/2024
#   ./listTagWalk.sh 2024 --skip-days 0       # re-scrape everything, no skipping
#   ./listTagWalk.sh 2024 --page-start 2      # start at tag-index page 2, read to the end
#   ./listTagWalk.sh 2024 --page-start 1 --page-end 3   # tag-index pages 1-3 only
#   ./listTagWalk.sh 2024 --dryRun            # enumerate lists, crawl nothing
#   ./listTagWalk.sh 2024 --list-max-pages 20 # cap each list's own crawl
#   ./listTagWalk.sh --help                   # full command help from the CLI
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  sed -n '2,24p' "$0"
  exit 0
fi
if [ -z "$1" ]; then
  echo "Error: a tag is required."
  echo "Usage: ./listTagWalk.sh <tag> [options]"
  echo "Example: ./listTagWalk.sh 2024"
  exit 1
fi
date
echo starting listTagWalk.sh
# A bare leading argument is the tag: ./listTagWalk.sh 2024 --page-end 3
case "$1" in
  -*) npm run list-tag-walk -- "$@" ;;
  *)  npm run list-tag-walk -- --tag "$1" "${@:2}" ;;
esac
echo ended listTagWalk.sh
date