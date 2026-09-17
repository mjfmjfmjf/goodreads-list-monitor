#!/bin/bash
# Walk https://www.goodreads.com/shelf page by page and scrape every tag shelf
# we HAVEN'T already captured into tag_books (the genre-gap approach, but over
# the whole top-shelves list instead of the genres table).
#
# This is the "scrape the rest" variation of bulk-tag-discovery: bulk processes
# a fixed slice of the list; this one skips whatever's already scraped and keeps
# going until it's scraped everything new (or --maxListPages is hit).
#
# Scraping records in the usual way: tag_books membership, tag_stats page count,
# author sync, and tags[tag] presence stamped on the affected book rows. Because
# "already scraped" is read from tag_books, an interrupted run can be restarted
# with no bookkeeping — already-done tags are skipped on re-run.
#
# Do not run this at the same time as heavy crawls (authorOrphans/authorRescan/
# bulk crawl) — Goodreads throttles; see AGENTS.md.
#
# Usage:
#   ./walkNewTags.sh --dryRun                    # preview new tags, no scraping
#   ./walkNewTags.sh                             # scrape everything new
#   ./walkNewTags.sh --startPage 40 --maxListPages 10   # resume near the end
#   ./walkNewTags.sh --shelfPages 1-10           # only first 10 pages of each shelf
#   ./walkNewTags.sh --minTags 100               # stop scanning a shelf below 100 tags
#
# NOTE: this does a LOT of real network I/O against Goodreads. Use
# `caffeinate -is` for long runs and respect the built-in delays.

date
echo "starting walkNewTags.sh"
npm run walk-new-tags -- "$@"
echo "ended walkNewTags.sh"
date