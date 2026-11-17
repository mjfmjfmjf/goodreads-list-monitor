#!/bin/bash
# Backfill Listopia header metadata for lists the DB already knows about.
#
# Finds every list in the database (the union of list_scrapes, lists, and
# list_tags) that has no list_meta row or is missing any of: books, voters,
# likes, creation date, creator. Reads ONLY the first page of each one and
# records the header metadata plus that list's "Tags:" sidebar.
#
# Lists are read EARLIEST-DISCOVERED FIRST (list_scrapes.first_scraped asc).
#
# This is metadata-only, NOT a book crawl: it never writes book rows and never
# touches list_scrapes, so first_scraped / last_scraped / num_scraped /
# num_books_scraped are left exactly as they were.
#
# It resumes naturally: a list that gets its metadata drops out of the candidate
# set, so simply re-running picks up where the last run stopped. Re-run until it
# reports the queue is empty.
#
# A list that fails to read (dead id, 404) is counted and skipped — never fatal.
# Only a connectivity outage or Goodreads throttling aborts the run.
#
# Usage:
#   ./backfillListMeta.sh                # fill every known list missing metadata
#   ./backfillListMeta.sh --limit 500    # just the next 500, earliest first
#   ./backfillListMeta.sh --dryRun       # show the queue, fetch nothing
#   ./backfillListMeta.sh --help         # full command help from the CLI
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  sed -n '2,27p' "$0"
  exit 0
fi
date
echo starting backfillListMeta.sh
npm run list-meta-backfill -- "$@"
echo ended backfillListMeta.sh
date
