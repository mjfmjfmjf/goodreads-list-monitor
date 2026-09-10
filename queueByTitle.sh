#!/bin/bash
# Queue-discovery for the title-letter lists defined in queueByTitle.json.
# Options (e.g. --requireWorkId) pass through — see ./queueDiscovery.sh --help.
set -euo pipefail
cd "$(dirname "$0")"
exec ./queueDiscovery.sh queueByTitle.json "$@"