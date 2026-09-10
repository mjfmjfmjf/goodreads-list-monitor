#!/bin/bash
# Queue-discovery for the queues defined in queueAllRatings.json.
# Options (e.g. --requireWorkId) pass through — see ./queueDiscovery.sh --help.
set -euo pipefail
cd "$(dirname "$0")"
exec ./queueDiscovery.sh queueAllRatings.json "$@"