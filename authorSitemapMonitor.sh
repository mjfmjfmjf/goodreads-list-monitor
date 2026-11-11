#!/bin/bash
# Goodreads author-sitemap monitor (Phase 1 dry-run + Phase 2 apply).
#
# Reads https://www.goodreads.com/siteindex.author.xml, validates that every
# shard <loc> matches https://www.goodreads.com/sitemap.<n>.xml.gz (otherwise it
# aborts), then works at most --files shards (default 2).
#
#   --dryRun        preview only; writes the shard ledger, never enqueues/scrapes
#   --enqueueOnly   build the candidate queue without scraping author pages
#   (default)       enqueue new/changed authors, drain the queue, scrape pages
#   (no --files)    drain-only: process ready candidates from the global queue
#
# Usage:
#   ./authorSitemapMonitor.sh --dryRun
#   ./authorSitemapMonitor.sh --files 2 --enqueueOnly
#   ./authorSitemapMonitor.sh --files 1 --start 178 --authors 100
#   ./authorSitemapMonitor.sh --authors 50
#
# New authors get a full catalog crawl; changed authors get one recent-books
# page unless --multiPage is passed. --minAge (default 90 days) defers authors
# scraped recently; --force re-downloads/reparses an unchanged shard.

date
echo "starting authorSitemapMonitor.sh"
npm run author-sitemap-monitor -- "$@"
echo "ended authorSitemapMonitor.sh"
date
