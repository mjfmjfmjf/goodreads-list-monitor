#!/bin/bash
# fieldCoverage.sh — wrapper for `field-coverage`
#
# Offline report: per-field population counts and percentages for the
# books, authors, and tag_books tables in goodreads.db.
#
# Usage:
#   ./fieldCoverage.sh
set -euo pipefail
cd "$(dirname "$0")"
npm run field-coverage -- "$@"
