#!/bin/bash
# exportData.sh — wrapper for `export-data`
#
# Sanitized share export: writes the books + authors tables as two timestamped,
# gzipped CSV files. Excludes config (live session cookies / userId) and lists.
# Pass a mandatory identifier (basename) as the first argument, e.g. mjf.
#
# Usage:
#   ./exportData.sh mjf
#   ./exportData.sh mjf --out ~/Downloads
set -euo pipefail
cd "$(dirname "$0")"
npm run export-data -- "$@"
