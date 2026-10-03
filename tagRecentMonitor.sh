#!/bin/bash
# Tail-scrape every tag needed for 100% tag_books coverage to discover NEW
# books and NEW authors.
#
# Takes the greedy set-cover tag list (./tagCoverage.sh --limit 20000) and, for
# each tag in that order, reads only the TAIL of its shelf — from the last page
# we previously knew about onward. The live pagination footer drives the stop, so
# a stable shelf costs ~1 fetch, a shelf that grew a page costs ~2. New books are
# synced into the book cache and new authors minted.
#
# Resume is automatic: pass state (start time + per-tag last-scraped) lives in
# the DB, so an interrupted run picks up where it stopped. A completed pass is
# marked done, so the next run re-checks every tag from scratch. Use --fresh to
# force a clean pass and --resumeHorizonHours to widen/narrow the resume window.
#
# Usage:
#   ./tagRecentMonitor.sh --dryRun            # preview the covered tag list, no scraping
#   ./tagRecentMonitor.sh                     # full pass (long — run under caffeinate -is)
#   ./tagRecentMonitor.sh --limit 500         # only the top 500 covered tags this pass
#   ./tagRecentMonitor.sh --fresh             # ignore an in-flight/recent partial pass
#   ./tagRecentMonitor.sh --shelfPages 5      # outer cap of pages read per tag (default 25)
#
# NOTE: this does real network I/O against Goodreads. Use `caffeinate -is` for
# long runs, respect the built-in delays + strict-throttle mode (AGENTS.md).

date
echo "starting tagRecentMonitor.sh"
npm run tag-recent-monitor -- "$@"
echo "ended tagRecentMonitor.sh"
date
