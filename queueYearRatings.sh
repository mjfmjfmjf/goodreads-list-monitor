#!/bin/bash
# Queue-discovery for the queues defined in queueYearRatings.json.
# Options (e.g. --requireWorkId) pass through — see ./queueDiscovery.sh --help.
set -euo pipefail
cd "$(dirname "$0")"
date
echo starting queueYearRatings.sh
./queueDiscovery.sh queueYearRatings.json "$@"
echo ended queueYearRatings.sh
date