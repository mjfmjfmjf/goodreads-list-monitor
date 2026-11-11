#!/bin/bash
# publishSite.sh — wrapper for `publish-site`
#
# Render static HTML reports from the local Goodreads database into ./publish
# (or --out <dir>). Files are overwritten one at a time (atomic temp+rename), so
# a running regeneration never takes the published site down.
#
# Usage:
#   ./publishSite.sh
#   ./publishSite.sh --out /tmp/site --limit 100
set -euo pipefail
cd "$(dirname "$0")"

npm run publish-site -- "$@"
