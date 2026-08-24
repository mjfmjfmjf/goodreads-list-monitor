#!/bin/bash
# dumpList.sh — wrapper for `dump-list`
#
# Dumps a Goodreads list to the screen in order: page, global position,
# title, author. Paginates politely (~2s between pages). Exits on throttle.
#
# Usage:
#   ./dumpList.sh 4893
#   ./dumpList.sh "https://www.goodreads.com/list/show/4893.Best_Science_Fiction_of_the_21st_Century"
#   ./dumpList.sh 4893 --grep penumbra
#   ./dumpList.sh 4893 --maxPages 3
set -euo pipefail
cd "$(dirname "$0")"
npm run dump-list -- "$@"
