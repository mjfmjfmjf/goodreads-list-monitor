#!/bin/bash
# Walk the Listopia popular-lists directory (https://www.goodreads.com/list/popular_lists).
#
# Reads ONE directory page, then crawls each list on that page into the DB —
# books + authors — before advancing to the next directory page (interleaved,
# so it never buffers all ~100 directory pages up front). Reports per list:
#   how long it took, how many books it had, how many books were added,
#   how many authors were added.
#
# Defaults to crawling every list. Lists fully scraped within the last 7 days
# are skipped (list_scrapes table); override the window with --skip-days (0
# disables skipping entirely). Pass --dryRun to just enumerate directory pages.
#
# Usage:
#   ./listPopularWalk.sh                        # crawl every list
#   ./listPopularWalk.sh --dryRun               # enumerate everything, crawl nothing
#   ./listPopularWalk.sh --page-start 2         # start at directory page 2
#   ./listPopularWalk.sh --page-start 1 --page-end 3   # directory pages 1-3 only
#   ./listPopularWalk.sh --skip-days 0          # harvest everything, no skipping
#   ./listPopularWalk.sh --list-max-pages 20    # cap each list's crawl
#   ./listPopularWalk.sh --help                 # full command help from the CLI
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  sed -n '2,28p' "$0"
  exit 0
fi
date
echo starting listPopularWalk.sh
npm run list-popular-walk -- "$@"
echo ended listPopularWalk.sh
date