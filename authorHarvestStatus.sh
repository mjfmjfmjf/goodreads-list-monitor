#!/bin/bash
# authorHarvestStatus.sh — wrapper for `author-harvest-status`
#
# Offline report: how many authors have harvested stats, freshness
# distribution of last_seen, and top never-harvested authors ranked
# by their best book's ratings. No network requests.
#
# Usage:
#   ./authorHarvestStatus.sh
set -euo pipefail
cd "$(dirname "$0")"
npm run author-harvest-status -- "$@"
