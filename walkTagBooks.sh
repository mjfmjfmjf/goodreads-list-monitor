#!/bin/bash
# Walk a Goodreads shelf tag (https://www.goodreads.com/shelf/show/<tag>)
# page by page in a headed, logged-in Chromium and harvest EVERY book with the
# same book-level engine as list-walk: checkpoint/skip-has skipping, throttle
# cooldown + single retry, consecutive-throttle abort, pacing, and a --limit cap.
# Unlike list-walk there is no rating-range description chain — one tag shelf,
# read top to bottom (or from --page-start).
#
# Resume: harvested books are checkpointed (browser_scrape 'ok'), so an
# interrupted run simply skips them on re-run unless --force is passed.
#
# Do not run this at the same time as heavy crawls (authorOrphans/authorRescan/
# gap-genre-tag-discovery) — Goodreads throttles; see AGENTS.md.
#
# Usage:
#   ./walkTagBooks.sh science-fiction --limit 100
#   ./walkTagBooks.sh "Science Fiction" --limit 50 --skip-has genres,tags
#   ./walkTagBooks.sh fantasy --dryRun --limit 10     # enumerate pages/books, no fetches/writes
#   ./walkTagBooks.sh mystery --page-start 2 --max-pages 5
#   ./walkTagBooks.sh --help                          # full command help from the CLI
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  sed -n '2,22p' "$0"
  exit 0
fi
if [ -z "$1" ]; then
  echo "Error: a tag is required."
  echo "Usage: ./walkTagBooks.sh <tag> [options]"
  echo "Example: ./walkTagBooks.sh science-fiction --limit 100"
  exit 1
fi
date
echo starting walkTagBooks.sh
# A bare leading argument is the tag: ./walkTagBooks.sh sci-fi --limit 50
case "$1" in
  -*) npm run walk-tag-books -- "$@" ;;
  *)  npm run walk-tag-books -- --tag "$1" "${@:2}" ;;
esac
echo ended walkTagBooks.sh
date