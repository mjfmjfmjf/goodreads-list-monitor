#!/bin/bash
# Goodreads list-sitemap monitor.
#
# Reads https://www.goodreads.com/siteindex.list.xml, validates that every shard
# <loc> matches https://www.goodreads.com/sitemap.<n>.xml.gz (otherwise it
# aborts), then streams every entry in the selected shards (default: all).
#
# For each list it consults list_scrapes.last_scraped and the sitemap lastmod:
#   - no prior scrape            -> scrape (new)
#   - lastmod <= last_scraped    -> skip (unchanged)
#   - lastmod >  last_scraped    -> scrape unless scraped within --minAge days
#                                   (recent); older than --minAge -> stale
#
# A completed list crawl marks list_scrapes; a 404/410 marks it gone; a
# --listMaxPages-capped crawl is NOT marked. Finished shards are re-walked as a
# new pass on the next run (eligibility is time-dependent); an interrupted pass
# resumes from its saved cursor.
#
# Usage:
#   ./listSitemapMonitor.sh --dryRun
#   ./listSitemapMonitor.sh
#   ./listSitemapMonitor.sh --files 1
#   ./listSitemapMonitor.sh --start 388 --end 390
#   ./listSitemapMonitor.sh --maxLists 500 --minAge 60

date
echo "starting listSitemapMonitor.sh"
npm run list-sitemap-monitor -- "$@"
echo "ended listSitemapMonitor.sh"
date
