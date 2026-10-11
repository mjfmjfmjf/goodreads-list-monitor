#!/bin/bash
# Walk EVERY Listopia list tag that has never been walked, biggest first.
#
# Computes the ./listTagStats.sh --exclude-walked ranking (most lists first,
# ties by name, walked tags excluded) and walks each unwalked tag with the
# SAME engine as list-tag-walk — every list under the tag, books + authors,
# lists fully scraped within the last --skip-days days skipped via list_scrapes.
# Runs until every unwalked tag is done; each tag is recorded when its walk
# starts, so a crash just resumes from the next tag on re-run.
#
# Nothing to pick = every tag has been walked; re-walk one with
# ./listTagWalk.sh <tag> directly instead.
#
# Do not run this at the same time as heavy crawls (authorOrphans/authorRescan/
# gap-genre-tag-discovery) — Goodreads throttles; see AGENTS.md.
#
# Usage:
#   ./walkNextTag.sh                          # walk all unwalked tags, biggest first
#   ./walkNextTag.sh --skip-days 30           # narrower skip window
#   ./walkNextTag.sh --min-lists 5            # only tags on 5+ lists
#   ./walkNextTag.sh --dryRun                 # list the unwalked tags in walk order
#   ./walkNextTag.sh --help                   # full command help from the CLI
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  sed -n '2,21p' "$0"
  exit 0
fi
date
echo starting walkNextTag.sh
npm run next-tag-walk -- "$@"
status=$?
echo ended walkNextTag.sh
date
exit $status