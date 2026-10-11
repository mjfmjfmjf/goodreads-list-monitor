#!/bin/bash
# Playwright scrape of the field-coverage gap revealed by ratingsCoverageHistogram.sh
# (the WORK+F column): work-representative editions (books.is_work_rep) that have
# NO book_page row, harvested most-ratings-first so the highest-value works are
# covered first. Uses the browser-book-scrape engine (checkpoint/skip-has skipping,
# throttle cooldown + single retry, consecutive-throttle abort, pacing, --limit cap).
#
# Resume: scraped works are checkpointed (browser_scrape 'ok') and get a book_page
# row, so a re-run reskips them unless --force.
#
# Do not run this at the same time as heavy crawls (authorOrphans/authorRescan/
# gap-genre-tag-discovery) — Goodreads throttles; see AGENTS.md.
#
# Usage:
#   ./scrapeFieldGaps.sh --limit 100
#   ./scrapeFieldGaps.sh --limit 300000
#   ./scrapeFieldGaps.sh --limit 50 --minRatings 100000
#   ./scrapeFieldGaps.sh --dryRun --limit 10     # list the backlog only, no network/writes
#   ./scrapeFieldGaps.sh --help                  # full command help from the CLI
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  sed -n '1,22p' "$0"
  npm run browser-book-scrape -- --help 2>/dev/null | sed -n '1,40p'
  exit 0
fi
date
echo starting scrapeFieldGaps.sh
npm run browser-book-scrape -- --candidate coverage-gap "$@"
echo ended scrapeFieldGaps.sh
date