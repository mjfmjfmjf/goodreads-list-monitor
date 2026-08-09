#!/bin/bash
# Runs the live integration test suite (Vitest): minimal live lookups against
# Goodreads to catch parser/scraper breakage or site-structure changes.
#
# Makes ~12 requests (shelves, search, author stats, tag counts, list
# pagination, and one rate-limited add-book lookup), so run it deliberately:
#   ./runIntegrationTests.sh
#
# Requirements: the app's config.json (for cookies), a cached library export
# (for the add-book lookup), and state.json (for monitored-list pagination).
#
# Runs in STRICT throttle mode: if Goodreads throttles the suite (HTTP 202
# interstitial, 403, or 429) it gives up immediately, so a throttled run fails
# fast instead of retrying for minutes. Retry after a ~60s+ cooldown.
cd "$(dirname "$0")"
npm run test:integration
