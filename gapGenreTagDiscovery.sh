#!/bin/bash
# Scrape the tag shelves for genres not yet scraped into tag_books.
#
# Every genre name is a Goodreads shelf (/shelf/show/<genre>), so a genre is a
# tag we can harvest. This walks the genres table and scrapes the ones we
# HAVEN'T already captured in tag_books, ordered "most books to least books"
# (goal 4) so the highest-value shelves go first.
#
# By default it SKIPS genres already present in tag_books, so a re-run only
# picks up whatever is still missing. Scraping is polite + rate-limited and the
# genre table is live-scrapable if you need more gaps (see genreList.sh).
#
# Usage:
#   ./gapGenreTagDiscovery.sh --dryRun          # preview the gap list, no scraping
#   ./gapGenreTagDiscovery.sh --count 10        # scrape the top 10 gap genres by books
#   ./gapGenreTagDiscovery.sh --start 11 --count 10   # resume after a partial run
#   ./gapGenreTagDiscovery.sh --shelfPages 1-10 # only first 10 pages of each shelf
#   ./gapGenreTagDiscovery.sh --force           # also re-scrape already-captured genres
#   ./gapGenreTagDiscovery.sh --sortBy alpha    # alphabetical instead of by member count
#
# NOTE: this does real network I/O against Goodreads. Use `caffeinate -is` for
# long runs, respect the built-in delays + strict-throttle mode (AGENTS.md).

date
echo "starting gapGenreTagDiscovery.sh"
npm run gap-genre-tag-discovery -- "$@"
echo "ended gapGenreTagDiscovery.sh"
date
