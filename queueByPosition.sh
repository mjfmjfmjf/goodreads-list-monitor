#!/bin/bash
# Queue-discovery for the series-position lists defined in queueByPosition.json.
# Options (e.g. --requireWorkId) pass through — see ./queueDiscovery.sh --help.
set -euo pipefail
cd "$(dirname "$0")"
exec ./queueDiscovery.sh queueByPosition.json "$@"