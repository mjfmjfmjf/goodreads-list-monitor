#!/bin/bash
# authorLedgerMigrate.sh — wrapper for `author-ledger-migrate`
#
# One-off §4 migration. Merges authors.fail_count / authors.last_error into
# author_scrape_failures (so strike state lives in exactly one table, gated by
# the single AUTHOR_FAIL_LIMIT in storage.ts) and drops all three legacy columns
# (fail_count, last_error, page_gone).
#
# MERGE, not discard. An earlier version dropped the legacy counts, which was a
# bug: the two ledgers barely overlap (live DB 569 ids legacy-only, 721
# ledger-only) because the legacy counter was written by years of past crawls.
# Filtering on the ledger alone re-admitted every author the legacy counter had
# already retired at the threshold — 519 never-crawled authors — and made a
# `--sortBy topRatings` queue GROW (235,645 -> 235,907) instead of shrink.
# MAX(authors.fail_count, ledger.fail_count) is used so a strike recorded in
# either place survives and no count is ever lowered.
#
# Run with ALL crawlers stopped: a process still on the old code shape would keep
# writing columns that no longer exist. Take a backup first.
# Idempotent — safe to re-run after it succeeds.
#
# Usage:
#   ./authorLedgerMigrate.sh            # dry run: report blast radius only
#   ./authorLedgerMigrate.sh --apply    # merge + drop the legacy columns
set -euo pipefail
cd "$(dirname "$0")"
npm run author-ledger-migrate -- "$@"