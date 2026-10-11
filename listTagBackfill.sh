#!/bin/bash
# Work down the list-tag backlog.
#
# Finds every list the database already knows about (the union of list_scrapes,
# lists, and list_walk) that has NO row in the list_tags table, then reads ONLY
# the first page of each one — books + authors, plus that list's "Tags:" block —
# recording it in list_tags. Lists are read in RANDOM order with the usual pacing
# between them.
#
# Only page 1 is read because the tag block repeats identically on every page of
# a list, so one request per list captures the whole set.
#
# It resumes naturally: a list that gets tagged drops out of the candidate set,
# so simply re-running picks up where the last run stopped. Re-run until it
# reports the queue is empty.
#
# A list that fails to read (dead id, 404) is counted and skipped — never fatal.
# Only a genuine connectivity outage aborts the run.
#
# Usage:
#   ./listTagBackfill.sh                # tag every known list that has none
#   ./listTagBackfill.sh --limit 200    # just the next 200, in random order
#   ./listTagBackfill.sh --dryRun       # show the queue, fetch nothing
#   ./listTagBackfill.sh --help         # full command help from the CLI
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  sed -n '2,22p' "$0"
  exit 0
fi
date
echo starting listTagBackfill.sh
npm run list-tag-backfill -- "$@"
echo ended listTagBackfill.sh
date