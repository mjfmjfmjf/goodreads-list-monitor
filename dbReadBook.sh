#!/bin/bash
# dbReadBook.sh — wrapper for `read-book`
#
# Offline, read-only: print a single book (and its joined author row) directly
# from goodreads.db by book id. Makes no network calls.
#
# Usage:
#   ./dbReadBook.sh 170448
set -euo pipefail
cd "$(dirname "$0")"
npm run read-book -- "$@"
