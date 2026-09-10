#!/bin/bash
# queueDiscovery.sh — shared wrapper for `queue-discovery`
#
# Discovers cached books that match each queue list's criteria but are NOT yet
# on that Goodreads list. The queue-*.sh wrappers delegate here with their
# config file; you can also call it directly.
#
# Usage:
#   ./queueDiscovery.sh                       # bulkAuditConfig.json
#   ./queueDiscovery.sh <config.json> [options...]
#
# Options pass through to queue-discovery:
#   --sortBy <type>       Sort candidates by year, ratings, or avg (default ratings)
#   --minAvg <n>          Global minimum average rating
#   --maxAvg <n>          Global maximum average rating
#   --listId <id>         Only run discovery for this list ID
#   --requireWorkId       Only propose books that already have a harvested workId
#
# Examples:
#   ./queueDiscovery.sh queueAllRatings.json
#   ./queueDiscovery.sh queueAllRatings.json --requireWorkId --minAvg 3.9
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  sed -n '3,21p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi
set -euo pipefail
cd "$(dirname "$0")"
npm run queue-discovery -- "$@"