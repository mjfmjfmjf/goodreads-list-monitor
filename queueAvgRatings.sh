#!/bin/bash
# Queue-discovery for the queues defined in queueAvgRatings.json.
# Options (e.g. --requireWorkId) pass through — see ./queueDiscovery.sh --help.
set -euo pipefail
cd "$(dirname "$0")"
date
echo starting queueAvgRatings.sh
./queueDiscovery.sh queueAvgRatings.json "$@"
echo ended queueAvgRatings.sh
date